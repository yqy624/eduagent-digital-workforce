<#
.SYNOPSIS
    edu-ai-platform 一键启动脚本（含全部依赖服务）。

.DESCRIPTION
    按依赖顺序拉起 6 个服务，启动期与运行期持续在终端输出：
        服务名 / 监听地址 / 端口 / PID / 实时日志。

    对“服务已经在跑”的处理：
      · 端口已被占用时先做“身份校验”（查该端口上跑的到底是不是本项目服务），
        命中才复用；命中不了就报“端口冲突”并跳过，不会把别人的进程当成自己的。
      · 复用（含接管上一轮脚本启动的实例）后仍会进入持续输出循环，不会直接退出。
      · PID 以“端口反查真实监听进程”为准，不再信任 Start-Process 的返回（shim）。
      · pids.json 采用合并语义，不会把上一轮记录冲掉。

    停止分三级：
      · Ctrl+C        只停“本次脚本自己启动的”服务（最安全，绝不误杀复用实例）
      · -Stop         停“由脚本启动过”的服务（含上一轮，不含纯外部复用）
      · -StopAll      停 pids.json 里记录的全部（含外部复用实例）

    服务与端口（统一端口方案：底座 1800x / 教育 1801x / 文档 1802x / 视觉 1803x）：
        Milvus            19530   Docker 容器（只检测，不代管，绝不 taskkill）
        MinIO              9000   对象存储，控制台 9001
        Elasticsearch      9200   rag-go 入库强依赖
        rag-go             18000  检索服务
        yolo-platform      18030  视觉推理服务
        edu-ai-platform    18010  主服务

.PARAMETER Stop
    停止由本脚本启动过的服务（读取 scripts/.run/pids.json 中 owned=true 的项）。
    不会停纯外部复用的实例，停它们请用 -StopAll。

.PARAMETER StopAll
    停止 pids.json 中记录的全部服务，包括外部复用实例。

.PARAMETER Restart
    先执行 -Stop（停本脚本启动过的），再正常启动。等价于“重启我这一套”。
    与 -StopAll 一起用则先全停再启动。

.PARAMETER NoTail
    只输出心跳状态，不跟随各服务实时日志。

.PARAMETER Only
    只启动指定服务，逗号分隔的短名。短名：milvus,minio,es,rag,yolo,edu
    例： -Only "minio,es,rag"

.PARAMETER ReadyTimeout
    单个服务等待端口就绪的默认秒数（各服务可单独覆盖），默认 90。

.EXAMPLE
    .\scripts\start_all.ps1

.EXAMPLE
    .\scripts\start_all.ps1 -Only "yolo,edu" -NoTail

.EXAMPLE
    .\scripts\start_all.ps1 -Restart

.EXAMPLE
    .\scripts\start_all.ps1 -StopAll
#>
param(
    [switch]$Stop,
    [switch]$StopAll,
    [switch]$Restart,
    [switch]$NoTail,
    [string]$Only = "",
    [int]$ReadyTimeout = 90
)

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = $null

# 本机环境同时存在 http_proxy / HTTP_PROXY 这种“仅大小写不同”的重复变量，
# 会让 Start-Process 构造环境字典时抛「字典中的关键字」异常；
# 而且本地服务也不该走代理。这里在“本进程作用域”把它们清干净（不影响系统设置）。
foreach ($round in 1..3) {
    foreach ($n in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                     'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        [System.Environment]::SetEnvironmentVariable($n, $null, 'Process')
    }
}

# ── 路径常量 ────────────────────────────────────────────────────────────────
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir      = Join-Path $PSScriptRoot 'logs'
$RunDir      = Join-Path $PSScriptRoot '.run'
$PidFile     = Join-Path $RunDir 'pids.json'

$YoloRoot  = '~\Desktop\yolo-platform'
$RagGoRoot = 'D:\Windows\go\project\anydoc_service\rag-go'
$EsBinDir  = 'D:\Windows\soft\Elasticsearch\elasticsearch-7.6.2-windows-x86_64\elasticsearch-7.6.2\bin'

# ── 服务定义（顺序即启动顺序） ──────────────────────────────────────────────
#   IdentMatch  身份校验关键词：命中该端口的服务返回内容里必须包含它，
#               否则视为“端口被别的程序占用”。为空则不做身份校验（只认端口）。
#   IdentProbe  二级指纹（可选）：只有本项目才有的探针地址，必须返回 200；
#               IdentProbeMustContain（可选）要求探针响应正文包含该关键词。
#               用途：挡住同源代码的副本——副本的 health 关键词会命中 IdentMatch，
#               但没有本项目的探针路由，据此判定为「端口冲突」而非复用。
$Services = @(
    @{
        Key        = 'milvus'
        Name       = 'Milvus 向量库'
        Kind       = 'docker'
        Port       = 19530
        Url        = 'http://127.0.0.1:19530'
        Health     = 'http://127.0.0.1:19530/healthz'
        ReadySec   = 10
        IdentMatch = ''
        Note       = 'Docker 容器 milvus-standalone，脚本只检测不复启（绝不 taskkill）'
    },
    @{
        Key        = 'minio'
        Name       = 'MinIO 对象存储'
        Kind       = 'process'
        File       = "$RagGoRoot\minio.exe"
        Args       = @('server', "$RagGoRoot\data\minio", '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001')
        WorkDir    = $RagGoRoot
        Env        = @{ MINIO_ROOT_USER = 'minioadmin'; MINIO_ROOT_PASSWORD = 'minioadmin' }
        Port       = 9000
        Url        = 'http://127.0.0.1:9000'
        Health     = 'http://127.0.0.1:9000/minio/health/live'
        ReadySec   = 30
        IdentMatch = 'MinIO'
        Extra      = '控制台 http://127.0.0.1:9001'
    },
    @{
        Key        = 'es'
        Name       = 'Elasticsearch 7.6.2'
        Kind       = 'process'
        File       = 'cmd.exe'
        CheckPath  = "$EsBinDir\elasticsearch.bat"
        Args       = @('/c', "$EsBinDir\elasticsearch.bat", '-E', 'xpack.ml.enabled=false', '-E', 'xpack.security.enabled=false')
        WorkDir    = $EsBinDir
        Port       = 9200
        Url        = 'http://127.0.0.1:9200'
        Health     = 'http://127.0.0.1:9200/_cluster/health'
        ReadySec   = 180
        IdentMatch = 'cluster_name'
        Note       = 'JDK17 下必须关闭 xpack.ml，否则启动失败'
    },
    @{
        Key        = 'rag'
        Name       = 'rag-go 检索服务'
        Kind       = 'process'
        File       = "$RagGoRoot\bin\rag-go.exe"
        Args       = @()
        WorkDir    = $RagGoRoot
        # 端口隔离（与 rag-go 的 .env 保持一致，双保险）：
        #   rag-go 自身会拉起两个 sidecar，它们的监听端口由 rag-go 的 .env 决定，
        #   而两者的**代码默认值**恰好落在常用端口上：
        #     · hermit-crab  sidecar  默认 http://127.0.0.1:18010  ← 与 edu 主服务旧端口硬冲突
        #     · anydoc-service sidecar 默认 http://127.0.0.1:8011  ← 与临时实例常用口 8010/8011 冲突
        #   注意 HERMIT_ENABLED 在 rag-go 代码里的默认值是 true（config.go），
        #   只要 .env 缺失或被覆盖成 true，寄居蟹就会去抢 8001。
        #   本项目只需要 rag-go 的 go 检索引擎，不需要寄居蟹（hermit），故显式关死，
        #   并统一收进「底座段 1800x」：引擎 18000 / hermit 18001 / anydoc 18002。
        Env        = @{
            HERMIT_ENABLED  = 'false'
            HERMIT_BASE_URL = 'http://127.0.0.1:18001'
            ANYDOC_BASE_URL = 'http://127.0.0.1:18002'
        }
        Port       = 18000
        Url        = 'http://127.0.0.1:18000'
        Health     = 'http://127.0.0.1:18000/api/v1/health'
        ReadySec   = 30
        IdentMatch = 'rag_ready'
        Depends    = @('minio', 'es', 'milvus')
    },
    @{
        Key        = 'yolo'
        Name       = 'yolo-platform 视觉服务'
        Kind       = 'process'
        File       = "$YoloRoot\.venv\Scripts\python.exe"
        Args       = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '18030')
        WorkDir    = "$YoloRoot\backend"
        Port       = 18030
        Url        = 'http://127.0.0.1:18030'
        Health     = 'http://127.0.0.1:18030/health'
        ReadySec   = 120
        IdentMatch = 'yolo-platform'
    },
    @{
        Key        = 'edu'
        Name       = 'edu-ai-platform 主服务'
        Kind       = 'process'
        File       = "$ProjectRoot\.venv\Scripts\python.exe"
        Args       = @('run.py', '--host', '127.0.0.1', '--port', '18010')
        WorkDir    = $ProjectRoot
        Env        = @{
            DB_BACKEND           = 'sqlite'
            MODEL_VISION_BACKEND = 'http-yolo'
            VISION_SERVICE_URL   = 'http://127.0.0.1:18030'
            RAG_BACKEND          = 'http-rag'
            RAG_SERVICE_URL      = 'http://127.0.0.1:18000'
        }
        Port       = 18010
        Url        = 'http://127.0.0.1:18010'
        Health     = 'http://127.0.0.1:18010/api/health'
        ReadySec   = 60
        IdentMatch = 'EduAgent'
        # 二级指纹：/workspace 是数字员工协作台的稳定地址，只有本项目才有这条路由；
        # 同源的毕设副本没有它（副本 /workspace 返回 404），据此可把副本挡在门外。
        IdentProbe = 'http://127.0.0.1:18010/workspace'
        IdentProbeMustContain = '数字员工'
        Depends    = @('yolo', 'rag')
    }
)

# ── 辅助函数 ────────────────────────────────────────────────────────────────
function Remove-FileQuiet {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return }
    try {
        if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
    } catch { }
}

function Test-Port {
    param([string]$Target, [int]$Port, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($Target, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# 端口 -> 真实监听进程 PID（权威来源，优于 Start-Process 的 shim PID）
function Get-ListenerPid {
    param([int]$Port)
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch { }
    return 0
}

function Get-ProcessNameById {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return '?' }
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p) { return $p.ProcessName }
    return '?'
}

function Get-HealthText {
    param([string]$Url, [int]$TimeoutSec = 4)
    if ([string]::IsNullOrEmpty($Url)) { return '-' }
    try {
        $r = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return "HTTP $([int]$r.StatusCode)"
    } catch {
        $resp = $_.Exception.Response
        if ($resp -ne $null) { return "HTTP $([int]$resp.StatusCode)" }
        return 'no-response'
    }
}

# 身份校验：返回 $true / $false / $null（无法判定）
#   $true  该端口上的服务命中全部指纹 -> 是本项目服务
#   $false 请求成功但指纹不符          -> 是别的程序（端口冲突）
#   $null  请求失败或无从判定          -> 未知
#
# 为什么要两级指纹：IdentMatch 只是健康响应里的一个关键词，**同源代码的副本也会命中**。
# 曾经的事故——桌面上的毕设副本（…\01_源代码）与本项目同源，其 /api/health 同样含
# "project": "EduAgent"，于是脚本把它当"自己人"复用了，而那个副本根本没有
# /workspace 路由、static/ 里也没有 desktop.html，用户打开 8001 看到的是旧版页面。
# 因此对 edu 追加 IdentProbe（只有本项目才有的二级探针）：
#   · IdentProbe             必须返回 HTTP 200
#   · IdentProbeMustContain  可选，响应正文必须包含该关键词
# 任一不满足即判为 $false（冲突），宁可报冲突也不静默复用错误实例。
function Test-Identity {
    param($Service)
    if (-not $Service.ContainsKey('IdentMatch')) { return $null }
    if ([string]::IsNullOrEmpty($Service.IdentMatch)) { return $null }
    if (-not $Service.ContainsKey('Health') -or [string]::IsNullOrEmpty($Service.Health)) { return $null }
    try {
        $r = Invoke-WebRequest -Uri $Service.Health -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $text = [string]$r.Content
        foreach ($hk in $r.Headers.Keys) { $text += "`n$hk`: $($r.Headers[$hk])" }
        if ($text -notlike "*$($Service.IdentMatch)*") { return $false }
    } catch {
        return $null
    }
    # 二级指纹：健康响应命中关键词还不够，再用本项目独有的探针路口二次确认
    if ($Service.ContainsKey('IdentProbe') -and -not [string]::IsNullOrEmpty($Service.IdentProbe)) {
        try {
            $probe = Invoke-WebRequest -Uri $Service.IdentProbe -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ([int]$probe.StatusCode -ne 200) { return $false }
            if ($Service.ContainsKey('IdentProbeMustContain') -and `
                -not [string]::IsNullOrEmpty($Service.IdentProbeMustContain)) {
                $ptext = [string]$probe.Content
                if ($ptext -notlike "*$($Service.IdentProbeMustContain)*") { return $false }
            }
        } catch {
            return $false
        }
    }
    return $true
}

function Write-Head {
    param([string]$Text, [string]$Color = 'Cyan')
    Write-Host ''
    Write-Host $Text -ForegroundColor $Color
}

# 杀掉一棵进程树（taskkill /T）。传多个 PID，逐个尝试，忽略失败。
function Stop-ProcessTree {
    param([int[]]$Ids)
    foreach ($procId in $Ids) {
        if ($procId -le 0) { continue }
        if ((Get-Process -Id $procId -ErrorAction SilentlyContinue) -eq $null) { continue }
        $res = & taskkill.exe /PID $procId /T /F 2>&1
        $txt = ($res | Out-String).Trim()
        Write-Host ("      taskkill /PID {0} /T /F -> {1}" -f $procId, $txt) -ForegroundColor DarkGray
    }
}

# ── pids.json 读写（v2 合并语义，兼容 v1 扁平格式） ──────────────────────────
# 内部结构：@{ key = @{ Pid; ShimPid; Owned; Port; StartedAt } }
function Read-Pids {
    $result = @{}
    if (-not (Test-Path -LiteralPath $PidFile)) { return $result }
    $raw = $null
    try { $raw = [System.IO.File]::ReadAllText($PidFile) } catch { return $result }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $result }
    try { $obj = $raw | ConvertFrom-Json } catch { return $result }
    if ($null -eq $obj) { return $result }

    $names = @($obj.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains 'services') {
        # v2
        if ($null -ne $obj.services) {
            foreach ($p in $obj.services.PSObject.Properties) {
                $v = $p.Value
                $result[$p.Name] = @{
                    Pid       = [int]"$($v.pid)"
                    ShimPid   = [int]"$($v.shimPid)"
                    Owned     = [bool]"$($v.owned)"
                    Port      = [int]"$($v.port)"
                    StartedAt = [string]$v.startedAt
                }
            }
        }
    } else {
        # v1 扁平：key -> int pid（视为本脚本启动，owned=true）
        foreach ($p in $obj.PSObject.Properties) {
            $result[$p.Name] = @{
                Pid       = [int]"$($p.Value)"
                ShimPid   = 0
                Owned     = $true
                Port      = 0
                StartedAt = ''
            }
        }
    }
    return $result
}

function Write-Pids {
    param([hashtable]$Entries)
    $svc = [ordered]@{}
    foreach ($k in $Entries.Keys) {
        $e = $Entries[$k]
        $svc[$k] = [ordered]@{
            pid       = [int]$e.Pid
            shimPid   = [int]$e.ShimPid
            owned     = [bool]$e.Owned
            port      = [int]$e.Port
            startedAt = [string]$e.StartedAt
        }
    }
    if ($svc.Count -eq 0) {
        Remove-FileQuiet $PidFile
        return
    }
    $doc = [ordered]@{ version = 2; services = $svc }
    $json = $doc | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($PidFile, $json, [System.Text.UTF8Encoding]::new($false))
}

# ── 停止逻辑 ────────────────────────────────────────────────────────────────
function Invoke-StopMode {
    param([switch]$All)
    $pids = Read-Pids
    if ($pids.Count -eq 0) {
        Write-Host '没有记录在案的服务，无需停止。' -ForegroundColor Yellow
        return
    }
    $scope = if ($All) { '记录在案的全部' } else { '由本脚本启动过的' }
    Write-Head ("== 停止{0}服务 ==" -f $scope) 'Yellow'

    $remaining = @{}
    foreach ($k in $pids.Keys) {
        $e = $pids[$k]
        $alive = (Get-Process -Id $e.Pid -ErrorAction SilentlyContinue) -ne $null
        if (-not $alive) {
            Write-Host ("  {0,-6} PID {1} 已不在运行" -f $k, $e.Pid) -ForegroundColor DarkGray
            continue
        }
        $shouldStop = $All -or $e.Owned
        if (-not $shouldStop) {
            Write-Host ("  {0,-6} PID {1} 外部复用实例，-Stop 不处理（如确需停止请用 -StopAll）" -f $k, $e.Pid) -ForegroundColor DarkGray
            $remaining[$k] = $e
            continue
        }
        Write-Host ("  停止 {0,-6} PID {1}" -f $k, $e.Pid) -ForegroundColor Yellow
        Stop-ProcessTree -Ids @($e.Pid, $e.ShimPid)
    }
    Start-Sleep -Seconds 1
    Write-Pids -Entries $remaining
    Write-Host '完成。' -ForegroundColor Green
}

# ── -Stop / -StopAll（不带 -Restart 时执行完即退出） ─────────────────────────
if (($Stop -or $StopAll) -and (-not $Restart)) {
    if ($StopAll) { Invoke-StopMode -All } else { Invoke-StopMode }
    return
}

# ── -Restart：先停后起 ──────────────────────────────────────────────────────
if ($Restart) {
    if ($StopAll) { Invoke-StopMode -All } else { Invoke-StopMode }
}

# ── 前置：目录与日志 ────────────────────────────────────────────────────────
foreach ($d in @($LogDir, $RunDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

Write-Head '============================================================' 'Cyan'
Write-Host '  edu-ai-platform 一键启动' -ForegroundColor Cyan
Write-Host "  项目根 : $ProjectRoot"
Write-Host "  日志目录: $LogDir"
Write-Host "  时间    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host '============================================================' 'Cyan'

$onlyList = @()
if (-not [string]::IsNullOrWhiteSpace($Only)) {
    $onlyList = $Only.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne '' }
}

$queue = $Services
if ($onlyList.Count -gt 0) {
    $queue = $Services | Where-Object { $onlyList -contains $_.Key }
}

# 本次运行登记的三类：Managed（跟踪的全部）、SelfStarted（本次自启，Ctrl+C 停）、Conflicts（端口冲突）
$script:Managed     = [ordered]@{}
$script:SelfStarted = [ordered]@{}
$script:Conflicts   = [ordered]@{}
$oldPids = Read-Pids

$total = @($queue).Count
$index = 0

foreach ($s in $queue) {
    $index++
    $key = $s.Key
    Write-Head ("[{0}/{1}] {2}  (端口 {3})" -f $index, $total, $s.Name, $s.Port) 'White'

    # 0) Docker 类型：只检测，绝不接管（否则会误杀 WSL 转发的 wslrelay）
    if ($s.Kind -eq 'docker') {
        if (Test-Port -Target '127.0.0.1' -Port $s.Port) {
            Write-Host "      检测到端口 $($s.Port) 已监听，Docker 容器在线" -ForegroundColor Green
            Write-Host "      >> $($s.Name)  $($s.Url)  （脚本不代管，Ctrl+C/-Stop 都不会动它）" -ForegroundColor Green
        } else {
            Write-Host "      [跳过] Docker 容器未运行。请先执行：docker compose up -d" -ForegroundColor Yellow
            Write-Host "      预期端口 $($s.Port) / $($s.Url)" -ForegroundColor DarkGray
        }
        continue
    }

    # 1) 端口已在监听 -> 先做身份校验，再决定“复用 / 冲突”
    if (Test-Port -Target '127.0.0.1' -Port $s.Port) {
        $realPid  = Get-ListenerPid -Port $s.Port
        $procName = Get-ProcessNameById -ProcessId $realPid
        $ident    = Test-Identity -Service $s

        if ($ident -eq $false) {
            $probeTag = ''
            if ($s.ContainsKey('IdentProbe') -and -not [string]::IsNullOrEmpty($s.IdentProbe)) {
                $probeTag = " + 探针 $($s.IdentProbe)"
            }
            Write-Host "      [冲突] 端口 $($s.Port) 被非本项目进程占用：PID $realPid ($procName)" -ForegroundColor Red
            Write-Host "             身份校验未通过（关键词 '$($s.IdentMatch)'$probeTag），既不接管也不启动。" -ForegroundColor Red
            Write-Host "             常见原因：同源代码的副本（如桌面上的毕业设计副本 01_源代码）先占住了该端口。" -ForegroundColor DarkYellow
            Write-Host "             处理：释放端口后重跑（taskkill /PID $realPid /T /F），或加 -Only 跳过本服务。" -ForegroundColor Red
            $script:Conflicts[$key] = "端口被 $procName (PID $realPid) 占用"
            continue
        }

        # 命中（或无法判定时按复用处理）
        $identTag = if ($ident -eq $true) { '身份已校验' } else { '身份未能校验(按复用处理)' }
        $owned    = $false
        $origin   = '复用'
        $inheritShim = 0
        $inheritAt   = ''
        if ($oldPids.ContainsKey($key)) {
            $o = $oldPids[$key]
            # 沿用历史记录的 shimPid / startedAt（即使不是接管，也保留可用的停止信息）
            $inheritShim = [int]$o.ShimPid
            $inheritAt   = [string]$o.StartedAt
            if ($o.Pid -eq $realPid -and $o.Owned) {
                $owned  = $true
                $origin = '接管'
            }
        }

        Write-Host "      端口 $($s.Port) 已在监听，PID $realPid ($procName) · $identTag · $origin" -ForegroundColor Green
        Write-Host "      >> $($s.Name)  $($s.Url)" -ForegroundColor Green
        if ($s.Extra) { Write-Host "         $($s.Extra)" -ForegroundColor DarkGray }

        $script:Managed[$key] = @{
            Pid       = $realPid
            ShimPid   = $inheritShim
            Owned     = $owned
            Reused    = $true
            Origin    = $origin
            Loggable  = $false
            Out       = ''
            Err       = ''
            CursorOut = 0
            CursorErr = 0
            Name      = $s.Name
            Url       = $s.Url
            Port      = $s.Port
            Health    = $s.Health
            StartedAt = $inheritAt
        }
        continue
    }

    # 2) 文件存在性检查（cmd.exe 这类走 PATH 的命令用 CheckPath 指定真实文件）
    $checkTarget = $s.File
    if ($s.ContainsKey('CheckPath')) { $checkTarget = $s.CheckPath }
    if (-not (Test-Path -LiteralPath $checkTarget)) {
        Write-Host "      [跳过] 可执行文件不存在：$checkTarget" -ForegroundColor Red
        continue
    }

    # 3) 依赖检查
    if ($s.ContainsKey('Depends')) {
        foreach ($dep in $s.Depends) {
            $depSvc = $Services | Where-Object { $_.Key -eq $dep } | Select-Object -First 1
            if ($depSvc -eq $null) { continue }
            if (-not (Test-Port -Target '127.0.0.1' -Port $depSvc.Port)) {
                Write-Host "      [警告] 依赖 $dep (:$($depSvc.Port)) 未就绪，仍继续启动" -ForegroundColor Yellow
            }
        }
    }

    $cmdText = $s.File
    if ($s.ContainsKey('Args')) { $cmdText = "$($s.File) $($s.Args -join ' ')" }
    Write-Host "      命令: $cmdText" -ForegroundColor DarkGray
    Write-Host "      工作目录: $($s.WorkDir)" -ForegroundColor DarkGray

    # 4) 准备日志
    $outLog = Join-Path $LogDir "$key.out.log"
    $errLog = Join-Path $LogDir "$key.err.log"
    foreach ($f in @($outLog, $errLog)) { Remove-FileQuiet $f }

    # 5) 注入环境变量（仅本进程级，Start-Process 启动时快照继承）
    $savedEnv = @{}
    if ($s.ContainsKey('Env')) {
        foreach ($ek in $s.Env.Keys) {
            $savedEnv[$ek] = [System.Environment]::GetEnvironmentVariable($ek, 'Process')
            [System.Environment]::SetEnvironmentVariable($ek, $s.Env[$ek], 'Process')
        }
    }

    # 6) 启动（用 splatting 组装参数：rag-go 这类无参数服务不发 ArgumentList，
    #    避免 PowerShell 把空数组判为 null 而报参数校验错误）
    $sp = @{
        FilePath               = $s.File
        WorkingDirectory       = $s.WorkDir
        RedirectStandardOutput = $outLog
        RedirectStandardError  = $errLog
        WindowStyle            = 'Hidden'
        PassThru               = $true
    }
    if ($s.ContainsKey('Args')) {
        $argList = @($s.Args | Where-Object { $null -ne $_ })
        if ($argList.Count -gt 0) { $sp['ArgumentList'] = $argList }
    }
    $startAt = Get-Date
    try {
        $proc = Start-Process @sp
    } finally {
        foreach ($ek in $savedEnv.Keys) {
            [System.Environment]::SetEnvironmentVariable($ek, $savedEnv[$ek], 'Process')
        }
    }
    $shimPid = $proc.Id
    Write-Host "      shim PID $shimPid 已拉起（真正的监听 PID 稍后按端口反查），等待端口 $($s.Port) 就绪 ..." -ForegroundColor DarkGray

    # 7) 等待就绪
    $readySec = $ReadyTimeout
    if ($s.ContainsKey('ReadySec')) { $readySec = $s.ReadySec }
    $deadline = (Get-Date).AddSeconds($readySec)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-Port -Target '127.0.0.1' -Port $s.Port -TimeoutMs 500) { $ok = $true; break }
        if ((Get-Process -Id $shimPid -ErrorAction SilentlyContinue) -eq $null) {
            # shim 退出：可能已 fork 出真实进程，再给端口一次机会
            if (Test-Port -Target '127.0.0.1' -Port $s.Port -TimeoutMs 500) { $ok = $true }
            break
        }
        Start-Sleep -Milliseconds 500
    }
    $elapsed = [int]((Get-Date) - $startAt).TotalSeconds

    # 8) 端口反查真实监听 PID（权威）；拿不到就退回 shim PID
    $realPid = Get-ListenerPid -Port $s.Port
    if ($realPid -le 0) { $realPid = $shimPid }

    if ($ok) {
        $sameNote = ''
        if ($realPid -ne $shimPid) { $sameNote = "（shim $shimPid / 监听 $realPid）" }
        Write-Host "      [OK] 就绪耗时约 ${elapsed}s$sameNote" -ForegroundColor Green
        Write-Host "      >> $($s.Name)  $($s.Url)" -ForegroundColor Green
        if ($s.Extra) { Write-Host "         $($s.Extra)" -ForegroundColor DarkGray }
    } else {
        Write-Host "      [失败] ${readySec}s 内端口未就绪。日志尾部：" -ForegroundColor Red
        $tail = @()
        if (Test-Path -LiteralPath $errLog) { $tail += @(Get-Content -LiteralPath $errLog -Encoding UTF8 -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $outLog) { $tail += @(Get-Content -LiteralPath $outLog -Encoding UTF8 -ErrorAction SilentlyContinue) }
        $tail | Select-Object -Last 8 | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkRed }
    }

    $entry = @{
        Pid       = $realPid
        ShimPid   = $shimPid
        Owned     = $true
        Reused    = $false
        Origin    = '自启'
        Loggable  = $true
        Out       = $outLog
        Err       = $errLog
        CursorOut = 0
        CursorErr = 0
        Name      = $s.Name
        Url       = $s.Url
        Port      = $s.Port
        Health    = $s.Health
        StartedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    }
    $script:Managed[$key]     = $entry
    $script:SelfStarted[$key] = $entry
}

# ── 保存 PID（合并语义：保留本次未触及、但仍存活的历史记录） ────────────────
$saveMap = @{}
foreach ($k in $script:Managed.Keys) {
    $e = $script:Managed[$k]
    $saveMap[$k] = @{
        Pid = $e.Pid; ShimPid = $e.ShimPid; Owned = $e.Owned
        Port = $e.Port; StartedAt = $e.StartedAt
    }
}
foreach ($k in $oldPids.Keys) {
    if ($saveMap.ContainsKey($k)) { continue }
    $o = $oldPids[$k]
    if ((Get-Process -Id $o.Pid -ErrorAction SilentlyContinue) -ne $null) {
        $saveMap[$k] = @{
            Pid = $o.Pid; ShimPid = $o.ShimPid; Owned = $o.Owned
            Port = $o.Port; StartedAt = $o.StartedAt
        }
    }
}
Write-Pids -Entries $saveMap

# ── 启动完成汇总 ────────────────────────────────────────────────────────────
Write-Head '============================================================' 'Cyan'
Write-Host '  启动完成 · 服务清单' -ForegroundColor Cyan
Write-Host '============================================================' 'Cyan'
Write-Host ("  {0,-22} {1,-6} {2,-30} {3}" -f '服务', '端口', '地址', '状态') -ForegroundColor White
Write-Host ("  {0,-22} {1,-6} {2,-30} {3}" -f '────', '────', '────', '────') -ForegroundColor DarkGray
foreach ($s in $Services) {
    if ($onlyList.Count -gt 0 -and -not ($onlyList -contains $s.Key)) { continue }
    $stateTxt = '未运行'; $color = 'DarkGray'
    if ($script:Conflicts.Contains($s.Key)) {
        $stateTxt = '端口冲突'; $color = 'Red'
    } elseif ($script:Managed.Contains($s.Key)) {
        $e = $script:Managed[$s.Key]
        if ($e.Reused) { $stateTxt = if ($e.Owned) { '在线(接管)' } else { '在线(复用)' }; $color = 'Yellow' }
        else { $stateTxt = '在线(自启)'; $color = 'Green' }
    } elseif (Test-Port -Target '127.0.0.1' -Port $s.Port) {
        $stateTxt = '在线'; $color = 'Green'
    }
    Write-Host ("  {0,-22} {1,-6} {2,-30} {3}" -f $s.Name, $s.Port, $s.Url, $stateTxt) -ForegroundColor $color
    if ($script:Conflicts.Contains($s.Key)) {
        Write-Host ("      └ {0}" -f $script:Conflicts[$s.Key]) -ForegroundColor DarkRed
    }
}
Write-Host ''
Write-Host '  主入口（数字员工协作台）：' -NoNewline -ForegroundColor White
Write-Host 'http://127.0.0.1:18010/' -ForegroundColor Green
Write-Host '  业务台（员工产出落到课程作业里）：' -NoNewline -ForegroundColor White
Write-Host 'http://127.0.0.1:18010/platform' -ForegroundColor Green
Write-Host '  登录页：' -NoNewline -foregroundColor White
Write-Host 'http://127.0.0.1:18010/login.html?next=%2F' -ForegroundColor Green
Write-Host '  接口文档：' -NoNewline -ForegroundColor White
Write-Host 'http://127.0.0.1:18010/docs' -ForegroundColor Green
Write-Host ''
Write-Host '  提示：Ctrl+C 停止本次脚本自启的服务；-Stop 停本脚本启动过的；-StopAll 停全部记录' -ForegroundColor DarkGray
Write-Host '============================================================' 'Cyan'

if ($script:Managed.Count -eq 0) {
    Write-Host '没有任何被跟踪的服务（全部冲突或跳过），退出。' -ForegroundColor Yellow
    return
}

# ── 运行期：持续输出 ────────────────────────────────────────────────────────
$heartbeatSec = 15
$nextHeartbeat = (Get-Date)
$hbCount = 0

try {
    while ($true) {
        # A. 跟随日志（仅本次自启、且有日志文件的服务）
        if (-not $NoTail) {
            foreach ($k in $script:Managed.Keys) {
                $entry = $script:Managed[$k]
                if (-not $entry.Loggable) { continue }
                foreach ($pair in @(@('Out', 'out'), @('Err', 'err'))) {
                    $field = $pair[0]
                    $path = $entry[$field]
                    if (-not (Test-Path -LiteralPath $path)) { continue }
                    $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -ErrorAction SilentlyContinue)
                    $cursor = $entry["Cursor$field"]
                    if ($lines.Count -gt $cursor) {
                        for ($i = $cursor; $i -lt $lines.Count; $i++) {
                            $line = $lines[$i]
                            if ([string]::IsNullOrWhiteSpace($line)) { continue }
                            Write-Host ("  [{0}] {1}" -f $k, $line) -ForegroundColor DarkGray
                        }
                        $entry["Cursor$field"] = $lines.Count
                    }
                }
            }
        }

        # B. 心跳状态（覆盖全部被跟踪的服务，含复用/接管）
        if ((Get-Date) -ge $nextHeartbeat) {
            $nextHeartbeat = (Get-Date).AddSeconds($heartbeatSec)
            $hbCount++
            $stamp = Get-Date -Format 'HH:mm:ss'
            Write-Host ''
            Write-Host "── 心跳 #$hbCount  $stamp ──────────────────────────────" -ForegroundColor Cyan
            foreach ($k in $script:Managed.Keys) {
                $entry = $script:Managed[$k]
                # 进程判定用 shim 或监听 PID 只要有一个活就算活
                $alive = ((Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue) -ne $null) `
                         -or ($entry.ShimPid -gt 0 -and ((Get-Process -Id $entry.ShimPid -ErrorAction SilentlyContinue) -ne $null))
                $portOk = Test-Port -Target '127.0.0.1' -Port $entry.Port -TimeoutMs 400
                $health = Get-HealthText -Url $entry.Health
                $tagTxt = "[$($entry.Origin)]"
                if ($alive -and $portOk) {
                    Write-Host ("  {0,-6} PID {1,-7} :{2,-6} 在线 {3,-5} {4,-12} {5}" -f $k, $entry.Pid, $entry.Port, $tagTxt, $health, $entry.Url) -ForegroundColor Green
                } elseif ($alive) {
                    Write-Host ("  {0,-6} PID {1,-7} :{2,-6} 进程在但端口不通 {3,-5} {4}" -f $k, $entry.Pid, $entry.Port, $tagTxt, $health) -ForegroundColor Yellow
                } else {
                    Write-Host ("  {0,-6} PID {1,-7} :{2,-6} 进程已退出 {3,-5}" -f $k, $entry.Pid, $entry.Port, $tagTxt) -ForegroundColor Red
                }
            }
        }

        Start-Sleep -Milliseconds 800
    }
} finally {
    Write-Host ''
    Write-Host '== 检测到退出，正在停止本次脚本自启的服务（复用/接管实例不会被动）==' -ForegroundColor Yellow
    foreach ($k in @($script:SelfStarted.Keys)) {
        $e = $script:SelfStarted[$k]
        Write-Host ("  停止 {0,-6} PID {1}" -f $k, $e.Pid) -ForegroundColor Yellow
        Stop-ProcessTree -Ids @($e.Pid, $e.ShimPid)
    }
    # 重新保存：保留仍存活的接管/复用记录，清掉已停的自启项
    $remain = @{}
    foreach ($k in $script:Managed.Keys) {
        if ($script:SelfStarted.Contains($k)) { continue }
        $e = $script:Managed[$k]
        $remain[$k] = @{
            Pid = $e.Pid; ShimPid = $e.ShimPid; Owned = $e.Owned
            Port = $e.Port; StartedAt = $e.StartedAt
        }
    }
    Write-Pids -Entries $remain
    Write-Host '== 已停止本次自启的服务 ==' -ForegroundColor Yellow
}

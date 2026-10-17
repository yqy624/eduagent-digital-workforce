# 原平台改造方案：菜单迁移与 YOLO 接入

> 日期：2026-10-04 ｜ 基于代码实测（行号可查），不是方案推演
> 上游：`智慧平台_菜单配置与路由映射表.md`（新菜单 6 模块 / 49 项）
> 本文解决三件事：①旧菜单怎么改 ②原功能搬去哪 ③YOLO 接在哪个点

---

## 零、先说结论

1. **YOLO 不能全塞进新菜单**。四个场景要分两类处理：**拍照批改嵌进原作业流程**（不占新菜单），**课堂/考场/实验室三个场景才独立成页**（占视觉模块）。
2. **旧菜单迁移分三阶段**，先共存再切换最后下线，不要一次性砍掉旧 dashboard。
3. **接入点已经存在**：`StoredFile` 表早就有 `assignment_id` / `submission_id` 字段，作业图片天然能绑到视觉任务，不需要新建关联表。缺的是 `VisionTask` 补 `submission_id`、`VisionEvent` 补 `course_id`。
4. **有 5 项旧功能在新菜单里没落位**（活动管理、chat-legacy 等），必须补，不能悄悄丢掉。

---

## 一、现状实测

### 1.1 旧前端菜单（`data-tab` 硬编码，无配置化）

| 角色 | 页面 | tab 数 | 实测项 |
|---|---|---|---|
| admin | `static/admin/dashboard.html:50-54` | 5 | 概览 / 用户管理 / 课程管理 / 活动管理 / 系统监控 |
| teacher | `static/teacher/dashboard.html:61-68` | 8 | 概览 / 课程 / 学生 / 作业 / 互评 / 评分 / 分析 / 智慧教育机器人 |
| student | `static/student/dashboard.html` | 6 | 概览 / 我的课程 / 作业 / 互评 / 成绩 / AI 机器人 |

**问题**：三份硬编码，加一个功能要改三处，且按角色切分而不是按能力切分——这正是这次重构要解决的。

### 1.2 后端与数据

| 层 | 现状 |
|---|---|
| 路由 | 8 个：`auth / admin(27 端点) / teacher(17) / student / files / notifications / ai(13) / vision(8，新增)` |
| 旧表 | 13 张：`users courses enrollments assignments submissions peer_reviews notifications audit_logs students published_activities stored_files teacher_comment_memories(+history)` |
| 新表 | 4 张：`vision_tasks vision_events vision_identities model_assets` |

### 1.3 关键发现：挂载点已经存在

```
app/models/models.py:252    StoredFile.assignment_id   ← 文件已能绑作业
app/models/models.py:265    StoredFile.submission_id   ← 文件已能绑提交记录
app/services/assignment_service.py:363  submit()      ← 提交入口
app/services/assignment_service.py:443  grade()       ← 评分入口
```

这意味着：**学生上传作业照片 → StoredFile → 直接建视觉任务**，链路是通的，不用新建中间表。

---

## 二、旧功能落位表（逐项，不含"新建"能力）

### 2.1 admin（5 项）

| 旧 tab | 落位（新模块 / 二级项） | 现成端点 |
|---|---|---|
| 概览 | `governance` 治理总览 | 需改造 |
| 用户管理 | `governance` 用户与权限 | ✅ `GET /api/admin/users` |
| 课程管理 | `review` 课程与班级 + `governance` 组织架构与班级 | ✅ 现成 |
| 活动管理 | ⚠️ **无落位**，见 §3 | `admin_service.py:71` |
| 系统监控 | `governance` 系统健康监控 | ✅ 现成 |

### 2.2 teacher（8 项）

| 旧 tab | 落位（新模块 / 二级项） | 现成端点 |
|---|---|---|
| 概览 | `review` 评阅总览 | 需改造 |
| 课程 | `review` 课程与班级 | ✅ |
| 学生 | `review` 选课与名单 + `insight` 学生画像 | ✅ + 需改造 |
| 作业 | `review` 作业发布 / 在线作答提交 | ✅ |
| 互评 | `review` 同伴互评 | ✅ |
| 评分 | `review` 人工批改 / AI 自动批改 / **拍照上传批改** | 前两项 ✅，第三项新建 |
| 分析 | `review` 作业分析 + `insight` 学习诊断 | ✅ |
| 智慧教育机器人 | `knowledge` Agent 智能对话 | ✅ |

### 2.3 student（6 项）

| 旧 tab | 落位 | 说明 |
|---|---|---|
| 概览 | `insight` 学情总览（只读） | 新建 |
| 我的课程 | `review` 课程与班级（只读） | ✅ |
| 作业 | `review` 在线作答提交 | ✅ |
| 互评 | `review` 同伴互评 | ✅ |
| 成绩 | `review` 成绩查询 | ✅ |
| AI 机器人 | `knowledge` Agent 智能对话 | ✅ |

**结论**：49 项里 24 项直接复用现成端点（49%），主要工作量确实在视觉。

---

## 三、⚠️ 未落位清单（必须补，不能悄悄丢）

| # | 旧能力 | 代码位置 | 建议落位 |
|---|---|---|---|
| 1 | 活动管理 | `PublishedActivity` / `admin_service.py:71` | `governance` 新增「活动与公告」 |
| 2 | 旧版对话 | `ai.py:/agent/chat-legacy` | `knowledge` 或标注废弃后下线（先确认有无调用方） |
| 3 | 我的学习路径 | `ai.py:/me/learning-plan` | `insight` 学习路径规划（学生视角） |
| 4 | 批改建议 | `ai.py:/teacher/submissions/{id}/grade-suggestion` | `review` AI 自动批改（应合并，避免两套批改入口） |
| 5 | 反馈详情 / 重新生成 | `ai.py:/feedback/{id}` 与 `/regenerate` | `review` 批改反馈确认（补两个子操作） |

---

## 四、YOLO 功能放哪里（核心）

### 4.1 两类分法，这是本方案的关键判断

| 类型 | 场景 | 理由 | 是否占新菜单 |
|---|---|---|---|
| **嵌入式** | 拍照识别批改 | 它本质是学生交作业的一种形式，老师工作流不该变：还是"布置 → 收 → 批"，只是多一种提交方式 | ❌ 嵌进 `review`，不新增一级入口 |
| **独立式** | 课堂行为 / 考场监测 / 实验室安全 | 原平台**没有**这三类业务载体（无课堂表、无考场表、无实验表），无处可嵌，必须新建 | ✅ 占 `vision` 模块 3 个场景页 |

### 4.2 四个场景的落位与数据流

| 场景 | 菜单位置 | 输入 | 输出去向 | 关联的旧业务 |
|---|---|---|---|---|
| 拍照识别批改 | `review` → 批改 → 拍照上传批改 | 作业照片（StoredFile） | 回写 `submissions.score` | ✅ assignments / submissions |
| 课堂行为识别 | `vision` → 场景 → 课堂行为识别 | 课堂图片/视频 | `vision_events` → `insight` 课堂参与度 | course_id（弱关联） |
| 考场行为监测 | `vision` → 场景 → 考场行为监测 | 考场视频 | `vision_events` → `situation` 告警 | 需新建考试关联 |
| 实验室安全识别 | `vision` → 场景 → 实验室安全识别 | 实验室图片 | `vision_events` → `situation` 告警 | 无（独立） |

### 4.3 接入点（代码级，可直接照着改）

**A. 拍照批改接进作业流程（推荐先做）**

```
学生上传作业照片
  → StoredFile(assignment_id, submission_id)        # models.py:252/265 已有字段
  → AssignmentService.submit()                      # assignment_service.py:363
  → 若附件是图片：建 VisionTask(
        scene="paper_grading",
        source_ref=<file path>,
        submission_id=<id>, assignment_id=<id>, course_id=<id>)   # 需补字段
  → 视觉 Provider 推理（占位 or yolo-platform）
  → 结果写回：客观题答案 / 得分建议
  → AssignmentService.grade() 消费               # assignment_service.py:443
```

**B. 课堂/考场/实验室（独立入口）**

```
教师选场景 + 上传素材
  → POST /api/vision/tasks（已实现）
  → VisionEvent 落库（scene / severity / subject_ref / evidence_json）
  → GET /api/vision/events → 事件流
  → 高严重度事件推送到 situation 告警（待建）
```

### 4.4 需要补的字段（实测缺口）

| 表 | 现有 | 缺 | 用途 |
|---|---|---|---|
| `vision_tasks` | course_id, operator | **submission_id, assignment_id, file_id** | 把视觉结果绑回具体作业 |
| `vision_events` | subject_ref, seat_ref | **course_id, assignment_id** | 事件能按课/按作业聚合 |
| `submissions` | score, feedback | 可选加 `vision_task_code` | 反向追溯是哪次推理给的分数 |

---

## 五、迁移三阶段

### 阶段 1：共存（1-2 天）

- 旧 dashboard **不动**，继续服务日常流程
- 新菜单只承载"旧平台没有的能力"：`vision` 全 11 项 + `review` 的拍照上传批改
- 顶栏加"新平台"入口（已完成：`/platform`）
- **验收**：旧功能零回归；新视觉链路可跑通

### 阶段 2：切换（按模块逐个搬）

按此顺序，每搬完一个就下线对应旧 tab：

```
1. review   （作业/批改/互评 —— 复用率最高，风险最低）
2. insight  （学情/画像）
3. knowledge（知识库/Agent）
4. governance（用户/课程/监控/审计）
5. situation（告警/通知）
6. vision   （已在阶段 1 建好）
```

- 旧 tab 改为跳转到新路由（保留一个版本的重定向）
- **验收**：每个旧 tab 都能在新菜单找到等价入口（对照 §2 表 + §3 缺口清单）

### 阶段 3：下线

- 删除三份 dashboard 的硬编码 `nav-item`
- `static/{admin,teacher,student}/dashboard.html` 保留为历史入口或删除
- `app/routers/{admin,teacher,student}.py` 逐步把端点迁到新前缀（或保留前缀不动，只换菜单归属）

---

## 六、下一步推荐（有主见版）

**先做「拍照批改接进作业流程」，不要先铺 11 个视觉菜单页面。**

理由：
1. 它是四个场景里**唯一有原业务闭环**的——作业表、提交表、评分入口、文件绑定全都现成，做完立刻能演示"上传作业照片 → 自动识别 → 出分"。
2. 其余三个场景没有业务载体，做了也只是"能跑但没处用"的孤岛。
3. 毕设答辩时，"批改闭环"比"三个独立识别页面"更有说服力。

**建议的第一步动作（半天）**：
1. `vision_tasks` 补 `submission_id` / `assignment_id` / `file_id` 三个字段
2. `AssignmentService.submit()` 里加：图片附件 → 自动建视觉任务
3. 在 `review` 模块加「拍照上传批改」页，回显识别结果与建议分数
4. 用 `MODEL_VISION_BACKEND=yolo-platform` 跑一张真实作业照片验证

---

---

# 七、实施进展（2026-10-04 已完成第一批）

## 7.1 已落地

| # | 改动 | 文件 |
|---|---|---|
| 1 | `vision_tasks` 补 `submission_id / assignment_id / file_id`；`vision_events` 补 `course_id / assignment_id / submission_id` | `app/models/vision_models.py` |
| 2 | 老库自动补列（6 列，SQLite/MySQL 通用） | `app/database.py` |
| 3 | 视觉任务支持业务绑定；`register_pending_scan`（登记不推理）、`scan_submission`（扫描+题块解析+复核建议）、复用已有任务 | `app/services/vision_service.py` |
| 4 | 请求/响应契约（业务绑定字段） | `app/schemas/vision.py` |
| 5 | 新增评阅域契约，**明确不产出分数** | `app/schemas/review.py` |
| 6 | 新增 `/api/review/*`：`POST /submissions/scan`、`POST /scan/tasks/{code}/run`、`GET /scan/tasks`、`POST /submissions/{id}/apply-score` | `app/routers/review.py`（已注册到 `main.py`） |
| 7 | 学生提交图片附件 → 自动登记 pending 批改任务（**不跑模型，不阻塞提交**） | `app/services/assignment_service.py:363` |
| 8 | `/platform` 智能评阅模块加"拍照上传批改"面板 + 待批改清单 | `static/js/app-shell.js` |
| 9 | 端到端冒烟脚本 | `scripts/smoke_review.py` |

## 7.2 实测结果

**占位后端**（`scripts/smoke_review.py`，全绿）：

```
提交成功 -> submission_id=2
已登记视觉任务 / 状态 pending / 绑定作业+提交+文件 / scene=paper_grading
扫描成功 / 复用同一条任务记录 / 未产生重复任务 4 -> 4
解析出题块 3 个（question_block，conf 0.813 / 0.650 / 0.697）
占位结果强制人工复核 / 成绩已写入 88.0 / 状态 GRADED
→ SMOKE PASS
```

**真实 YOLO 后端**（`MODEL_VISION_BACKEND=yolo-platform`，业务代码零改动）：

```
status=succeeded | placeholder=False | model=yolo11n.pt | latency 11.66s
检出 bus 0.940 + person×4
hint: 当前权重未训练题块类别（question_block）… 正式批改需接入自训练权重
```

## 7.3 设计上的两条硬边界（不要越线）

1. **扫描不产分数**。系统没有标准答案，凭识别结果直接给分等于编数据。产出的是"题块在哪、置信度多少、哪些要复核"，分数由教师确认后经 `apply-score` 写回。
2. **提交时只登记、不推理**。GPU 推理要数秒甚至更久，绝不能挡住学生提交；登记失败也不允许影响提交本身（异常只记日志）。

## 7.4 阶段 2 已完成：评阅域端点迁移（2026-10-04）

按 §5 的顺序，`review` 是第一个搬完的模块。迁移原则是**只搬路由与权限，
不搬业务逻辑** —— 新端点全部调用原 `TeacherService / StudentService /
AssignmentService`，旧端点与新端点行为同源，阶段 3 下线旧路由时不会漂移。

**菜单 14 项的落点（`static/js/menu.config.js` 中 `review.apiPrefix=/api/review`）**

| 菜单项 | 端点 | 来源 | 状态 |
|---|---|---|---|
| 评阅总览 | `GET /overview` | 新建（课程/作业/提交/批改/扫描五口径真实计数） | ✅ |
| 课程与班级 | `GET /courses` | `TeacherService.get_my_courses` | ✅ |
| 作业发布 | `GET/POST /assignments`、`PUT/DELETE /assignments/{id}` | `TeacherService` | ✅ |
| 在线作答提交 | `POST /assignments/{id}/submit` | `StudentService.submit_assignment` | ✅ |
| 人工批改 | `POST /submissions/{id}/grade` | `TeacherService.grade_submission` | ✅ |
| AI 自动批改 | `POST /submissions/{id}/ai-grade` | 收编 `ai.py` 的 grade-suggestion（避免两套批改入口） | ✅ |
| 拍照上传批改 | `POST /submissions/scan` | 上一批已建 | ✅ |
| 同伴互评 | `GET /peer-reviews`、`POST/PUT /assignments/{id}/peer-review` | `TeacherService` | ✅ |
| 选课与名单 | `GET /enrollments` | `TeacherService.get_course_students` | ✅ |
| 成绩查询 | `GET /grades` | `StudentService.get_my_grades` | ✅ |
| 批改反馈确认 | `POST /feedback/{id}/approve`、`/regenerate` | 收编 `ai.py` 的反馈确认 | ✅ |
| 作业分析 | `GET /assignments/{id}/analysis` | `TeacherService` | ✅ |
| 教师评语库 | `GET /comment-memories` | 复刻 `teacher.py` 同款查询 | ✅ |
| 批改质量复核 | `GET /grading-quality` | 新建（样本不足时明确 `sample_enough=false`） | ✅ |

`ai.py` 依赖 `ai/` 包与模型密钥，导入失败时 `ai-grade` / `feedback` 降级为 501，
不会拖垮应用启动。

### 实测结果

`scripts/smoke_review_migration.py` 走真实 HTTP，**21 项全通过且可重复运行**：

```
登录 teacher01 / student01
总览/课程/评语库/批改质量/名单/作业清单/待批改清单  全部 200
成绩查询、我的互评（学生）                          200
发布作业 -> 编辑 -> 提交记录 -> 作业分析 -> 互评概览 -> 互评配置
学生提交 -> 教师批改（写回 88.0）
权限：学生调用批改被拒 403
业务保护：有提交的作业禁止删除（原平台既有规则）
删除无提交作业           -> 作业已删除
=== 21 通过 / 0 失败 · SMOKE PASS（连跑两次幂等）===
```

**批改质量复核的真实读数**（占位后端）：
`submissionCount=4 / gradedCount=3 / scanCount=5 / 占位扫描 5 条 / 均分 88.0`
样本不足 10 条时返回 `sample_enough=false` 并给出提示，不硬算比率。

### 顺带修掉的两个真实问题

1. **`app/main.py:276` 健康检查带删除副作用**：`_check_vector_store()` 每次调用
   都 `probe.unlink()`，既会误触发外部安全护栏（批量删除保护）把整个服务带崩，
   也不该让健康检查产生副作用。已改为只写不删。
2. **`app/schemas/review.py` 未设 `protected_namespaces`**：`model_name` 字段
   触发 pydantic 启动告警。已提取 `ReviewModel` 基类统一关闭该限制。
3. `POST /assignments/{id}/submit` 的 `response_model` 误写为 `ApiResponse[dict]`，
   而 service 返回 `SubmissionResponse` 对象，导致响应序列化 500。
   已改为 `ApiResponse[SubmissionResponse]`。

### 前端同步

`static/js/app-shell.js` 新增**评阅工作台**（`renderReviewWorkbench`）：
总览读数条 → 课程下拉 → 作业下拉 → 提交表格（行内填分 + 写回）→ 自动刷新总览。
全部走 `/api/review/*`，不再是静态能力清单。

## 7.5 下一步（阶段 2 剩余）

按 §5 顺序继续：`insight`（学情洞察）→ `knowledge`（知识库）→ `governance`（治理）。
`governance` 需处理 §3 中仍未落位的**活动管理**（`admin_service.py:71`）；
`ai.py` 的 `chat-legacy` 与 `/me/learning-plan` 两项要先确认有无调用方再决定废弃或并入。

---

## 附：本文引用的实测位置

| 结论 | 证据 |
|---|---|
| 旧菜单硬编码 | `admin/dashboard.html:50-54`、`teacher/dashboard.html:61-68` |
| 文件已绑作业 | `models.py:252`（assignment_id）、`models.py:265`（submission_id） |
| 提交/评分入口 | `assignment_service.py:363`（submit）、`:443`（grade） |
| 视觉表缺字段 | `vision_models.py:59-60`（只有 course_id/operator） |
| 未落位功能 | `ai.py` 的 chat-legacy / me/learning-plan / grade-suggestion；`admin_service.py:71` 活动 |

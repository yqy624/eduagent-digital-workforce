/**
 * 平台外壳 —— 视觉层使用 hifi 组件库（企业中后台主题），数据全部来自真实接口。
 *
 * 边界：hash 路由、角色权限裁剪、真实 API 调用保持不变；
 * 所有组件类名与 data-* 交互均取自 hifi 组件规范，不自建样式体系。
 * 动态渲染的节点由 hifi-bridge.js 补图标、动效与分段控件绑定。
 */
(function () {
  "use strict";

  var MENU = window.PLATFORM_MENU;
  var PERM = window.PLATFORM_PERMISSIONS;
  var LOGIN_URL = "/login.html?next=" + encodeURIComponent("/platform");

  // 建设状态 -> 语义标签（真实反映后端有没有这个能力，不做装饰）
  var SRC = {
    existing: { tag: "tag-success", text: "已接入", pct: 100 },
    extend: { tag: "tag-warning", text: "需改造", pct: 55 },
    new: { tag: "tag-off", text: "待建设", pct: 12 }
  };

  var MODICON = {
    vision: "scan",
    review: "check-circle",
    insight: "bar-chart",
    knowledge: "folder",
    situation: "bell",
    governance: "shield"
  };

  var ROLE_TEXT = { ADMIN: "管理员", TEACHER: "教师", STUDENT: "学生" };
  var SEV_TAG = { critical: "tag-danger", warning: "tag-warning", info: "tag-info" };
  var SEV_TEXT = { critical: "严重", warning: "关注", info: "记录" };

  var state = { role: "", username: "", displayName: "", modules: [], current: null, filter: "" };

  // ------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------

  function token() {
    return localStorage.getItem("token") || "";
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function fmtTime(iso) {
    if (!iso) return "--";
    var s = String(iso).replace("T", " ");
    return s.slice(5, 19);
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { "Content-Type": "application/json" };
    if (token()) headers["Authorization"] = "Bearer " + token();
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = LOGIN_URL;
        throw new Error("未登录或登录已过期");
      }
      return res.json();
    });
  }

  function dataOf(res) {
    return (res && res.data) || {};
  }

  function srcOf(source) {
    return SRC[source] || SRC.new;
  }

  function logout() {
    ["token", "role", "displayName", "username"].forEach(function (k) {
      localStorage.removeItem(k);
    });
    window.location.href = LOGIN_URL;
  }

  function findMod(id) {
    for (var i = 0; i < state.modules.length; i++) {
      if (state.modules[i].id === id) return state.modules[i];
    }
    return null;
  }

  function childrenOf(mod) {
    return PERM.visibleChildren(state.role, mod.id, mod.children);
  }

  function canWrite(mod) {
    return PERM.canWriteModule(state.role, mod.id);
  }

  // ------------------------------------------------------------
  // 顶栏：时钟 / 模型状态 / 事件角标
  // ------------------------------------------------------------

  function startClock() {
    var el = document.getElementById("clock");
    if (!el) return;
    function tick() {
      var d = new Date();
      el.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  function loadBackendChip() {
    var chip = document.getElementById("modelChip");
    api("/api/health")
      .then(function (res) {
        var caps = (((res || {}).checks || {}).modelRegistry || {}).capabilities || {};
        var vision = caps.vision || {};
        var info = (vision.implementations || {})[vision.default] || {};
        var ph = info.placeholder === true;
        chip.className = "tag " + (ph ? "tag-warning" : "tag-success");
        chip.innerHTML =
          '<span data-icon="layers" class="ico-sm"></span> 视觉 · ' +
          esc(ph ? "占位实现" : vision.default || "未配置");
        chip.title = ph
          ? "接口与返回结构与真实模型一致，数值为确定性模拟，不作为结论"
          : "当前由真实模型 " + (vision.default || "") + " 提供推理";
        window.Hifi.mount(chip);
      })
      .catch(function () {
        chip.className = "tag tag-danger";
        chip.innerHTML = '<span data-icon="alert-triangle" class="ico-sm"></span> 模型层不可达';
        window.Hifi.mount(chip);
      });
  }

  function loadNotif() {
    api("/api/vision/overview")
      .then(function (res) {
        var d = dataOf(res);
        var n = d.unacknowledged || 0;
        var badge = document.getElementById("notifCount");
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.hidden = n === 0;
      })
      .catch(function () {});
  }

  // ------------------------------------------------------------
  // 侧栏
  // ------------------------------------------------------------

  function renderSidebar() {
    var nav = document.getElementById("sideNav");
    var html = "";
    state.modules.forEach(function (mod) {
      var kids = childrenOf(mod);
      var live = kids.filter(function (c) { return c.source === "existing"; }).length;
      html +=
        '<a class="nav-item" href="#/' + esc(mod.id) + '" data-mod="' + esc(mod.id) + '">' +
        '<span data-icon="' + (MODICON[mod.id] || "grid") + '"></span>' +
        '<span class="ni-txt">' + esc(mod.label) +
        '<span class="ni-sub">' + kids.length + " 项能力 · " + live + " 已接入</span></span>" +
        "</a>";
    });
    nav.innerHTML = html;
    window.Hifi.mount(nav);
  }

  function renderSideFoot() {
    var el = document.getElementById("sideFoot");
    var first = (state.displayName || state.username || "—").slice(0, 1);
    el.innerHTML =
      '<div class="who">' +
      '<span class="avatar avatar-sm" style="--a1:#3d5afe;--a2:#22c68b">' + esc(first) + "</span>" +
      "<span><b>" + esc(state.displayName || state.username) + "</b>" +
      "<span>" + esc(ROLE_TEXT[state.role] || state.role) + " · " + esc(state.username) + "</span></span>" +
      "</div>";
    var um = document.getElementById("umTitle");
    if (um) um.textContent = (state.displayName || state.username) + " · " + (ROLE_TEXT[state.role] || state.role);
    var btn = document.getElementById("btnUser");
    if (btn) btn.textContent = first;
  }

  function highlight(modId) {
    var items = document.querySelectorAll("#sideNav .nav-item");
    Array.prototype.forEach.call(items, function (el) {
      el.classList.toggle("is-active", el.getAttribute("data-mod") === modId);
    });
    var title = document.querySelector(".topbar-title");
    var mod = findMod(modId);
    if (title && mod) title.textContent = mod.label;
  }

  // ------------------------------------------------------------
  // 模块页：指标 + 图表 + 分段面板
  // ------------------------------------------------------------

  function countBy(children, source) {
    return children.filter(function (c) { return c.source === source; }).length;
  }

  function statCard(icon, label, value, hint, decimals, suffix) {
    return (
      '<div class="stat">' +
      '<span class="stat-icon" data-icon="' + icon + '"></span>' +
      '<div class="stat-body">' +
      '<div class="stat-label">' + esc(label) + "</div>" +
      '<div class="stat-value num" data-count-to="' + value + '" data-decimals="' + (decimals || 0) +
      '" data-suffix="' + esc(suffix || "") + '">' + value + "</div>" +
      '<div class="stat-hint">' + esc(hint) + "</div>" +
      "</div></div>"
    );
  }

  function renderHead(mod, children) {
    var live = countBy(children, "existing");
    return (
      '<div class="crumb">' +
      '<a href="#/' + esc(mod.id) + '">控制台</a><span class="sep">/</span>' +
      "<span class=\"cur\">" + esc(mod.label) + "</span></div>" +
      '<div class="pg-head"><div class="pg-main">' +
      "<h2>" + esc(mod.label) + "</h2>" +
      '<div class="pg-desc">' + esc(mod.desc || (mod.label + "：共 " + children.length + " 项能力，其中 " + live + " 项已接入真实接口。")) + "</div>" +
      "</div>" +
      '<div class="pg-actions">' +
      '<button class="btn btn-secondary" type="button" id="btnReload" data-toast="已刷新"><span data-icon="refresh"></span>刷新数据</button>' +
      '<button class="btn btn-primary" type="button" data-drawer-open="#modelDrawer"><span data-icon="layers"></span>模型注册表</button>' +
      "</div></div>"
    );
  }

  function renderCharts(mod, children) {
    var max = 1;
    state.modules.forEach(function (m) {
      max = Math.max(max, childrenOf(m).length);
    });
    var bars = state.modules.map(function (m) {
      var n = childrenOf(m).length;
      var h = Math.round((n / max) * 100);
      return (
        '<div class="chart-bar' + (m.id === mod.id ? " is-max" : "") + '">' +
        '<span class="bv">' + n + "</span>" +
        '<span class="bar" style="height:' + h + '%"></span>' +
        '<span class="bl">' + esc(m.label.slice(0, 4)) + "</span></div>"
      );
    }).join("");

    var live = countBy(children, "existing");
    var ext = countBy(children, "extend");
    var pct = children.length ? Math.round((live / children.length) * 100) : 0;
    var r = 58, c = 2 * Math.PI * r;
    var offset = c * (1 - pct / 100);

    return (
      '<div class="chart-grid">' +
      '<div class="card"><div class="card-hd"><div class="card-title">能力分布</div>' +
      '<div class="card-sub">各通道可见能力项数（按当前角色裁剪）</div></div>' +
      '<div class="card-bd"><div class="chart-bars">' + bars + "</div></div></div>" +
      '<div class="card"><div class="card-hd"><div class="card-title">接入率</div>' +
      '<div class="card-sub">本模块真实接口覆盖情况</div></div>' +
      '<div class="card-bd center" style="flex-direction:column;gap:8px">' +
      '<div class="donut-wrap"><svg class="donut-track" width="140" height="140" viewBox="0 0 140 140">' +
      '<circle class="tr" cx="70" cy="70" r="' + r + '"></circle>' +
      '<circle class="seg1" cx="70" cy="70" r="' + r + '" stroke-dasharray="' + c.toFixed(1) +
      '" stroke-dashoffset="' + offset.toFixed(1) + '"></circle></svg>' +
      '<div class="donut-center"><div class="dv">' + pct + "%</div><div class=\"sub\">已接入</div></div></div>" +
      '<div class="chart-legend">' +
      '<span><span class="tag tag-success">已接入 ' + live + "</span></span>" +
      '<span><span class="tag tag-warning">需改造 ' + ext + "</span></span>" +
      '<span><span class="tag tag-off">待建设 ' + countBy(children, "new") + "</span></span>" +
      "</div></div></div></div>"
    );
  }

  function renderTable(children) {
    var rows = children.map(function (c) {
      var s = srcOf(c.source);
      return (
        '<tr data-cap="' + esc(c.id) + '" data-search="' + esc((c.label + " " + (c.endpoint || "") + " " + (c.group || "")).toLowerCase()) + '">' +
        '<td><input type="checkbox"></td>' +
        '<td class="tbl-name">' + esc(c.label) +
        (c.desc ? '<div class="sub">' + esc(c.desc) + "</div>" : "") + "</td>" +
        "<td>" + esc(c.group || "—") + "</td>" +
        '<td><span class="tag ' + s.tag + '">' + s.text + "</span></td>" +
        '<td><div class="progress progress-thin" style="width:84px"><div class="progress-bar" style="width:' + s.pct + '%"></div></div></td>' +
        '<td class="tbl-endpoint">' + esc(c.endpoint || "—") + "</td>" +
        "<td>" + esc(c.ai || "无") + "</td>" +
        "</tr>"
      );
    }).join("");

    return (
      '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
      '<span class="strong">能力清单</span>' +
      '<span class="sub" id="capCount">' + children.length + " 项</span>" +
      '<span class="spacer"></span>' +
      '<span class="sub">点击表头可排序 · 勾选可批量标记</span>' +
      "</div>" +
      '<table class="table table-stripe"><thead><tr>' +
      '<th style="width:36px"><input type="checkbox" data-select-all></th>' +
      '<th data-sort>能力</th><th data-sort>分组</th><th data-sort>状态</th>' +
      '<th>建设度</th><th>端点</th><th>AI 依赖</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>"
    );
  }

  function renderSeg(mod) {
    return (
      '<div data-seg style="margin-top:var(--sp-5)">' +
      '<div class="seg">' +
      '<button class="seg-item is-on" type="button" data-seg-panel="caps"><span data-icon="grid"></span>能力清单</button>' +
      '<button class="seg-item" type="button" data-seg-panel="run"><span data-icon="bar-chart"></span>运行记录</button>' +
      '<button class="seg-item" type="button" data-seg-panel="model"><span data-icon="box"></span>模型资产</button>' +
      "</div>" +
      '<div data-seg-view="caps" style="margin-top:var(--sp-4)"></div>' +
      '<div data-seg-view="run" style="margin-top:var(--sp-4)" hidden></div>' +
      '<div data-seg-view="model" style="margin-top:var(--sp-4)" hidden></div>' +
      "</div>"
    );
  }

  function renderModule(mod, childId) {
    var children = childrenOf(mod);
    var content = document.getElementById("content");
    var live = countBy(children, "existing");

    content.innerHTML =
      renderHead(mod, children) +
      '<div class="stat-grid" style="margin-bottom:var(--sp-4)">' +
      statCard("grid", "能力项", children.length, "当前角色可见的二级功能") +
      statCard("check-circle", "已接入", live, "后端已有真实接口支撑") +
      statCard("alert-triangle", "待建设", countBy(children, "new"), "菜单已列、接口未落地") +
      statCard("zap", "场景任务", 0, "读取中…") +
      "</div>" +
      renderCharts(mod, children) +
      (mod.id === "vision" ? renderLab() : "") +
      (mod.id === "review" ? renderWorkbench() : "") +
      renderSeg(mod);

    var capView = content.querySelector('[data-seg-view="caps"]');
    capView.innerHTML = renderTable(children);
    window.Hifi.mount(content);

    // 分模块加载真实运行数据（失败给告警条，不填假数据）
    loadRunView(mod);
    loadModelAssets();
    if (mod.id === "vision") { bindLab(); loadScanPane(); }
    if (mod.id === "review") { bindWorkbench(); }

    var btn = document.getElementById("btnReload");
    if (btn) btn.addEventListener("click", function () { route(); });

    if (childId) focusChild(childId);
  }

  // ------------------------------------------------------------
  // 运行记录（分模块取真实数据）
  // ------------------------------------------------------------

  function loadRunView(mod) {
    var view = document.querySelector('[data-seg-view="run"]');
    if (!view) return;
    view.innerHTML = '<div class="spinner-center"><span class="spinner"></span></div>';

    if (mod.id === "vision") {
      api("/api/vision/overview")
        .then(function (res) {
          var d = dataOf(res);
          view.innerHTML =
            '<div class="stat-grid" style="margin-bottom:var(--sp-4)">' +
            statCard("layers", "任务总数", d.taskTotal || 0, "视觉分析任务累计") +
            statCard("bell", "事件总数", d.eventTotal || 0, "识别出的结构化事件") +
            statCard("alert-triangle", "待确认", d.unacknowledged || 0, "教师尚未确认的事件") +
            statCard("clock", "占位任务", (d.placeholdersInUse || []).length, "由占位实现产出的结果，勿作结论") +
            "</div>" +
            '<div class="card"><div class="card-hd"><div class="card-title">场景任务分布</div>' +
            '<div class="card-sub">数据源 GET /api/vision/overview</div></div>' +
            '<div class="card-bd">' + sceneBars(d.scenes || []) + "</div></div>";
          window.Hifi.mount(view);
        })
        .catch(function (err) {
          view.innerHTML = alertHtml("danger", "运行数据读取失败", String(err.message || err));
        });
      return;
    }

    if (mod.id === "review") {
      api("/api/review/overview")
        .then(function (res) {
          var d = dataOf(res);
          view.innerHTML =
            '<div class="stat-grid">' +
            statCard("bookmark", "课程", d.courseCount || 0, "我任教的课程") +
            statCard("file", "作业", d.assignmentCount || 0, "已发布作业") +
            statCard("users", "提交", d.submissionCount || 0, "学生提交总数") +
            statCard("check", "已批改", d.gradedCount || 0, "平均分 " + (d.averageScore == null ? "—" : d.averageScore)) +
            "</div>" +
            '<div class="card" style="margin-top:var(--sp-4)"><div class="card-bd">' +
            '<dl class="kv">' +
            "<dt>待批改</dt><dd>" + (d.pendingCount || 0) + "</dd>" +
            "<dt>扫描任务</dt><dd>" + (d.scanTaskCount || 0) + "（待处理 " + (d.scanPendingCount || 0) + "）</dd>" +
            "<dt>视觉后端</dt><dd>" + esc(d.visionBackend || "—") +
            (d.visionIsPlaceholder ? ' <span class="tag tag-warning">占位</span>' : "") + "</dd>" +
            "</dl></div></div>";
          window.Hifi.mount(view);
        })
        .catch(function (err) {
          view.innerHTML = alertHtml("danger", "评阅数据读取失败", String(err.message || err));
        });
      return;
    }

    view.innerHTML = emptyHtml(
      "该通道尚无运行数据源",
      "能力清单已按角色列出，但目前没有对接到可查询的运行记录接口。先完成服务端接口后再启用本页。"
    );
    window.Hifi.mount(view);
  }

  function sceneBars(scenes) {
    if (!scenes.length) return emptyHtml("暂无场景", "接口未返回场景数据");
    var html = scenes.map(function (s) {
      return (
        '<div class="list-item"><div class="li-main">' +
        '<div class="li-title">' + esc(s.label) + "</div>" +
        '<div class="li-desc">' + esc(s.description || s.value) + "</div></div>" +
        '<div class="li-meta"><span class="tag tag-outline">' + esc(s.value) + "</span></div></div>"
      );
    }).join("");
    return '<div class="list">' + html + "</div>";
  }

  // ------------------------------------------------------------
  // 模型资产
  // ------------------------------------------------------------

  function loadModelAssets() {
    var view = document.querySelector('[data-seg-view="model"]');
    if (!view) return;
    view.innerHTML = '<div class="spinner-center"><span class="spinner"></span></div>';
    api("/api/vision/models")
      .then(function (res) {
        var d = dataOf(res);
        var assets = d.assets || [];
        var rows = assets.map(function (a) {
          return (
            "<tr><td class=\"tbl-name\">" + esc(a.name) +
            '<div class="sub">' + esc(a.assetCode) + "</div></td>" +
            "<td>" + esc(a.capability) + "</td>" +
            "<td>" + esc(a.framework || "—") + " " + esc(a.version || "") + "</td>" +
            "<td>" + (a.isPlaceholder ? '<span class="tag tag-warning">占位</span>' : '<span class="tag tag-success">真实</span>') + "</td>" +
            "<td>" + (a.enabled ? '<span class="tag tag-info">启用</span>' : '<span class="tag tag-off">停用</span>') + "</td>" +
            '<td class="tbl-endpoint">' + esc(a.weightsPath || "内置") + "</td></tr>"
          );
        }).join("");
        view.innerHTML =
          '<div class="table-wrap"><div class="table-toolbar"><span class="strong">模型资产</span>' +
          '<span class="sub">' + assets.length + " 条</span><span class=\"spacer\"></span>" +
          '<span class="sub">替换步骤见项目根目录《模型接入清单.md》</span></div>' +
          '<table class="table table-stripe"><thead><tr>' +
          '<th data-sort>名称</th><th data-sort>能力</th><th>框架</th><th data-sort>实现</th><th>状态</th><th>权重</th>' +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>";
        window.Hifi.mount(view);
      })
      .catch(function (err) {
        view.innerHTML = alertHtml("danger", "模型资产读取失败", String(err.message || err));
      });
  }

  // ------------------------------------------------------------
  // 视觉模块：场景试跑
  // ------------------------------------------------------------

  var SCENES = [];

  function renderLab() {
    return (
      '<div class="card" style="margin-top:var(--sp-4)">' +
      '<div class="card-hd"><div class="card-title">场景试跑</div>' +
      '<div class="card-sub">提交一次真实分析任务，验证链路是否连通</div></div>' +
      '<div class="card-bd">' +
      '<div class="grid">' +
      '<div class="col-4"><div class="field"><label class="field-label">场景</label>' +
      '<div class="select-wrap"><select class="select" id="labScene"><option>加载中…</option></select></div></div></div>' +
      '<div class="col-4"><div class="field"><label class="field-label">素材路径</label>' +
      '<input class="input" id="labSource" value="data/samples/lab.jpg" placeholder="data/samples/xx.jpg"></div></div>' +
      '<div class="col-4"><div class="field"><label class="field-label">置信度阈值 <b class="num" id="labConfVal">0.30</b></label>' +
      '<input class="slider" type="range" id="labConf" min="0.05" max="0.9" step="0.05" value="0.3"></div></div>' +
      "</div>" +
      '<div class="row" style="margin-top:var(--sp-3);gap:var(--sp-2)">' +
      '<button class="btn btn-primary" type="button" id="labRun"><span data-icon="play"></span>提交分析</button>' +
      '<span class="sub" id="labHint">提交后由服务端调度模型层执行，结果原样回显</span>' +
      "</div>" +
      '<div id="labResult" style="margin-top:var(--sp-4)"></div>' +
      "</div></div>"
    );
  }

  function bindLab() {
    var sel = document.getElementById("labScene");
    var conf = document.getElementById("labConf");
    var confVal = document.getElementById("labConfVal");
    var run = document.getElementById("labRun");

    api("/api/vision/scenes")
      .then(function (res) {
        SCENES = dataOf(res) || [];
        if (Array.isArray(SCENES) && SCENES.length) {
          sel.innerHTML = SCENES.map(function (s) {
            return '<option value="' + esc(s.value) + '">' + esc(s.label) + "</option>";
          }).join("");
        }
      })
      .catch(function () {});

    conf.addEventListener("input", function () {
      confVal.textContent = Number(conf.value).toFixed(2);
    });

    run.addEventListener("click", function () {
      var body = {
        scene: sel.value,
        source_ref: document.getElementById("labSource").value,
        conf: Number(conf.value)
      };
      var out = document.getElementById("labResult");
      out.innerHTML = '<div class="spinner-center"><span class="spinner"></span></div>';
      run.disabled = true;
      var label = run.innerHTML;
      var t0 = Date.now();
      var timer = setInterval(function () {
        run.innerHTML = '<span data-icon="clock"></span>运行中 ' + ((Date.now() - t0) / 1000).toFixed(1) + "s";
      }, 100);

      api("/api/vision/tasks", { method: "POST", body: body })
        .then(function (res) {
          var d = dataOf(res);
          out.innerHTML = taskResultHtml(d);
          window.Hifi.mount(out);
          fillTaskEvents(d.taskCode || d.task_code, out);
          loadNotif();
        })
        .catch(function (err) {
          out.innerHTML = alertHtml("danger", "任务提交失败", String(err.message || err));
        })
        .then(function () {
          clearInterval(timer);
          run.innerHTML = label;
          run.disabled = false;
          window.Hifi.mount(run);
        });
    });
  }

  // 任务返回的是「任务记录」（result 字段多数为空），结构化结果在事件流里，
  // 所以这里如实展示任务信息，再异步把该任务的事件拉回来渲染，不做任何补全。
  function taskResultHtml(d) {
    var code = d.taskCode || d.task_code || "";
    var st = (d.status || "").toLowerCase();
    var tagCls = st === "succeeded" ? "tag-success" : (st === "failed" ? "tag-danger" : "tag-info");
    return (
      '<div class="alert alert-' + (d.isPlaceholder ? "warning" : "info") + '">' +
      '<span class="a-ic" data-icon="' + (d.isPlaceholder ? "alert-triangle" : "check-circle") + '"></span>' +
      "<div><div class=\"a-title\">" +
      (d.isPlaceholder ? "占位实现产出：结构与真实模型一致，数值不作为结论" : "真实模型产出") +
      '</div><div class="a-body">实现 ' + esc(d.provider || "—") +
      " · 模型 " + esc(d.modelName || d.model_name || "—") +
      " · 耗时 " + (d.latencyMs == null ? "—" : Number(d.latencyMs).toFixed(1) + "ms") + "</div></div></div>" +
      '<div class="card" style="margin-top:var(--sp-4)"><div class="card-bd">' +
      '<dl class="kv">' +
      "<dt>任务号</dt><dd class=\"num\">" + esc(code) + ' <span class="tag ' + tagCls + '">' + esc(d.status || "—") + "</span></dd>" +
      "<dt>场景</dt><dd>" + esc(d.scene || "—") + "</dd>" +
      "<dt>素材</dt><dd>" + esc(d.sourceRef || d.source_ref || "—") + "</dd>" +
      "<dt>进度</dt><dd>" + '<div class="progress progress-thin" style="width:160px"><div class="progress-bar" style="width:' +
      (d.progress || 0) + '%"></div></div></dd>' +
      "</dl>" +
      '<div id="taskEvents" style="margin-top:var(--sp-3)"></div>' +
      "</div></div>"
    );
  }

  function fillTaskEvents(code, out) {
    if (!code || !out) return;
    var box = document.getElementById("taskEvents");
    if (!box) return;
    box.innerHTML = '<div class="spinner-center"><span class="spinner"></span></div>';
    api("/api/vision/events?limit=40")
      .then(function (res) {
        var list = dataOf(res) || [];
        var mine = list.filter(function (e) { return (e.taskCode || e.task_code) === code; });
        if (!mine.length) {
          box.innerHTML = emptyHtml("该任务未产生事件", "占位实现按素材哈希确定性产出；换素材或调低阈值再试");
          return;
        }
        var blocks = mine.map(function (e, i) {
          return (
            '<div class="blk"><div class="bk-no">#' + (i + 1) + "</div>" +
            '<div class="bk-cls">' + esc(e.eventLabel || e.event_label || e.eventType || e.event_type) + "</div>" +
            '<div class="progress progress-thin"><div class="progress-bar" style="width:' +
            Math.round((e.confidence || 0) * 100) + '%"></div></div>' +
            '<div class="sub num" style="margin-top:4px">conf ' +
            (e.confidence == null ? "—" : Number(e.confidence).toFixed(3)) + "</div>" +
            '<div class="sub"><span class="tag ' + (SEV_TAG[e.severity] || "tag-off") + '">' +
            (SEV_TEXT[e.severity] || e.severity) + "</span></div></div>"
          );
        }).join("");
        box.innerHTML =
          '<div class="sub" style="margin-bottom:8px">本次任务产出 ' + mine.length + " 条事件</div>" +
          '<div class="blk-grid">' + blocks + "</div>";
        window.Hifi.mount(box);
      })
      .catch(function () {
        box.innerHTML = emptyHtml("事件读取失败", "可在顶栏铃铛图标中重试");
      });
  }

  function loadScanPane() {
    // 试跑结果区初始提示：说明占位与真实后端的区别
    var out = document.getElementById("labResult");
    if (!out) return;
    out.innerHTML =
      '<div class="sub">提示：默认使用占位实现（毫秒级返回）。设置环境变量 MODEL_VISION_BACKEND=yolo-platform 后重启服务，同一页面即可切到 GPU 真实推理。</div>';
  }

  // ------------------------------------------------------------
  // 评阅模块：批改工作台
  // ------------------------------------------------------------

  function renderWorkbench() {
    return (
      '<div class="card" style="margin-top:var(--sp-4)">' +
      '<div class="card-hd"><div class="card-title">批改工作台</div>' +
      '<div class="card-sub">课程 → 作业 → 提交，逐条确认分数</div></div>' +
      '<div class="card-bd">' +
      '<div class="row row-wrap" style="gap:var(--sp-3)">' +
      '<div class="field" style="min-width:200px"><label class="field-label">课程</label>' +
      '<div class="select-wrap"><select class="select" id="wbCourse"><option>加载中…</option></select></div></div>' +
      '<div class="field" style="min-width:240px"><label class="field-label">作业</label>' +
      '<div class="select-wrap"><select class="select" id="wbAssign"><option>请先选课程</option></select></div></div>' +
      '<div class="field" style="align-self:flex-end">' +
      '<button class="btn btn-secondary" type="button" id="wbReload"><span data-icon="refresh"></span>刷新</button></div>' +
      "</div>" +
      '<div id="wbStats" class="stat-grid" style="margin:var(--sp-4) 0"></div>' +
      '<div id="wbTable"><div class="empty"><div class="empty-title">选择课程与作业后加载提交列表</div></div></div>' +
      "</div></div>"
    );
  }

  function bindWorkbench() {
    var cSel = document.getElementById("wbCourse");
    var aSel = document.getElementById("wbAssign");
    var reload = document.getElementById("wbReload");

    api("/api/review/courses")
      .then(function (res) {
        var list = dataOf(res);
        list = Array.isArray(list) ? list : list.items || [];
        if (!list.length) {
          cSel.innerHTML = '<option value="">暂无课程</option>';
          return;
        }
        cSel.innerHTML = list.map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.name || c.title || "课程 " + c.id) + "</option>";
        }).join("");
        loadAssignments(cSel.value);
      })
      .catch(function (err) {
        document.getElementById("wbTable").innerHTML = alertHtml("danger", "课程加载失败", String(err.message || err));
      });

    cSel.addEventListener("change", function () { loadAssignments(cSel.value); });
    aSel.addEventListener("change", function () { loadSubmissions(aSel.value); });
    reload.addEventListener("click", function () { loadSubmissions(aSel.value); });
  }

  function loadAssignments(courseId) {
    var aSel = document.getElementById("wbAssign");
    if (!courseId) return;
    api("/api/review/assignments?course_id=" + encodeURIComponent(courseId))
      .then(function (res) {
        var list = dataOf(res);
        list = Array.isArray(list) ? list : list.items || [];
        if (!list.length) {
          aSel.innerHTML = '<option value="">该课程暂无作业</option>';
          loadSubmissions("");
          return;
        }
        aSel.innerHTML = list.map(function (a) {
          return '<option value="' + esc(a.id) + '">' + esc(a.title) +
            "（" + (a.submission_count == null ? "—" : a.submission_count) + " 份）</option>";
        }).join("");
        loadSubmissions(aSel.value);
      })
      .catch(function (err) {
        document.getElementById("wbTable").innerHTML = alertHtml("danger", "作业加载失败", String(err.message || err));
      });
  }

  function loadSubmissions(assignmentId) {
    var box = document.getElementById("wbTable");
    var stats = document.getElementById("wbStats");
    if (!box) return;
    if (!assignmentId) {
      box.innerHTML = '<div class="empty"><div class="empty-title">请选择一个作业</div></div>';
      return;
    }
    box.innerHTML = '<div class="spinner-center"><span class="spinner"></span></div>';

    api("/api/review/assignments/" + encodeURIComponent(assignmentId) + "/submissions")
      .then(function (res) {
        var list = dataOf(res);
        list = Array.isArray(list) ? list : list.items || [];
        var graded = list.filter(function (s) { return s.status === "GRADED" || s.status === "graded"; }).length;
        var avg = 0, n = 0;
        list.forEach(function (s) { if (s.score != null) { avg += Number(s.score); n++; } });
        stats.innerHTML =
          statCard("users", "提交数", list.length, "本作业学生提交总数") +
          statCard("check", "已批改", graded, "状态为 GRADED 的提交") +
          statCard("clock", "待批改", list.length - graded, "需要教师确认分数") +
          statCard("star", "平均分", n ? Math.round((avg / n) * 10) / 10 : 0, n ? "已批改 " + n + " 份" : "暂无成绩", 1);
        window.Hifi.mount(stats);

        if (!list.length) {
          box.innerHTML = emptyHtml("该作业暂无提交", "学生提交后会出现在这里，带图片附件的提交会自动登记视觉批改任务");
          return;
        }
        var rows = list.map(function (s) {
          var done = s.status === "GRADED" || s.status === "graded";
          return (
            "<tr><td class=\"tbl-name\">" + esc(s.student_name || s.studentName || s.student_no || s.studentNo || "学生 " + s.id) + "</td>" +
            "<td>" + esc(s.status || "—") + "</td>" +
            "<td>" + (s.score == null ? '<span class="sub">未批改</span>' : '<b class="num">' + s.score + "</b>") + "</td>" +
            '<td><input class="input" type="number" step="0.5" min="0" style="width:96px" value="' +
            (s.score == null ? "" : s.score) + '" data-score="' + esc(s.id) + '"></td>' +
            "<td>" + (done ? '<span class="tag tag-success">已批改</span>' : '<span class="tag tag-off">待批改</span>') + "</td>" +
            "<td>" + fmtTime(s.submitted_at || s.submittedAt || s.created_at || s.createdAt) + "</td>" +
            '<td><button class="btn btn-sm btn-primary" type="button" data-grade="' + esc(s.id) + '" ' +
            'data-toast="成绩已写回">写回</button></td></tr>'
          );
        }).join("");
        box.innerHTML =
          '<div class="table-wrap"><table class="table table-stripe"><thead><tr>' +
          '<th data-sort>学生</th><th data-sort>状态</th><th data-sort>当前分</th>' +
          "<th>调整</th><th>进度</th><th data-sort>提交时间</th><th>操作</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>";
        window.Hifi.mount(box);
        bindGradeButtons(assignmentId);
      })
      .catch(function (err) {
        box.innerHTML = alertHtml("danger", "提交列表加载失败", String(err.message || err));
      });
  }

  function bindGradeButtons(assignmentId) {
    var btns = document.querySelectorAll("[data-grade]");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () {
        var sid = b.getAttribute("data-grade");
        var input = document.querySelector('[data-score="' + sid + '"]');
        var score = Number(input.value);
        if (!input.value || isNaN(score)) {
          b.setAttribute("data-toast", "请先填写分数");
          return;
        }
        b.disabled = true;
        api("/api/review/submissions/" + encodeURIComponent(sid) + "/grade", {
          method: "POST",
          body: { score: score, feedback: "" }
        })
          .then(function () {
            b.setAttribute("data-toast", "成绩已写回 " + score);
            loadSubmissions(assignmentId);
          })
          .catch(function (err) {
            b.setAttribute("data-toast", "写回失败：" + (err.message || err));
          })
          .then(function () { b.disabled = false; });
      });
    });
  }

  // ------------------------------------------------------------
  // 抽屉 / 弹窗内容
  // ------------------------------------------------------------

  function loadModelDrawer() {
    var body = document.getElementById("modelDrawerBody");
    api("/api/vision/models")
      .then(function (res) {
        var d = dataOf(res);
        var reg = d.registry || {};
        var html = "";
        Object.keys(reg).forEach(function (cap) {
          var impls = reg[cap] || {};
          html += '<div class="card" style="margin-bottom:var(--sp-4)"><div class="card-hd">' +
            '<div class="card-title">' + esc(cap) + "</div>" +
            '<div class="card-sub">' + Object.keys(impls).length + " 个实现</div></div><div class=\"card-bd\">";
          Object.keys(impls).forEach(function (name) {
            var im = impls[name] || {};
            var isDef = name === (d.defaults && d.defaults[cap]);
            html +=
              '<div class="list-item' + (isDef ? " is-active" : "") + '"><div class="li-main">' +
              '<div class="li-title">' + esc(im.modelName || name) +
              (isDef ? ' <span class="tag tag-brand">默认</span>' : "") +
              (im.isPlaceholder ? ' <span class="tag tag-warning">占位</span>' : ' <span class="tag tag-success">真实</span>') +
              "</div>" +
              '<div class="li-desc">' + esc(name) + " · " + esc(im.modelVersion || "—") +
              " · 超时 " + ((im.policy && im.policy.timeoutMs) || "—") + "ms" +
              " · 重试 " + ((im.policy && im.policy.maxAttempts) || "—") + " 次</div></div>" +
              '<div class="li-meta">' + (im.circuit && im.circuit.open
                ? '<span class="tag tag-danger">熔断</span>'
                : '<span class="tag tag-off">正常</span>') + "</div></div>";
          });
          html += "</div></div>";
        });
        body.innerHTML = html || emptyHtml("注册表为空", "接口未返回模型实现");
        window.Hifi.mount(body);
      })
      .catch(function (err) {
        body.innerHTML = alertHtml("danger", "模型注册表读取失败", String(err.message || err));
      });
  }

  function loadEventDrawer() {
    var body = document.getElementById("eventDrawerBody");
    api("/api/vision/events?limit=40")
      .then(function (res) {
        var list = dataOf(res) || [];
        if (!list.length) {
          body.innerHTML = emptyHtml("暂无事件", "提交一次场景试跑后，识别结果会以事件形式写入这里");
          return;
        }
        var items = list.map(function (e) {
          return (
            '<div class="tl-item' + (e.acknowledged ? " done" : "") + '">' +
            '<div class="tl-time num">' + fmtTime(e.createdAt || e.created_at) + "</div>" +
            '<div class="tl-title">' + esc(e.eventLabel || e.event_label || e.eventType || e.event_type) +
            ' <span class="tag ' + (SEV_TAG[e.severity] || "tag-off") + '">' + (SEV_TEXT[e.severity] || e.severity) + "</span>" +
            (e.acknowledged ? ' <span class="tag tag-off">已确认</span>' : "") + "</div>" +
            '<div class="tl-desc">' + esc(e.scene || "") + " · " + esc(e.taskCode || e.task_code || "") +
            (e.confidence != null ? " · conf " + Number(e.confidence).toFixed(3) : "") + "</div></div>"
          );
        }).join("");
        body.innerHTML = '<div class="timeline">' + items + "</div>";
        window.Hifi.mount(body);
      })
      .catch(function (err) {
        body.innerHTML = alertHtml("danger", "事件读取失败", String(err.message || err));
      });
  }

  // ------------------------------------------------------------
  // 通用片段
  // ------------------------------------------------------------

  function alertHtml(kind, title, body) {
    return (
      '<div class="alert alert-' + kind + '">' +
      '<span class="a-ic" data-icon="' + (kind === "danger" ? "x-circle" : "info") + '"></span>' +
      '<div><div class="a-title">' + esc(title) + "</div>" +
      '<div class="a-body">' + esc(body) + "</div></div></div>"
    );
  }

  function emptyHtml(title, desc) {
    return (
      '<div class="empty"><div class="empty-title">' + esc(title) + "</div>" +
      '<div class="empty-desc">' + esc(desc) + "</div></div>"
    );
  }

  // ------------------------------------------------------------
  // 路由
  // ------------------------------------------------------------

  function focusChild(childId) {
    var row = document.querySelector('[data-cap="' + childId + '"]');
    if (!row) return;
    row.style.background = "var(--brand-50)";
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderNotFound(hash) {
    document.getElementById("content").innerHTML =
      alertHtml("warning", "未找到通道：" + hash, "该模块不存在，或当前角色无权访问。");
  }

  function route() {
    var hash = (location.hash || "").replace(/^#\/?/, "");
    var parts = hash.split("/").filter(Boolean);
    if (!parts.length) {
      if (state.modules.length) location.hash = "#/" + state.modules[0].id;
      return;
    }
    var mod = findMod(parts[0]);
    if (!mod) { renderNotFound(hash); return; }
    highlight(mod.id);
    scrollContentTop();
    renderModule(mod, parts[1]);
  }

  // ------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------

  function bindGlobal() {
    var search = document.getElementById("searchInput");
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      state.filter = q;
      var rows = document.querySelectorAll("#content tbody tr[data-search]");
      var shown = 0;
      Array.prototype.forEach.call(rows, function (tr) {
        var hit = !q || tr.getAttribute("data-search").indexOf(q) >= 0;
        tr.hidden = !hit;
        if (hit) shown++;
      });
      var c = document.getElementById("capCount");
      if (c) c.textContent = shown + " 项" + (q ? "（已过滤）" : "");
    });

    document.getElementById("umLogout").addEventListener("click", logout);
    document.getElementById("umRole").addEventListener("click", function () {
      var m = PERM.matrix ? PERM.matrix() : null;
      this.setAttribute("data-toast", m ? "当前角色可访问 " + state.modules.length + " 个通道" : "权限矩阵未加载");
    });

    document.getElementById("btnModels").addEventListener("click", loadModelDrawer);
    document.getElementById("btnNotif").addEventListener("click", function () {
      loadEventDrawer();
      loadNotif();
    });

    // 回到顶部：主滚动容器是 document；.content 曾是滚动容器，双保险兼容
    var backTop = document.getElementById("backTop");
    if (backTop) {
      var onScroll = function () {
        var y = window.scrollY || document.documentElement.scrollTop || 0;
        var c = document.querySelector(".content");
        if (c && c.scrollTop > y) y = c.scrollTop;
        backTop.classList.toggle("is-on", y > 320);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      var sc = document.querySelector(".content");
      if (sc) sc.addEventListener("scroll", onScroll, { passive: true });
      backTop.addEventListener("click", function () {
        window.scrollTo({ top: 0, behavior: "smooth" });
        var c = document.querySelector(".content");
        if (c) c.scrollTo({ top: 0, behavior: "instant" });
      });
    }
  }

  // 切换通道时把页面滚回顶部：否则新页面会停在上一页的滚动位置，
  // 看起来像"页面是空的 / 下面的内容没加载出来"。
  function scrollContentTop() {
    window.scrollTo({ top: 0, behavior: "instant" });
    var scroller = document.querySelector(".content");
    var backTop = document.getElementById("backTop");
    if (scroller && scroller.scrollTop) scroller.scrollTop = 0;
    if (backTop) backTop.classList.remove("is-on");
  }

  function boot() {
    if (!token()) {
      window.location.href = LOGIN_URL;
      return;
    }
    state.role = (localStorage.getItem("role") || "").toUpperCase();
    state.username = localStorage.getItem("username") || "";
    state.displayName = localStorage.getItem("displayName") || state.username;
    state.modules = PERM.visibleModules(state.role, MENU);

    if (!state.modules.length) {
      document.getElementById("content").innerHTML =
        alertHtml("warning", "当前角色无可访问通道", "角色 " + state.role + " 未被授权访问任何模块。");
      return;
    }

    renderSidebar();
    renderSideFoot();
    startClock();
    loadBackendChip();
    loadNotif();
    bindGlobal();

    window.addEventListener("hashchange", route);
    route();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

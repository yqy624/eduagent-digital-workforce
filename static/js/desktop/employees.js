/**
 * 数字员工档案（前端配置层）
 * ============================
 *
 * 边界说明（重要，避免误读）
 * --------------------------
 * 后端**没有「员工」实体**。后端的授权维度是**登录角色**（ADMIN / TEACHER /
 * STUDENT），工具白名单写在 `ai/agents/tool_registry.py` 的 `allowed_roles` 里。
 * 前端这 5 名「员工」是**岗位抽象层**：把同一批工具按业务职责重新分组，让
 * 「谁在干活、能干什么」变得可读。
 *
 * 因此本模块可编辑的字段全部落在**展示与语义层**，不伪造后端能力：
 *   - name / role / persona / icon / tint —— 展示
 *   - enabled（启停）—— 前端是否把该岗位计入协作面
 *   - writePolicy —— 岗位的写操作策略说明（真实写权限仍由后端 role 决定）
 *   - tools —— 该岗位**职责范围内**的工具名（来自 /api/knowledge/tools 的真实清单）
 *   - order —— 名册排序
 *
 * 持久化用 localStorage（键 ea.employees），存的是**覆盖层**：默认档案是基线，
 * 本地只记录被改动过的字段。这样升级默认值时，未被用户改过的字段能跟着更新。
 *
 * 文案铁律（本模块 + app.js + desktop.html 共同遵守）
 * ------------------------------------------------
 * 用户可见的每一个字都要「面向使用者」，不得出现实现细节：接口路径、字段名、
 * 工具名、版本号、运行编号、状态枚举、存储键、内部模块名一律只在代码里出现，
 * 界面上换成业务白话。回归检查见 scripts/check_prototype.py 与
 * scripts/smoke_desktop_dom.mjs 的「禁用词」扫描。
 */

export const STORAGE_KEY = "ea.employees";

/**
 * 工具名 → 用户能看懂的一句「这位员工能帮你做的事」。
 *
 * 这是**显示层**：键必须与后端 tool_registry 的 11 个工具逐字一致（改名会让
 * 弹窗勾选失配），值是人话。界面上永远只出现值，不出现键。
 */
export const TOOL_LABELS = {
  get_course_overview: "查看课程信息",
  get_course_assignments: "查看作业清单",
  retrieve_course_material: "检索课程资料",
  get_my_grades: "查看我的成绩",
  get_my_submissions: "查看我的提交",
  analyze_learning_gaps: "找出薄弱知识点",
  generate_learning_plan: "制定学习计划",
  get_course_statistics: "查看课程统计",
  send_notification: "给学生发通知",
  publish_assignment: "发布作业",
  submit_assignment: "替我提交作业",
};

/** 会改动数据的工具（用户必须点头才执行）。与后端 requires_confirmation 同名单。 */
export const TOOL_NEEDS_CONFIRM = [
  "send_notification",
  "publish_assignment",
  "submit_assignment",
];

/** 该工具是否需要用户先确认（显示层用；真实闸门在后端）。 */
export function toolNeedsConfirm(name) {
  return TOOL_NEEDS_CONFIRM.indexOf(name) >= 0;
}

/** 可选图标（全部来自 hifi.js 的图标词汇表，勿填未注册名）。 */
export const ICON_CHOICES = [
  "message", "edit", "scan", "trending-up", "shield", "users",
  "search", "bell", "layers", "bookmark", "file", "grid",
];

/** 可选主题色（对应 employee-ui.css 的 .emp-avatar.emp-aN）。 */
export const TINT_CHOICES = [
  { value: "", label: "品牌蓝" },
  { value: "emp-a2", label: "琥珀" },
  { value: "emp-a3", label: "青" },
  { value: "emp-a4", label: "紫" },
  { value: "emp-a5", label: "绿" },
];

/**
 * 「涉及改动时」的选项。值是内部枚举（改不得），标签是给用户看的一句话。
 */
export const WRITE_POLICIES = [
  { value: "read", label: "只看不改" },
  { value: "write-event", label: "只记录发现，不改成绩" },
  { value: "write-gate", label: "改动前先问我" },
];

export function writePolicyLabel(value) {
  const hit = WRITE_POLICIES.filter(function (x) { return x.value === value; })[0];
  return hit ? hit.label : "只看不改";
}

export function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

export function tintLabel(value) {
  const hit = TINT_CHOICES.filter(function (x) { return x.value === value; })[0];
  return hit ? hit.label : "品牌蓝";
}

/**
 * 默认档案。code 是主键，不可编辑。
 *
 * persona / domain 都是**给用户看的白描**：写「它替你做什么」，不写实现
 * （不提模型、知识库、规则引擎、数据结构这类内部概念）。
 */
export const DEFAULT_EMPLOYEES = [
  {
    code: "knowledge",
    name: "知问",
    role: "答疑员工",
    persona:
      "回答学生关于课程和作业的问题，每条答案都附上资料出处；资料里没有的会直说找不到，不会编。",
    domain: "课程资料、常见问题",
    icon: "message",
    tint: "",
    enabled: true,
    writePolicy: "read",
    tools: ["get_course_overview", "get_course_assignments", "retrieve_course_material"],
    order: 1,
  },
  {
    code: "review",
    name: "笔正",
    role: "批改员工",
    persona:
      "对照评分标准逐题看学生的作答，给出各题得分、错因和评语；最终成绩要你确认后才计入。",
    domain: "学生提交的作业、评分标准",
    icon: "edit",
    tint: "emp-a2",
    enabled: true,
    writePolicy: "write-gate",
    tools: ["get_course_assignments", "get_course_statistics"],
    order: 2,
  },
  {
    code: "vision",
    name: "明察",
    role: "视觉员工",
    persona:
      "盯着课堂、实验室、作业和考试的影像，发现异常第一时间告诉你；只负责发现，怎么处理由你定。",
    domain: "课堂与实验室的影像记录",
    icon: "scan",
    tint: "emp-a3",
    enabled: true,
    writePolicy: "write-event",
    tools: ["retrieve_course_material"],
    order: 3,
  },
  {
    code: "insight",
    name: "知微",
    role: "学情员工",
    persona:
      "把成绩、课堂表现和作业情况汇总起来，找出薄弱环节并给出改进建议，不替你下结论。",
    domain: "成绩、课堂表现、作业情况",
    icon: "trending-up",
    tint: "emp-a4",
    enabled: true,
    writePolicy: "read",
    tools: [
      "get_my_grades",
      "get_my_submissions",
      "analyze_learning_gaps",
      "generate_learning_plan",
      "get_course_statistics",
    ],
    order: 4,
  },
  {
    code: "situation",
    name: "守则",
    role: "督导员工",
    persona:
      "按你设定的条件留意异常，需要时通知你和学生，同一条提醒不会重复打扰。",
    domain: "异常提醒、通知记录",
    icon: "shield",
    tint: "emp-a5",
    enabled: true,
    writePolicy: "write-gate",
    tools: ["send_notification", "get_course_statistics"],
    order: 5,
  },
];

const NEW_EMPLOYEE_DEFAULTS = {
  name: "",
  role: "自定义岗位",
  persona: "",
  domain: "",
  icon: "users",
  tint: "",
  enabled: false,
  writePolicy: "read",
  tools: [],
  order: 99,
};

function readRaw() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeRaw(list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (_) {
    return false;
  }
}

function defaultByCode(code) {
  return (
    DEFAULT_EMPLOYEES.filter(function (d) { return d.code === code; })[0] || null
  );
}

/**
 * 读出生效档案 = 默认基线 ⊕ 本地覆盖层 ⊕ 本地新增。
 * 默认值更新后，未被用户改过的字段会自动跟随（因为覆盖层只存改过的键）。
 */
export function loadEmployees() {
  const stored = readRaw();
  const overrides = {};
  const extras = [];
  stored.forEach(function (e) {
    if (!e || typeof e !== "object" || !e.code) return;
    if (defaultByCode(e.code)) overrides[e.code] = e;
    else extras.push(Object.assign({}, NEW_EMPLOYEE_DEFAULTS, e));
  });

  const merged = DEFAULT_EMPLOYEES.map(function (d) {
    return Object.assign({}, d, overrides[d.code] || {});
  });
  extras.forEach(function (e) { merged.push(e); });

  return merged.sort(function (a, b) {
    return (a.order || 99) - (b.order || 99);
  });
}

/** 把「与默认不同的字段」写进覆盖层。未改动的键不落盘，便于默认值升级。 */
export function saveEmployees(list) {
  const payload = [];
  list.forEach(function (e) {
    if (!e || !e.code) return;
    const base = defaultByCode(e.code);
    if (!base) {
      payload.push(e);
      return;
    }
    const diff = {};
    let changed = false;
    Object.keys(e).forEach(function (k) {
      if (k === "code") return;
      const a = Array.isArray(e[k]) ? JSON.stringify(e[k]) : e[k];
      const b = Array.isArray(base[k]) ? JSON.stringify(base[k]) : base[k];
      if (a !== b) {
        diff[k] = e[k];
        changed = true;
      }
    });
    if (changed) payload.push(Object.assign({ code: e.code }, diff));
  });
  return writeRaw(payload);
}

export function upsertEmployee(list, emp) {
  const next = list.slice();
  const idx = next.map(function (x) { return x.code; }).indexOf(emp.code);
  if (idx >= 0) next[idx] = Object.assign({}, next[idx], emp);
  else next.push(Object.assign({}, NEW_EMPLOYEE_DEFAULTS, emp));
  return next.sort(function (a, b) { return (a.order || 99) - (b.order || 99); });
}

export function removeEmployee(list, code) {
  return list.filter(function (e) { return e.code !== code; });
}

export function resetEmployees() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

/** 该 code 是否是内置员工（内置的只能编辑不能删除）。 */
export function isBuiltin(code) {
  return !!defaultByCode(code);
}

export function makeEmployee(input) {
  const code = String(input.code || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return Object.assign({}, NEW_EMPLOYEE_DEFAULTS, input, { code: code });
}

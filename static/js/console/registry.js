/**
 * 能力注册表。
 *
 * 数据源 = /static/js/menu.config.js（项目已有的、逐条对照过端点的映射表），
 * 本文件只做规范化，不复制一份新的清单 —— 两份清单必然漂移。
 * 规范化内容：
 *   · 端点字符串 → { method, path }（仅内部寻址用，不进界面）
 *   · 角色 → 可见性裁剪（admin 全量可见）
 *   · 模块图标与排序
 *
 * 文案铁律
 * --------
 * 注册表里的 `label` / `desc` 会被直接渲染给用户，因此只写「用户能得到什么」，
 * 不写实现状态。历史上有过的「建设进度（已接入 / 需改造 / 待建设）」「AI 依赖
 * （强依赖 YOLO / 依赖大模型 / 向量检索）」两套标签已移除：那是给研发排期看的，
 * 对使用者零价值，反而暴露了平台还在搭建中。
 */

const MENU = (typeof window !== "undefined" && window.PLATFORM_MENU) || { modules: [] };

const MODULE_ICON = {
  vision: "scan",
  review: "pen",
  insight: "chart",
  knowledge: "wand",
  situation: "broadcast",
  governance: "sliders",
};

const MODULE_ORDER = ["vision", "review", "insight", "knowledge", "situation", "governance"];

function parseEndpoint(str) {
  if (!str) return { method: "", path: "" };
  const s = String(str).trim();
  const sp = s.indexOf(" ");
  if (sp < 0) return { method: "", path: s };
  return { method: s.slice(0, sp).toUpperCase(), path: s.slice(sp + 1) };
}

function normRole(r) {
  return String(r || "").toUpperCase();
}

function childView(c, mod) {
  const ep = parseEndpoint(c.endpoint);
  return {
    id: c.id,
    module: mod.id,
    label: c.label,
    tab: c.tab || c.id,
    group: c.group || "其他",
    desc: c.desc || "",
    endpoint: c.endpoint || "",
    method: ep.method,
    path: ep.path,
    /** 该能力背后是否已有可用接口（决定页面直接取数还是提示「请在业务页完成」） */
    available: c.source === "existing",
    roles: c.roles || [],
  };
}

const modules = (MENU.modules || [])
  .slice()
  .sort((a, b) => MODULE_ORDER.indexOf(a.id) - MODULE_ORDER.indexOf(b.id))
  .map((m) => ({
    id: m.id,
    label: m.label,
    icon: MODULE_ICON[m.id] || "grid",
    note: m.note || "",
    roles: m.roles || [],
    children: (m.children || []).map((c) => childView(c, m)),
  }));

export const registry = {
  meta: MENU.meta || {},
  modules,
  all() { return modules; },
  get(id) { return modules.find((m) => m.id === id) || null; },
  child(moduleId, childId) {
    const m = this.get(moduleId);
    return m ? m.children.find((c) => c.id === childId) || null : null;
  },
  findByPath(path) {
    for (const m of modules) for (const c of m.children) if (c.path === path) return { module: m, child: c };
    return null;
  },
  visibleModules(role) {
    const r = normRole(role);
    return modules.filter((m) => {
      if (r === "ADMIN") return true;
      const roles = (m.children || []).flatMap((c) => c.roles || []).concat(m.roles || []);
      return roles.indexOf(r.toLowerCase()) >= 0;
    });
  },
  visibleChildren(role, moduleId) {
    const r = normRole(role);
    const mod = this.get(moduleId);
    if (!mod) return [];
    if (r === "ADMIN") return mod.children;
    return mod.children.filter((c) => !c.roles.length || c.roles.indexOf(r.toLowerCase()) >= 0);
  },
  /** 当前角色在某模块下可用的能力（用于导航与列表） */
  canWrite(role, moduleId) {
    const r = normRole(role);
    if (r === "ADMIN") return true;
    if (r === "TEACHER") return ["vision", "review", "insight", "knowledge", "situation"].indexOf(moduleId) >= 0;
    return false;
  },
};

export default registry;

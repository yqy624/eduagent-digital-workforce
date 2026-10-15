/**
 * 角色 × 模块 权限矩阵。
 *
 * 与菜单配置解耦：菜单决定"看得见什么"，这里决定"能做什么"。
 * 后端仍有最终裁决（JWT + RoleChecker），前端这层只用于界面裁剪，
 * 不能作为安全边界。
 */
(function () {
  "use strict";

  var ROLE_MAP = {
    ADMIN: "admin",
    TEACHER: "teacher",
    STUDENT: "student",
    admin: "admin",
    teacher: "teacher",
    student: "student"
  };

  // 每个模块的读写能力。read 决定菜单是否渲染，write 决定操作按钮是否可用。
  var MODULE_ACCESS = {
    vision: { read: ["admin", "teacher"], write: ["admin", "teacher"] },
    review: { read: ["admin", "teacher", "student"], write: ["admin", "teacher"] },
    insight: { read: ["admin", "teacher", "student"], write: ["admin", "teacher"] },
    knowledge: { read: ["admin", "teacher", "student"], write: ["admin", "teacher"] },
    situation: { read: ["admin", "teacher"], write: ["admin", "teacher"] },
    governance: { read: ["admin"], write: ["admin"] }
  };

  function normalizeRole(role) {
    return ROLE_MAP[role] || "student";
  }

  function accessOf(moduleId) {
    return (
      MODULE_ACCESS[moduleId] || { read: ["admin"], write: ["admin"] }
    );
  }

  function canReadModule(role, moduleId) {
    return accessOf(moduleId).read.indexOf(normalizeRole(role)) >= 0;
  }

  function canWriteModule(role, moduleId) {
    return accessOf(moduleId).write.indexOf(normalizeRole(role)) >= 0;
  }

  /**
   * 与菜单配置里的 roles 取交集：配置更细粒度，这里兜底。
   */
  function canAccessChild(role, moduleId, childRoles) {
    var r = normalizeRole(role);
    if (!canReadModule(role, moduleId)) return false;
    // 管理员全量可见：菜单配置里的 roles 列的是"业务使用者"，
    // 不逐个给 admin 补名，否则维护时极易漏项
    if (r === "admin") return true;
    if (!childRoles || !childRoles.length) return true;
    return childRoles.indexOf(r) >= 0;
  }

  function visibleModules(role, menu) {
    var r = normalizeRole(role);
    var modules = (menu && menu.modules) || [];
    return modules.filter(function (mod) {
      if (!canReadModule(role, mod.id)) return false;
      if (r === "admin") return true;
      if (!mod.roles || !mod.roles.length) return true;
      return mod.roles.indexOf(r) >= 0;
    });
  }

  function visibleChildren(role, moduleId, children) {
    return (children || []).filter(function (child) {
      return canAccessChild(role, moduleId, child.roles);
    });
  }

  function matrix() {
    return MODULE_ACCESS;
  }

  window.PLATFORM_PERMISSIONS = {
    normalizeRole: normalizeRole,
    canReadModule: canReadModule,
    canWriteModule: canWriteModule,
    canAccessChild: canAccessChild,
    visibleModules: visibleModules,
    visibleChildren: visibleChildren,
    matrix: matrix
  };
})();

/**
 * 桌面端数据层：把后端接口收成一个模块，视图层只认这里的方法名。
 *
 * 设计要点
 * --------
 * 1. 复用 console/api.js，不另写请求层 —— 它已经处理了本项目最容易踩的三个坑：
 *      响应信封 {code,message,data}、业务失败也返回 HTTP 200、401 自动跳登录。
 * 2. 每个取数函数都过 safe() 包装：单个接口失败只降级这一块，不炸整页。
 *      safe() 返回 { ok, data, error, code }，视图层据此决定渲染数据还是降级态。
 * 3. 路径与方法**逐条实测过**（每个端点用三个角色各打一遍，确认可达性），
 *      不采信 menu.config.js 里的规划清单 —— 那份清单含大量尚未实现的端点。
 *
 * 后端约定（读自 app/middleware/camelcase.py 与 app/schemas/common.py）：
 *   · 响应键被中间件转为小驼峰（displayName / taskTotal / eventBySeverity）；
 *   · 请求体必须保持 snake_case（course_id / student_id）；
 *   · /api/health 是裸对象，无 code 字段，api.js 会原样返回。
 */
import { api, session, loginUrl } from "../console/api.js";

export { session, loginUrl };

/** 把 Promise 收成结果对象，失败不抛，交给调用方降级。 */
async function safe(promise) {
  try {
    const data = await promise;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: (err && err.message) || String(err),
      code: (err && err.code) || 0,
    };
  }
}

/* ============================ 认证 ============================ */

export const auth = {
  /** 当前登录用户档案：{ id, username, displayName, email, studentNo, role } */
  profile: () => safe(api.get("/api/auth/profile")),
  /**
   * 更新个人资料。
   * 请求体保持 snake_case（display_name / email / new_password），响应键由中间件转驼峰。
   * new_password 留空即表示不改密码 —— 传空串会被后端当成"要改成一个空密码"，所以调用方必须过滤掉空值。
   */
  updateProfile: (body) => safe(api.put("/api/auth/profile", body)),
};

/* ============================ 视觉感知中枢（明察） ============================ */

export const vision = {
  /** 总览：taskTotal / taskByStatus / eventTotal / eventBySeverity / unacknowledged / scenes */
  overview: () => safe(api.get("/api/vision/overview")),
  /** 场景字典：4 个（classroom / lab_safety / exam_proctor / paper_grading） */
  scenes: () => safe(api.get("/api/vision/scenes")),
  /** 事件流：[{ id, scene, eventType, eventLabel, severity, confidence, durationS, subjectRef, seatRef, createdAt }] */
  events: (limit) =>
    safe(api.get("/api/vision/events" + (limit ? "?limit=" + limit : ""))),
  /** 身份映射（座位↔学号），用来把 subjectRef 翻成学生名 */
  identities: () => safe(api.get("/api/vision/identities")),
};

/* ============================ 智能评阅（笔正） ============================ */

export const review = {
  /** 总览：courseCount / assignmentCount / submissionCount / pendingCount / averageScore …
   *  注意：该接口只对教师与管理员开放，学生调用会 403 → 由 loadDashboard 按角色跳过。 */
  overview: () => safe(api.get("/api/review/overview")),
  /**
   * 批改质量复核：把「机器初判的结论」与「教师最终给分」摆在一起做对照。
   * 返回 { scopeCourseId, submissionCount, gradedCount, scanCount, scanPlaceholderCount,
   *        needReviewCount, lowConfidenceCount, averageScore, sampleEnough, note }
   * 只对教师与管理员开放；样本不足时 sampleEnough=false —— 此时不硬算比率。
   */
  gradingQuality: (courseId) =>
    safe(
      api.get(
        "/api/review/grading-quality" + (courseId ? "?course_id=" + courseId : "")
      )
    ),
};

/* ============================ 学情洞察（知微） ============================ */

export const insight = {
  /** 总览：studentTotal / submissionTotal / gradedTotal / averageScore / visionEventTotal */
  overview: () => safe(api.get("/api/insight/overview")),
  /** 单个学生画像：{ studentId, courses, grades, lowScoreAssignments, gradeCount, averageScore } */
  studentProfile: (studentId) =>
    safe(api.get("/api/insight/students/" + studentId + "/profile")),
  /** 该生的课堂参与度：{ studentId, studentNo, identityCount, eventTotal, scenes, bySeverity, note }
   *  连接键是业务学号；没有身份映射时 eventTotal 为 0 并给出 note 说明原因，不编造参与度。 */
  studentEngagement: (studentId) =>
    safe(api.get("/api/insight/students/" + studentId + "/engagement")),
};

/* ============================ 态势感知与告警（守则） ============================ */

export const situation = {
  /** 总览：taskTotal / eventTotal / eventBySeverity / unacknowledged / unreadNotifications */
  overview: () => safe(api.get("/api/situation/overview")),
  /** 告警规则：{ implemented, rules:[{ id,name,scene,severity,notifyStudent,notifyRoles,dedupMinutes,enabled }], note } */
  rules: () => safe(api.get("/api/situation/rules")),
  /** 已派发通知（告警消费侧的产物） */
  notifications: () => safe(api.get("/api/situation/notifications")),
};

/* ============================ 通知（全局） ============================ */

export const notifications = {
  list: () => safe(api.get("/api/notifications")),
  unreadCount: () => safe(api.get("/api/notifications/unread-count")),
  markRead: (id) => safe(api.put("/api/notifications/" + id + "/read")),
  markAllRead: () => safe(api.put("/api/notifications/read-all")),
};

/* ============================ Agent 运行时（协作台的底座） ============================ */

export const agent = {
  /**
   * 受控运行时对话：规划 → 工具调用 → 记忆 → 综合。
   * 响应字段：answer / status / plan / executedSteps / citations /
   *          requiresConfirmation / memory / confirmationRequired / runId
   *
   * 注意 status 语义：
   *   COMPLETED    —— 正常完成
   *   NEEDS_INPUT  —— 规划阶段就中止（当前环境未配置 LLM 时会落到这里）
   */
  chat: (question, opts) =>
    safe(
      api.post("/api/knowledge/agent/chat", {
        question,
        course_id: (opts && opts.courseId) || null,
        session_id: (opts && opts.sessionId) || null,
        confirm: !!(opts && opts.confirm),
      })
    ),
  /** 运行记录（含 toolCalls） */
  run: (runId) => safe(api.get("/api/knowledge/runs/" + runId)),
  /** 该次运行的工具调用轨迹 */
  toolCalls: (runId) =>
    safe(api.get("/api/knowledge/runs/" + runId + "/tool-calls")),
  /** 当前登录角色可调用的 Agent 工具清单（数据源与运行时同源） */
  tools: () => safe(api.get("/api/knowledge/tools")),
};

/* ============================ 课程与学生（学情档案的入口） ============================ */

export const teaching = {
  /** 我名下的课程：[{ id, name, schedule, credits, enrolledCount, … }]，教师与管理员可用 */
  courses: () => safe(api.get("/api/teacher/courses")),
  /** 某门课的学生名单：[{ id, username, displayName, email }] */
  courseStudents: (courseId) =>
    safe(api.get("/api/teacher/courses/" + courseId + "/students")),
  /** 我选修的课程（学生视角）。教师/管理员调用不报错，只是返回空列表。 */
  myCourses: () => safe(api.get("/api/student/my-courses")),
  /** 全校课程（管理员视角）：治理模块的「组织架构」里，课程就是班级载体 */
  allCourses: () => safe(api.get("/api/governance/org?page_size=50")),
};

/* ============================ 全局检索（顶栏搜索框） ============================ */

export const search = {
  /**
   * 按角色可见范围检索课程与学生。
   * 返回 { query, total, groups:[{ kind, label, items:[{ id, title, subtitle, target }] }] }
   * target 决定点击后做什么：course → 切换查看范围；student → 打开学情档案。
   */
  query: (q) => safe(api.get("/api/search?q=" + encodeURIComponent(q))),
};

/* ============================ 聚合：一次拉齐首页所需 ============================ */

/**
 * P0/P1 共用的聚合取数。
 * 用 allSettled 语义并发，任何一块失败只标记该块，不影响其余。
 *
 * 两条收敛规则：
 *   1. 只取**确有消费方**的接口 —— 这里每多一项就是每次刷新多一个请求。
 *      平台治理 / 用户管理 / 组织架构这类运维面不在桌面端范围内，故不收；
 *      需要时由管理控制台（static/js/console）自己的数据层去取。
 *   2. 按角色取数：评阅总览只对教师与管理员开放，学生请求会 403，
 *      所以学生直接跳过，不产生一次注定失败的请求。
 */
export async function loadDashboard() {
  const role = String(
    (session && (session.role || (session.user && session.user.role))) || ""
  ).toUpperCase();
  const isStudent = role === "STUDENT";

  const [
    profile,
    visionOverview,
    scenes,
    events,
    identities,
    reviewOverview,
    insightOverview,
    situationOverview,
    rules,
    sitNotifs,
    unread,
  ] = await Promise.all([
    auth.profile(),
    vision.overview(),
    vision.scenes(),
    vision.events(8),
    vision.identities(),
    isStudent ? Promise.resolve(null) : review.overview(),
    insight.overview(),
    situation.overview(),
    situation.rules(),
    situation.notifications(),
    notifications.unreadCount(),
  ]);

  return {
    profile,
    vision: { overview: visionOverview, scenes, events, identities },
    review: { overview: reviewOverview },
    insight: { overview: insightOverview },
    situation: { overview: situationOverview, rules, notifications: sitNotifs },
    notifications: { unread },
  };
}

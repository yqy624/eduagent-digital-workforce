/**
 * 智慧平台菜单配置（能力维度重构版）
 *
 * 设计说明
 * --------
 * 1. 切分维度为「能力」而非「角色」。角色仅通过 roles 字段控制可见性，
 *    不再决定菜单结构 —— 这是本次重构的核心动作。
 * 2. 本文件是纯配置数据，不含渲染逻辑，与页面实现解耦。
 *    现有页面的 nav-item 硬编码可逐步迁移过来，迁移期两者共存。
 * 3. source 字段用于判断改造成本：
 *      existing = 现有端点可直接复用，仅换菜单归属
 *      extend   = 现有端点需扩字段或调整返回结构
 *      new      = 全新建设
 *
 * 约定：只有 label / desc / icon / children / roles 会被渲染给用户。
 *      endpoint / legacy 仅供 `scripts/crosscheck_legacy.py` 校对端点，不进界面。
 *
 * @version 2.0-restructure
 * @date 2026-10-03
 */
window.PLATFORM_MENU = {
  meta: {
    version: "2.0-restructure",
    updatedAt: "2026-10-03",
    // 旧版三端页面（admin/teacher/student dashboard）已于 2026-10-12 下线，控制台为唯一入口
    legacy: {
      admin: ["概览", "用户", "课程", "日志", "活动", "监控"],
      teacher: ["概览", "课程", "学生", "作业", "互评", "评分", "分析", "智慧教育机器人"],
      student: ["概览", "我的课程", "作业", "互评", "成绩"]
    },
  },

  modules: [
    /* ============================================================
     * 1. 视觉感知中枢 —— 平台核心引擎与数据源
     * ============================================================ */
    {
      id: "vision",
      label: "课堂与考场监测",
      en: "Vision Intelligence",
      icon: "fa-solid fa-eye",
      apiPrefix: "/api/vision",
      priority: "P0",
      tier: "核心引擎",
      roles: ["admin", "teacher"],
      note: "课堂、考场与实验室里的画面，在这里变成看得见、可回看的记录。",
      children: [
        {
          id: "vision-overview",
          label: "感知总览",
          tab: "vision-overview",
          endpoint: "GET /api/vision/overview",
          source: "new",
          group: "总览",
          roles: ["admin", "teacher"],
          desc: "今天有哪些设备在工作、识别出多少情况、有多少需要处理"
        },
        {
          id: "vision-models",
          label: "识别模型",
          tab: "vision-models",
          endpoint: "GET /api/vision/models",
          source: "new",
          group: "模型",
          roles: ["admin"],
          desc: "上传与切换识别模型，按需要选更准还是更快"
        },
        {
          id: "vision-datasets",
          label: "训练图片集",
          tab: "vision-datasets",
          endpoint: "GET /api/vision/datasets",
          source: "new",
          group: "模型",
          roles: ["admin"],
          desc: "整理用来训练识别模型的图片，检查标注是否正确"
        },
        {
          id: "vision-training",
          label: "训练新模型",
          tab: "vision-training",
          endpoint: "GET /api/vision/train-runs",
          source: "new",
          group: "模型",
          roles: ["admin"],
          desc: "训练新的识别模型，并查看训练效果"
        },
        {
          id: "vision-inference",
          label: "识别任务",
          tab: "vision-inference",
          endpoint: "GET /api/vision/infer-tasks",
          source: "new",
          group: "识别",
          roles: ["admin", "teacher"],
          desc: "提交图片、视频或实时画面做识别，并查看进度"
        },
        {
          id: "vision-classroom",
          label: "课堂行为识别",
          tab: "vision-classroom",
          endpoint: "GET /api/vision/scenes/classroom",
          source: "new",
          group: "场景",
          roles: ["admin", "teacher"],
          desc: "识别抬头、写字、举手、离座等课堂表现"
        },
        {
          id: "vision-exam",
          label: "考场行为监测",
          tab: "vision-exam",
          endpoint: "GET /api/vision/scenes/exam",
          source: "new",
          group: "场景",
          roles: ["admin", "teacher"],
          desc: "识别考场里的手机、传物、离座等异常情况"
        },
        {
          id: "vision-lab",
          label: "实验室安全识别",
          tab: "vision-lab",
          endpoint: "GET /api/vision/scenes/lab",
          source: "new",
          group: "场景",
          roles: ["admin", "teacher"],
          desc: "识别未戴手套、未戴护目镜、未穿实验服等实验安全问题"
        },
        {
          id: "vision-scan",
          label: "拍照识别批改",
          tab: "vision-scan",
          endpoint: "GET /api/vision/scenes/scan",
          source: "new",
          group: "场景",
          roles: ["admin", "teacher"],
          desc: "拍照上传纸质作业，自动框出题目区域，客观题自动比对判分"
        },
        {
          id: "vision-records",
          label: "记录回看与纠正",
          tab: "vision-records",
          endpoint: "GET /api/vision/records",
          source: "new",
          group: "结果",
          roles: ["admin", "teacher"],
          desc: "按时间回看识别记录，发现判错可以直接纠正"
        },
        {
          id: "vision-identity",
          label: "学生对应",
          tab: "vision-identity",
          endpoint: "GET /api/vision/identity-map",
          source: "new",
          group: "结果",
          roles: ["admin"],
          desc: "把画面里的人对应到座位表上的学生，识别结果才有归属"
        }
      ]
    },

    /* ============================================================
     * 2. 智能评阅 —— 作业业务模块
     * ============================================================ */
    {
      id: "review",
      label: "作业与评阅",
      en: "Smart Review",
      icon: "fa-solid fa-pen-nib",
      apiPrefix: "/api/review",
      priority: "P1",
      tier: "业务模块",
      roles: ["admin", "teacher", "student"],
      note: "从布置作业到批改出分，整条流程都在这里完成。",
      children: [
        {
          id: "review-overview",
          label: "评阅总览",
          tab: "dashboard",
          endpoint: "GET /api/review/overview",
          source: "extend",
          group: "总览",
          roles: ["admin", "teacher", "student"],
          desc: "作业、提交与成绩的整体情况",
          legacy: "/api/teacher/dashboard · /api/student/dashboard · /api/admin/dashboard"
        },
        {
          id: "review-courses",
          label: "课程与班级",
          tab: "courses",
          endpoint: "GET /api/review/courses",
          source: "existing",
          group: "班级",
          roles: ["admin", "teacher", "student"],
          desc: "查看课程、班级名单与选课情况",
          legacy: "/api/teacher/courses · /api/student/courses · /api/student/my-courses",
          note: "课程与班级的日常查看在这里，面向全校的批量调整在平台管理里。"
        },
        {
          id: "review-assignments",
          label: "作业发布",
          tab: "assignments",
          endpoint: "GET /api/review/assignments",
          source: "existing",
          group: "作业",
          roles: ["teacher"],
          desc: "布置作业：写清题目、截止时间与评分标准",
          legacy: "/api/teacher/assignments"
        },
        {
          id: "review-submit",
          label: "在线作答提交",
          tab: "submit",
          endpoint: "POST /api/review/assignments/{id}/submit",
          source: "existing",
          group: "作业",
          roles: ["student"],
          desc: "在线作答并提交，也可以上传附件",
          legacy: "/api/student/assignments/{id}/submit"
        },
        {
          id: "review-manual",
          label: "人工批改",
          tab: "grading",
          endpoint: "POST /api/review/submissions/{id}/grade",
          source: "existing",
          group: "批改",
          roles: ["teacher"],
          desc: "逐份打分，写评语与批注",
          legacy: "/api/teacher/submissions/{id}/grade"
        },
        {
          id: "review-ai",
          label: "AI 自动批改",
          tab: "ai-grading",
          endpoint: "POST /api/review/submissions/{id}/ai-grade",
          source: "existing",
          group: "批改",
          roles: ["teacher"],
          desc: "先由 AI 给出分数建议，老师确认后才计入成绩",
          legacy: "/api/ai/teacher/submissions/{id}/grade-suggestion"
        },
        {
          id: "review-scan",
          label: "拍照上传批改",
          tab: "scan-grading",
          endpoint: "POST /api/review/submissions/scan",
          source: "new",
          group: "批改",
          roles: ["teacher", "student"],
          desc: "拍照上传作业，客观题自动比对判分"
        },
        {
          id: "review-peer",
          label: "同伴互评",
          tab: "peer-review",
          endpoint: "GET /api/review/peer-reviews",
          source: "existing",
          group: "批改",
          roles: ["teacher", "student"],
          desc: "把同伴互评任务分给学生，评阅时隐去姓名",
          legacy: "/api/teacher/assignments/{id}/peer-review"
        },
        {
          id: "review-enroll",
          label: "选课与名单",
          tab: "enrollments",
          endpoint: "GET /api/review/enrollments",
          source: "existing",
          group: "班级",
          roles: ["admin", "teacher", "student"],
          desc: "选课、退课与班级名单维护",
          legacy: "/api/student/enroll/{id} · /api/teacher/courses/{id}/students"
        },
        {
          id: "review-grades",
          label: "成绩查询",
          tab: "grades",
          endpoint: "GET /api/review/grades",
          source: "existing",
          group: "作业",
          roles: ["student"],
          desc: "查看自己的成绩与课程均分",
          legacy: "/api/student/grades · /api/student/courses/{id}/average"
        },
        {
          id: "review-feedback",
          label: "确认批改建议",
          tab: "feedback",
          endpoint: "POST /api/review/feedback/{id}/approve",
          source: "existing",
          group: "批改",
          roles: ["teacher"],
          desc: "对 AI 的批改建议选择采纳、修改或重新生成",
          legacy: "/api/ai/feedback/{id}"
        },
        {
          id: "review-analysis",
          label: "作业分析",
          tab: "analysis",
          endpoint: "GET /api/review/assignments/{id}/analysis",
          source: "existing",
          group: "辅助",
          roles: ["teacher"],
          desc: "看一道题的得分分布与学生常见错误",
          legacy: "/api/teacher/assignments/{id}/analysis"
        },
        {
          id: "review-comments",
          label: "教师评语库",
          tab: "comment-memories",
          endpoint: "GET /api/review/comment-memories",
          source: "existing",
          group: "辅助",
          roles: ["teacher"],
          desc: "从历史评语里检索，保持评语风格一致",
          legacy: ""
        },
        {
          id: "review-quality",
          label: "批改质量复核",
          tab: "grading-quality",
          endpoint: "GET /api/review/grading-quality",
          source: "new",
          group: "辅助",
          roles: ["admin", "teacher"],
          desc: "抽样复查批改结果，看看 AI 建议的采纳情况"
        }
      ]
    },

    /* ============================================================
     * 3. 学情洞察 —— 消费视觉数据的关键模块
     * ============================================================ */
    {
      id: "insight",
      label: "学情分析",
      en: "Learning Insight",
      icon: "fa-solid fa-chart-column",
      apiPrefix: "/api/insight",
      priority: "P2",
      tier: "业务模块",
      roles: ["admin", "teacher", "student"],
      note: "把成绩、作业和课堂表现汇总起来，看清每个学生的情况。",
      children: [
        {
          id: "insight-overview",
          label: "学情总览",
          tab: "insight-overview",
          endpoint: "GET /api/insight/overview",
          source: "new",
          group: "总览",
          roles: ["admin", "teacher"],
          desc: "看整体学情：平均分、薄弱点与课堂表现"
        },
        {
          id: "insight-profiles",
          label: "学生画像",
          tab: "insight-profiles",
          endpoint: "GET /api/insight/students/{id}/profile",
          source: "extend",
          group: "学生",
          roles: ["admin", "teacher"],
          desc: "把成绩、作业与课堂表现汇总成一份学生档案",
          legacy: "/api/ai/students/{id}/diagnosis"
        },
        {
          id: "insight-diagnosis",
          label: "学习诊断",
          tab: "insight-diagnosis",
          endpoint: "POST /api/insight/students/{id}/diagnosis",
          source: "existing",
          group: "学生",
          roles: ["admin", "teacher"],
          desc: "找出学生薄弱的知识点",
          legacy: "/api/ai/students/{id}/diagnosis"
        },
        {
          id: "insight-plan",
          label: "学习路径规划",
          tab: "insight-plan",
          endpoint: "POST /api/insight/students/{id}/learning-plan",
          source: "existing",
          group: "学生",
          roles: ["admin", "teacher", "student"],
          desc: "按薄弱点给出学习建议与先后顺序",
          legacy: "/api/ai/students/{id}/learning-plan"
        },
        {
          id: "insight-engagement",
          label: "课堂参与度分析",
          tab: "insight-engagement",
          endpoint: "GET /api/insight/students/{id}/engagement",
          source: "new",
          group: "课堂表现",
          roles: ["admin", "teacher"],
          desc: "看专注时长、互动次数与座位分布"
        },
        {
          id: "insight-alerts",
          label: "学业与行为预警",
          tab: "insight-alerts",
          endpoint: "GET /api/insight/alerts",
          source: "new",
          group: "课堂表现",
          roles: ["admin", "teacher"],
          desc: "按你设定的条件，提醒可能掉队的学生"
        },
        {
          id: "insight-reports",
          label: "学情报告",
          tab: "insight-reports",
          endpoint: "POST /api/insight/reports",
          source: "new",
          group: "结果",
          roles: ["admin", "teacher"],
          desc: "生成阶段性的学情报告并导出"
        }
      ]
    },

    /* ============================================================
     * 4. 知识智能 —— RAG 与 Agent
     * ============================================================ */
    {
      id: "knowledge",
      label: "智能问答",
      en: "Knowledge Intelligence",
      icon: "fa-solid fa-wand-magic-sparkles",
      apiPrefix: "/api/knowledge",
      priority: "P2",
      tier: "能力模块",
      roles: ["admin", "teacher", "student"],
      note: "用课程资料回答问题并给出出处，也能把违规记录对应到具体规范。",
      children: [
        {
          id: "knowledge-docs",
          label: "课程资料",
          tab: "knowledge-docs",
          endpoint: "POST /api/knowledge/courses/{id}/documents/index",
          source: "existing",
          group: "资料",
          roles: ["admin", "teacher"],
          desc: "上传课程资料，作为问答的依据",
          legacy: "/api/ai/courses/{id}/documents/index"
        },
        {
          id: "knowledge-qa",
          label: "资料问答",
          tab: "knowledge-qa",
          endpoint: "POST /api/knowledge/courses/{id}/qa",
          source: "existing",
          group: "资料",
          roles: ["admin", "teacher", "student"],
          desc: "用课程资料回答问题，并给出出处",
          legacy: "/api/ai/courses/{id}/qa"
        },
        {
          id: "knowledge-agent",
          label: "智能对话",
          tab: "ai-agent",
          endpoint: "POST /api/knowledge/agent/chat",
          source: "existing",
          group: "问答",
          roles: ["admin", "teacher", "student"],
          desc: "直接对话，由它代你查询和办理",
          legacy: ""
        },
        {
          id: "knowledge-regulation",
          label: "规范对照",
          tab: "knowledge-regulation",
          endpoint: "POST /api/knowledge/regulations/match",
          source: "new",
          group: "问答",
          roles: ["admin", "teacher"],
          desc: "把发现的违规对应到具体的安全或纪律条文"
        },
        {
          id: "knowledge-runs",
          label: "AI 处理记录",
          tab: "knowledge-runs",
          endpoint: "GET /api/knowledge/runs/{id}/tool-calls",
          source: "existing",
          group: "记录",
          roles: ["admin"],
          desc: "回看 AI 每次是怎么一步步得出结果的",
          legacy: "/api/ai/runs/{id} · /api/ai/runs/{id}/tool-calls"
        }
      ]
    },

    /* ============================================================
     * 5. 态势感知与告警 —— 所有模块的事件出口
     * ============================================================ */
    {
      id: "situation",
      label: "提醒与通知",
      en: "Situation Awareness",
      icon: "fa-solid fa-tower-broadcast",
      apiPrefix: "/api/situation",
      priority: "P1",
      tier: "公共出口",
      roles: ["admin", "teacher", "student"],
      note: "课堂与考场里发现的情况，需要你知道的时候都会在这里提醒。",
      children: [
        {
          id: "situation-overview",
          label: "态势总览",
          tab: "situation-overview",
          endpoint: "GET /api/situation/overview",
          source: "extend",
          group: "总览",
          roles: ["admin", "teacher"],
          desc: "把各处的提醒与处理情况汇总在一页",
          legacy: "/api/admin/dashboard · /api/admin/monitor"
        },
        {
          id: "situation-stream",
          label: "实时提醒",
          tab: "situation-stream",
          endpoint: "WS /api/situation/alerts/stream",
          source: "existing",
          group: "告警",
          roles: ["admin", "teacher"],
          desc: "有新情况时立即推送到这里",
          legacy: "/api/notifications (ws_router)"
        },
        {
          id: "situation-rules",
          label: "提醒条件",
          tab: "situation-rules",
          endpoint: "GET /api/situation/rules",
          source: "new",
          group: "告警",
          roles: ["admin"],
          desc: "设定什么情况要提醒：触发条件、持续多久、何时生效"
        },
        {
          id: "situation-alerts",
          label: "提醒处理",
          tab: "situation-alerts",
          endpoint: "GET /api/situation/alerts",
          source: "new",
          group: "告警",
          roles: ["admin", "teacher"],
          desc: "按轻重缓急把提醒分给对应的人去处理"
        },
        {
          id: "situation-notifications",
          label: "通知中心",
          tab: "notifications",
          endpoint: "GET /api/situation/notifications",
          source: "existing",
          group: "通知",
          roles: ["admin", "teacher", "student"],
          desc: "所有通知集中在这里，可一键标记已读",
          legacy: "/api/notifications"
        }
      ]
    },

    /* ============================================================
     * 6. 平台治理 —— 含模型与算力资产（智慧平台标志）
     * ============================================================ */
    {
      id: "governance",
      label: "平台管理",
      en: "Platform Governance",
      icon: "fa-solid fa-sliders",
      apiPrefix: "/api/governance",
      priority: "P0",
      tier: "底座",
      roles: ["admin"],
      note: "账号、班级、服务器与存储等平台运行相关的事务。",
      children: [
        {
          id: "governance-overview",
          label: "平台概况",
          tab: "governance-overview",
          endpoint: "GET /api/governance/overview",
          source: "extend",
          group: "总览",
          roles: ["admin"],
          desc: "平台运行状况与资源概况",
          legacy: "/api/admin/dashboard"
        },
        {
          id: "governance-users",
          label: "账号与权限",
          tab: "users",
          endpoint: "GET /api/governance/users",
          source: "existing",
          group: "账号",
          roles: ["admin"],
          desc: "维护账号，并决定每类账号能看到哪些内容",
          legacy: "/api/admin/users"
        },
        {
          id: "governance-org",
          label: "院系与班级",
          tab: "org",
          endpoint: "GET /api/governance/org",
          source: "existing",
          group: "账号",
          roles: ["admin"],
          desc: "维护院系、班级与座位表；座位表是识别结果对应到学生的依据",
          legacy: "/api/admin/courses/{id}/visibility"
        },
        {
          id: "governance-compute",
          label: "模型与算力",
          tab: "governance-compute",
          endpoint: "GET /api/governance/compute",
          source: "new",
          group: "模型",
          roles: ["admin"],
          desc: "查看识别模型的版本与服务器算力占用"
        },
        {
          id: "governance-files",
          label: "文件与附件",
          tab: "files",
          endpoint: "GET /api/governance/files",
          source: "existing",
          group: "模型",
          roles: ["admin"],
          desc: "统一管理截图、作业附件与课程文档",
          legacy: "/api/files"
        },
        {
          id: "governance-audit",
          label: "操作记录",
          tab: "logs",
          endpoint: "GET /api/governance/audit-logs",
          source: "existing",
          group: "安全",
          roles: ["admin"],
          desc: "记录谁在什么时候改动了什么",
          legacy: ""
        },
        {
          id: "governance-monitor",
          label: "运行状态",
          tab: "monitor",
          endpoint: "GET /api/governance/monitor",
          source: "existing",
          group: "安全",
          roles: ["admin"],
          desc: "查看各项服务是否正常、识别任务是否堆积",
          legacy: "/api/admin/monitor"
        }
      ]
    }
  ]
};

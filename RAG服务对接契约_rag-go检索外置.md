# RAG 服务对接契约（rag-go 检索外置）

> 状态：**草案，待确认**  
> 探测对象：`D:\Windows\go\project\anydoc_service\rag-go`  
> 探测方式：静态代码 + 内嵌 OpenAPI（`openapi/openapi.json`）双证据。服务当前**未运行**（`127.0.0.1:9004` 连接被拒），故本契约的字段全部来自代码与 OpenAPI，而非运行时抓包。  
> 目标：把 edu 侧的「文档切分 + 向量检索」外置给 rag-go，edu 只保留业务语义与权限。

---

## 一、探测结论（先看这段）

### 1.1 rag-go 是什么

Go 写的单体知识库服务，**对外只暴露一个检索接口**，进程内自管解析、切块、embedding、向量写入、图片语义索引。

| 项      | 实测值                                                                                                   | 证据                                          |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 监听地址   | `127.0.0.1:9004`                                                                                      | `.env:5 GO_RAG_LISTEN_ADDRESS`              |
| Milvus | `http://127.0.0.1:19530`                                                                              | `.env:96 MILVUS_URI`                        |
| MinIO  | `127.0.0.1:9000`，bucket **`rag-docs`**，`MINIO_SECURE=false`                                           | `.env:106-110`                              |
| 对象存储开关 | `OBJECT_STORAGE_ENABLED` 已配置                                                                          | `.env:104`                                  |
| API 数量 | OpenAPI 39 路径 / 46 个 operation，`validateNativeOperations` 启动时强制校验一一对应                                 | `server.go:299-334`                         |
| 鉴权     | `/api/v1/*` **无鉴权**（只有 `loggingMiddleware`）；`/internal/v1/*` 校验 `X-Go-Rag-Internal-Key`，未配置 key 时直接放行 | `server.go:293`、`internal_search.go:97-109` |
| 前端/文档  | `http://127.0.0.1:9004/`、`/docs`、`/redoc`、`/openapi.json`                                             | 已 `go:embed`                                |

### 1.2 rag-go 早就为业务平台留了接口

`POST /api/v1/documents/from-object` 的 OpenAPI 描述原文：

> **审核平台对接主路径**：对方一键将原文件写入业务 MinIO 后，调用本接口仅传 object_key + 目标库。知识库自动分配 doc_id（响应中返回，调用方请持久化），校验对象存在后入队并立即返回；不上传字节、不改写对方 object key。请求中的 doc_id 一期忽略。

`POST /api/v1/retriever` 的 OpenAPI 描述原文：

> 输入自然语言，不经过 LLM 生成回答，直接返回匹配到的文本 chunks 和图片 URL。支持按逻辑库、文档 ID 和 top-k 数量参数控制检索范围，**适合后端服务直接调用**。

结论：**这不是"我要改造它来适配我"，而是"它本来就是按被业务后端调用设计的"。** 外置成本比预期的低。

### 1.3 顺带发现的 edu 侧硬事实（必须先说清）

| 事实                                                                                              | 证据                                                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| edu 侧"向量检索"实际是 **FAISS 本地文件**，不是 Milvus。注释原文"优先使用 FAISS"                                        | `ai/rag/vector_store.py:12-13, 39-51`                       |
| 调用点外面包了兜底：FAISS 读不到就 `vector_hits = []`，**静默降级**                                                | `app/routers/ai.py:204-212`                                 |
| 降级后走**纯词法打分**（jaccard + 字符覆盖率），遍历 Python 内存里所有 chunk                                            | `app/routers/ai.py:238-248`、`ai/rag/vector_store.py:99-133` |
| 本地只有 1 个索引：`ai/data/vector_store/course_1.faiss`（`index.faiss` 24KB + `index.pkl` 7KB，10-04 生成） | 文件系统                                                        |
| `VECTOR_STORE=faiss`，`EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2`                   | `.env:20-21`                                                |
| edu **没有实现 MinIO 写入**：附件落在本地磁盘 `upload_root/YYYY/MM/DD/uuid.ext`，`MINIO_*` 只是预留配置项              | `app/routers/files.py:317-318`、`app/config.py:65-68`        |

**含义**：除了 `course_1`，其余课程的"RAG 检索"实为关键词匹配。这不是架构洁癖问题，是检索质量问题。同时，"edu 没有 MinIO 写入能力"这一条会影响下面的方案选型（见第五节）。

### 1.4 两侧能力对照

| 维度   | edu 现状                                | rag-go                                          |
| ---- | ------------------------------------- | ----------------------------------------------- |
| 向量后端 | FAISS 单机文件                            | Milvus（文本库 + 图片库双库）                             |
| 检索模式 | 无真向量 → 词法兜底                           | `vector` / `keyword` / `hybrid`（RRF 融合）+ rerank |
| 图片检索 | 无                                     | 有，返回可直接下载的 `image_url`                          |
| 解析管道 | 简易切分                                  | MinerU / anydoc OCR、CAD 区域、VLM 图片语义             |
| 租户隔离 | `course_id` 过滤 + 每课程一个 FAISS 文件       | 逻辑库 `library`，检索时显式传 `selected_libraries`       |
| 权限   | pg 表 + `vector_id` 正则解析 submission 归属 | **无业务权限概念**                                     |
| 引用定位 | `chunk_index`                         | `page_start` / `page_end` / `locator_status`    |

---

## 二、契约边界：谁负责什么

一句话原则：**rag-go 管"知识和证据"，edu 管"谁的、能看吗"。**

| 职责                        | 归属      | 说明                                           |
| ------------------------- | ------- | -------------------------------------------- |
| 文档解析、切块、embedding、向量写入    | rag-go  | edu 不再做任何切块                                  |
| 文本/图片召回、融合、重排             | rag-go  | edu 不再持有 embedding 模型                        |
| 权限判定、可见范围计算               | **edu** | rag-go 无用户概念，edu 把"可见 doc 白名单"传进去            |
| 业务语义（课程 / 作业 / 提交 / 附件归属） | **edu** | 业务库仍是唯一事实源                                   |
| LLM 生成回答 / 组 prompt       | **edu** | 用 `/api/v1/retriever`（不生成），不用 `/api/v1/chat` |
| 引用展示、页码跳转                 | edu     | 用 `page_start` 拼 `#page=`                    |

**关键设计决策：不使用 `/api/v1/chat`，只用 `/api/v1/retriever`。** 因为 edu 的问答链路要自己拼 prompt、自己记 `AiQaLog`、自己决定 agent 模式（`app/routers/ai.py:271` `_classify_agent_mode`）。让 rag-go 生成回答会把 LLM 调用割裂到两个服务里。

---

## 三、接口契约（edu 只需 5 个）

### 3.1 检索：`POST /api/v1/retriever`

**请求体**（字段来自 OpenAPI `RetrievalRequest` + Go 结构体 `retrievalRequest`，`retriever.go:24-34`）

| 字段                   | 类型       | 必填    | 说明                                                         |
| -------------------- | -------- | ----- | ---------------------------------------------------------- |
| `message`            | string   | **是** | 自然语言查询，非空                                                  |
| `selected_libraries` | string[] | 强烈建议  | 逻辑库白名单。为空时会**回退到服务端全局 `active_library` 状态**，多租户下等于串库，必须显式传 |
| `doc_ids`            | string[] | 建议    | 限定检索的文档白名单。为空时表示"所选库内全库检索"                                 |
| `search_mode`        | enum     | 否     | `vector` / `keyword` / `hybrid`，默认 `hybrid`                |
| `text_top_k`         | int      | 否     | 默认 5，范围 **1–20**                                           |
| `image_top_k`        | int      | 否     | 默认 1，范围 **1–5**                                            |
| `enable_rerank`      | bool     | 否     | 是否重排                                                       |
| `tag_value_ids`      | uint[]   | 否     | 业务标签过滤，一期不用                                                |
| `tag_match`          | enum     | 否     | `any` / `all`                                              |

> 服务端硬校验（`decodeRetrievalRequest`，`retriever.go:90-129`）：`message` 非空；`text_top_k` 越界、`image_top_k` 越界、`search_mode` 非法值都会返回 **422** 且报文是 FastAPI 风格 `detail[]`，不是 rag-go 自己的错误结构。

**请求样例**（学生 A 在课程 1 提问）

```json
{
  "message": "第三次全国土壤普查的技术路线是什么",
  "selected_libraries": ["course_1"],
  "doc_ids": ["c1-file-1024", "c1-sub-3301-file-1042"],
  "search_mode": "hybrid",
  "text_top_k": 15,
  "image_top_k": 3,
  "enable_rerank": true
}
```

**响应体**（顶层是普通 map，`retriever.go:74-77`；`TextMatch` / `ImageMatch` 字段来自 OpenAPI）

```json
{
  "used_libraries": ["course_1"],
  "used_stores": [],
  "text_matches": [
    {
      "chunk_id": "9f2c...",
      "doc_id": "c1-file-1024",
      "filename": "第三次全国土壤普查-技术规程规范（修订版）.pdf",
      "snippet": "……普查以土壤类型为基本单元……",
      "score": 0.83,
      "page_start": 12,
      "page_end": 13,
      "locator_status": "ok",
      "file_path": "服务端本地路径，勿依赖"
    }
  ],
  "image_matches": [
    {
      "image_id": "a1b2c3...",
      "doc_id": "c1-file-1024",
      "image_url": "http://127.0.0.1:9004/api/v1/documents/c1-file-1024/images/a1b2c3...",
      "caption": "土壤普查技术路线图",
      "score": 0.85,
      "matched_kind": "tag",
      "matched_tag": "技术路线",
      "concept_types": ["主体", "属性"],
      "concepts": ["土壤普查", "技术路线"]
    }
  ]
}
```

两个必须注意的点：

1. **`text_matches[].snippet` 是完整原文**（OpenAPI 描述："命中文本块的完整原文内容"），不是截断片段。edu 侧要自己截到 800 字符，保持与现有 `citation_from_chunk` 的观感一致（`app/routers/ai.py:196`）。
2. **`score` 语义不可移植。** OpenAPI 原文："向量检索得分或距离，**数值含义取决于底层向量库**"。edu 现在是 `similarity = 1/(1+distance)`（`app/routers/ai.py:226`），阈值 `0.18`。这个阈值**不能直接搬到 rag-go 上**——必须重新标定，或者改成"只信任排序、不信任绝对值"（推荐后者，见第六节风险）。

### 3.2 入库（方案 A，走 MinIO）：`POST /api/v1/documents/from-object`

| 字段                         | 类型     | 必填     | 说明                                                         |
| -------------------------- | ------ | ------ | ---------------------------------------------------------- |
| `object_key`               | string | **是**  | 业务桶内对象 key                                                 |
| `library_name`             | string | 二选一    | 目标逻辑库                                                      |
| `new_library_name`         | string | 二选一    | 不存在则创建后入库，**优先于 `library_name`**                           |
| `bucket`                   | string | 否      | **一期仅允许等于 rag-go 配置的 `MINIO_BUCKET`（即 `rag-docs`），否则 400** |
| `filename`                 | string | 否      | 显示/落盘文件名，省略时取 `object_key` 最后一段                            |
| `chunk_strategy`           | string | 否      | `token` / `paragraph`；图片忽略                                 |
| `chunk_token_size`         | int    | 否      | 默认 800，范围 64–8192                                          |
| `chunk_overlap_token_size` | int    | 否      | 默认 120，须满足 `0 <= overlap < chunk_token_size`               |
| `doc_id`                   | string | **勿传** | 描述原文："【对接忽略】正式对接请勿传入；一期即使传入也忽略"                            |

返回 `UploadDocumentsResponse`，`uploaded[]` 元素是 `DocumentInfo`，**从中取 `doc_id` 并持久化**。

### 3.3 入库（方案 B，不走 MinIO）：`POST /api/v1/documents`

`multipart/form-data`，`files` 必填。

| 表单项                                                                            | 说明                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `files`                                                                        | 一个或多个文件（**必填**）                                          |
| `library_name` / `new_library_name`                                            | 同上                                                       |
| `doc_id`                                                                       | **仅单文件时可指定**；多文件禁止传。pattern `^[A-Za-z0-9_.-]+$`，长度 1–120 |
| `chunk_strategy` / `chunk_token_size` / `chunk_overlap_token_size` / `caption` | 同上                                                       |

> `doc_id` 可自定义是**方案 B 的关键优势**：edu 可以在上传时就造出带业务语义的 doc_id（如 `c1-sub3301-f1042`），检索回来直接解析，不必维护映射表。方案 A 拿不到这个能力。

### 3.4 状态轮询：`GET /api/v1/documents/{doc_id}/status`

```json
{
  "doc_id": "c1-file-1024",
  "status": "processing",
  "is_terminal": false,
  "processing_stage": "ocr",
  "processing_progress": 45,
  "processing_message": "正在识别第 12 / 27 页",
  "library_name": "course_1",
  "store_type": "text",
  "filename": "…",
  "image_count": 3,
  "image_index_status": "pending",
  "error": null
}
```

- `status`：`pending` → `processing` → `ready` / `failed`
- **`is_terminal=true` 时停止轮询**
- 批量场景用 `GET|POST /api/v1/documents/status`
- 这套字段可以直接映射到 edu 现有的 `AiIndexJob`（`status / total_chunks / error_message / created_at / finished_at`，`app/models/ai_models.py:36-49`），差不多够用

### 3.5 健康检查：`GET /api/v1/health`

> OpenAPI 描述："健康检查接口**永远返回 HTTP 200**；调用方应根据响应体中的 `ok` 字段判断服务是否已就绪。"

```json
{
  "ok": true,
  "rag_ready": true,
  "milvus_ok": true,
  "image_branch_enabled": true,
  "image_store_ready": true,
  "api_key_configured": true,
  "vector_backend": "milvus",
  "active_library": "course_1"
}
```

**这一条很重要**：健康探测不能看 HTTP 状态码，必须看 `ok`。否则 9004 端口活着但 Milvus 挂了，edu 会以为服务健康。

### 3.6 其他备查

| 接口                                                        | 用途                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/v1/libraries`                                   | 列出逻辑库，用于校准 edu ↔ rag-go 的库映射                                                                     |
| `DELETE /api/v1/documents/{doc_id}`                       | edu 删除附件时同步删除                                                                                    |
| `PATCH /api/v1/documents/{doc_id}/retrieval`              | 检索开关，可用来做软下线                                                                                     |
| `GET /api/v1/documents/{doc_id}/images`                   | 列出文档图片，给 PPT 插图                                                                                  |
| `POST /api/v1/documents/{doc_id}/replace`                 | 替换文件并重新入库                                                                                        |
| `POST /api/v1/documents/from-object` 的 `tag_value_ids` 体系 | rag-go 有 `BUSINESS_TAG_RESOLVER_URL`（注释举例 `http://127.0.0.1:8888`），可反向调用业务服务解析标签。**一期不用**，但记着这条路 |

---

## 四、数据映射

### 4.1 三层对应关系

```
edu 业务层                    rag-go 知识库层
────────────────────────────────────────────────
Course.id = 1      ────────►  library_name = "course_1"
StoredFile (附件)   ────────►  doc_id
AiDocumentChunk     ────────►  chunk（rag-go 内部管理）
```

- **课程 → 逻辑库**：`library_name = f"course_{course_id}"`。与 edu 现有 FAISS collection 命名（`ai/rag/indexer.py:106` `course_{course_id}`）**完全一致**，心智无需切换。库名合法性已验证：rag-go 的规则是 `[^A-Za-z0-9_.\-\p{Han}]+` 替换为 `-` 并去首尾 `-._`、截断 80 字符（`library.go:22, 52-59`），`course_1` 合法。
- **附件 → doc_id**：一个 `StoredFile` 对应一个 `doc_id`。
- **chunk**：edu **不再持有**。这是本次拆除的主要负担。

### 4.2 edu 侧需要的新表（替代 `ai_document_chunks` 的检索职责）

`ai_document_chunks` 目前承担两个职责：① 存正文供词法兜底 ② 提供 `vector_id` 供权限正则解析。外置后两个职责都不需要了。建议改为一张轻量映射表：

```sql
-- 建议表名：rag_documents
CREATE TABLE rag_documents (
    id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    rag_doc_id      VARCHAR(120) NOT NULL,          -- rag-go 分配的 doc_id（方案 B 下为 edu 自定义）
    library_name    VARCHAR(80)  NOT NULL,          -- course_{course_id}
    course_id       BIGINT       NOT NULL,
    file_id         BIGINT       NULL,              -- → stored_files.id
    submission_id   BIGINT       NULL,              -- 权限判定用
    assignment_id   BIGINT       NULL,              -- 权限判定用
    source          VARCHAR(255) NOT NULL,          -- 展示名，对应原 source
    source_type     VARCHAR(50)  NOT NULL,          -- course_material / assignment_attachment / submission_attachment / submission_text
    ingest_status   VARCHAR(20)  NOT NULL DEFAULT 'pending',
    ingest_error    TEXT         NULL,
    created_at      DATETIME     NULL,
    updated_at      DATETIME     NULL,
    UNIQUE KEY uq_rag_doc (rag_doc_id),
    KEY idx_rag_course (course_id),
    KEY idx_rag_submission (submission_id)
);
```


**doc_id 在 edu 侧的语义**（任选其一，取决于方案 A/B）：

| 方案             | doc_id 来源                      | edu 侧查询方式                                      |
| -------------- | ------------------------------ | ---------------------------------------------- |
| A（from-object） | rag-go 发号，形如随机串                | 必须查 `rag_documents.rag_doc_id → submission_id` |
| B（multipart）   | **edu 自定义**，如 `c1-u3301-f1042` | 可直接字符串解析，映射表降级为缓存                              |

### 4.3 引用映射

| rag-go 字段                    | edu citation 字段（`app/routers/ai.py:192-202`） | 处理                              |
| ---------------------------- | -------------------------------------------- | ------------------------------- |
| `snippet`                    | `content`                                    | 截断到 800 字符                      |
| `doc_id`                     | `document_id`                                | 直通                              |
| —                            | `chunk_index`                                | **无对应**，用 `page_start` 替代，或按序编号 |
| `score`                      | `score` / `similarity`                       | **需重新标定**，勿直接套 0.18 阈值          |
| `filename`                   | `file_name`                                  | 直通                              |
| `doc_id` → 映射表 `source`      | `source`                                     | 查 `rag_documents`               |
| `doc_id` → 映射表 `source_type` | `source_type`                                | 查 `rag_documents`               |
| `page_start` / `page_end`    | **新增**                                       | 拼 `#page=12`，PDF 预览跳转           |
| `image_url`                  | **新增**                                       | 给 PPT / 图文回答插图                  |

---

## 五、权限门控（这是整个方案的关键）

**问题**：rag-go 没有用户概念，而 edu 的学生只能看自己的提交附件（`app/routers/ai.py:151-185`）。

**方案：白名单前置收窄，而不是事后过滤。**

```
① edu 验权 → 算出该用户在本课程可见的 doc_id 集合
② 调 /api/v1/retriever 时把集合放进 doc_ids
③ rag-go 只在白名单内召回
④ 返回结果按 doc_id 反查映射表，补 source / source_type
```

为什么必须前置：如果先让 rag-go 按 top-5 返回、再在 edu 过滤，一旦 5 条里 3 条是别人的，学生实际只看到 2 条，**召回数量被动缩水**，且白名单外的内容已经在网络和内存里流转过了。

白名单算法（对应现有逻辑）：

| 角色                  | 可见 doc 范围                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 教师（课程 owner）/ ADMIN | 该课程全部 `source_type in (course_material, assignment_attachment, submission_attachment, submission_text)`           |
| 学生                  | `course_material` + `assignment_attachment`（全班共享）+ 自己提交的 `submission_attachment` / `submission_text` + 被分配互评对象的附件 |

即把现有 `can_access_chunk`（`app/routers/ai.py:179-185`）从"过滤 chunk 对象"改成"过滤 doc_id 集合"，判定依据从 `vector_id` 正则改为 `rag_documents.submission_id`——**后者是结构化列，比正则稳**。

---

## 六、配置与降级

### 6.1 edu 侧新增配置（`.env`）

```dotenv
# === 外部 RAG 检索服务（rag-go）===
RAG_BACKEND=local                 # local | http-rag
RAG_SERVICE_URL=http://127.0.0.1:9004
RAG_SERVICE_TIMEOUT_MS=15000
RAG_LIBRARY_PREFIX=course_        # 生成 course_{id}
RAG_INGEST_MODE=multipart         # multipart | from-object
# 仅 from-object 模式需要：edu 附件投递到 rag-go 的 MinIO 桶
RAG_MINIO_ENDPOINT=127.0.0.1:9000
RAG_MINIO_BUCKET=rag-docs
```

### 6.2 实现位置

完全复用已有的 Provider Registry 模式（上一轮 YOLO 拆分验证过的路径）：

| 文件                                     | 动作                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `app/core/models/adapters/http_rag.py` | **新建**，`HttpRetrievalProvider`，写法照抄 `http_vision.py`                                                       |
| `app/core/models/registry.py`          | 注册 `http-rag`，新增 `retrieval` capability                                                                    |
| `app/config.py`                        | 新增上述字段                                                                                                     |
| `app/routers/ai.py:136`                | `_search_course_chunks` 内部改为调 provider；**函数签名与返回结构不变**，4 个调用点（`ai.py:676, 798, 930`、`knowledge.py:114`）零改动 |
| `app/routers/files.py:317`             | 上传成功后追加一步"投递入库"（异步/后台任务）                                                                                   |
| `app/models/ai_models.py`              | 新增 `RagDocument`；`AiDocumentChunk` 与 `AiIndexJob` 标记废弃                                                     |

熔断 / 重试 / 超时 / 统计由基类 `ModelProvider.invoke` 统一调度（`app/core/models/base.py:41-53`），`HttpRetrievalProvider` 只需实现"把请求发出去、把结果搬回来"。

### 6.3 降级策略（必须明确）

| 场景                                    | 行为                                            |
| ------------------------------------- | --------------------------------------------- |
| `rag-go` 不可达 + `RAG_BACKEND=http-rag` | 熔断后**回退到现有词法打分**，而不是返回空。否则检索质量反而下降            |
| `rag-go` 返回 `ok=false`                | 视为不可用，同上                                      |
| 校验类 422                               | **不重试**（`validate()` 返回错误直接终止），因为报文格式错误重试无意义  |
| 无权限 doc 全部被过滤                         | 返回空 citations，正常回答"未找到相关材料"，不要 fallback 到全库检索 |

---

## 七、落地顺序（建议分三步）

| 步     | 内容                                                                                                   | 验收标准                                                          |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **1** | 只做检索外置：写 `HttpRetrievalProvider` + 改 `_search_course_chunks`；入库仍由 edu 现有流程负责（先手工把 1 个课程的资料灌进 rag-go） | 同一个问题，`RAG_BACKEND=local` 与 `http-rag` 各跑一次，对比引用条数与页码         |
| **2** | 接入库：上传附件 → 投递 rag-go → 轮询状态 → 写 `rag_documents`                                                      | 上传一个 PDF，`GET /documents/{doc_id}/status` 走到 `ready`，随后能被检索命中 |
| **3** | 收尾：`ai_document_chunks` / `AiIndexJob` 退役；引用加页码；图片接给 PPT                                             | 三端审计无回归                                                       |

**第 1 步刻意不自研入库**，是为了把"检索质量是否真的变好"这个最关键的问题先验证掉。如果外置后检索质量没有提升，后面两步就没必要做。

---

## 八、需要你确认的 4 个决策点

| # | 决策                      | 选项                                                                   | 我的建议                                                                                                                                                                                                    |
| - | ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **入库走哪条路**              | A `from-object`（需 edu 新增 MinIO 写入）／B `multipart`（edu 直接传字节，无需 MinIO） | **B**。理由：edu 目前**没有 MinIO 客户端**（`app/config.py:65-68` 只是预留），走 A 要先补一套对象存储写入 + 保证两边 bucket 一致（edu 默认 `education-files` vs rag-go 的 `rag-docs`，**当前不一致会直接 400**）；B 只多一份磁盘占用，换掉两个新增依赖，且能自定义 `doc_id` 省掉映射表 |
| 2 | **是否使用 `/api/v1/chat`** | 用／只用 `/api/v1/retriever`                                             | **只用 retriever**。edu 要自己控制 prompt、`AiQaLog`、agent 模式（`ai.py:271`），用 chat 会把 LLM 调用割裂到两个服务                                                                                                               |
| 3 | **score 阈值怎么处理**        | 重新标定绝对阈值／只信任排序                                                       | **只信任排序**。rag-go 的 `score` 含义随底层向量库变化（OpenAPI 原话），跨库不可比；改为"取 top-k 中相对最优的 N 条"                                                                                                                          |
| 4 | **权限是否前置收窄**            | 前置 `doc_ids` 白名单／事后过滤                                                | **前置**。事后过滤会让召回数量被动缩水，且越权内容已经在网络上流转                                                                                                                                                                     |

---

## 九、未采纳方案与理由

| 方案                     | 为什么不选                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| 用 `/api/v1/chat` 直接拿答案 | 把 prompt 与 LLM 调用割裂到两个服务，edu 的 agent 编排、问答日志、模式分类全部要改造                          |
| 让 rag-go 支持业务权限过滤（改它）  | 违反"知识库不该懂业务权限"的边界；且需改 Go 代码，成本高、耦合反而更强                                          |
| 继续本地 FAISS + 自研切分      | 现状已经证明行不通：只有 `course_1` 有索引，其余课程静默走词法                                           |
| edu 直连 Milvus          | 会引入对 rag-go 内部数据结构（collection / schema / embedding 维度）的强耦合，rag-go 一切换 schema 就断 |

---

## 十、待补信息

以下项需要 rag-go 跑起来后才能确认（服务当前未监听 9004）：

1. 现有逻辑库清单（`GET /api/v1/libraries`），确认 `course_*` 命名是否已被占用
2. 单个文档的实际切块粒度与 `page_start/page_end` 在中文 PDF 上的定位命中率
3. `score` 在 `hybrid` 模式下的实际取值范围（用于决策点 3 的最终判断）
4. 9004 未鉴权的风险边界：如果 rag-go 与 edu 不在同一台机器，`/api/v1/*` 裸暴露需要加反代或启用 `GO_RAG_INTERNAL_API_KEY` 走 `/internal/v1/search/*`

---

*本契约所有字段均取自 `openapi/openapi.json` 与 Go 源码，未做推测填充。标注「待补信息」的部分为运行时才能确定的内容。*

# YOLO 目标检测平台 —— 从 0 到 1 复刻方案

> 定位：以 YOLO 为核心的目标检测平台，覆盖数据集管理、模型训练、推理、结果可视化四大能力
> 约束：**不复用旧 EduAgent 平台代码，平台层全部手写**
> 目标机器：RTX 4060 Laptop / 8GB 显存 / 16G 内存 / Windows

---

## 零、边界声明与关键决策（先读这节）

### 0.1 "全部手写"的范围界定

| 层 | 是否手写 | 说明 |
|---|---|---|
| 平台层（数据集/训练调度/推理编排/评估/可视化/API） | ✅ **100% 手写** | 这是本项目的主体 |
| 检测引擎（YOLO 网络与训练循环） | ❌ 调用 Ultralytics | 见下方理由 |
| 前端（页面与图表） | ✅ 手写 | ECharts 只作为图表库 |

**为什么检测引擎不手写**：YOLO11 涉及 C2f/C3k2 模块、SPPF、解耦检测头、Anchor-free + TAL 标签分配、DFL loss、以及一整套 Mosaic/MixUp 增强。从零复现要 3–4 周，且精度大概率低于官方实现。本项目的工程价值在"数据集 → 训练 → 推理 → 可视化"的闭环，不在复现网络结构。

> **可选自研分支**（仅在论文需要"模型改进"章节时启用）：在 `core/model/` 下手写 YOLO 网络与训练循环，作为与 Ultralytics 的对照实验。**成本 +10～14 天，高风险，默认不走。**

### 0.2 技术选型与理由

| 选型 | 选择 | 理由 |
|---|---|---|
| 检测引擎 | Ultralytics YOLO11 | 训练/验证/导出一条链，Python API 干净，detect/pose/seg/obb 全覆盖，切换任务零成本 |
| 后端 | FastAPI + Pydantic + SQLAlchemy 2.0 | 异步友好、自带 Swagger、你已熟悉这套栈 |
| 元数据库 | **SQLite** | 单机单卡平台，元数据量小（数据集几十、任务几百）。零外部依赖，启动即用。**不引入 MySQL/Redis** —— 历史上 Docker daemon 起不来已经白烧过时间，这条路必须堵死 |
| 任务调度 | **子进程 + 状态表轮询** | 单卡同时只跑一个训练，Celery+Redis 属过度设计。子进程隔离保证训练崩溃不拖垮 API |
| 前端 | 手写静态页 + ECharts | Gradio/Streamlit 定制性差，且体现不出前端工程能力；ECharts 你已用过 |
| 文件存储 | 文件系统 + DB 只存路径 | 图片/视频/权重天然是文件；DB 存大对象会迅速膨胀 |
| 标注工具 | **不自己写**，接 X-AnyLabeling / CVAT 导出 | 自研标注器至少一周，与平台核心价值无关 |
| 导出格式 | ONNX / TensorRT | Ultralytics 原生 export，一行调用 |

### 0.3 内部数据格式约定

**内部统一用 YOLO txt 格式**（`class cx cy w h` 归一化），因为它是引擎的原生契约。COCO / VOC 的转换**只在导入边界做一次**，平台内部不再有任何格式分支。

---

## 一、整体架构

### 1.1 模块划分与数据流转

```
数据集管理 ──→ 模型训练 ──→ 推理服务 ──→ 结果可视化
导入·切分·转换  配置·任务·权重  图像·视频·流   渲染·曲线·报告
                    ↓               ↓
                      评估模块
              mAP·PR曲线·混淆矩阵·多权重对比
                          ↓
   共享底座：SQLite 元数据 + 文件系统（数据集/权重/结果）
```

**数据流转（细粒度）**

```
原始图/视频/标注
  → [数据集管理] 导入 → 格式归一 → 校验 → 切分 → data.yaml
  → [模型训练]   读取 data.yaml → 子进程训练 → runs/train/expN/weights/*.pt
                                ↘ metrics 实时写 metrics.jsonl + DB
  → [推理服务]   加载权重 → 图像/视频/目录/流 → 结果 JSON + 渲染图/视频
  → [评估模块]   对权重跑 val → mAP/PR/混淆矩阵 → 报告 JSON
  → [可视化]     四块面板：数据集 / 训练监控 / 推理演示 / 评估报告
```

### 1.2 分层职责

| 层 | 职责 | 目录 |
|---|---|---|
| 能力层 `core/` | 纯计算逻辑，**不依赖 Web**，可 CLI 直接跑 | `backend/core/` |
| 服务层 `services/` | 编排 core + 读写 DB + 管任务状态 | `backend/app/services/` |
| 接口层 `routers/` | REST + WebSocket，只做参数校验与转发 | `backend/app/routers/` |
| 持久层 `models/` | SQLite 元数据表 | `backend/app/models/` |
| 展示层 | 静态页 + ECharts | `frontend/` |

**关键原则：`core/` 必须能脱离 Web 独立运行。** 这是"每阶段可独立验证"的前提——训练逻辑在 CLI 下就能跑通并验证，不用先搭 API。

---

## 二、目录结构

```
yolo-platform/
├── backend/
│   ├── app/
│   │   ├── main.py               # FastAPI 入口
│   │   ├── config.py             # 路径与运行参数
│   │   ├── db.py                 # SQLite 引擎与会话
│   │   ├── models/
│   │   │   ├── dataset.py        # Dataset / DatasetVersion / ImageItem
│   │   │   ├── train.py          # TrainRun / TrainMetric
│   │   │   ├── model.py          # ModelArtifact
│   │   │   └── infer.py          # InferTask / InferResult
│   │   ├── schemas/              # Pydantic 请求响应
│   │   ├── routers/
│   │   │   ├── datasets.py
│   │   │   ├── training.py
│   │   │   ├── inference.py
│   │   │   ├── models.py
│   │   │   └── evaluation.py
│   │   └── services/
│   │       ├── dataset_service.py
│   │       ├── train_service.py
│   │       ├── infer_service.py
│   │       └── eval_service.py
│   ├── core/
│   │   ├── dataset/
│   │   │   ├── formats.py        # COCO/VOC → YOLO 转换
│   │   │   ├── split.py          # train/val/test 切分
│   │   │   ├── validate.py       # 标注校验
│   │   │   └── builder.py        # 生成 data.yaml
│   │   ├── train/
│   │   │   ├── config.py         # 训练参数模型
│   │   │   └── worker.py         # 子进程训练入口
│   │   ├── infer/
│   │   │   ├── predictor.py      # 图像/视频/目录推理
│   │   │   └── render.py         # 画框与结果渲染
│   │   ├── eval/
│   │   │   └── metrics.py        # 指标计算
│   │   └── export/
│   │       └── exporter.py       # ONNX / TensorRT
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── dataset.html
│   ├── train.html
│   ├── infer.html
│   ├── report.html
│   └── js/app.js
├── data/                         # 数据集存储
│   └── datasets/<dataset_id>/
│       ├── images/train val test
│       ├── labels/train val test
│       └── data.yaml
├── runs/                         # 训练产出（Ultralytics 原生目录）
├── storage/                      # 推理结果与导出物
├── scripts/
│   ├── verify_env.py
│   ├── smoke_dataset.py
│   ├── smoke_train.py
│   ├── smoke_infer.py
│   └── smoke_eval.py
└── README.md
```

---

## 三、阶段拆分（严格按序执行）

图例：**🔴 阻塞项** = 不做完，后续阶段全部无法进行

---

### S0 · 环境与依赖准备 🔴

| 项 | 内容 |
|---|---|
| **目标** | GPU 可用、依赖齐备、能跑通一次官方推理 |
| **前置依赖** | 无 |
| **产出物** | `requirements.txt`、`scripts/verify_env.py`、验证通过的输出 |
| **核心代码** | `scripts/verify_env.py` |

**⚠️ 已知阻塞**：当前项目环境里 torch 是 `2.13.0+cpu`，`cuda.is_available() = False`。**必须先换装 CUDA 版**，否则训练阶段直接卡死。

```bash
# 换装 CUDA 版（驱动 560.94 兼容 CUDA 12.x）
python -m venv .venv
./.venv/Scripts/python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
./.venv/Scripts/python.exe -m pip install ultralytics opencv-python fastapi uvicorn sqlalchemy pydantic-settings
```

`scripts/verify_env.py`

```python
import sys, torch
from ultralytics import YOLO

print("python :", sys.version.split()[0])
print("torch  :", torch.__version__)
print("cuda   :", torch.cuda.is_available())
assert torch.cuda.is_available(), "CUDA 不可用，S0 未通过，不要进入 S1"
print("device :", torch.cuda.get_device_name(0))
print("vram   :", round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2), "GB")

model = YOLO("yolo11n.pt")
res = model("https://ultralytics.com/images/bus.jpg", device=0, verbose=False)
print("boxes  :", len(res[0].boxes), "→ S0 通过")
```

**独立验证**：`python scripts/verify_env.py` 必须打印 `cuda: True` 且 `boxes > 0`。

---

### S1 · 目录骨架与配置底座 🔴

| 项 | 内容 |
|---|---|
| **目标** | 目录建好、配置与 DB 可用、一个 `/health` 接口能返回 |
| **前置依赖** | S0 |
| **产出物** | 完整目录树、`config.py`、`db.py`、`main.py`、SQLite 文件 |
| **核心代码** | `backend/app/config.py`、`db.py`、`main.py` |

`backend/app/config.py`

```python
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    ROOT: Path = Path(__file__).resolve().parents[2]
    DATA_DIR: Path = ROOT / "data" / "datasets"
    RUNS_DIR: Path = ROOT / "runs"
    STORAGE_DIR: Path = ROOT / "storage"
    DB_URL: str = f"sqlite:///{(ROOT / 'platform.db').as_posix()}"
    DEVICE: str = "0"

    class Config:
        env_file = ".env"

settings = Settings()
for d in (settings.DATA_DIR, settings.RUNS_DIR, settings.STORAGE_DIR):
    d.mkdir(parents=True, exist_ok=True)
```

`backend/app/db.py`

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from app.config import settings

engine = create_engine(settings.DB_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def init_db():
    from app.models import dataset, train, model, infer  # noqa
    Base.metadata.create_all(engine)
```

`backend/app/main.py`（最小版）

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from app.db import init_db

app = FastAPI(title="YOLO Platform")
init_db()

@app.get("/health")
def health():
    return {"status": "ok"}
```

**独立验证**：`uvicorn app.main:app --port 8000`，`GET /health` 返回 `{"status":"ok"}`，且根目录生成 `platform.db`。

---

### S2 · 数据集管理与标注格式 🔴🔴（最高优先级阻塞项）

| 项 | 内容 |
|---|---|
| **目标** | 导入 → 格式归一 → 校验 → 切分 → 产出可被引擎直接训练的 `data.yaml` |
| **前置依赖** | S1 |
| **产出物** | `core/dataset/*`、`dataset_service.py`、一个真实可训练的数据集、冒烟脚本 |
| **核心代码** | `backend/core/dataset/formats.py`、`split.py`、`validate.py`、`builder.py` |

**为什么这是最高阻塞项**：没有能跑训练的数据集，S3 之后全部停摆。先用一个极小数据集（官方 `coco8` 或自建 20 张）把链路打通，再换真实数据。

`backend/core/dataset/builder.py`

```python
import yaml
from pathlib import Path

def build_data_yaml(ds_dir: Path, names: dict[int, str]) -> Path:
    cfg = {
        "path": str(ds_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": names,
    }
    out = ds_dir / "data.yaml"
    out.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return out
```

`backend/core/dataset/split.py`

```python
import random, shutil
from pathlib import Path

def split_dataset(src_img: Path, src_lbl: Path, out: Path,
                  ratios=(0.8, 0.1, 0.1), seed=42):
    images = sorted([p for p in src_img.iterdir() if p.suffix.lower() in {".jpg", ".png", ".jpeg"}])
    random.Random(seed).shuffle(images)
    n = len(images)
    n_tr, n_va = int(n * ratios[0]), int(n * ratios[1])

    for split, chunk in zip(("train", "val", "test"),
                            (images[:n_tr], images[n_tr:n_tr + n_va], images[n_tr + n_va:])):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        for img in chunk:
            shutil.copy(img, out / "images" / split / img.name)
            lbl = src_lbl / (img.stem + ".txt")
            if lbl.exists():
                shutil.copy(lbl, out / "labels" / split / lbl.name)
    return {"train": n_tr, "val": n_va, "test": n - n_tr - n_va}
```

`backend/core/dataset/validate.py`

```python
from pathlib import Path

def validate_yolo(ds_dir: Path) -> list[str]:
    """返回问题列表，空列表表示通过。"""
    problems = []
    for split in ("train", "val"):
        img_dir, lbl_dir = ds_dir / "images" / split, ds_dir / "labels" / split
        if not img_dir.exists():
            problems.append(f"missing {img_dir}")
            continue
        for img in img_dir.iterdir():
            lbl = lbl_dir / (img.stem + ".txt")
            if not lbl.exists():
                problems.append(f"{split}/{img.name}: no label")
                continue
            for i, line in enumerate(lbl.read_text(encoding="utf-8").splitlines()):
                parts = line.split()
                if len(parts) != 5:
                    problems.append(f"{lbl.name}:{i} bad field count")
                    continue
                cx, cy, w, h = map(float, parts[1:])
                if not (0 <= cx <= 1 and 0 <= cy <= 1 and 0 < w <= 1 and 0 < h <= 1):
                    problems.append(f"{lbl.name}:{i} out of range")
    return problems
```

`scripts/smoke_dataset.py`

```python
from pathlib import Path
from core.dataset.builder import build_data_yaml
from core.dataset.split import split_dataset
from core.dataset.validate import validate_yolo

out = Path("data/datasets/smoke")
stats = split_dataset(Path("raw/images"), Path("raw/labels"), out)
build_data_yaml(out, {0: "person", 1: "phone"})
problems = validate_yolo(out)
print("split   :", stats)
print("yaml    :", (out / "data.yaml").read_text(encoding="utf-8"))
print("problems:", problems[:10], "→ S2", "通过" if not problems else "失败")
```

**独立验证**：`python scripts/smoke_dataset.py` 输出问题列表为空，且生成的 `data.yaml` 能被下一阶段的训练脚本直接加载。

---

### S3 · 训练流水线

| 项 | 内容 |
|---|---|
| **目标** | 配置驱动训练、任务状态机、实时指标落库、断点续训、可中断 |
| **前置依赖** | S2（有效 data.yaml） |
| **产出物** | `core/train/worker.py`、`train_service.py`、`TrainRun` 表、`runs/` 权重 |
| **核心代码** | `backend/core/train/worker.py`、`backend/app/services/train_service.py` |

**设计要点**：训练跑在**独立子进程**。API 只写 `TrainRun(status=QUEUED)` 然后 spawn，worker 自己更新状态与指标。这样训练崩溃不会拖垮 API，且 worker 可直接在命令行单独调试。

`backend/core/train/worker.py`

```python
import argparse, json, time
from pathlib import Path
from ultralytics import YOLO

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default="yolo11n.pt")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--workers", type=int, default=2)   # Windows 下不要设太大
    ap.add_argument("--project", default="runs")
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", required=True)              # metrics.jsonl
    a = ap.parse_args()

    model = YOLO(a.model)
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    def on_epoch_end(trainer):
        m = trainer.metrics
        rec = {
            "epoch": trainer.epoch + 1,
            "map50": float(getattr(m, "box", None) and m.box.map50 or 0),
            "map": float(getattr(m, "box", None) and m.box.map or 0),
            "ts": time.time(),
        }
        with out_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    model.add_callback("on_fit_epoch_end", on_epoch_end)
    results = model.train(data=a.data, epochs=a.epochs, imgsz=a.imgsz,
                          batch=a.batch, workers=a.workers,
                          project=a.project, name=a.name, device=0, amp=True)
    print("best:", results.save_dir)
```

`scripts/smoke_train.py`

```python
import subprocess, sys, time
from pathlib import Path

name = "smoke"
out = Path("runs/logs") / f"{name}.jsonl"
subprocess.run([sys.executable, "-m", "core.train.worker",
                "--data", "data/datasets/smoke/data.yaml",
                "--model", "yolo11n.pt", "--epochs", "2",
                "--batch", "8", "--workers", "2",
                "--project", "runs", "--name", name,
                "--out", str(out)], check=True)
print("metrics:", out.read_text(encoding="utf-8"))
print("best pt :", list(Path("runs").rglob("best.pt")))
```

**独立验证**：跑 2 个 epoch 完成，`metrics.jsonl` 有 2 行，`runs/**/best.pt` 存在。**这一步先只求跑通，不追求精度。**

**硬件建议（RTX 4060 Laptop 8GB）**：`imgsz=640`、`yolo11n/s` 用 `batch=8~16`；Windows 下 `workers` 保持 `0~2`，设大了 spawn 容易卡死。

---

### S4 · 推理引擎

| 项 | 内容 |
|---|---|
| **目标** | 图像 / 视频 / 目录批量推理，结果结构化落盘，支持权重热切换 |
| **前置依赖** | S3（有 best.pt） |
| **产出物** | `core/infer/predictor.py`、`render.py`、`infer_service.py` |
| **核心代码** | `backend/core/infer/predictor.py` |

`backend/core/infer/predictor.py`

```python
from dataclasses import dataclass, asdict
from pathlib import Path
import json
from ultralytics import YOLO

@dataclass
class Det:
    cls: int
    conf: float
    xyxy: list[float]

class Predictor:
    def __init__(self, weights: str, device: str = "0"):
        self.model = YOLO(weights)
        self.device = device
        self.names = self.model.names

    def predict_image(self, img_path: Path) -> list[Det]:
        r = self.model(str(img_path), device=self.device, verbose=False)[0]
        return [Det(int(b.cls), float(b.conf), [round(v, 2) for v in b.xyxy[0].tolist()])
                for b in r.boxes]

    def predict_video(self, video: Path, out: Path, stride: int = 1):
        import cv2
        cap = cv2.VideoCapture(str(video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        idx, results = 0, []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % stride == 0:
                r = self.model(frame, device=self.device, verbose=False)[0]
                results.append({"frame": idx, "dets": [asdict(d) for d in self._to_dets(r)]})
                frame = r.plot()
            writer.write(frame)
            idx += 1
        cap.release(); writer.release()
        (out.with_suffix(".json")).write_text(json.dumps(results, ensure_ascii=False), encoding="utf-8")
        return {"frames": idx, "annotated": str(out)}

    def _to_dets(self, r):
        return [Det(int(b.cls), float(b.conf), [round(v, 2) for v in b.xyxy[0].tolist()])
                for b in r.boxes]
```

`scripts/smoke_infer.py`

```python
from pathlib import Path
from core.infer.predictor import Predictor

p = Predictor("runs/detect/smoke/weights/best.pt")
print("image:", p.predict_image(Path("samples/test.jpg"))[:3])
print("video:", p.predict_video(Path("samples/demo.mp4"), Path("storage/out.mp4"), stride=5))
```

**独立验证**：输出带框图片/视频 + 对应 JSON，帧数与原视频一致。

---

### S5 · 评估模块

| 项 | 内容 |
|---|---|
| **目标** | mAP / PR 曲线 / 混淆矩阵 / 每类指标 / 多权重横向对比 |
| **前置依赖** | S3（权重）+ S2（val 集） |
| **产出物** | `core/eval/metrics.py`、`eval_service.py`、评估报告 JSON |
| **核心代码** | `backend/core/eval/metrics.py` |

`backend/core/eval/metrics.py`

```python
import json
from pathlib import Path
from ultralytics import YOLO

def evaluate(weights: str, data_yaml: str, imgsz: int = 640, split: str = "val") -> dict:
    model = YOLO(weights)
    m = model.val(data=data_yaml, imgsz=imgsz, split=split, device=0, verbose=False)
    box = m.box
    report = {
        "weights": weights,
        "map50": round(float(box.map50), 4),
        "map": round(float(box.map), 4),
        "per_class": {
            model.names[int(c)]: {
                "map50": round(float(box.ap50[i]), 4),
                "map": round(float(box.ap[i]), 4),
            }
            for i, c in enumerate(box.ap_class_index.tolist())
        },
    }
    out = Path("storage/reports") / f"{Path(weights).parent.parent.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
```

**独立验证**：`python scripts/smoke_eval.py` 输出 `map50`、`map` 数值，且 `storage/reports/*.json` 生成。即使数据集很小、mAP 很低也没关系——**本阶段只验证流程，不验证效果**。

---

### S6 · 可视化与接口封装

| 项 | 内容 |
|---|---|
| **目标** | 四个前端面板 + 完整 REST + WebSocket 推送训练进度 |
| **前置依赖** | S5（各模块 core 层均已验证） |
| **产出物** | `routers/*` 完整实现、`frontend/` 五个页面、WS 推送 |
| **核心代码** | `backend/app/routers/training.py`、`frontend/train.html` |

**顺序建议**：先把所有 `core/` 能力包成 REST（此时前端可先用 Swagger 验证），再写页面。这样前后端问题不会互相掩盖。

训练进度推送（最小版）：

```python
# routers/training.py
from fastapi import APIRouter, BackgroundTasks
from app.services.train_service import start_run, read_metrics, list_runs

router = APIRouter(prefix="/api/training", tags=["training"])

@router.post("/runs")
def create_run(dataset_id: int, model: str = "yolo11n.pt", epochs: int = 50):
    return start_run(dataset_id=dataset_id, model=model, epochs=epochs)

@router.get("/runs")
def get_runs():
    return list_runs()

@router.get("/runs/{run_id}/metrics")
def get_metrics(run_id: int):
    return read_metrics(run_id)      # 读 metrics.jsonl，返回曲线数组
```

前端四个面板职责：

| 页面 | 内容 |
|---|---|
| `dataset.html` | 数据集列表、类别分布、切分比例、图片抽样预览 |
| `train.html` | 新建训练任务、实时 loss/mAP 曲线（ECharts）、日志流 |
| `infer.html` | 选权重 + 上传图片/视频 → 渲染结果 + JSON |
| `report.html` | mAP 对比柱状图、PR 曲线、每类指标表、混淆矩阵 |

**独立验证**：浏览器走完整链路——选数据集 → 起训练 → 看曲线 → 推理一张图 → 看报告。

---

### S7 · 导出与部署

| 项 | 内容 |
|---|---|
| **目标** | ONNX / TensorRT 导出、加速推理验证、Docker 化 |
| **前置依赖** | S6 |
| **产出物** | `core/export/exporter.py`、`Dockerfile`、`docker-compose.yml` |
| **核心代码** | `backend/core/export/exporter.py` |

```python
from pathlib import Path
from ultralytics import YOLO

def export(weights: str, fmt: str = "onnx", imgsz: int = 640) -> Path:
    model = YOLO(weights)
    out = model.export(format=fmt, imgsz=imgsz, device=0)
    return Path(out)
```

**独立验证**：导出 ONNX 后用 `onnxruntime` 跑同一张图，与 `.pt` 结果的框数和置信度差异在可接受范围内（< 1e-2）。

---

## 四、阶段依赖与阻塞项

| 阶段 | 依赖 | 是否阻塞 | 卡住会怎样 |
|---|---|---|---|
| **S0 环境** | — | 🔴 **阻塞** | CUDA 不可用 → 训练无法启动 |
| **S1 骨架** | S0 | 🔴 **阻塞** | 无配置/DB → 后续全部无法持久化 |
| **S2 数据集** | S1 | 🔴🔴 **最高阻塞** | 无可用 data.yaml → S3/S4/S5 全停 |
| S3 训练 | S2 | 否 | 可先用官方 coco8 临时替代 |
| S4 推理 | S3 | 否 | 可先用官方 `yolo11n.pt` 预训练权重验证，不必等自己训的权重 |
| S5 评估 | S3 + S2 | 否 | 同上，可用官方权重跑 val |
| S6 可视化 | S5 | 否 | 可先用 Swagger 顶着 |
| S7 导出部署 | S6 | 否 | 最后做 |

### 三条硬性纪律

1. **每个阶段必须先跑冒烟脚本再进下一阶段**。`scripts/smoke_*.py` 是一等公民，不是附属品。
2. **S4/S5 不等 S3**。用官方预训练权重先把推理和评估链路跑通，等自训权重出来再替换——这条能省掉大量串行等待。
3. **core 层不许 import app 层**。方向只能是 `app → core`。这条约束保证 core 能在 CLI 下独立验证。

---

## 五、里程碑清单

| 编号 | 里程碑 | 验收标准 | 涉及阶段 |
|---|---|---|---|
| M1 | 环境就绪 | `verify_env.py` 打印 `cuda: True`，能跑通一次官方推理 | S0 |
| M2 | 骨架可用 | `GET /health` 返回 ok，`platform.db` 生成 | S1 |
| M3 | **数据集闭环** | 导入→切分→校验→`data.yaml` 全流程通过，问题列表为空 | S2 |
| M4 | **训练跑通** | 2 epoch 完成，`metrics.jsonl` 有数据，`best.pt` 产出 | S3 |
| M5 | 推理可用 | 图像/视频均能出结果 JSON + 渲染产物 | S4 |
| M6 | 评估可用 | 产出含 map50/map/每类指标的报告 JSON | S5 |
| M7 | **主干全通** | 浏览器走完 选数据集→训练→推理→看报告 | S6 |
| M8 | 可交付 | ONNX 导出成功，Docker 能起，结果一致 | S7 |

**主干优先级**：M1 → M2 → M3 → M4 → M5 → M7 是必须打通的主干，M6、M8 可在主干通后补。

---

## 六、已知坑与规避

| 坑 | 表现 | 规避 |
|---|---|---|
| torch 装成 CPU 版 | `cuda.is_available() = False` | S0 强校验，assert 失败直接中断 |
| Windows dataloader workers | 训练卡死在第一个 epoch | `workers` 保持 0~2 |
| 8GB 显存 OOM | batch 过大直接崩 | n/s 模型 batch 8~16，开 `amp=True` |
| 标注越界或空标签 | 训练 loss 为 nan 或 mAP 恒为 0 | S2 的 `validate_yolo` 前置拦截 |
| 路径中文/空格 | 数据加载失败 | 数据集目录只用 ASCII 命名 |
| 数据库存大文件 | platform.db 暴涨 | 严格只存路径与指标 |
| 训练阻塞 API | 服务无响应 | 必须走子进程，不要在同进程里调 `model.train()` |

---

## 七、与毕业设计的关系（重要，别走偏）

如果你最终还要落到"教育场景"的毕设，这个平台**不是替代品，而是底座**：

- 教育场景 = 平台里的**一个数据集 + 一个训练任务 + 一套推理配置**
- 之前设计的 `SceneState` 抽象层 = 在 S4 推理之后接的一层**场景解释器**，不属于平台核心，可作为插件
- Agent 决策层 = 消费 S4 的结构化推理结果，同样是外挂

**建议顺序：先把这个平台的主干打通（M1–M5），再往上面叠教育场景。** 反过来先做场景、后补平台的做法，会在数据集管理和实验复现上反复返工。

---

## 八、下一步

建议立刻从 **S0** 开始，且只做两件事：

1. 换装 CUDA 版 torch（当前是 `+cpu`，这是硬阻塞）
2. 跑通 `scripts/verify_env.py`

这两步不到一小时，做完 S0、S1 就能直接落地。要我现在就帮你把 S1 的目录骨架和最小可运行代码建起来吗？

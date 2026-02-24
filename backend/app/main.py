import logging
import os
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .ai import apply_ai_explanations
from .analysis import DEFAULT_EXTS, analyze_project
from .analysis_store import analysis_exists, load_analysis, save_analysis
from .history import (
    init_history_db,
    list_history,
    record_history_error,
    record_history_finish,
    record_history_start,
)


def setup_logging():
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    logger = logging.getLogger("svn_merge_annotator")
    if not logger.handlers:
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.setLevel(log_level)
    logger.propagate = False
    return logger


LOGGER = setup_logging()

try:
    init_history_db()
except Exception as exc:
    LOGGER.exception("history_db_init_failed: %s", exc)

app = FastAPI(title="SVN Merge Annotator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/pick-dir")
def pick_dir():
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askdirectory()
        root.destroy()
        return {"path": path or ""}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Pick directory failed: {exc}")


class AnalyzeRequest(BaseModel):
    branch_dir: str
    trunk_dir: str
    merge_dir: str
    base_dir: str | None = None
    extensions: list[str] | None = None


class AIExplain(BaseModel):
    reason: str
    merge_reason: str = ""
    impact: str = ""
    risk: str = ""
    note: str = "AI推断"
    source: str | None = None
    updated_at: str | None = None


class AIAnnotateItem(BaseModel):
    path: str
    start: int
    end: int
    explain: AIExplain


class AIAnnotateRequest(BaseModel):
    analysis_id: str
    items: list[AIAnnotateItem] = []


ANALYSIS_STORE = {}
ANALYSIS_PROGRESS = {}
ANALYSIS_LOCK = threading.Lock()


def set_progress(analysis_id, **kwargs):
    with ANALYSIS_LOCK:
        current = ANALYSIS_PROGRESS.get(analysis_id, {})
        current.update(kwargs)
        ANALYSIS_PROGRESS[analysis_id] = current


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def get_analysis_data(analysis_id: str):
    analysis = ANALYSIS_STORE.get(analysis_id)
    if analysis is None:
        analysis = load_analysis(analysis_id)
        if analysis is not None:
            ANALYSIS_STORE[analysis_id] = analysis
    return analysis


def has_ai_explain(ai_explain: dict | None) -> bool:
    if not ai_explain:
        return False
    return bool(
        ai_explain.get("merge_reason")
        or ai_explain.get("reason")
        or ai_explain.get("impact")
        or ai_explain.get("risk")
        or ai_explain.get("note")
        or ai_explain.get("source")
        or ai_explain.get("updated_at")
    )


def has_risk(ai_explain: dict | None) -> bool:
    if not ai_explain:
        return False
    risk = ai_explain.get("risk")
    if risk is None:
        return False
    return bool(str(risk).strip())


def build_summary(analysis: dict) -> dict:
    cached = analysis.get("_summary")
    if cached:
        return cached
    files = analysis.get("files") or []
    file_map = analysis.get("file_map") or {}
    summary_files = []
    totals = {
        "file_total": 0,
        "file_annotated": 0,
        "file_risk": 0,
        "block_total": 0,
        "block_annotated": 0,
        "block_risk": 0,
        "block_manual": 0,
        "block_conflict": 0,
    }
    for item in files:
        rel_path = item.get("path")
        if not rel_path:
            continue
        file_data = file_map.get(rel_path) or {}
        blocks = file_data.get("blocks") or []
        block_total = len(blocks)
        annotated_blocks = 0
        risk_blocks = 0
        manual_blocks = 0
        conflict_blocks = 0
        for block in blocks:
            ai_explain = block.get("ai_explain")
            if has_ai_explain(ai_explain):
                annotated_blocks += 1
            if has_risk(ai_explain):
                risk_blocks += 1
            if ai_explain and ai_explain.get("source") == "manual":
                manual_blocks += 1
            if block.get("origin") == "conflict":
                conflict_blocks += 1
        has_annotated = annotated_blocks > 0
        has_risk_flag = risk_blocks > 0
        summary_files.append(
            {
                "path": rel_path,
                "block_total": block_total,
                "annotated_blocks": annotated_blocks,
                "risk_blocks": risk_blocks,
                "manual_blocks": manual_blocks,
                "conflict_blocks": conflict_blocks,
                "has_annotated": has_annotated,
                "has_risk": has_risk_flag,
            }
        )
        totals["file_total"] += 1
        totals["block_total"] += block_total
        totals["block_annotated"] += annotated_blocks
        totals["block_risk"] += risk_blocks
        totals["block_manual"] += manual_blocks
        totals["block_conflict"] += conflict_blocks
        if has_annotated:
            totals["file_annotated"] += 1
        if has_risk_flag:
            totals["file_risk"] += 1
    summary = {"files": summary_files, "totals": totals}
    analysis["_summary"] = summary
    return summary


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    for path in (req.branch_dir, req.trunk_dir, req.merge_dir):
        if not os.path.isdir(path):
            raise HTTPException(status_code=400, detail=f"Invalid directory: {path}")
    if req.base_dir and not os.path.isdir(req.base_dir):
        raise HTTPException(status_code=400, detail=f"Invalid directory: {req.base_dir}")
    analysis_id = str(uuid.uuid4())
    set_progress(
        analysis_id,
        state="running",
        stage="start",
        total=0,
        current=0,
        percent=0.0,
        path="",
        message="starting",
        started_at=now_iso(),
    )
    try:
        record_history_start(
            analysis_id,
            req.branch_dir,
            req.trunk_dir,
            req.merge_dir,
            req.base_dir,
        )
    except Exception as exc:
        LOGGER.exception("history_start_failed: %s", exc)

    def worker():
        try:
            def progress_callback(info):
                total = info.get("total", 0) or 0
                current = info.get("current", 0) or 0
                percent = round((current / total) * 100, 1) if total else 0.0
                set_progress(
                    analysis_id,
                    state="running",
                    stage=info.get("stage", ""),
                    total=total,
                    current=current,
                    percent=percent,
                    path=info.get("path", ""),
                    elapsed=info.get("elapsed", 0),
                    file_elapsed=info.get("file_elapsed", 0),
                )

            analysis = analyze_project(
                req.branch_dir,
                req.trunk_dir,
                req.merge_dir,
                extensions=req.extensions or list(DEFAULT_EXTS),
                base_dir=req.base_dir,
                progress_callback=progress_callback,
            )
            ANALYSIS_STORE[analysis_id] = analysis
            total = len(analysis["files"])
            try:
                save_analysis(analysis_id, analysis)
            except Exception as exc:
                LOGGER.exception("analysis_store_failed: %s", exc)
            try:
                record_history_finish(analysis_id, total)
            except Exception as exc:
                LOGGER.exception("history_finish_failed: %s", exc)
            set_progress(
                analysis_id,
                state="done",
                stage="done",
                total=total,
                current=total,
                percent=100.0,
                path="",
                finished_at=now_iso(),
            )
        except Exception as exc:
            try:
                record_history_error(analysis_id, str(exc))
            except Exception as error_exc:
                LOGGER.exception("history_error_failed: %s", error_exc)
            set_progress(
                analysis_id,
                state="error",
                stage="error",
                message=str(exc),
                finished_at=now_iso(),
            )
            LOGGER.exception("analysis_failed: %s", analysis_id)

    threading.Thread(target=worker, daemon=True).start()
    return {
        "analysis_id": analysis_id,
        "state": "running",
    }


@app.get("/api/status")
def status(analysis_id: str):
    progress = ANALYSIS_PROGRESS.get(analysis_id)
    if not progress:
        raise HTTPException(status_code=404, detail="analysis_id not found")
    return progress


@app.get("/api/history")
def history(limit: int = 50, offset: int = 0):
    safe_limit = max(1, min(limit or 50, 200))
    safe_offset = max(0, offset or 0)
    try:
        items = list_history(limit=safe_limit, offset=safe_offset)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"History load failed: {exc}")
    for item in items:
        item["available"] = item["id"] in ANALYSIS_STORE or analysis_exists(item["id"])
    return {"items": items}


@app.get("/api/files")
def files(analysis_id: str):
    analysis = get_analysis_data(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="analysis_id not found")
    return {"files": analysis["files"], "roots": analysis.get("roots", {})}


@app.get("/api/summary")
def summary(analysis_id: str):
    analysis = get_analysis_data(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="analysis_id not found")
    return build_summary(analysis)


@app.get("/api/file")
def file_detail(analysis_id: str, path: str):
    analysis = get_analysis_data(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="analysis_id not found")
    file_data = analysis["file_map"].get(path)
    if not file_data:
        raise HTTPException(status_code=404, detail="file not found in analysis")
    return file_data


@app.post("/api/ai/annotate")
def ai_annotate(req: AIAnnotateRequest):
    analysis = get_analysis_data(req.analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="analysis_id not found")
    result = apply_ai_explanations(analysis, [item.model_dump() for item in req.items])
    if result.get("updated"):
        analysis.pop("_summary", None)
        try:
            save_analysis(req.analysis_id, analysis)
        except Exception as exc:
            LOGGER.exception("analysis_store_failed: %s", exc)
    return result


@app.post("/api/ai/explain")
def ai_explain_deprecated():
    raise HTTPException(
        status_code=501,
        detail="AI explain is handled by Codex. Use /api/ai/annotate.",
    )

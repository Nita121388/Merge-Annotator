import json
import os
import threading
from typing import Any, Dict


STORE_ENV_KEY = "ANALYSIS_STORE_DIR"
DEFAULT_STORE_DIR = "analysis_store"
STORE_LOCK = threading.Lock()


def get_store_dir():
    env = os.getenv(STORE_ENV_KEY, "").strip()
    if env:
        return env
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(base_dir, DEFAULT_STORE_DIR)


def ensure_store_dir():
    path = get_store_dir()
    os.makedirs(path, exist_ok=True)
    return path


def get_analysis_path(analysis_id: str) -> str:
    safe_id = analysis_id.replace("/", "_").replace("\\", "_")
    return os.path.join(ensure_store_dir(), f"{safe_id}.json")


def save_analysis(analysis_id: str, analysis: Dict[str, Any]) -> str:
    path = get_analysis_path(analysis_id)
    temp_path = f"{path}.tmp"
    with STORE_LOCK:
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(analysis, handle, ensure_ascii=False)
        os.replace(temp_path, path)
    return path


def load_analysis(analysis_id: str) -> Dict[str, Any] | None:
    path = get_analysis_path(analysis_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def analysis_exists(analysis_id: str) -> bool:
    path = get_analysis_path(analysis_id)
    return os.path.exists(path)

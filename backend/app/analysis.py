import logging
import os
import shutil
import subprocess
import time
from difflib import SequenceMatcher


DEFAULT_EXTS = {
    ".py",
    ".cs",
    ".ts",
    ".js",
    ".jsx",
    ".tsx",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".ini",
    ".cfg",
    ".conf",
    ".md",
    ".txt",
}

PROGRESS_EVERY = int(os.getenv("ANALYSIS_LOG_EVERY", "10"))
if PROGRESS_EVERY < 1:
    PROGRESS_EVERY = 1
MAX_FILE_BYTES = int(os.getenv("ANALYSIS_MAX_FILE_BYTES", "2097152"))
DISABLE_BLAME = os.getenv("ANALYSIS_DISABLE_BLAME", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
DISABLE_SVN = os.getenv("ANALYSIS_DISABLE_SVN", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

logger = logging.getLogger("svn_merge_annotator.analysis")


def should_skip_blame(rel_path):
    normalized = rel_path.replace("\\", "/").lower()
    return normalized.startswith("release/bin/")


def collect_files_under(root_dir, merge_dir, exts):
    results = []
    for dirpath, _, filenames in os.walk(root_dir):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if exts and ext not in exts:
                continue
            abs_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(abs_path, merge_dir)
            results.append(rel_path)
    return results


def svn_diff_summarize(old_path, new_path):
    if not old_path or not new_path:
        return None
    if not os.path.exists(old_path) or not os.path.exists(new_path):
        return None
    try:
        result = subprocess.run(
            ["svn", "diff", "--summarize", "--old", old_path, "--new", new_path],
            capture_output=True,
            text=False,
            check=False,
        )
    except Exception:
        return None
    if result.returncode not in (0, 1):
        return None
    output = result.stdout or b""
    try:
        decoded = output.decode("utf-8")
    except UnicodeDecodeError:
        try:
            decoded = output.decode("gbk")
        except UnicodeDecodeError:
            decoded = output.decode("utf-8", errors="replace")
    paths = set()
    for raw_line in decoded.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        paths.add(parts[-1])
    return paths


def collect_changed_files(branch_dir, trunk_dir, merge_dir, exts, file_scope="trunk"):
    trunk_changed = svn_diff_summarize(trunk_dir, merge_dir)
    branch_changed = svn_diff_summarize(branch_dir, merge_dir)
    if trunk_changed is None and branch_changed is None:
        return None
    merge_root = os.path.normpath(merge_dir)
    scope = (file_scope or "trunk").lower().strip()
    changed = set()
    if scope in ("trunk", "merge_vs_trunk", "trunk_only"):
        if trunk_changed is None:
            logger.warning("trunk diff 失败，回退为并集筛选")
            if trunk_changed:
                changed.update(trunk_changed)
            if branch_changed:
                changed.update(branch_changed)
        else:
            changed.update(trunk_changed)
    elif scope in ("branch", "merge_vs_branch", "branch_only"):
        if branch_changed is None:
            logger.warning("branch diff 失败，回退为并集筛选")
            if trunk_changed:
                changed.update(trunk_changed)
            if branch_changed:
                changed.update(branch_changed)
        else:
            changed.update(branch_changed)
    else:
        if trunk_changed:
            changed.update(trunk_changed)
        if branch_changed:
            changed.update(branch_changed)
    results = set()
    for path in changed:
        rel_path = resolve_rel_path(path, merge_dir, trunk_dir, branch_dir)
        if not rel_path:
            continue
        abs_path = os.path.join(merge_root, rel_path)
        if not os.path.exists(abs_path):
            continue
        if os.path.isdir(abs_path):
            logger.info("skip_dir_change: %s", rel_path)
            continue
        ext = os.path.splitext(abs_path)[1].lower()
        if exts and ext not in exts:
            continue
        results.add(rel_path)
    return sorted(results)


def resolve_rel_path(path, merge_dir, trunk_dir, branch_dir):
    if not path:
        return None
    if os.path.isabs(path):
        path_norm = os.path.normpath(path)
        for root in (merge_dir, trunk_dir, branch_dir):
            root_norm = os.path.normpath(root)
            try:
                if os.path.commonpath([root_norm, path_norm]) == root_norm:
                    return os.path.relpath(path_norm, root_norm)
            except ValueError:
                continue
        return None
    candidate = path.replace("/", os.sep)
    for root in (merge_dir, trunk_dir, branch_dir):
        root_norm = os.path.normpath(root)
        abs_path = os.path.abspath(os.path.join(root_norm, candidate))
        try:
            if os.path.commonpath([root_norm, abs_path]) != root_norm:
                continue
        except ValueError:
            continue
        if os.path.exists(abs_path):
            return os.path.relpath(abs_path, root_norm)
    return None


def log_step_start(rel_path, step_name):
    logger.info("step_start: %s - %s", rel_path, step_name)
    return time.perf_counter()


def log_step_end(rel_path, step_name, start_time):
    elapsed = time.perf_counter() - start_time
    logger.info("step_end: %s - %s - %.2fs", rel_path, step_name, elapsed)


def analyze_project(
    branch_dir,
    trunk_dir,
    merge_dir,
    extensions=None,
    base_dir=None,
    progress_callback=None,
):
    exts = set((extensions or DEFAULT_EXTS))
    exts = {e.lower() for e in exts}
    files = []
    file_map = {}
    only_changed = os.getenv("ANALYSIS_ONLY_CHANGED", "1") != "0"
    file_scope = os.getenv("ANALYSIS_FILE_SCOPE", "trunk").strip()
    if only_changed:
        rel_paths = collect_changed_files(
            branch_dir, trunk_dir, merge_dir, exts, file_scope=file_scope
        )
        if rel_paths is None:
            logger.warning("仅分析改动文件失败，回退为全量扫描")
            rel_paths = collect_files(merge_dir, exts)
        else:
            logger.info("仅分析改动文件: %d (scope=%s)", len(rel_paths), file_scope)
    else:
        rel_paths = collect_files(merge_dir, exts)
    total = len(rel_paths)
    logger.info(
        "开始分析: files=%d, branch=%s, trunk=%s, merge=%s",
        total,
        branch_dir,
        trunk_dir,
        merge_dir,
    )
    start_time = time.perf_counter()
    if progress_callback:
        progress_callback(
            {
                "stage": "start",
                "total": total,
                "current": 0,
                "path": "",
                "elapsed": 0,
                "file_elapsed": 0,
            }
        )
    if total == 0:
        logger.info("未发现可分析文件")
    for idx, rel_path in enumerate(rel_paths, start=1):
        file_start = time.perf_counter()
        file_data = analyze_file(rel_path, branch_dir, trunk_dir, merge_dir, base_dir)
        files.append(file_data["summary"])
        file_map[rel_path] = file_data
        if file_data["summary"].get("error"):
            logger.warning(
                "读取文件失败: %s - %s", rel_path, file_data["summary"]["error"]
            )
        if idx == 1 or idx == total or idx % PROGRESS_EVERY == 0:
            elapsed = time.perf_counter() - start_time
            file_elapsed = time.perf_counter() - file_start
            percent = (idx / total) * 100 if total else 0
            logger.info(
                "分析进度 %d/%d (%.1f%%) - %s - 本文件耗时 %.2fs - 总耗时 %.2fs",
                idx,
                total,
                percent,
                rel_path,
                file_elapsed,
                elapsed,
            )
        if progress_callback:
            elapsed = time.perf_counter() - start_time
            file_elapsed = time.perf_counter() - file_start
            progress_callback(
                {
                    "stage": "file",
                    "total": total,
                    "current": idx,
                    "path": rel_path,
                    "elapsed": elapsed,
                    "file_elapsed": file_elapsed,
                }
            )
    files.sort(key=lambda item: item["path"])
    logger.info(
        "分析完成: files=%d, 总耗时=%.2fs", total, time.perf_counter() - start_time
    )
    if progress_callback:
        progress_callback(
            {
                "stage": "done",
                "total": total,
                "current": total,
                "path": "",
                "elapsed": time.perf_counter() - start_time,
                "file_elapsed": 0,
            }
        )
    return {
        "roots": {"branch": branch_dir, "trunk": trunk_dir, "merge": merge_dir},
        "files": files,
        "file_map": file_map,
    }


def collect_files(root_dir, exts):
    results = []
    for dirpath, _, filenames in os.walk(root_dir):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if exts and ext not in exts:
                continue
            abs_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(abs_path, root_dir)
            results.append(rel_path)
    return results


def analyze_file(rel_path, branch_dir, trunk_dir, merge_dir, base_dir=None):
    file_start = time.perf_counter()
    logger.info("file_start: %s", rel_path)
    merge_path = os.path.join(merge_dir, rel_path)
    branch_path = os.path.join(branch_dir, rel_path)
    trunk_path = os.path.join(trunk_dir, rel_path)
    base_path = os.path.join(base_dir, rel_path) if base_dir else None
    branch_exists = os.path.exists(branch_path)
    trunk_exists = os.path.exists(trunk_path)
    file_origin = resolve_file_origin(branch_exists, trunk_exists)

    if MAX_FILE_BYTES > 0:
        try:
            size_bytes = os.path.getsize(merge_path)
        except OSError:
            size_bytes = None
        if size_bytes and size_bytes > MAX_FILE_BYTES:
            logger.info("file_skip: %s - size=%d", rel_path, size_bytes)
            return {
                "path": rel_path,
                "summary": {
                    "path": rel_path,
                    "total_lines": 0,
                    "branch_lines": 0,
                    "trunk_lines": 0,
                    "common_lines": 0,
                    "manual_lines": 0,
                    "unknown_lines": 0,
                    "conflict_lines": 0,
                    "has_changes": True,
                    "error": f"skipped_large_file:{size_bytes}",
                    "skipped": True,
                    "size": size_bytes,
                    "file_origin": file_origin,
                },
                "versions": {"merge": [], "branch": [], "trunk": [], "base": []},
                "line_meta": [],
                "blocks": [],
                "svn": svn_info(merge_path),
            }

    step_start = log_step_start(rel_path, "read_text:merge")
    merge_text, merge_error = read_text(merge_path)
    log_step_end(rel_path, "read_text:merge", step_start)

    if branch_exists:
        step_start = log_step_start(rel_path, "read_text:branch")
        branch_text, _ = read_text(branch_path)
        log_step_end(rel_path, "read_text:branch", step_start)
    else:
        branch_text = ""

    if trunk_exists:
        step_start = log_step_start(rel_path, "read_text:trunk")
        trunk_text, _ = read_text(trunk_path)
        log_step_end(rel_path, "read_text:trunk", step_start)
    else:
        trunk_text = ""

    if base_path and os.path.exists(base_path):
        step_start = log_step_start(rel_path, "read_text:base")
        base_text, _ = read_text(base_path)
        log_step_end(rel_path, "read_text:base", step_start)
    else:
        base_text = ""

    merge_lines = split_lines(merge_text)
    branch_lines = split_lines(branch_text)
    trunk_lines = split_lines(trunk_text)
    base_lines = split_lines(base_text)

    step_start = log_step_start(rel_path, "build_equal_map:branch")
    branch_map = build_equal_map(merge_lines, branch_lines)
    log_step_end(rel_path, "build_equal_map:branch", step_start)

    step_start = log_step_start(rel_path, "build_equal_map:trunk")
    trunk_map = build_equal_map(merge_lines, trunk_lines)
    log_step_end(rel_path, "build_equal_map:trunk", step_start)

    if base_lines:
        step_start = log_step_start(rel_path, "build_equal_map:base")
        base_map = build_equal_map(merge_lines, base_lines)
        log_step_end(rel_path, "build_equal_map:base", step_start)
    else:
        base_map = {}

    if DISABLE_SVN:
        branch_changed = None
        trunk_changed = None
        base_merge_old, base_branch_old, base_trunk_old = (None, None, None)
        base_changed_merge = None
        base_changed_branch = None
        base_changed_trunk = None
    else:
        step_start = log_step_start(rel_path, "svn_diff_changed_lines:branch")
        branch_changed = svn_diff_changed_lines(branch_path, merge_path, len(merge_lines))
        log_step_end(rel_path, "svn_diff_changed_lines:branch", step_start)

        step_start = log_step_start(rel_path, "svn_diff_changed_lines:trunk")
        trunk_changed = svn_diff_changed_lines(trunk_path, merge_path, len(merge_lines))
        log_step_end(rel_path, "svn_diff_changed_lines:trunk", step_start)

        if base_path:
            step_start = log_step_start(rel_path, "svn_diff_changed:base_merge")
            base_merge_old, _ = svn_diff_changed(base_path, merge_path)
            log_step_end(rel_path, "svn_diff_changed:base_merge", step_start)

            step_start = log_step_start(rel_path, "svn_diff_changed:base_branch")
            base_branch_old, _ = svn_diff_changed(base_path, branch_path)
            log_step_end(rel_path, "svn_diff_changed:base_branch", step_start)

            step_start = log_step_start(rel_path, "svn_diff_changed:base_trunk")
            base_trunk_old, _ = svn_diff_changed(base_path, trunk_path)
            log_step_end(rel_path, "svn_diff_changed:base_trunk", step_start)
        else:
            base_merge_old, base_branch_old, base_trunk_old = (None, None, None)

        base_changed_merge = (
            svn_diff_changed_lines(base_path, merge_path, len(merge_lines))
            if base_path and os.path.exists(base_path)
            else None
        )
        base_changed_branch = (
            svn_diff_changed_lines(base_path, branch_path, len(branch_lines))
            if base_path and os.path.exists(base_path)
            else None
        )
        base_changed_trunk = (
            svn_diff_changed_lines(base_path, trunk_path, len(trunk_lines))
            if base_path and os.path.exists(base_path)
            else None
        )
    if DISABLE_BLAME:
        logger.info("step_skip: %s - svn_blame_disabled", rel_path)
        blame_lines = None
    elif should_skip_blame(rel_path):
        logger.info("step_skip: %s - svn_blame", rel_path)
        blame_lines = None
    else:
        step_start = log_step_start(rel_path, "svn_blame")
        blame_lines = svn_blame(merge_path)
        log_step_end(rel_path, "svn_blame", step_start)

    if DISABLE_SVN:
        conflict_details = None
        conflict_lines = None
    else:
        step_start = log_step_start(rel_path, "diff3_conflict_details")
        conflict_details = diff3_conflict_details(
            base_path, branch_path, trunk_path, merge_lines
        )
        log_step_end(rel_path, "diff3_conflict_details", step_start)
        conflict_lines = conflict_details["lines"] if conflict_details else None

    line_meta = []
    counts = {
        "branch": 0,
        "trunk": 0,
        "common": 0,
        "manual": 0,
        "unknown": 0,
        "conflict": 0,
    }

    for idx, _ in enumerate(merge_lines):
        branch_idx = branch_map.get(idx)
        trunk_idx = trunk_map.get(idx)
        base_idx = base_map.get(idx)
        if conflict_lines is not None and (idx + 1) in conflict_lines:
            origin = "conflict"
        elif base_idx is not None and base_merge_old is not None:
            base_no = base_idx + 1
            changed_merge = base_no in base_merge_old
            changed_branch = base_no in base_branch_old if base_branch_old is not None else None
            changed_trunk = base_no in base_trunk_old if base_trunk_old is not None else None
            origin = resolve_origin_with_base(
                changed_merge,
                changed_branch,
                changed_trunk,
                branch_idx,
                trunk_idx,
            )
        elif branch_changed is not None and trunk_changed is not None:
            changed_branch = (idx + 1) in branch_changed
            changed_trunk = (idx + 1) in trunk_changed
            origin = resolve_origin_by_change(changed_branch, changed_trunk)
        else:
            origin = resolve_origin(branch_idx, trunk_idx)
        counts[origin] += 1
        line_meta.append(
            {
                "merge_no": idx + 1,
                "origin": origin,
                "branch_no": branch_idx + 1 if branch_idx is not None else None,
                "trunk_no": trunk_idx + 1 if trunk_idx is not None else None,
                "base_no": base_idx + 1 if base_idx is not None else None,
            }
        )

    step_start = log_step_start(rel_path, "build_blocks")
    blocks = build_blocks(
        line_meta, merge_lines, branch_lines, trunk_lines, blame_lines, conflict_details
    )
    log_step_end(rel_path, "build_blocks", step_start)
    summary = {
        "path": rel_path,
        "total_lines": len(merge_lines),
        "branch_lines": counts["branch"],
        "trunk_lines": counts["trunk"],
        "common_lines": counts["common"],
        "manual_lines": counts["manual"],
        "unknown_lines": counts["unknown"],
        "conflict_lines": counts["conflict"],
        "has_changes": counts["branch"] + counts["trunk"] + counts["manual"] + counts["conflict"] > 0,
        "error": merge_error,
        "file_origin": file_origin,
    }

    logger.info("file_end: %s - %.2fs", rel_path, time.perf_counter() - file_start)

    return {
        "path": rel_path,
        "summary": summary,
        "versions": {
            "merge": merge_lines,
            "branch": branch_lines,
            "trunk": trunk_lines,
            "base": base_lines,
        },
        "line_meta": line_meta,
        "blocks": blocks,
        "svn": {"available": False, "error": "svn_disabled"}
        if DISABLE_SVN
        else svn_info(merge_path),
    }


def resolve_origin(branch_idx, trunk_idx):
    if branch_idx is not None and trunk_idx is not None:
        return "common"
    if branch_idx is not None:
        return "branch"
    if trunk_idx is not None:
        return "trunk"
    return "manual"


def resolve_file_origin(branch_exists, trunk_exists):
    if branch_exists and not trunk_exists:
        return "branch_new"
    if trunk_exists and not branch_exists:
        return "trunk_new"
    if not branch_exists and not trunk_exists:
        return "merge_only"
    return "shared"


def resolve_origin_by_change(changed_branch, changed_trunk):
    if not changed_branch and not changed_trunk:
        return "common"
    if not changed_branch and changed_trunk:
        return "branch"
    if changed_branch and not changed_trunk:
        return "trunk"
    return "manual"


def resolve_origin_with_base(
    changed_merge, changed_branch, changed_trunk, branch_idx, trunk_idx
):
    if changed_merge is False:
        return "common"
    if changed_merge is True:
        if changed_branch is False and changed_trunk is False:
            return "manual"
        if changed_branch is True and changed_trunk is False:
            return "branch" if branch_idx is not None else "manual"
        if changed_trunk is True and changed_branch is False:
            return "trunk" if trunk_idx is not None else "manual"
        if changed_branch is True and changed_trunk is True:
            if branch_idx is not None and trunk_idx is None:
                return "branch"
            if trunk_idx is not None and branch_idx is None:
                return "trunk"
            if branch_idx is not None and trunk_idx is not None:
                return "common"
            return "manual"
    return resolve_origin(branch_idx, trunk_idx)


def build_equal_map(a_lines, b_lines):
    if not a_lines or not b_lines:
        return {}
    matcher = SequenceMatcher(a=a_lines, b=b_lines, autojunk=False)
    mapping = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                mapping[i1 + offset] = j1 + offset
    return mapping


def build_blocks(
    line_meta, merge_lines, branch_lines, trunk_lines, blame_lines, conflict_details
):
    blocks = []
    if not line_meta:
        return blocks
    start_idx = 0
    current_origin = line_meta[0]["origin"]
    for idx in range(1, len(line_meta)):
        if line_meta[idx]["origin"] != current_origin:
            blocks.append(
                build_block(
                    line_meta,
                    merge_lines,
                    branch_lines,
                    trunk_lines,
                    blame_lines,
                    conflict_details,
                    start_idx,
                    idx - 1,
                    current_origin,
                )
            )
            start_idx = idx
            current_origin = line_meta[idx]["origin"]
    blocks.append(
        build_block(
            line_meta,
            merge_lines,
            branch_lines,
            trunk_lines,
            blame_lines,
            conflict_details,
            start_idx,
            len(line_meta) - 1,
            current_origin,
        )
    )
    return blocks


def build_block(
    line_meta,
    merge_lines,
    branch_lines,
    trunk_lines,
    blame_lines,
    conflict_details,
    start_idx,
    end_idx,
    origin,
):
    merge_start = line_meta[start_idx]["merge_no"]
    merge_end = line_meta[end_idx]["merge_no"]
    branch_numbers = [
        item["branch_no"]
        for item in line_meta[start_idx : end_idx + 1]
        if item["branch_no"] is not None
    ]
    base_numbers = [
        item["base_no"]
        for item in line_meta[start_idx : end_idx + 1]
        if item.get("base_no") is not None
    ]
    trunk_numbers = [
        item["trunk_no"]
        for item in line_meta[start_idx : end_idx + 1]
        if item["trunk_no"] is not None
    ]
    branch_start = min(branch_numbers) if branch_numbers else None
    branch_end = max(branch_numbers) if branch_numbers else None
    base_start = min(base_numbers) if base_numbers else None
    base_end = max(base_numbers) if base_numbers else None
    trunk_start = min(trunk_numbers) if trunk_numbers else None
    trunk_end = max(trunk_numbers) if trunk_numbers else None

    merge_text = "\n".join(merge_lines[merge_start - 1 : merge_end])
    branch_text = "\n".join(
        branch_lines[branch_start - 1 : branch_end] if branch_start else []
    )
    trunk_text = "\n".join(
        trunk_lines[trunk_start - 1 : trunk_end] if trunk_start else []
    )
    svn_summary = summarize_blame(blame_lines, merge_start, merge_end)

    confidence = 0.6
    if origin == "common":
        confidence = 0.95
    elif origin in ("branch", "trunk"):
        confidence = 0.9

    return {
        "start": merge_start,
        "end": merge_end,
        "origin": origin,
        "branch_start": branch_start,
        "branch_end": branch_end,
        "base_start": base_start,
        "base_end": base_end,
        "trunk_start": trunk_start,
        "trunk_end": trunk_end,
        "confidence": confidence,
        "diff": {"merge": merge_text, "branch": branch_text, "trunk": trunk_text},
        "conflict": summarize_conflict(conflict_details, merge_start, merge_end),
        "svn": svn_summary,
    }


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read(), None
    except UnicodeDecodeError:
        try:
            with open(path, "r", encoding="gbk") as handle:
                return handle.read(), None
        except Exception as exc:
            return "", str(exc)
    except Exception as exc:
        return "", str(exc)


def split_lines(text):
    if text is None:
        return []
    return text.splitlines()


def svn_info(path):
    try:
        result = subprocess.run(
            ["svn", "info", path],
            capture_output=True,
            text=False,
            check=True,
        )
    except Exception as exc:
        return {"available": False, "error": str(exc)}
    output = result.stdout or b""
    try:
        decoded = output.decode("utf-8")
    except UnicodeDecodeError:
        try:
            decoded = output.decode("gbk")
        except UnicodeDecodeError:
            decoded = output.decode("utf-8", errors="replace")
    info = {"available": True}
    for line in decoded.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        info[key.strip().lower().replace(" ", "_")] = value.strip()
    return info


def svn_blame(path):
    try:
        result = subprocess.run(
            ["svn", "blame", "-g", "-v", path],
            capture_output=True,
            text=False,
            check=True,
        )
    except Exception:
        return None
    output = result.stdout or b""
    try:
        decoded = output.decode("utf-8")
    except UnicodeDecodeError:
        try:
            decoded = output.decode("gbk")
        except UnicodeDecodeError:
            decoded = output.decode("utf-8", errors="replace")
    lines = []
    for raw_line in decoded.splitlines():
        lines.append(parse_blame_line(raw_line))
    return lines


def parse_blame_line(line):
    stripped = line.strip()
    if not stripped:
        return None
    parts = stripped.split()
    if len(parts) < 2:
        return None
    rev = parts[0]
    author = parts[1]
    date_tokens = []
    for token in parts[2:]:
        if token.startswith("("):
            break
        date_tokens.append(token)
    date_str = " ".join(date_tokens)
    return {"rev": rev, "author": author, "date": date_str}


def summarize_blame(blame_lines, start, end):
    if not blame_lines:
        return None
    counts = {}
    for idx in range(start - 1, end):
        if idx < 0 or idx >= len(blame_lines):
            continue
        info = blame_lines[idx]
        if not info:
            continue
        key = (info.get("rev"), info.get("author"), info.get("date"))
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return None
    best_key = max(counts.items(), key=lambda item: item[1])[0]
    return {
        "rev": best_key[0],
        "author": best_key[1],
        "date": best_key[2],
        "lines": counts[best_key],
        "source": "svn blame",
    }


def svn_diff_changed_lines(old_path, new_path, total_lines):
    if not os.path.exists(new_path):
        return None
    if not os.path.exists(old_path):
        return set(range(1, total_lines + 1))
    _, new_changed = svn_diff_changed(old_path, new_path)
    return new_changed


def svn_diff_changed(old_path, new_path):
    if not old_path or not new_path:
        return None, None
    if not os.path.exists(old_path) or not os.path.exists(new_path):
        return None, None
    try:
        result = subprocess.run(
            ["svn", "diff", "--old", old_path, "--new", new_path],
            capture_output=True,
            text=False,
            check=False,
        )
    except Exception:
        return None, None
    if result.returncode not in (0, 1):
        return None, None
    output = result.stdout or b""
    try:
        decoded = output.decode("utf-8")
    except UnicodeDecodeError:
        try:
            decoded = output.decode("gbk")
        except UnicodeDecodeError:
            decoded = output.decode("utf-8", errors="replace")
    return parse_unified_diff_changed(decoded)


def parse_unified_diff_changed(diff_text):
    changed_old = set()
    changed_new = set()
    old_line = 0
    new_line = 0
    for raw_line in diff_text.splitlines():
        if raw_line.startswith("@@"):
            old_line, new_line = parse_hunk_header(raw_line)
            continue
        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            changed_new.add(new_line)
            new_line += 1
            continue
        if raw_line.startswith("-") and not raw_line.startswith("---"):
            changed_old.add(old_line)
            old_line += 1
            continue
        if raw_line.startswith("\\"):
            continue
        if raw_line.startswith(" "):
            old_line += 1
            new_line += 1
            continue
    return changed_old, changed_new


def parse_hunk_header(header_line):
    old_start = 0
    new_start = 0
    parts = header_line.split()
    for part in parts:
        if part.startswith("-"):
            old_start = parse_hunk_start(part)
        elif part.startswith("+"):
            new_start = parse_hunk_start(part)
    return old_start, new_start


def parse_hunk_start(token):
    token = token[1:]
    if "," in token:
        token = token.split(",", 1)[0]
    try:
        return int(token)
    except ValueError:
        return 0


def find_diff3_command():
    cmd = os.getenv("SVN_MERGE_DIFF3", "").strip()
    if cmd:
        return cmd
    return shutil.which("diff3")


def diff3_conflict_details(base_path, branch_path, trunk_path, merge_lines):
    if not base_path or not branch_path or not trunk_path:
        return None
    if not os.path.exists(base_path):
        return None
    if not os.path.exists(branch_path) or not os.path.exists(trunk_path):
        return None
    cmd = find_diff3_command()
    if not cmd:
        return None
    try:
        result = subprocess.run(
            [cmd, "-m", base_path, branch_path, trunk_path],
            capture_output=True,
            text=False,
            check=False,
        )
    except Exception:
        return None
    if result.returncode not in (0, 1):
        return None
    output = result.stdout or b""
    try:
        decoded = output.decode("utf-8")
    except UnicodeDecodeError:
        try:
            decoded = output.decode("gbk")
        except UnicodeDecodeError:
            decoded = output.decode("utf-8", errors="replace")
    diff3_lines, conflict_flags, conflict_blocks = parse_diff3_output(decoded)
    mapped = map_conflict_to_merge(diff3_lines, conflict_flags, merge_lines)
    return {
        "lines": mapped,
        "blocks": conflict_blocks,
    }


def parse_diff3_output(text):
    lines = []
    flags = []
    conflict_blocks = []
    current_block = None
    in_conflict = False
    for raw_line in text.splitlines():
        if raw_line.startswith("<<<<<<<"):
            in_conflict = True
            current_block = {"left": [], "right": []}
            continue
        if raw_line.startswith("|||||||"):
            continue
        if raw_line.startswith("======="):
            if current_block is not None:
                current_block["split"] = len(current_block["left"])
            continue
        if raw_line.startswith(">>>>>>>"):
            in_conflict = False
            if current_block is not None:
                conflict_blocks.append(current_block)
            current_block = None
            continue
        if in_conflict and current_block is not None:
            current_block["left" if current_block.get("split") is None else "right"].append(
                raw_line
            )
        lines.append(raw_line)
        flags.append(in_conflict)
    return lines, flags, conflict_blocks


def map_conflict_to_merge(diff3_lines, conflict_flags, merge_lines):
    if not diff3_lines or not merge_lines:
        return None
    matcher = SequenceMatcher(a=diff3_lines, b=merge_lines, autojunk=False)
    conflict_lines = set()
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue
        for offset in range(i2 - i1):
            if conflict_flags[i1 + offset]:
                conflict_lines.add(j1 + offset + 1)
    return conflict_lines


def summarize_conflict(details, start, end):
    if not details or not details.get("lines"):
        return None
    in_block = any(start <= line_no <= end for line_no in details["lines"])
    if not in_block:
        return None
    block = details.get("blocks", [])
    if not block:
        return {"note": "conflict"}
    left_full = block[0].get("left", [])
    right_full = block[0].get("right", [])
    return {
        "note": "conflict",
        "left_preview": preview_lines(left_full),
        "right_preview": preview_lines(right_full),
        "left_full": left_full,
        "right_full": right_full,
        "left_count": len(left_full),
        "right_count": len(right_full),
    }


def preview_lines(lines, max_lines=6):
    if not lines:
        return []
    return list(lines[:max_lines])

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from urllib.parse import urlparse


def engine_config_path():
    local_appdata = os.getenv("LOCALAPPDATA")
    if not local_appdata:
        user_profile = os.getenv("USERPROFILE")
        if user_profile:
            local_appdata = os.path.join(user_profile, "AppData", "Local")
    if not local_appdata:
        return ""
    return os.path.join(
        local_appdata, "svn-merge-annotator", "engine", "engine.json"
    )


def load_engine_config():
    path = engine_config_path()
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


ENGINE_CONFIG = load_engine_config()
DEFAULT_API_BASE = (ENGINE_CONFIG.get("api_base") or "").strip() or "http://localhost:18000"
DEFAULT_UI_BASE = (ENGINE_CONFIG.get("ui_base") or "").strip() or "http://localhost:5173"


def cli_has_arg(flag):
    return flag in sys.argv


def run_npx_ensure():
    cmd = os.getenv(
        "SVN_MERGE_ANNOTATOR_NPX",
        "npx --yes @chemclin/svn-merge-annotator ensure",
    )
    try:
        result = subprocess.run(cmd, shell=True)
        return result.returncode == 0
    except Exception:
        return False


def ensure_engine_available(api_base):
    if health_check(api_base):
        return True
    print("分析服务不可用，尝试通过 npx 启动本地引擎...", file=sys.stderr)
    ok = run_npx_ensure()
    if not ok:
        return False
    return health_check(api_base)


def request_json(method, url, payload=None, timeout=None):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if timeout is None:
        resp_ctx = urllib.request.urlopen(req)
    else:
        resp_ctx = urllib.request.urlopen(req, timeout=timeout)
    with resp_ctx as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def health_check(api_base):
    try:
        request_json("GET", f"{api_base}/api/health", timeout=3)
        return True
    except Exception:
        return False


def wait_for_analysis(api_base, analysis_id, timeout_sec=120, heartbeat_sec=5):
    start_time = time.time()
    last_heartbeat = start_time
    while True:
        try:
            status = request_json(
                "GET",
                f"{api_base}/api/status?analysis_id={analysis_id}",
                timeout=5,
            )
        except Exception:
            status = None
        if status:
            state = status.get("state")
            if state == "done":
                return True
            if state == "error":
                message = status.get("message", "分析失败")
                print(f"分析失败: {message}", file=sys.stderr)
                return False
        now = time.time()
        if heartbeat_sec and now - last_heartbeat >= heartbeat_sec:
            elapsed = int(now - start_time)
            print(f"分析进行中... 已等待 {elapsed}s")
            last_heartbeat = now
        if now - start_time >= timeout_sec:
            status_hint = None
            try:
                status_hint = request_json(
                    "GET",
                    f"{api_base}/api/status?analysis_id={analysis_id}",
                    timeout=5,
                )
            except Exception:
                status_hint = None
            if status_hint and status_hint.get("state"):
                state = status_hint.get("state")
                message = status_hint.get("message", "")
                if message:
                    print(f"分析仍在进行（state={state}）：{message}", file=sys.stderr)
                else:
                    print(f"分析仍在进行（state={state}）。", file=sys.stderr)
            else:
                print("分析超时，无法获取进度状态。", file=sys.stderr)
            print(
                f"你可以稍后访问 {api_base}/api/status?analysis_id={analysis_id} 查看进度。",
                file=sys.stderr,
            )
            return False
        time.sleep(1)


def decode_bytes(payload):
    if not payload:
        return ""
    for encoding in ("utf-8", "gbk"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="replace")


def drain_stream(stream, sink):
    if stream is None:
        return
    try:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                break
            sink.append(chunk)
    except Exception:
        pass


def run_svn(args, timeout_sec=None, label=None, heartbeat_sec=5):
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception:
        return b"", b"", -1

    stdout_chunks = []
    stderr_chunks = []
    threads = []
    if proc.stdout is not None:
        t_out = threading.Thread(target=drain_stream, args=(proc.stdout, stdout_chunks))
        t_out.daemon = True
        t_out.start()
        threads.append(t_out)
    if proc.stderr is not None:
        t_err = threading.Thread(target=drain_stream, args=(proc.stderr, stderr_chunks))
        t_err.daemon = True
        t_err.start()
        threads.append(t_err)

    start_time = time.time()
    last_heartbeat = start_time
    returncode = None

    while True:
        returncode = proc.poll()
        if returncode is not None:
            break
        now = time.time()
        if timeout_sec and now - start_time >= timeout_sec:
            try:
                proc.kill()
            except Exception:
                pass
            returncode = -2
            break
        if heartbeat_sec and now - last_heartbeat >= heartbeat_sec:
            elapsed = int(now - start_time)
            if label:
                print(f"{label}... 已等待 {elapsed}s")
            else:
                print(f"正在执行 SVN 命令... 已等待 {elapsed}s")
            last_heartbeat = now
        time.sleep(0.2)

    try:
        proc.wait(timeout=1)
    except Exception:
        pass

    for t in threads:
        t.join(timeout=1)

    stdout = b"".join(stdout_chunks)
    stderr = b"".join(stderr_chunks)
    if returncode is None:
        returncode = 0
    return stdout, stderr, returncode


def svn_info_xml(path):
    stdout, _, code = run_svn(
        ["svn", "info", "--xml", path],
        timeout_sec=15,
        label="正在读取工作副本信息",
    )
    if code != 0:
        return {}
    try:
        root = ET.fromstring(decode_bytes(stdout))
    except ET.ParseError:
        return {}
    entry = root.find("entry")
    if entry is None:
        return {}
    repo_root = ""
    repo = entry.find("repository")
    if repo is not None:
        repo_root = repo.findtext("root") or ""
    return {
        "url": entry.findtext("url") or "",
        "relative_url": entry.findtext("relative-url") or "",
        "repos_root": repo_root,
    }


def svn_branch_origin(target):
    stdout, _, code = run_svn(
        ["svn", "log", "--stop-on-copy", "--xml", target],
        timeout_sec=45,
        label="正在分析分支起点",
    )
    if code == -2:
        print("分支起点分析超时，提交候选可能不完整。", file=sys.stderr)
        return None
    if code != 0:
        return None
    try:
        root = ET.fromstring(decode_bytes(stdout))
    except ET.ParseError:
        return None
    entries = root.findall("logentry")
    if not entries:
        return None
    oldest = entries[-1]
    info = {"revision": oldest.attrib.get("revision", "")}
    paths = oldest.find("paths")
    if paths is None:
        return info
    for item in paths.findall("path"):
        copy_from = item.attrib.get("copyfrom-path")
        if copy_from:
            info["copyfrom_path"] = copy_from
            info["copyfrom_rev"] = item.attrib.get("copyfrom-rev", "")
            return info
    return info


def svn_diff_summarize_paths(old_path, new_path):
    stdout, _, code = run_svn(
        ["svn", "diff", "--summarize", "--old", old_path, "--new", new_path],
        timeout_sec=45,
        label="正在生成变更清单",
    )
    if code == -2:
        print("变更清单获取超时，可稍后重试或缩小范围。", file=sys.stderr)
        return None
    if code not in (0, 1):
        return None
    decoded = decode_bytes(stdout)
    paths = []
    for raw_line in decoded.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        paths.append(parts[-1])
    return paths


def summarize_paths(paths, depth):
    groups = {}
    for rel_path in paths:
        key = group_key_for_path(rel_path, depth)
        groups[key] = groups.get(key, 0) + 1
    return groups


def print_branch_summary(branch_dir, trunk_dir, depth):
    branch_info = svn_info_xml(branch_dir)
    trunk_info = svn_info_xml(trunk_dir)
    branch_target = branch_info.get("url") or branch_dir
    trunk_target = trunk_info.get("url") or trunk_dir
    print("分支起点分析")
    if branch_info.get("url"):
        print(f"- 分支URL: {branch_info['url']}")
    if trunk_info.get("url"):
        print(f"- 主线URL: {trunk_info['url']}")
    origin = svn_branch_origin(branch_target)
    if origin and origin.get("copyfrom_path"):
        print(
            f"- copy-from: {origin['copyfrom_path']}@{origin.get('copyfrom_rev', '')}"
        )
        if origin.get("revision"):
            print(f"- 创建修订: r{origin['revision']}")
    elif origin and origin.get("revision"):
        print(f"- 分支最早记录: r{origin['revision']} (未找到 copy-from)")
    else:
        print("- 未能从 svn log 推断分支起点")

    changed = svn_diff_summarize_paths(trunk_target, branch_target)
    if changed is None:
        print("变更概览: 无法获取差异（svn diff --summarize 失败）")
        return branch_target, trunk_target, origin
    groups = summarize_paths(changed, depth)
    print(f"变更概览: {len(changed)} 个文件")
    for name in sorted(groups.keys()):
        print(f"- {name}: {groups[name]}")
    return branch_target, trunk_target, origin


def safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def first_non_empty_line(text):
    if not text:
        return ""
    for line in text.splitlines():
        candidate = line.strip()
        if candidate:
            return candidate
    return ""


def strip_revision_noise(text):
    if not text:
        return ""
    value = text
    value = re.sub(
        r"\br\d{3,}(?:\s*[-/]\s*r?\d{3,})+\b",
        " ",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"\br\d{3,}(?:r\d{3,})+\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\br\d{3,}\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def clean_subject_line(text):
    first = first_non_empty_line(text)
    if not first:
        return ""
    cleaned = strip_revision_noise(first)
    cleaned = cleaned.strip(" -:;、，。")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def extract_topic(text):
    first = clean_subject_line(text)
    if not first:
        return ""
    generic = {"fix", "feat", "refactor", "docs", "chore", "perf", "test", "style"}
    if first.startswith("[") and "]" in first:
        topic = first[1 : first.find("]")].strip()
        return topic
    if first.startswith("【") and "】" in first:
        topic = first[1 : first.find("】")].strip()
        return topic
    if "：" in first:
        head, tail = first.split("：", 1)
        head = head.strip()
        tail = tail.strip()
        if head.lower() in generic and tail:
            return tail[:20]
        if 0 < len(head) <= 20:
            return head
    if ":" in first:
        head, tail = first.split(":", 1)
        head = head.strip()
        tail = tail.strip()
        if head.lower() in generic and tail:
            return tail[:20]
        if 0 < len(head) <= 20:
            return head
    if "-" in first:
        head, tail = first.split("-", 1)
        head = head.strip()
        tail = tail.strip()
        if head.lower() in generic and tail:
            return tail[:20]
        if 0 < len(head) <= 20:
            return head
    lower = first.lower()
    for token in generic:
        prefix = token + " "
        if lower.startswith(prefix):
            tail = first[len(prefix) :].strip()
            if tail:
                return tail[:20]
            return token
    return first[:20].strip()


def svn_log_entries(target, start_rev=None, end_rev="HEAD", limit=None):
    args = ["svn", "log", "--xml", "--verbose", target]
    if start_rev is not None:
        args.extend(["-r", f"{start_rev}:{end_rev}"])
    if limit is not None and limit > 0:
        args.extend(["--limit", str(limit)])
    stdout, _, code = run_svn(
        args,
        timeout_sec=60,
        label="正在获取提交记录",
    )
    if code == -2:
        print("提交记录获取超时，可能是远端仓库响应较慢。", file=sys.stderr)
        return []
    if code != 0:
        return []
    try:
        root = ET.fromstring(decode_bytes(stdout))
    except ET.ParseError:
        return []
    entries = []
    for entry in root.findall("logentry"):
        paths = []
        paths_node = entry.find("paths")
        if paths_node is not None:
            for item in paths_node.findall("path"):
                if item.text:
                    paths.append(item.text.strip())
        entries.append(
            {
                "revision": entry.attrib.get("revision", ""),
                "author": entry.findtext("author") or "",
                "date": entry.findtext("date") or "",
                "msg": entry.findtext("msg") or "",
                "paths": paths,
            }
        )
    return entries


def entry_path_groups(entry, depth):
    groups = []
    for raw_path in entry.get("paths", []):
        key = group_key_for_path(raw_path, depth)
        if key and key not in groups:
            groups.append(key)
    return groups


def build_feature_candidates(entries, depth):
    if not entries:
        return []
    ordered = list(reversed(entries))
    groups = []
    current = None
    for entry in ordered:
        topic = extract_topic(entry.get("msg", ""))
        path_groups = entry_path_groups(entry, depth)
        path_key = path_groups[0] if path_groups else ""
        msg_hint = short_message(entry.get("msg", ""), limit=40)
        key = topic or path_key or msg_hint or "未归类"
        if current and current["key"] == key:
            current["entries"].append(entry)
            current["paths"].update(path_groups)
        else:
            current = {
                "key": key,
                "entries": [entry],
                "paths": set(path_groups),
            }
            groups.append(current)
    return groups


def short_message(text, limit=60):
    first = clean_subject_line(text)
    if not first:
        return ""
    if len(first) <= limit:
        return first
    return first[: limit - 3] + "..."


def print_feature_candidates(groups, show_revs=False):
    if not groups:
        print("提交记录: 未能生成候选功能包")
        return
    print("功能候选（基于提交记录与顺序）")
    for group in groups:
        entries = group["entries"]
        start_rev = entries[0].get("revision", "")
        end_rev = entries[-1].get("revision", "")
        count = len(entries)
        path_list = sorted(group["paths"])
        path_hint = ", ".join(path_list[:3])
        if len(path_list) > 3:
            path_hint += "..."
        if show_revs and start_rev and end_rev:
            if start_rev == end_rev:
                header = f"r{start_rev}"
            else:
                header = f"r{start_rev}-r{end_rev}"
            print(f"- {header} {group['key']}（提交{count}个）")
        else:
            print(f"- {group['key']}（提交{count}个）")
        if path_hint:
            print(f"  路径: {path_hint}")
        samples = entries[:3]
        for entry in samples:
            msg = short_message(entry.get("msg", ""))
            rev = entry.get("revision", "")
            if msg and rev:
                print(f"  - r{rev} {msg}")
            elif msg:
                print(f"  - {msg}")
    print("你只需告诉我要合并哪些功能、不要合并哪些功能；如需调整拆分或补充说明，直接说。")


def parse_keywords(raw):
    if not raw:
        return []
    normalized = raw.replace(";", ",").replace("|", ",")
    items = []
    for part in normalized.split(","):
        value = part.strip().lower()
        if value:
            items.append(value)
    return items


def normalize_path(rel_path):
    value = (rel_path or "").replace("\\", "/")
    if "://" in value:
        try:
            parsed = urlparse(value)
            if parsed.path:
                value = parsed.path
        except Exception:
            pass
    return value


def filter_files(files, include_raw, exclude_raw):
    include_keys = parse_keywords(include_raw)
    exclude_keys = parse_keywords(exclude_raw)
    if not include_keys and not exclude_keys:
        return files
    filtered = []
    for item in files:
        rel_path = normalize_path(item.get("path", "")).lower()
        if include_keys and not any(key in rel_path for key in include_keys):
            continue
        if exclude_keys and any(key in rel_path for key in exclude_keys):
            continue
        filtered.append(item)
    return filtered


def strip_repo_prefix(parts):
    for token in ("branches", "trunk", "tags"):
        if token in parts:
            idx = parts.index(token)
            if token in ("branches", "tags"):
                if idx + 1 < len(parts):
                    return parts[idx + 2 :]
            elif token == "trunk":
                return parts[idx + 1 :]
    return parts


def group_key_for_path(rel_path, depth):
    parts = [part for part in normalize_path(rel_path).split("/") if part]
    parts = strip_repo_prefix(parts)
    dirs = parts[:-1]
    if depth <= 0 or not dirs:
        return "ROOT"
    if depth >= len(dirs):
        return "/".join(dirs)
    return "/".join(dirs[:depth])


def group_files(files, depth):
    groups = {}
    for item in files:
        key = group_key_for_path(item.get("path", ""), depth)
        groups.setdefault(key, []).append(item)
    return groups


def print_merge_plan(groups, depth, include_raw, exclude_raw, show_files):
    print(f"合并计划（分组层级: {depth}）")
    if include_raw:
        print(f"已按关键词过滤: 包含 {include_raw}")
    if exclude_raw:
        print(f"已按关键词过滤: 排除 {exclude_raw}")
    if not groups:
        print("没有可展示的文件分组。")
        return
    for group_name in sorted(groups.keys()):
        items = groups[group_name]
        total = len(items)
        changed = sum(1 for item in items if item.get("has_changes"))
        print(f"- {group_name} (文件: {total}, 改动: {changed})")
        if show_files:
            for item in sorted(items, key=lambda it: it.get("path", "")):
                flag = "C" if item.get("has_changes") else "-"
                rel_path = item.get("path", "")
                print(f"  {flag} {rel_path}")
    print("下一步：请告诉我哪些功能要合并/不合并，我会据此生成合并指令。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--branch", required=True)
    parser.add_argument("--trunk", required=True)
    parser.add_argument("--merge", required=True)
    parser.add_argument("--base")
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--include")
    parser.add_argument("--exclude")
    parser.add_argument("--group-depth", type=int, default=1)
    parser.add_argument("--log-limit", type=int, default=200)
    parser.add_argument("--show-files", action="store_true")
    parser.add_argument("--show-revs", action="store_true")
    parser.add_argument("--hide-revs", action="store_true")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--ui-base", default=DEFAULT_UI_BASE)
    args = parser.parse_args()

    api_base = args.api_base.rstrip("/")
    ui_base = args.ui_base.rstrip("/")

    print("正在检测分析服务是否可用...")
    if not health_check(api_base):
        if ensure_engine_available(api_base):
            if not cli_has_arg("--api-base") or not cli_has_arg("--ui-base"):
                refreshed = load_engine_config()
                if refreshed:
                    if not cli_has_arg("--api-base"):
                        api_base = (refreshed.get("api_base") or api_base).rstrip("/")
                    if not cli_has_arg("--ui-base"):
                        ui_base = (refreshed.get("ui_base") or ui_base).rstrip("/")
        else:
            print("分析服务不可用，请先启动服务后重试。", file=sys.stderr)
            return 2

    print("正在提交分析请求...")

    payload = {
        "branch_dir": args.branch,
        "trunk_dir": args.trunk,
        "merge_dir": args.merge,
    }
    if args.base:
        payload["base_dir"] = args.base

    try:
        resp = request_json("POST", f"{api_base}/api/analyze", payload, timeout=10)
    except urllib.error.HTTPError as exc:
        print(f"Analyze failed: {exc.read().decode('utf-8')}", file=sys.stderr)
        return 2
    except urllib.error.URLError:
        print("分析服务无响应，请确认服务已启动。", file=sys.stderr)
        return 2

    analysis_id = resp.get("analysis_id")
    if not analysis_id:
        print("No analysis_id returned.", file=sys.stderr)
        return 2

    print(f"analysis_id={analysis_id}")

    if args.plan:
        depth = args.group_depth if args.group_depth is not None else 1
        print("正在生成分支起点与变更摘要...")
        branch_target, trunk_target, origin = print_branch_summary(
            args.branch, args.trunk, depth
        )
        start_rev = None
        if origin and origin.get("copyfrom_rev"):
            start_rev = safe_int(origin.get("copyfrom_rev"))
            if start_rev is not None:
                start_rev += 1
        elif origin and origin.get("revision"):
            start_rev = safe_int(origin.get("revision"))
        print("正在获取提交记录...")
        entries = svn_log_entries(
            branch_target, start_rev=start_rev, end_rev="HEAD", limit=args.log_limit
        )
        if entries:
            candidates = build_feature_candidates(entries, depth)
            show_revs = True
            if args.hide_revs:
                show_revs = False
            if args.show_revs:
                show_revs = True
            print_feature_candidates(candidates, show_revs=show_revs)
        else:
            print("提交记录: 无法获取，功能候选可能不完整")
        print("正在等待分析完成...")
        if not wait_for_analysis(api_base, analysis_id):
            return 2
        print("正在获取分析文件列表...")
        files_resp = request_json(
            "GET", f"{api_base}/api/files?analysis_id={analysis_id}", timeout=5
        )
        files = files_resp.get("files", [])
        if not files:
            print("合并计划: 未获取到分析文件列表，改用分支/主线差异清单生成。")
            diff_paths = svn_diff_summarize_paths(trunk_target, branch_target)
            if diff_paths:
                diff_items = [
                    {"path": path, "has_changes": True} for path in diff_paths
                ]
                filtered = filter_files(diff_items, args.include, args.exclude)
            else:
                filtered = []
        else:
            filtered = filter_files(files, args.include, args.exclude)
        groups = group_files(filtered, depth)
        print_merge_plan(groups, depth, args.include, args.exclude, args.show_files)

    if args.open:
        webbrowser.open(f"{ui_base}/?analysis={analysis_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

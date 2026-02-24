import argparse
import json
import urllib.request


def request_json(method, url, payload=None):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def build_explain(block):
    origin = block.get("origin", "unknown")
    if origin == "branch":
        reason = "合并支线改动"
        merge_reason = "该块来自分支，实现分支目标功能或修复"
    elif origin == "trunk":
        reason = "沿用主线改动"
        merge_reason = "保持与主线一致，避免回退主线行为"
    elif origin == "manual":
        reason = "手工合并/冲突解决"
        merge_reason = "冲突裁决后的保留结果，优先保证主线兼容"
    else:
        reason = "来源不明确"
        merge_reason = "缺少明确来源，需要人工确认合并意图"
    return {
        "reason": reason,
        "merge_reason": merge_reason,
        "impact": "需结合业务确认影响范围",
        "risk": "可能存在未覆盖的边界情况",
        "note": "AI推断",
        "source": "codex-example",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", required=True)
    parser.add_argument("--api-base", default="http://localhost:8000")
    parser.add_argument("--max-blocks", type=int, default=50)
    args = parser.parse_args()

    api_base = args.api_base.rstrip("/")
    analysis_id = args.analysis

    files = request_json(
        "GET", f"{api_base}/api/files?analysis_id={analysis_id}"
    ).get("files", [])

    items = []
    for file_info in files:
        if len(items) >= args.max_blocks:
            break
        path = file_info.get("path")
        if not path:
            continue
        detail = request_json(
            "GET",
            f"{api_base}/api/file?analysis_id={analysis_id}&path={path}",
        )
        for block in detail.get("blocks", []):
            if block.get("origin") == "common":
                continue
            items.append(
                {
                    "path": path,
                    "start": block.get("start"),
                    "end": block.get("end"),
                    "explain": build_explain(block),
                }
            )
            if len(items) >= args.max_blocks:
                break

    if not items:
        print("No blocks to annotate.")
        return 0

    payload = {"analysis_id": analysis_id, "items": items}
    result = request_json("POST", f"{api_base}/api/ai/annotate", payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

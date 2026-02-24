import argparse
import json
import sys
import urllib.request


def request_json(method, url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}


def load_payload_file(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", default="http://localhost:8000")
    parser.add_argument("--analysis-id")
    parser.add_argument("--path")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--merge-reason", default="")
    parser.add_argument("--reason", default="")
    parser.add_argument("--impact", default="")
    parser.add_argument("--risk", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--source", default="codex")
    parser.add_argument("--updated-at", default="")
    parser.add_argument("--payload-file")
    args = parser.parse_args()

    api_base = args.api_base.rstrip("/")
    if args.payload_file:
        payload = load_payload_file(args.payload_file)
    else:
        if not args.analysis_id or not args.path or args.start is None or args.end is None:
            print("Missing required arguments.", file=sys.stderr)
            return 2
        explain = {
            "merge_reason": args.merge_reason,
            "reason": args.reason,
            "impact": args.impact,
            "risk": args.risk,
            "note": args.note,
            "source": args.source,
            "updated_at": args.updated_at,
        }
        payload = {
            "analysis_id": args.analysis_id,
            "items": [
                {
                    "path": args.path,
                    "start": args.start,
                    "end": args.end,
                    "explain": explain,
                }
            ],
        }

    resp = request_json("POST", f"{api_base}/api/ai/annotate", payload)
    print(json.dumps(resp, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

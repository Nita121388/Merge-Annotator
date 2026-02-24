def apply_ai_explanations(analysis, items):
    updated = 0
    missing = 0
    for item in items or []:
        path = item.get("path")
        start = item.get("start")
        end = item.get("end")
        explain = item.get("explain")
        if not path or not start or not end or not explain:
            continue
        file_data = analysis.get("file_map", {}).get(path)
        if not file_data:
            missing += 1
            continue
        applied = False
        for block in file_data.get("blocks", []):
            if block.get("start") == start and block.get("end") == end:
                block["ai_explain"] = explain
                updated += 1
                applied = True
                break
        if not applied:
            missing += 1
    return {"status": "ok", "updated": updated, "missing": missing}

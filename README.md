# SVN Merge Annotator

Local service + web UI scaffold.

## Structure
- backend: FastAPI service
- frontend: Vue + Vite UI

## 功能说明
- 目标：对 merge/branch/trunk（可选 base）进行行级归因，输出颜色标注与可读的差异块。
- UI 功能：文件列表、代码视图切换（merge/branch/trunk/base）、冲突块跳转、块级注释与 SVN 信息。

### 使用步骤（UI）
1) 启动后端与前端服务
2) 在页面填写 branch / trunk / merge（可选 base）
3) 点击 Analyze 获取 analysis_id（页面会显示进度条）
4) 访问：http://localhost:5173/?analysis=<analysis_id>

### 颜色含义（UI）
- 分支改动（origin-branch）
- 主线改动（origin-trunk）
- 共同一致（origin-common）
- 手工调整（origin-manual）
- 冲突块（origin-conflict）
- 未知归属（origin-unknown）
- 黄色描边：当前选中块范围
- 文件列表标签：分支新增 / 主线新增（仅用于标记新增文件，便于过滤关注）

### 分析范围与限制
- 默认仅分析改动文件：基于 `svn diff --summarize`，按 merge vs trunk 结果筛选；目录项不展开。
- 可设置 `ANALYSIS_ONLY_CHANGED=0` 启用全量扫描。
- 可设置 `ANALYSIS_FILE_SCOPE=union` 使用 merge vs trunk 与 merge vs branch 并集。
- 大文件跳过：`ANALYSIS_MAX_FILE_BYTES` 默认 2097152（2MB），超限文件标记 skipped。
- 目录 `release/bin` 下跳过 `svn blame`，避免耗时与噪声。
- 冲突块解析依赖 `diff3`；可通过 `SVN_MERGE_DIFF3` 指定可执行路径。

### 日志与排查
- 后端日志：`backend/uvicorn.out.log` 与 `backend/uvicorn.err.log`
- pipeline 日志：`C:\\Users\\chemclin\\.codex\\skills\\svn-merge-annotator-pipeline\\pipeline.out.log`

## Dev (example)
Backend:
  cd backend
  python -m venv .venv
  .venv\Scripts\activate
  pip install -r requirements.txt
  uvicorn app.main:app --reload --port 18000

Frontend:
  cd frontend
  npm install
  npm run dev

## 本地引擎一键安装（npx）
适用于不打开 VSCode、直接在命令行触发 skills 的场景。
1) npx --yes @sobreak/svn-merge-annotator ensure
2) engine.json 会写入：%LOCALAPPDATA%\\svn-merge-annotator\\engine\\engine.json
3) 若尚未发布 npm 包，可设置环境变量 SVN_MERGE_ANNOTATOR_NPX 指向本地 npx 命令

## Codex 一键流程（推荐）
1) 调用 /api/analyze（可选 base_dir）拿到 analysis_id
2) 调用 /api/files 获取文件列表
3) 逐个调用 /api/file 获取 blocks 与 diff
4) Codex 生成解释后调用 /api/ai/annotate 写回
5) 打开 http://localhost:5173/?analysis=analysis_id

## AI annotations（由 Codex 写回）
Codex 计算解释后调用：
  POST /api/ai/annotate
可选字段：
- merge_reason: 合并理由（为什么这样合并/保留/舍弃）

示例：
  {
    "analysis_id": "...",
    "items": [
      { "path": "src/foo.py", "start": 10, "end": 18, "explain": { "merge_reason": "...", "reason": "...", "impact": "...", "risk": "...", "note": "AI推断", "source": "codex", "updated_at": "2026-02-10T10:00:00+08:00" } }
    ]
  }

示例脚本：
  python backend\ai_annotate_example.py --analysis <analysis_id>

## base_dir 可选说明
若提供 base_dir（共同基线），后端将优先使用 SVN diff 基于 base 的变更集合进行归因，准确度更高。

## diff3 冲突块（可选）
若系统可用 diff3（或设置 SVN_MERGE_DIFF3 指向 diff3 可执行文件），后端将解析 diff3 冲突块并标记为 conflict。

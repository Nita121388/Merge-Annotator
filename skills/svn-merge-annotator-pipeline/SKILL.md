---
name: svn-merge-annotator-pipeline
description: 运行 svn-merge-annotator 的端到端分析流程，并扩展“合并闭环”能力：基于用户意图生成合并计划、提供半自动合并指令、记录合并批注、完成功能后自动分析并提示。
---

# SVN Merge Annotator Pipeline

## 适用场景
- 用户请求“一键分析 / 打开结果页 / 批量批注”
- 用户请求“合并计划 / 合并某功能 / 排除某功能 / 合并闭环”

## 交互提示（对用户）
- 我会先自动生成“分支起点 + 变更摘要 + 功能候选清单”，不需要你选择模式或参数。
- 我会自动检测分析服务是否可用；若不可用或无响应，会提示你启动服务或提供启动脚本位置。
- 我会根据功能候选清单询问“哪些功能要合并/不合并”，无需你输入命令参数。
- 列出合并改动时必须保留 SVN 修订号 + 提交信息，不要用自编号替代。
- 用自然语言提示，不出现“前端/后端/命令参数”等术语（只说“分析服务/结果页”）。
- 若提交记录或变更清单超时，会提示可能是远端响应慢并建议稍后重试。
- 不要只说“计划已生成”，必须直接展示候选功能清单的可见内容。
- 若出现超时，不直接判定失败，必须去状态接口或结果页确认进度后再给结论。

## Inputs
- branch_dir: full path to the branch folder
- trunk_dir: full path to the trunk folder
- merge_dir: full path to the merge-result folder
- base_dir (optional): full path to the common base folder
- Optional: --open to open the web UI after analysis
- Optional: --plan to generate a merge plan grouped by paths
- Optional: --include/--exclude to filter merge plan by keywords
- Optional: --group-depth to control grouping depth
- Optional: --log-limit to limit svn log entries (default 200)
- Optional: --show-files to list files under each feature group
- Optional: --show-revs to show revision ranges in feature list
- Optional: --hide-revs to hide revision numbers in feature list

## 脚本位置
- 本地引擎配置统一写入：%LOCALAPPDATA%\\svn-merge-annotator\\engine\\engine.json
- 若本地服务未启动，会尝试通过 `npx --yes @chemclin/svn-merge-annotator ensure` 自动安装/启动。
- 脚本文件：C:\Users\chemclin\.codex\skills\svn-merge-annotator-pipeline\scripts\run_pipeline.py
- 批注写回脚本：C:\Users\chemclin\.codex\skills\svn-merge-annotator-pipeline\scripts\post_annotate.py（UTF-8 写回 /api/ai/annotate，避免中文乱码）
- 建议在技能目录下执行，或在命令里使用该脚本的绝对路径。
- 不要对磁盘做全量搜索；如需定位，先在上述路径检查，或仅在 C:\Users\chemclin\.codex\skills 范围内查找。

## 合并计划输出规范
- 必须直接展示候选功能清单（不少于前 10 条或全部），不要仅说“计划已生成”。
- 每条候选尽量包含：SVN 修订号 + 提交信息 + 功能名/一句描述。
- 列表展示用“-”或空行分隔，避免 AI 自编号（1/2/3）。
- 询问用自然语言：请直接说“要合并哪些功能/暂不合并哪些功能”，允许用户用功能名描述回复。
- 不提示“按编号/按路径/混合”等固定格式；只有在用户主动提到路径筛选时再解释。
- 如果用户觉得功能划分不合理，提示可按模块/目录/医院补丁等重新拆分，并让用户给拆分规则。

## 超时与进度确认
- 若脚本提示超时，先检查状态接口：/api/status?analysis_id=...，确认 state 后再给出结论。
- 若状态显示仍在运行/排队，提示用户“可以继续等待或稍后重试获取文件列表”。
- 若状态不可用，再提示可能是分析服务无响应，并建议重启服务。

## Steps
1) 确保分析服务已启动（若需打开结果页再启动界面服务）。
2) 默认先运行 --plan 生成“分支起点 + 提交候选 + 变更摘要”（除非用户明确只要打开结果页）。
3) Run the pipeline script with the three directories.
4) If --open is set, the script opens the result UI.
5) If --plan is set, the script outputs a merge plan (feature groups).
6) 输出提交记录候选功能包并提示用户选择（合并/排除/顺序），不要求用户选择修订号。
7) Codex fetches /api/files and /api/file to build explanations.
8) Codex 使用 scripts/post_annotate.py 以 UTF-8 写回 /api/ai/annotate（避免中文乱码）。

## 合并闭环（新增）
1) 识别用户合并意图（自然语言）。
2) 确认分支/主线/merge 根目录（可复用上次路径）。
3) 询问“合并/不合并”的功能范围（用户逐步确认）。
4) 生成合并计划（功能项、文件列表、风险提示）。
5) 确认合并功能后，先深入代码了解该功能的实现与改动点，再进入合并步骤。
6) 输出半自动合并指令（建议含 --dry-run），不直接执行合并。
7) 合并过程中随时记录批注（关联功能/文件/块）。
8) 单个功能合并完成后自动触发分析并提示结果。
9) 分析完成后自动写入合并记录（merge_reason/impact/risk/note/source/updated_at），并提示可在 VSCode 插件查看。

## 合并前代码理解清单
- 明确该功能涉及的提交范围（保留 SVN 修订号与提交信息）。
- 阅读关键变更文件，识别模块入口/核心逻辑/关键数据流。
- 检查配置/依赖/接口/数据库等是否有变更点。
- 评估与其他功能的依赖关系与潜在冲突。
- 明确验证方式与回滚策略（最少写一句验证结论或待验证说明）。
- 输出“功能摘要 + 风险点”，并记录到批注字段（note/impact/risk）。
- 若信息不足，先向用户确认或请求允许读取相关代码再进入合并步骤。

## 合并批注是什么
- 用于记录“为什么合并、怎么处理、影响范围、风险与结论”的结构化说明。
- 典型内容：合并理由、冲突处理方式、影响模块、风险/注意事项、验证结论。

## 合并批注如何使用
- 触发时机（强制）：
  - 每一次合并动作完成后都记录（一次合并动作 = 一组提交/一次冲突处理/一次手工修改）
  - 处理冲突或手工改动后
  - 决定暂不合并某功能时
- 写入方式：由 AI 通过 scripts/post_annotate.py 以 UTF-8 自动写入批注（/api/ai/annotate），并关联到具体文件/块。
- 字段建议：merge_reason / impact / risk / note / source / updated_at（必要时补充 ai_explain）。
- 查看方式：在 VSCode 插件的批注/合并记录视图中查看。
- 用户需要做的事：用自然语言说明“为何这样合并/如何处理冲突/是否已验证”，AI 负责写入批注。

## Command
python scripts/run_pipeline.py --branch "E:\\branch" --trunk "E:\\trunk" --merge "E:\\merge" --base "E:\\base" --open

## Command (merge plan)
python scripts/run_pipeline.py --branch "E:\\branch" --trunk "E:\\trunk" --merge "E:\\merge" --base "E:\\base" --plan --group-depth 1 --include "report,api" --exclude "auth" --show-files

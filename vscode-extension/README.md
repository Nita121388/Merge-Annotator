# SVN Merge Annotator VSCode 插件

## 功能概述
- TreeView 显示分析文件列表（标记分支/主线新增）
- 点击文件后在编辑器打开 **merge 文件**，自动定位首个非 common 块
- 行级颜色高亮（branch/trunk/common/manual/conflict/unknown）
- gutter 图标标记 manual/conflict
- Hover 展示 AI 批注（合并理由等）
- CodeLens 提供合并理由/写入批注/跳转（Branch/Trunk/Base）
- Notes 视图汇总批注并显示数量，可一键复制
- 分析历史记录与快速跳转
- 分析历史支持一键复制 analysis_id
- merge 根目录缺失时可手动选择并回填

## 使用前提
- 后端服务已启动（默认 http://localhost:8000）
- 后端 `/api/files` 返回 roots（已在本项目后端实现）
- Base 目录可选，用于三方对比提升归因准确度

## 构建与运行
1) 安装依赖  
   `npm install`
2) 编译  
   `npm run compile`
3) 在 VSCode 中按 F5 运行扩展

## 快速使用
1) 点击左侧活动栏图标 “Merge Annotator”
2) 执行命令 `SVN Merge Annotator: 运行分析`（支持复用上次路径）
3) 分析完成后点击文件列表即可打开并高亮
4) 使用 CodeLens 查看合并理由/写入批注或跳转到对应分支文件
5) 需要批注汇总时执行 `SVN Merge Annotator: 刷新 Notes`
6) 通过 `SVN Merge Annotator: 分析历史` 快速切换分析（支持复制 ID）

## 常用命令
- `SVN Merge Annotator: 显示颜色图例`
- `SVN Merge Annotator: 切换隐藏新增文件`
- `SVN Merge Annotator: 切换仅显示改动文件`
- `SVN Merge Annotator: 切换仅显示风险行`

## 配置项
- `svnMergeAnnotator.backendUrl`：后端地址
- `svnMergeAnnotator.showCommonLines`：是否高亮 common 行
- `svnMergeAnnotator.showOnlyRiskLines`：仅高亮存在风险批注的行
- `svnMergeAnnotator.showOnlyChangedFiles`：仅显示 has_changes 文件
- `svnMergeAnnotator.hideNewFiles`：隐藏分支/主线新增或仅合并存在文件
- `svnMergeAnnotator.autoLoadNotes`：加载分析后自动刷新 Notes
- `svnMergeAnnotator.analysisHistoryLimit`：分析历史保留数量
- `svnMergeAnnotator.noteSnippetMaxLines`：复制批注时代码片段最大行数
- `svnMergeAnnotator.notesIncludeAllBlocks`：Notes 是否包含未批注的合并块
- `svnMergeAnnotator.debugLogging`：是否输出调试日志到输出面板

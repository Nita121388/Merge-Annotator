# VSCode 插件需求文档（草案）

## 1. 背景与目标
需要在 VSCode 中直接完成合并分析的查看与批注，而非嵌入网页前端。  
目标是将“分析结果 → 文件列表 → 行级高亮 → AI 批注展示/写回”完整融入 VSCode 原生体验。

## 2. 角色与使用场景
- 合并负责人：快速定位 merge 相对 trunk 的真实变更
- 评审人员：查看每个改动块的合并理由、影响、风险
- 维护人员：在代码编辑器中直接跳转、复核、批注

## 3. 需求范围
### 3.1 必须实现
1) TreeView 显示分析后的文件列表  
2) 点击文件在编辑器中打开 **merge 文件**  
3) 基于行级归因结果进行颜色高亮  
4) 在代码上展示 AI 批注（至少 Hover）  
5) 支持“仅展示 merge vs trunk 有变化的文件”

### 3.2 可选增强
- CodeLens 展示合并理由/跳转/复制
- gutter 图标标记冲突或手工合并块
- 过滤器：隐藏 common 行、仅看风险块
- 历史分析记录（local/global state）

### 3.3 不在范围
- 直接在插件内重写分析算法
- 替代后端 API 的分析逻辑

## 4. 核心流程（简化）
1) 触发分析（调用后端 /api/analyze）  
2) 轮询 /api/status 获取进度  
3) /api/files 获取文件列表（仅 merge vs trunk 变化）  
4) TreeView 显示文件  
5) 点击文件 → 打开 merge 文件 → 行级高亮 → Hover 显示批注  
6) AI 批注写回 /api/ai/annotate

## 5. 功能需求细化
### 5.1 TreeView（文件列表）
- 数据来源：/api/files
- 显示信息：路径、行数、changed、文件级标签（分支新增/主线新增可选）
- 点击后：打开 merge 文件并自动定位到首个非 common 块
- merge 根目录缺失时允许手动选择并缓存

### 5.2 编辑器行级高亮
- 使用 VSCode Decoration 实现
- 颜色映射：
  - branch: 橙色系
  - trunk: 蓝色系
  - common: 绿色系
  - manual: 紫色系
  - conflict: 红色系
  - unknown: 灰色系

### 5.3 批注展示
- Hover 显示以下字段：
  - merge_reason（合并理由）
  - reason / impact / risk / note / source / updated_at
- 后续支持 CodeLens 或侧栏详情（可选）

### 5.4 跳转（可选）
- 在 Hover/CodeLens 中提供跳转：
  - branch/trunk/base 对应范围
- 若文件不存在则提示

### 5.5 AI 批注写回
- 通过 /api/ai/annotate 写回
- 结构必须包含 merge_reason

### 5.6 分析历史与复制
- 历史列表支持快速加载
- 支持一键复制 analysis_id 便于分享与复用

## 6. 依赖与接口
### 6.1 后端接口
- POST /api/analyze  
- GET /api/status  
- GET /api/files  
- GET /api/file  
- POST /api/ai/annotate

### 6.2 数据结构
文件摘要（/api/files）
- path
- total_lines
- has_changes
- file_origin（branch_new / trunk_new / shared）

文件详情（/api/file）
- versions.merge
- line_meta（merge_no + origin）
- blocks（start/end/origin + ai_explain）

## 7. 配置需求
建议加入 VSCode Settings：
- backendUrl（默认 http://localhost:8000）
- mergeDir / trunkDir / branchDir / baseDir（可持久化）
- showCommonLines（默认 false）

## 8. 性能与稳定性
- 大文件跳过策略沿用后端
- 仅对当前打开文件做高亮
- 缓存已加载 file_data

## 9. 验收标准
1) TreeView 能正确展示文件列表  
2) 点击文件能打开 merge 文件  
3) 行级高亮与前端色彩一致  
4) Hover 能展示 merge_reason 等批注  
5) 仅展示 merge vs trunk 有变化的文件  

## 10. 实现里程碑
1) 扩展骨架 + TreeView  
2) 文件打开 + 行级高亮  
3) Hover 批注  
4) 可选增强（CodeLens/跳转/过滤）

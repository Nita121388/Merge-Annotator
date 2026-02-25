# SVN Merge Annotator Engine CLI

本目录用于发布 npx 本地引擎安装器。

> 开发阶段声明：当前包处于开发阶段（Alpha），接口和行为可能随迭代调整，请勿直接用于生产环境。
> Vibe Coding 说明：项目允许探索性/即兴式开发（vibe coding），实现细节可能快速演进，欢迎反馈与 PR。

## 开发阶段（私有 registry）
1) 配置私有 registry（示例）：
```
@sobreak:registry=https://your-registry.example.com/
//your-registry.example.com/:_authToken=YOUR_TOKEN
```
2) 发布：
```
npm publish --registry https://your-registry.example.com/
```
3) 用户侧使用：
```
npx --yes @sobreak/svn-merge-annotator ensure
```

## 转公有 npm
1) 确认包名在公有 npm 可用
2) 发布：
```
npm publish --access public
```

## 发布脚本（PowerShell）
```
scripts/publish.ps1 -Registry "https://your-registry.example.com/" -Access restricted
scripts/publish.ps1 -Access public
scripts/publish.ps1 -Access public -Tag next -DryRun
```

## 本地测试（不发布）
```
npx --yes E:\File\NitaFile\Projects\svn-merge-annotator-repo\tools\engine-cli ensure
```

## 二进制自动下载（推荐）
默认会在首次运行时自动下载后端二进制（按平台/架构），并缓存到本地目录。
可通过环境变量覆盖下载地址或禁用二进制模式：

- `SVN_MERGE_ANNOTATOR_BACKEND_BASE_URL`：自定义下载基址
- `SVN_MERGE_ANNOTATOR_BACKEND_RELEASE_BASE`：同上（兼容别名）
- `SVN_MERGE_ANNOTATOR_DISABLE_BINARY=1`：禁用二进制，回退到 Python venv

默认下载地址格式：
```
https://github.com/sobreak/svn-merge-annotator/releases/download/v{version}
```

需要提供的发布资产文件名：
- `svn-merge-annotator-backend-windows-x64.exe`
- `svn-merge-annotator-backend-macos-x64`
- `svn-merge-annotator-backend-macos-arm64`
- `svn-merge-annotator-backend-linux-x64`
- `svn-merge-annotator-backend-linux-arm64`
- `checksums.txt`（每行：`<sha256> <filename>`）

## 后端二进制构建
Windows（PowerShell）：
```
backend\scripts\build_exe.ps1
backend\scripts\generate_checksums.ps1
```

macOS / Linux（bash）：
```
./backend/scripts/build_exe.sh
./backend/scripts/generate_checksums.sh
```

## 说明
- `prepack` 会将仓库根目录的 `backend/` 复制到本包内，确保 npx 可用。
- `postpack` 会清理复制后的 `backend/`。

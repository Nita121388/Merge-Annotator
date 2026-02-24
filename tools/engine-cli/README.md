# SVN Merge Annotator Engine CLI

本目录用于发布 npx 本地引擎安装器。

## 开发阶段（私有 registry）
1) 配置私有 registry（示例）：
```
@chemclin:registry=https://your-registry.example.com/
//your-registry.example.com/:_authToken=YOUR_TOKEN
```
2) 发布：
```
npm publish --registry https://your-registry.example.com/
```
3) 用户侧使用：
```
npx --yes @chemclin/svn-merge-annotator ensure
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

## 说明
- `prepack` 会将仓库根目录的 `backend/` 复制到本包内，确保 npx 可用。
- `postpack` 会清理复制后的 `backend/`。

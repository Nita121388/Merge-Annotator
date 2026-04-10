"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const child_process = __importStar(require("child_process"));
const crypto = __importStar(require("crypto"));
const LAST_DIRS_KEY = "lastDirs";
const REV_RANGE_KEY = "revRangeState";
const DIFF_COMPARE_TARGET_KEY = "diffCompareTarget";
const DIFF_COMPARE_REMOTE_REV_KEY = "diffCompareRemoteRev";
const SVN_REV_COMPARE_SCHEME = "svnrevcmp";
const FILE_HISTORY_PICK_LIMIT = 100;
class FileItem extends vscode.TreeItem {
    constructor(summary, label, stats) {
        super(label || summary.path, vscode.TreeItemCollapsibleState.None);
        this.relPath = summary.path;
        const originLabel = formatFileOrigin(summary.file_origin);
        const changeLabel = summary.has_changes ? "有改动" : "无改动";
        const descriptionParts = [
            originLabel,
            changeLabel,
            `${summary.total_lines}行`,
        ];
        if (stats) {
            if (stats.block_total > 0) {
                descriptionParts.push(`批注${stats.annotated_blocks}/${stats.block_total}`);
            }
            else {
                descriptionParts.push("批注0");
            }
            if (stats.risk_blocks > 0) {
                descriptionParts.push(`风险${stats.risk_blocks}`);
            }
        }
        this.description = descriptionParts.join(" · ");
        const tooltipLines = [
            summary.path,
            `来源: ${originLabel}`,
            `改动: ${changeLabel}`,
            `行数: ${summary.total_lines}`,
        ];
        if (stats) {
            tooltipLines.push(`批注块: ${stats.annotated_blocks}/${stats.block_total}`);
            if (stats.risk_blocks > 0) {
                tooltipLines.push(`风险批注: ${stats.risk_blocks}`);
            }
            if (stats.manual_blocks > 0) {
                tooltipLines.push(`手动批注: ${stats.manual_blocks}`);
            }
        }
        if (summary.error) {
            tooltipLines.push(`错误: ${summary.error}`);
        }
        this.tooltip = tooltipLines.join("\n");
        this.command = {
            command: "svnMergeAnnotator.openFile",
            title: "打开文件",
            arguments: [this],
        };
        this.contextValue = summary.has_changes ? "changed" : "unchanged";
    }
}
class DirectoryItem extends vscode.TreeItem {
    constructor(label, relPath) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.childDirs = new Map();
        this.fileCount = 0;
        this.annotatedCount = 0;
        this.riskCount = 0;
        this.relPath = relPath;
        this.contextValue = "dir";
        this.iconPath = new vscode.ThemeIcon("folder");
    }
}
class RootPathItem extends vscode.TreeItem {
    constructor(target, rootPath) {
        super(formatRootLabel(target), vscode.TreeItemCollapsibleState.None);
        this.target = target;
        this.rootPath = rootPath;
        this.description = rootPath || "未设置";
        this.tooltip = rootPath
            ? `${formatRootLabel(target)}路径: ${rootPath}`
            : `${formatRootLabel(target)}路径未设置`;
        this.contextValue = "rootPath";
        this.command = {
            command: "svnMergeAnnotator.setRootPath",
            title: "设置路径",
            arguments: [this],
        };
        this.iconPath = new vscode.ThemeIcon("folder");
    }
}
class RootsGroupItem extends vscode.TreeItem {
    constructor(roots) {
        super("路径设置", vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = "rootGroup";
        this.iconPath = new vscode.ThemeIcon("settings-gear");
        this.children = [
            new RootPathItem("branch", roots?.branch),
            new RootPathItem("trunk", roots?.trunk),
            new RootPathItem("merge", roots?.merge),
        ];
    }
}
class LegendRowItem extends vscode.TreeItem {
    constructor(label, description, iconPath) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.contextValue = "legendRow";
        if (iconPath) {
            this.iconPath = iconPath;
        }
    }
}
class LegendGroupItem extends vscode.TreeItem {
    constructor(context) {
        super("颜色图例", vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = "legendGroup";
        this.iconPath = new vscode.ThemeIcon("symbol-color");
        const iconBase = context.asAbsolutePath(path.join("resources", "icons"));
        const manualIcon = context.asAbsolutePath(path.join("resources", "icons", "manual.svg"));
        const conflictIcon = context.asAbsolutePath(path.join("resources", "icons", "conflict.svg"));
        this.children = [
            new LegendRowItem("分支改动", "橙色", path.join(iconBase, "legend-branch.svg")),
            new LegendRowItem("主线改动", "蓝色", path.join(iconBase, "legend-trunk.svg")),
            new LegendRowItem("共同一致", "绿色", path.join(iconBase, "legend-common.svg")),
            new LegendRowItem("手工调整", "紫色", path.join(iconBase, "legend-manual.svg")),
            new LegendRowItem("冲突块", "红色", path.join(iconBase, "legend-conflict.svg")),
            new LegendRowItem("未知归属", "灰色", path.join(iconBase, "legend-unknown.svg")),
            new LegendRowItem("Gutter 图标-手工批注", "manual", manualIcon),
            new LegendRowItem("Gutter 图标-冲突块", "conflict", conflictIcon),
        ];
    }
}
function splitRelPath(relPath) {
    return relPath.replace(/\\/g, "/").split("/").filter(Boolean);
}
function formatDiffCompareTarget(target) {
    if (target === "merge")
        return "待合并";
    if (target === "branch")
        return "分支";
    return "主线";
}
function normalizePathKey(relPath) {
    return relPath.replace(/\\/g, "/").toLowerCase();
}
function getTreeItemPathParts(relPath) {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const fileName = path.posix.basename(normalized || relPath);
    const dir = path.posix.dirname(normalized || relPath);
    const dirLabel = dir === "." ? "" : dir;
    return {
        fileName: fileName || relPath,
        dirLabel,
    };
}
function buildDiffCompareGroup(label, iconId, entries, getDesc) {
    const group = new DiffCompareGroupItem(label, `${entries.length}项`, iconId);
    group.children = entries
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => new DiffCompareFileItem(entry.path, getDesc(entry), entry.status));
    return group;
}
function compareDiffItems(rangeItems, localItems) {
    const rangeMap = new Map();
    const localMap = new Map();
    for (const item of rangeItems) {
        rangeMap.set(normalizePathKey(item.path), item);
    }
    for (const item of localItems) {
        localMap.set(normalizePathKey(item.path), item);
    }
    const keys = new Set([...rangeMap.keys(), ...localMap.keys()]);
    const entries = [];
    let matched = 0;
    let missing = 0;
    let extra = 0;
    let mismatch = 0;
    for (const key of keys) {
        const rangeItem = rangeMap.get(key);
        const localItem = localMap.get(key);
        if (rangeItem && localItem) {
            const rangeStatus = normalizeRevStatus(rangeItem.status);
            const localStatus = normalizeRevStatus(localItem.status);
            if (rangeStatus === localStatus) {
                matched += 1;
                entries.push({
                    path: rangeItem.path,
                    rangeStatus,
                    localStatus,
                    status: "matched",
                });
            }
            else {
                mismatch += 1;
                entries.push({
                    path: rangeItem.path,
                    rangeStatus,
                    localStatus,
                    status: "mismatch",
                });
            }
        }
        else if (rangeItem) {
            missing += 1;
            entries.push({
                path: rangeItem.path,
                rangeStatus: normalizeRevStatus(rangeItem.status),
                status: "missing",
            });
        }
        else if (localItem) {
            extra += 1;
            entries.push({
                path: localItem.path,
                localStatus: normalizeRevStatus(localItem.status),
                status: "extra",
            });
        }
    }
    const summary = {
        matched,
        missing,
        extra,
        mismatch,
        total: entries.length,
    };
    return { entries, summary };
}
function normalizeRevStatus(status) {
    const upper = status.toUpperCase();
    if (upper === "A" || upper === "D")
        return upper;
    return "M";
}
function getRevStatusIcon(status) {
    const normalized = normalizeRevStatus(status);
    if (normalized === "A") {
        return new vscode.ThemeIcon("diff-added");
    }
    if (normalized === "D") {
        return new vscode.ThemeIcon("diff-removed");
    }
    return new vscode.ThemeIcon("diff-modified");
}
function formatRevMergeSummaryText(summary) {
    if (!summary || summary.total <= 0)
        return "";
    const parts = [`已合并${summary.merged}/${summary.total}`];
    if (summary.unmerged > 0) {
        parts.push(`未合并${summary.unmerged}`);
    }
    if (summary.conflict > 0) {
        parts.push(`冲突${summary.conflict}`);
    }
    if (summary.unknown > 0) {
        parts.push(`未知${summary.unknown}`);
    }
    return parts.join(" · ");
}
function getRevFileIcon(status, summary) {
    if (!summary || summary.total <= 0) {
        return getRevStatusIcon(status);
    }
    if (summary.conflict > 0 || summary.unknown > 0) {
        return new vscode.ThemeIcon("warning");
    }
    if (summary.unmerged === 0) {
        return new vscode.ThemeIcon("check");
    }
    if (summary.merged > 0) {
        return new vscode.ThemeIcon("sync");
    }
    return getRevStatusIcon(status);
}
function countRevItems(items) {
    let add = 0;
    let del = 0;
    let mod = 0;
    for (const item of items) {
        const normalized = normalizeRevStatus(item.status);
        if (normalized === "A") {
            add += 1;
        }
        else if (normalized === "D") {
            del += 1;
        }
        else {
            mod += 1;
        }
    }
    return { total: items.length, add, mod, del };
}
function formatRevCounts(counts) {
    return `A${counts.add} M${counts.mod} D${counts.del}`;
}
function updateDirectoryDescription(dir) {
    if (!dir.fileCount) {
        dir.description = undefined;
        dir.tooltip = dir.relPath;
        return;
    }
    const unannotated = Math.max(0, dir.fileCount - dir.annotatedCount);
    const parts = [
        `总${dir.fileCount}`,
        `已批注${dir.annotatedCount}`,
        `未批注${unannotated}`,
    ];
    if (dir.riskCount > 0) {
        parts.push(`风险${dir.riskCount}`);
    }
    dir.description = parts.join(" · ");
    const tooltipLines = [
        dir.relPath || "根目录",
        `总文件: ${dir.fileCount}`,
        `已批注: ${dir.annotatedCount}`,
        `未批注: ${unannotated}`,
    ];
    if (dir.riskCount > 0) {
        tooltipLines.push(`风险文件: ${dir.riskCount}`);
    }
    dir.tooltip = tooltipLines.join("\n");
}
function buildFileTree(files, summaryByPath) {
    const root = new DirectoryItem("__root__", "");
    for (const summary of files) {
        const parts = splitRelPath(summary.path);
        const stats = summaryByPath?.get(summary.path);
        const annotatedFile = stats ? stats.annotated_blocks > 0 : false;
        const riskFile = stats ? stats.risk_blocks > 0 : false;
        if (!parts.length) {
            root.children.push(new FileItem(summary, undefined, stats));
            root.fileCount += 1;
            if (annotatedFile)
                root.annotatedCount += 1;
            if (riskFile)
                root.riskCount += 1;
            updateDirectoryDescription(root);
            continue;
        }
        let current = root;
        const dirStack = [root];
        for (let idx = 0; idx < parts.length - 1; idx += 1) {
            const part = parts[idx];
            let child = current.childDirs.get(part);
            if (!child) {
                const nextPath = current.relPath
                    ? `${current.relPath}/${part}`
                    : part;
                child = new DirectoryItem(part, nextPath);
                current.childDirs.set(part, child);
                current.children.push(child);
            }
            current = child;
            dirStack.push(current);
        }
        const fileLabel = parts[parts.length - 1] || summary.path;
        current.children.push(new FileItem(summary, fileLabel, stats));
        for (const dir of dirStack) {
            dir.fileCount += 1;
            if (annotatedFile)
                dir.annotatedCount += 1;
            if (riskFile)
                dir.riskCount += 1;
            updateDirectoryDescription(dir);
        }
    }
    return root.children;
}
class FileTreeProvider {
    constructor(context) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.nodes = [];
        this.legendNode = new LegendGroupItem(context);
    }
    refresh(files = [], summaryByPath, roots) {
        this.nodes = [
            new RootsGroupItem(roots),
            this.legendNode,
            ...buildFileTree(files || [], summaryByPath),
        ];
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.nodes);
        }
        if (element instanceof LegendGroupItem) {
            return Promise.resolve(element.children);
        }
        if (element instanceof RootsGroupItem) {
            return Promise.resolve(element.children);
        }
        if (element instanceof LegendRowItem) {
            return Promise.resolve([]);
        }
        if (element instanceof DirectoryItem) {
            return Promise.resolve(element.children);
        }
        return Promise.resolve([]);
    }
}
class NotesFileItem extends vscode.TreeItem {
    constructor(relPath, count) {
        super(relPath, vscode.TreeItemCollapsibleState.Collapsed);
        this.relPath = relPath;
        this.count = count;
        this.description = `${count}条`;
        this.tooltip = `${relPath}\n批注数: ${count}`;
        this.contextValue = "noteFile";
    }
}
class NoteBlockItem extends vscode.TreeItem {
    constructor(relPath, block, label) {
        super(label || `L${block.start}-L${block.end}`, vscode.TreeItemCollapsibleState.None);
        this.relPath = relPath;
        this.block = block;
        this.description = buildNoteTitle(block);
        this.tooltip = formatNoteTooltip(relPath, block);
        this.contextValue = "note";
        this.command = {
            command: "svnMergeAnnotator.openMergeBlock",
            title: "打开合并块",
            arguments: [this.relPath, this.block.start],
        };
    }
}
class NotesGroupItem extends vscode.TreeItem {
    constructor(key, count) {
        super(key, vscode.TreeItemCollapsibleState.Collapsed);
        this.entries = [];
        this.key = key;
        this.description = `${count}条`;
        this.contextValue = "noteGroup";
    }
}
class NotesTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.notesByFile = new Map();
        this.groupBy = "file";
        this.totalNotes = 0;
        this.emptyMessage = "暂无批注";
    }
    refresh(notesByFile, totalNotes, emptyMessage, groupBy) {
        this.notesByFile = notesByFile;
        this.totalNotes = totalNotes;
        if (groupBy) {
            this.groupBy = groupBy;
        }
        if (emptyMessage) {
            this.emptyMessage = emptyMessage;
        }
        this._onDidChangeTreeData.fire();
    }
    getTotalNotes() {
        return this.totalNotes;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            if (this.groupBy === "file") {
                const items = [];
                const keys = Array.from(this.notesByFile.keys()).sort();
                for (const key of keys) {
                    const blocks = this.notesByFile.get(key) || [];
                    if (!blocks.length)
                        continue;
                    items.push(new NotesFileItem(key, blocks.length));
                }
                if (!items.length) {
                    const placeholder = new vscode.TreeItem(this.emptyMessage);
                    placeholder.contextValue = "notePlaceholder";
                    return Promise.resolve([placeholder]);
                }
                return Promise.resolve(items);
            }
            const entries = [];
            for (const [relPath, blocks] of this.notesByFile.entries()) {
                for (const block of blocks) {
                    entries.push({ relPath, block });
                }
            }
            if (!entries.length) {
                const placeholder = new vscode.TreeItem(this.emptyMessage);
                placeholder.contextValue = "notePlaceholder";
                return Promise.resolve([placeholder]);
            }
            const groupMap = new Map();
            if (this.groupBy === "origin") {
                for (const entry of entries) {
                    const key = formatOriginLabel(entry.block.origin);
                    if (!groupMap.has(key)) {
                        groupMap.set(key, []);
                    }
                    groupMap.get(key)?.push(entry);
                }
                const originOrder = [
                    "分支改动",
                    "主线改动",
                    "手工调整",
                    "冲突块",
                    "共同一致",
                    "未知归属",
                ];
                const items = originOrder
                    .filter((key) => groupMap.has(key))
                    .map((key) => {
                    const group = new NotesGroupItem(key, groupMap.get(key)?.length || 0);
                    group.entries = groupMap.get(key) || [];
                    return group;
                });
                return Promise.resolve(items);
            }
            if (this.groupBy === "risk") {
                for (const entry of entries) {
                    const key = hasRisk(entry.block.ai_explain) ? "有风险" : "无风险";
                    if (!groupMap.has(key)) {
                        groupMap.set(key, []);
                    }
                    groupMap.get(key)?.push(entry);
                }
                const riskOrder = ["有风险", "无风险"];
                const items = riskOrder
                    .filter((key) => groupMap.has(key))
                    .map((key) => {
                    const group = new NotesGroupItem(key, groupMap.get(key)?.length || 0);
                    group.entries = groupMap.get(key) || [];
                    return group;
                });
                return Promise.resolve(items);
            }
            return Promise.resolve([]);
        }
        if (element instanceof NotesFileItem) {
            const blocks = this.notesByFile.get(element.relPath) || [];
            const items = blocks
                .slice()
                .sort((a, b) => a.start - b.start)
                .map((block) => new NoteBlockItem(element.relPath, block));
            return Promise.resolve(items);
        }
        if (element instanceof NotesGroupItem) {
            const items = element.entries
                .slice()
                .sort((a, b) => {
                if (a.relPath === b.relPath)
                    return a.block.start - b.block.start;
                return a.relPath.localeCompare(b.relPath);
            })
                .map((entry) => new NoteBlockItem(entry.relPath, entry.block, `${entry.relPath} · L${entry.block.start}-L${entry.block.end}`));
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}
class RevHeaderItem extends vscode.TreeItem {
    constructor(label, description) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.contextValue = "revHeader";
    }
}
class RevGroupItem extends vscode.TreeItem {
    constructor(label, description, tooltip) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.description = description;
        if (tooltip) {
            this.tooltip = tooltip;
        }
        this.contextValue = "revGroup";
    }
}
class RevFileItem extends vscode.TreeItem {
    constructor(relPath, status, mergeSummary) {
        const pathParts = getTreeItemPathParts(relPath);
        super(pathParts.fileName, vscode.TreeItemCollapsibleState.None);
        this.relPath = relPath;
        this.status = status;
        this.mergeSummary = mergeSummary;
        const summaryText = formatRevMergeSummaryText(mergeSummary);
        const descParts = [status];
        if (summaryText) {
            descParts.push(summaryText);
        }
        if (pathParts.dirLabel) {
            descParts.push(pathParts.dirLabel);
        }
        this.description = descParts.join(" · ");
        const tooltipLines = [`${status} ${relPath}`];
        if (summaryText) {
            tooltipLines.push(`变更块: ${summaryText}`);
        }
        this.tooltip = tooltipLines.join("\n");
        this.contextValue = "revFile";
        this.command = {
            command: "svnMergeAnnotator.openRevDiff",
            title: "打开差异",
            arguments: [this],
        };
        this.iconPath = getRevFileIcon(status, mergeSummary);
    }
}
class RevChangeTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.nodes = [];
    }
    refresh(nodes) {
        this.nodes = nodes;
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.nodes);
        }
        if (element instanceof RevGroupItem) {
            return Promise.resolve(element.children);
        }
        return Promise.resolve([]);
    }
}
class DiffCompareSummaryItem extends vscode.TreeItem {
    constructor(label, description) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.contextValue = "diffCompareSummary";
        this.iconPath = new vscode.ThemeIcon("list-flat");
    }
}
class DiffCompareGroupItem extends vscode.TreeItem {
    constructor(label, description, iconId) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.description = description;
        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId);
        }
        this.contextValue = "diffCompareGroup";
    }
}
class DiffCompareFileItem extends vscode.TreeItem {
    constructor(relPath, description, status) {
        const pathParts = getTreeItemPathParts(relPath);
        super(pathParts.fileName, vscode.TreeItemCollapsibleState.None);
        this.relPath = relPath;
        this.status = status;
        this.description = pathParts.dirLabel
            ? `${description} · ${pathParts.dirLabel}`
            : description;
        this.tooltip = `${relPath} ${description}`;
        this.contextValue = "diffCompareFile";
        if (status === "matched") {
            this.iconPath = new vscode.ThemeIcon("check");
        }
        else if (status === "missing") {
            this.iconPath = new vscode.ThemeIcon("error");
        }
        else if (status === "extra") {
            this.iconPath = new vscode.ThemeIcon("add");
        }
        else if (status === "mismatch") {
            this.iconPath = new vscode.ThemeIcon("warning");
        }
        else {
            this.iconPath = new vscode.ThemeIcon("diff");
        }
    }
}
class DiffCompareTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.nodes = [];
    }
    refresh(state) {
        if (!state) {
            this.nodes = [
                new vscode.TreeItem("尚未生成差异对比", vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
            return;
        }
        const summaryText = `覆盖${state.summary.matched} · 缺失${state.summary.missing} · 多余${state.summary.extra} · 不一致${state.summary.mismatch}`;
        const summary = new DiffCompareSummaryItem(`范围: ${state.rangeLabel} | 目标: ${formatDiffCompareTarget(state.target)} | 远程: ${state.remoteRev}`, summaryText);
        const localGroup = new DiffCompareGroupItem("本地差异", `${state.localItems.length}项`, "diff");
        localGroup.children = state.localItems
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((item) => new DiffCompareFileItem(item.path, normalizeRevStatus(item.status), "local"));
        const matchedGroup = buildDiffCompareGroup("已覆盖", "check", state.compareItems.filter((item) => item.status === "matched"), (item) => `范围:${item.rangeStatus || "-"} 本地:${item.localStatus || "-"}`);
        const missingGroup = buildDiffCompareGroup("缺失", "error", state.compareItems.filter((item) => item.status === "missing"), (item) => `范围:${item.rangeStatus || "-"} 本地:-`);
        const extraGroup = buildDiffCompareGroup("多余", "add", state.compareItems.filter((item) => item.status === "extra"), (item) => `范围:- 本地:${item.localStatus || "-"}`);
        const mismatchGroup = buildDiffCompareGroup("不一致", "warning", state.compareItems.filter((item) => item.status === "mismatch"), (item) => `范围:${item.rangeStatus || "-"} 本地:${item.localStatus || "-"}`);
        this.nodes = [summary, localGroup, matchedGroup, missingGroup, extraGroup, mismatchGroup];
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.nodes);
        }
        if (element instanceof DiffCompareGroupItem) {
            return Promise.resolve(element.children);
        }
        return Promise.resolve([]);
    }
}
class DecorationManager {
    constructor(context) {
        this.types = {
            branch: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(255, 213, 128, 0.35)",
                overviewRulerColor: "rgba(255, 183, 77, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            trunk: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(144, 202, 249, 0.3)",
                overviewRulerColor: "rgba(100, 181, 246, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            common: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(200, 230, 201, 0.25)",
                overviewRulerColor: "rgba(129, 199, 132, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            manual: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(206, 147, 216, 0.25)",
                overviewRulerColor: "rgba(186, 104, 200, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            conflict: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(239, 154, 154, 0.35)",
                overviewRulerColor: "rgba(229, 115, 115, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            unknown: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: "rgba(224, 224, 224, 0.3)",
                overviewRulerColor: "rgba(189, 189, 189, 0.9)",
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
        };
        const manualIcon = context.asAbsolutePath(path.join("resources", "icons", "manual.svg"));
        const conflictIcon = context.asAbsolutePath(path.join("resources", "icons", "conflict.svg"));
        this.gutterTypes = {
            manual: vscode.window.createTextEditorDecorationType({
                gutterIconPath: manualIcon,
                gutterIconSize: "contain",
            }),
            conflict: vscode.window.createTextEditorDecorationType({
                gutterIconPath: conflictIcon,
                gutterIconSize: "contain",
            }),
        };
    }
    dispose() {
        Object.values(this.types).forEach((type) => type.dispose());
        Object.values(this.gutterTypes).forEach((type) => type.dispose());
    }
    apply(editor, lineMeta, blocks, showCommon, showOnlyRisk) {
        const doc = editor.document;
        const rangesByOrigin = {
            branch: [],
            trunk: [],
            common: [],
            manual: [],
            conflict: [],
            unknown: [],
        };
        const grouped = {
            branch: [],
            trunk: [],
            common: [],
            manual: [],
            conflict: [],
            unknown: [],
        };
        const riskLineSet = showOnlyRisk ? buildRiskLineSet(blocks) : null;
        for (const meta of lineMeta || []) {
            const origin = meta.origin || "unknown";
            if (!grouped[origin]) {
                grouped[origin] = [];
            }
            const lineIndex = meta.merge_no - 1;
            if (lineIndex >= 0 && lineIndex < doc.lineCount) {
                if (riskLineSet && !riskLineSet.has(lineIndex)) {
                    continue;
                }
                grouped[origin].push(lineIndex);
            }
        }
        for (const [origin, lines] of Object.entries(grouped)) {
            if (origin === "common" && !showCommon) {
                rangesByOrigin[origin] = [];
                continue;
            }
            rangesByOrigin[origin] = buildLineRanges(lines, doc.lineCount);
        }
        Object.entries(this.types).forEach(([origin, type]) => {
            editor.setDecorations(type, rangesByOrigin[origin] || []);
        });
        const manualGutters = buildGutterRanges(blocks, "manual", riskLineSet, doc.lineCount);
        const conflictGutters = buildGutterRanges(blocks, "conflict", riskLineSet, doc.lineCount);
        editor.setDecorations(this.gutterTypes.manual, manualGutters);
        editor.setDecorations(this.gutterTypes.conflict, conflictGutters);
    }
}
function getConfig(key, fallback) {
    return vscode.workspace.getConfiguration("svnMergeAnnotator").get(key, fallback);
}
function buildLineRanges(lines, totalLines) {
    if (!lines.length)
        return [];
    const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i += 1) {
        const current = sorted[i];
        if (current === prev + 1) {
            prev = current;
            continue;
        }
        ranges.push(makeRange(start, prev, totalLines));
        start = current;
        prev = current;
    }
    ranges.push(makeRange(start, prev, totalLines));
    return ranges;
}
function makeRange(startLine, endLine, totalLines) {
    const safeStart = Math.max(0, Math.min(startLine, totalLines - 1));
    const safeEnd = Math.max(0, Math.min(endLine + 1, totalLines));
    return new vscode.Range(new vscode.Position(safeStart, 0), new vscode.Position(safeEnd, 0));
}
function buildGutterRanges(blocks, origin, riskLineSet, totalLines) {
    if (!blocks || blocks.length === 0)
        return [];
    const ranges = [];
    for (const block of blocks) {
        if (block.origin !== origin)
            continue;
        const lineIndex = block.start - 1;
        if (lineIndex < 0 || lineIndex >= totalLines)
            continue;
        if (riskLineSet && !riskLineSet.has(lineIndex)) {
            continue;
        }
        ranges.push(makeRange(lineIndex, lineIndex, totalLines));
    }
    return ranges;
}
function buildRiskLineSet(blocks) {
    const set = new Set();
    if (!blocks || blocks.length === 0)
        return set;
    for (const block of blocks) {
        if (!hasRisk(block.ai_explain))
            continue;
        for (let i = block.start; i <= block.end; i += 1) {
            set.add(i - 1);
        }
    }
    return set;
}
function formatHover(block) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**合并块** L${block.start}-L${block.end}\n\n`);
    md.appendMarkdown(`来源: ${block.origin}\n\n`);
    const ai = block.ai_explain;
    if (ai) {
        if (ai.merge_reason) {
            md.appendMarkdown(`- 合并理由: ${ai.merge_reason}\n`);
        }
        if (ai.reason) {
            md.appendMarkdown(`- 原因: ${ai.reason}\n`);
        }
        if (ai.impact) {
            md.appendMarkdown(`- 影响: ${ai.impact}\n`);
        }
        if (ai.risk) {
            md.appendMarkdown(`- 风险: ${ai.risk}\n`);
        }
        if (ai.note) {
            md.appendMarkdown(`- 备注: ${ai.note}\n`);
        }
        if (ai.source) {
            md.appendMarkdown(`- 来源: ${ai.source}\n`);
        }
        if (ai.updated_at) {
            md.appendMarkdown(`- 更新时间: ${ai.updated_at}\n`);
        }
    }
    else {
        md.appendMarkdown(`- 暂无 AI 批注\n`);
    }
    return md;
}
function formatBlockDetailText(block) {
    const lines = [];
    lines.push(`合并块: L${block.start}-L${block.end}`);
    lines.push(`来源: ${block.origin}`);
    if (block.branch_start && block.branch_end) {
        lines.push(`分支范围: L${block.branch_start}-L${block.branch_end}`);
    }
    if (block.trunk_start && block.trunk_end) {
        lines.push(`主线范围: L${block.trunk_start}-L${block.trunk_end}`);
    }
    if (block.base_start && block.base_end) {
        lines.push(`Base范围: L${block.base_start}-L${block.base_end}`);
    }
    const ai = block.ai_explain;
    if (ai) {
        if (ai.merge_reason)
            lines.push(`合并理由: ${ai.merge_reason}`);
        if (ai.reason)
            lines.push(`原因: ${ai.reason}`);
        if (ai.impact)
            lines.push(`影响: ${ai.impact}`);
        if (ai.risk)
            lines.push(`风险: ${ai.risk}`);
        if (ai.note)
            lines.push(`备注: ${ai.note}`);
        if (ai.source)
            lines.push(`来源: ${ai.source}`);
        if (ai.updated_at)
            lines.push(`更新时间: ${ai.updated_at}`);
    }
    return lines.join("\n");
}
function formatRootLabel(target) {
    if (target === "branch")
        return "分支";
    if (target === "trunk")
        return "主线";
    return "待合并";
}
function formatFileOrigin(origin) {
    switch (origin) {
        case "branch_new":
            return "分支新增";
        case "trunk_new":
            return "主线新增";
        case "merge_only":
            return "仅合并存在";
        case "shared":
            return "主干共享";
        default:
            return "未知来源";
    }
}
function formatOriginLabel(origin) {
    switch (origin) {
        case "branch":
            return "分支改动";
        case "trunk":
            return "主线改动";
        case "common":
            return "共同一致";
        case "manual":
            return "手工调整";
        case "conflict":
            return "冲突块";
        case "unknown":
            return "未知归属";
        default:
            return "未知归属";
    }
}
function formatHistoryTime(value) {
    if (!value)
        return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toLocaleString();
}
function isNewFileOrigin(origin) {
    return origin === "branch_new" || origin === "trunk_new" || origin === "merge_only";
}
function hasExplain(ai) {
    if (!ai)
        return false;
    return Boolean(ai.merge_reason ||
        ai.reason ||
        ai.impact ||
        ai.risk ||
        ai.note ||
        ai.source ||
        ai.updated_at);
}
function hasRisk(ai) {
    if (!ai || !ai.risk)
        return false;
    return ai.risk.trim().length > 0;
}
function buildNoteTitle(block) {
    const ai = block.ai_explain;
    if (!ai)
        return `未批注 · ${formatOriginLabel(block.origin)}`;
    if (ai.merge_reason)
        return `合并理由: ${ai.merge_reason}`;
    if (ai.reason)
        return `原因: ${ai.reason}`;
    if (ai.risk)
        return `风险: ${ai.risk}`;
    if (ai.note)
        return `备注: ${ai.note}`;
    return "AI批注";
}
function buildNoteBaseLines(relPath, block) {
    const lines = [];
    lines.push(`文件: ${relPath}`);
    lines.push(`合并范围: L${block.start}-L${block.end}`);
    lines.push(`来源: ${block.origin}`);
    if (block.branch_start && block.branch_end) {
        lines.push(`分支范围: L${block.branch_start}-L${block.branch_end}`);
    }
    if (block.trunk_start && block.trunk_end) {
        lines.push(`主线范围: L${block.trunk_start}-L${block.trunk_end}`);
    }
    if (block.base_start && block.base_end) {
        lines.push(`Base范围: L${block.base_start}-L${block.base_end}`);
    }
    return lines;
}
function appendAiLines(lines, ai) {
    if (!ai) {
        lines.push("AI批注: 暂无");
        return;
    }
    if (ai.merge_reason)
        lines.push(`合并理由: ${ai.merge_reason}`);
    if (ai.reason)
        lines.push(`原因: ${ai.reason}`);
    if (ai.impact)
        lines.push(`影响: ${ai.impact}`);
    if (ai.risk)
        lines.push(`风险: ${ai.risk}`);
    if (ai.note)
        lines.push(`备注: ${ai.note}`);
    if (ai.source)
        lines.push(`来源: ${ai.source}`);
    if (ai.updated_at)
        lines.push(`更新时间: ${ai.updated_at}`);
}
function extractSnippet(text, maxLines) {
    if (!text)
        return [];
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines)
        return lines;
    return [...lines.slice(0, maxLines), `... (共${lines.length}行)`];
}
function formatNoteCopyText(relPath, block) {
    const maxLines = getConfig("noteSnippetMaxLines", 30);
    const lines = buildNoteBaseLines(relPath, block);
    const snippet = extractSnippet(block.diff?.merge, maxLines);
    if (snippet.length) {
        lines.push("合并片段:");
        lines.push("```");
        lines.push(...snippet);
        lines.push("```");
    }
    appendAiLines(lines, block.ai_explain);
    return lines.join("\n");
}
function formatNoteTooltip(relPath, block) {
    const lines = buildNoteBaseLines(relPath, block);
    const snippet = extractSnippet(block.diff?.merge, 6);
    if (snippet.length) {
        lines.push("合并片段:");
        lines.push(...snippet);
    }
    appendAiLines(lines, block.ai_explain);
    return lines.join("\n");
}
function extractNotes(detail) {
    if (!detail?.blocks)
        return [];
    const includeAll = getConfig("notesIncludeAllBlocks", true);
    if (includeAll)
        return detail.blocks;
    return detail.blocks.filter((block) => hasExplain(block.ai_explain));
}
function activate(context) {
    const revProvider = new RevChangeTreeProvider();
    const diffCompareProvider = new DiffCompareTreeProvider();
    const output = vscode.window.createOutputChannel("SVN Merge Annotator");
    const state = {
        allFiles: [],
        files: [],
        fileDetailByPath: new Map(),
        fileDetailByRelPath: new Map(),
        notesByRelPath: new Map(),
        notesLoaded: false,
        notesLoading: false,
        annotationIndex: new Map(),
        annotationIndexLoaded: false,
        annotationIndexLoading: false,
        summaryByPath: new Map(),
        summaryLoaded: false,
        summaryLoading: false,
    };
    let revState;
    let diffCompareState;
    let revMergeSummaryScanToken = 0;
    const revRootCache = new Map();
    const diffCompareRootCache = new Map();
    const revFileLogCache = new Map();
    const fileHistoryCompareCache = new Map();
    const revView = vscode.window.createTreeView("svnMergeAnnotator.revChanges", {
        treeDataProvider: revProvider,
    });
    const diffCompareView = vscode.window.createTreeView("svnMergeAnnotator.diffCompare", {
        treeDataProvider: diffCompareProvider,
    });
    context.subscriptions.push(revView, diffCompareView, output);
    diffCompareProvider.refresh(diffCompareState);
    const diffLensEmitter = new vscode.EventEmitter();
    const diffLensProvider = {
        onDidChangeCodeLenses: diffLensEmitter.event,
        async provideCodeLenses(document) {
            if (document.uri.scheme !== "svnrev")
                return [];
            const lenses = [];
            try {
                if (!revState)
                    return [];
                const relPath = decodeURIComponent(document.uri.path.replace(/^\/+/, ""));
                const rev = new URLSearchParams(document.uri.query).get("rev") || "";
                const useOldSide = normalizeRevCompareValue(rev) ===
                    normalizeRevCompareValue(revState.startRev);
                const diff = await ensureRevFileDiff(relPath);
                for (const hunk of diff.hunks) {
                    const anchorLine = getRevHunkAnchorLine(hunk, useOldSide, document.lineCount);
                    const range = new vscode.Range(Math.max(anchorLine - 1, 0), 0, Math.max(anchorLine - 1, 0), 0);
                    const status = await ensureRevHunkStatus(relPath, hunk.index, false);
                    lenses.push(new vscode.CodeLens(range, {
                        command: "svnMergeAnnotator.noop",
                        title: `块${hunk.index + 1} 状态: ${getRevHunkStatusLabel(status)}`,
                    }));
                    lenses.push(new vscode.CodeLens(range, {
                        command: "svnMergeAnnotator.openMergeByHunkContext",
                        title: "定位合并处",
                        arguments: [relPath, hunk.index],
                    }));
                    if (status !== "merged") {
                        lenses.push(new vscode.CodeLens(range, {
                            command: "svnMergeAnnotator.applyRevHunkToMerge",
                            title: "合并此块",
                            arguments: [relPath, hunk.index],
                        }));
                    }
                    lenses.push(new vscode.CodeLens(range, {
                        command: "svnMergeAnnotator.copyRevHunkDebugLog",
                        title: "复制日志",
                        arguments: [relPath, hunk.index],
                    }));
                }
            }
            catch (err) {
                logMessage("WARN", "diff codelens resolve hunk failed", {
                    error: String(err),
                });
            }
            return lenses;
        },
    };
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: "svnrev" }, diffLensProvider), vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== "svnrev")
            return;
        diffLensEmitter.fire();
    }));
    const revContentProvider = {
        provideTextDocumentContent: async (uri) => {
            const relPath = decodeURIComponent(uri.path.replace(/^\/+/, ""));
            const params = new URLSearchParams(uri.query);
            const rev = params.get("rev") || "";
            if (!revState) {
                return "未加载提交范围数据";
            }
            const fileUrl = joinUrl(revState.root.rootUrl, relPath);
            const resp = await runSvn(["cat", "-r", rev, fileUrl], revState.root.rootPath);
            if (resp.code !== 0) {
                const errorText = resp.stderr || "该修订号下文件不存在";
                return `// ${formatRevLabel(rev)} 无法读取\n${errorText}`;
            }
            return resp.stdout;
        },
    };
    const revCompareContentProvider = {
        provideTextDocumentContent: async (uri) => {
            const relPath = decodeURIComponent(uri.path.replace(/^\/+/, ""));
            const params = new URLSearchParams(uri.query);
            const rev = params.get("rev") || "";
            const targetRaw = (params.get("target") || "").toLowerCase();
            if (targetRaw !== "branch" && targetRaw !== "trunk") {
                return "// 无效的对比来源";
            }
            const target = targetRaw;
            const root = await getRootInfo(target);
            if (!root) {
                return `// ${formatRootLabel(target)}目录未配置`;
            }
            const fileUrl = joinUrl(root.rootUrl, relPath);
            const resp = await runSvn(["cat", "-r", rev, fileUrl], root.rootPath);
            if (resp.code !== 0) {
                const errorText = resp.stderr || "该修订号下文件不存在";
                return `// ${formatRootLabel(target)} ${formatRevLabel(rev)} 无法读取\n${errorText}`;
            }
            return resp.stdout;
        },
    };
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("svnrev", revContentProvider), vscode.workspace.registerTextDocumentContentProvider(SVN_REV_COMPARE_SCHEME, revCompareContentProvider));
    function logMessage(level, message, detail) {
        const enabled = getConfig("debugLogging", true);
        if (!enabled)
            return;
        const timestamp = new Date().toISOString();
        const suffix = detail ? ` | ${JSON.stringify(detail)}` : "";
        output.appendLine(`[${timestamp}] [${level}] ${message}${suffix}`);
    }
    function createOperationId(prefix) {
        const stamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2, 8);
        return `${prefix}-${stamp}-${random}`;
    }
    function getErrorDetail(err) {
        if (err instanceof Error) {
            return {
                message: err.message,
                stack: err.stack,
            };
        }
        return {
            message: String(err),
            stack: undefined,
        };
    }
    function captureFileSnapshotForDebug(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return {
                    path: filePath,
                    exists: false,
                    isFile: false,
                };
            }
            const stat = fs.statSync(filePath);
            const snapshot = {
                path: filePath,
                exists: true,
                isFile: stat.isFile(),
                size: stat.size,
                mtimeMs: stat.mtimeMs,
            };
            if (!stat.isFile()) {
                return snapshot;
            }
            const maxHashSize = 20 * 1024 * 1024;
            if (stat.size > maxHashSize) {
                snapshot.hashSkipped = true;
                return snapshot;
            }
            const buf = fs.readFileSync(filePath);
            snapshot.sha1 = crypto.createHash("sha1").update(buf).digest("hex");
            return snapshot;
        }
        catch (err) {
            const detail = getErrorDetail(err);
            return {
                path: filePath,
                exists: false,
                isFile: false,
                error: detail.message,
            };
        }
    }
    function normalizePath(value) {
        if (!value)
            return "";
        let normalized = path.normalize(value);
        const root = path.parse(normalized).root;
        if (normalized !== root) {
            normalized = normalized.replace(/[\\\/]+$/, "");
        }
        return normalized.toLowerCase();
    }
    function isSamePath(a, b) {
        if (!a || !b)
            return false;
        return normalizePath(a) === normalizePath(b);
    }
    function sanitizeRoots(roots) {
        const result = { ...(roots || {}) };
        if (result.merge) {
            if (result.branch && isSamePath(result.branch, result.merge)) {
                logMessage("WARN", "sanitizeRoots: branch=merge, ignored", {
                    branch: result.branch,
                    merge: result.merge,
                });
                result.branch = undefined;
            }
            if (result.trunk && isSamePath(result.trunk, result.merge)) {
                logMessage("WARN", "sanitizeRoots: trunk=merge, ignored", {
                    trunk: result.trunk,
                    merge: result.merge,
                });
                result.trunk = undefined;
            }
            if (result.base && isSamePath(result.base, result.merge)) {
                logMessage("WARN", "sanitizeRoots: base=merge, ignored", {
                    base: result.base,
                    merge: result.merge,
                });
                result.base = undefined;
            }
        }
        return result;
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("svnMergeAnnotator.revGroupMode") ||
            event.affectsConfiguration("svnMergeAnnotator.revChangeFilter")) {
            void (async () => {
                if (getRevGroupMode() === "commit") {
                    try {
                        await ensureLogEntries();
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(message);
                    }
                }
                refreshRevView();
            })();
        }
    }));
    function getRevGroupMode() {
        const value = getConfig("revGroupMode", "dir1");
        if (value === "dir2" || value === "commit")
            return value;
        return "dir1";
    }
    function getRevChangeFilter() {
        const value = getConfig("revChangeFilter", "all");
        if (value === "A" || value === "M" || value === "D")
            return value;
        return "all";
    }
    function buildDisplayRoots() {
        const lastDirs = context.globalState.get(LAST_DIRS_KEY);
        const branch = state.roots?.branch || lastDirs?.branch || "";
        const trunk = state.roots?.trunk || lastDirs?.trunk || "";
        const merge = state.roots?.merge || lastDirs?.merge || "";
        return {
            branch: branch || undefined,
            trunk: trunk || undefined,
            merge: merge || undefined,
        };
    }
    async function resolveMergeRoot() {
        logMessage("INFO", "resolveMergeRoot: start");
        if (state.roots?.merge) {
            logMessage("INFO", "resolveMergeRoot: using roots.merge", {
                merge: state.roots.merge,
            });
            return state.roots.merge;
        }
        const lastDirs = context.globalState.get(LAST_DIRS_KEY);
        if (lastDirs?.merge) {
            state.roots = state.roots || {};
            state.roots.merge = lastDirs.merge;
            logMessage("INFO", "resolveMergeRoot: using lastDirs", {
                merge: lastDirs.merge,
            });
            return lastDirs.merge;
        }
        const picked = await pickFolder("选择 Merge 目录", false);
        if (picked) {
            state.roots = state.roots || {};
            state.roots.merge = picked;
            await context.globalState.update(LAST_DIRS_KEY, {
                branch: lastDirs?.branch || "",
                trunk: lastDirs?.trunk || "",
                merge: picked,
                base: lastDirs?.base || "",
            });
            logMessage("INFO", "resolveMergeRoot: picked merge", { merge: picked });
            return picked;
        }
        logMessage("WARN", "resolveMergeRoot: missing merge root");
        return undefined;
    }
    function getKnownMergeRoot() {
        if (state.roots?.merge)
            return state.roots.merge;
        const lastDirs = context.globalState.get(LAST_DIRS_KEY);
        if (lastDirs?.merge) {
            state.roots = state.roots || {};
            state.roots.merge = lastDirs.merge;
            return lastDirs.merge;
        }
        return undefined;
    }
    async function resolveRoot(target) {
        logMessage("INFO", "resolveRoot: start", { target });
        if (target === "merge") {
            return resolveMergeRoot();
        }
        const lastDirs = context.globalState.get(LAST_DIRS_KEY);
        const mergeRoot = state.roots?.merge || lastDirs?.merge;
        const candidate = state.roots ? state.roots[target] : undefined;
        if (candidate) {
            if (mergeRoot && isSamePath(candidate, mergeRoot)) {
                logMessage("WARN", "resolveRoot: root equals merge, ignored", {
                    target,
                    path: candidate,
                    merge: mergeRoot,
                });
            }
            else {
                logMessage("INFO", "resolveRoot: using roots", {
                    target,
                    path: candidate,
                });
                return candidate;
            }
        }
        const fallback = target === "branch"
            ? lastDirs?.branch
            : target === "trunk"
                ? lastDirs?.trunk
                : target === "base"
                    ? lastDirs?.base
                    : "";
        if (fallback) {
            if (mergeRoot && isSamePath(fallback, mergeRoot)) {
                logMessage("WARN", "resolveRoot: lastDirs equals merge, ignored", {
                    target,
                    path: fallback,
                    merge: mergeRoot,
                });
                if (lastDirs) {
                    await context.globalState.update(LAST_DIRS_KEY, {
                        branch: target === "branch" ? "" : lastDirs.branch || "",
                        trunk: target === "trunk" ? "" : lastDirs.trunk || "",
                        merge: lastDirs.merge || "",
                        base: target === "base" ? "" : lastDirs.base || "",
                    });
                }
            }
            else {
                state.roots = state.roots || {};
                state.roots[target] = fallback;
                logMessage("INFO", "resolveRoot: using lastDirs", {
                    target,
                    path: fallback,
                });
                return fallback;
            }
        }
        const prompt = target === "branch"
            ? "选择 Branch 目录"
            : target === "trunk"
                ? "选择 Trunk 目录"
                : "选择 Base 目录";
        logMessage("INFO", "resolveRoot: prompt pickFolder", { target });
        const picked = await pickFolder(prompt, false);
        if (picked) {
            state.roots = state.roots || {};
            state.roots[target] = picked;
            await context.globalState.update(LAST_DIRS_KEY, {
                branch: target === "branch" ? picked : lastDirs?.branch || "",
                trunk: target === "trunk" ? picked : lastDirs?.trunk || "",
                merge: lastDirs?.merge || "",
                base: target === "base" ? picked : lastDirs?.base || "",
            });
            logMessage("INFO", "resolveRoot: picked root", { target, path: picked });
            return picked;
        }
        logMessage("WARN", "resolveRoot: missing root", { target });
        return undefined;
    }
    function resolveRootTarget(input) {
        if (!input)
            return undefined;
        if (input instanceof RootPathItem) {
            return input.target;
        }
        return input;
    }
    async function updateRootPath(target, value) {
        const nextRoots = sanitizeRoots({
            ...(state.roots || {}),
            [target]: value,
        });
        state.roots = nextRoots;
        const lastDirs = context.globalState.get(LAST_DIRS_KEY);
        const nextDirs = {
            branch: lastDirs?.branch || "",
            trunk: lastDirs?.trunk || "",
            merge: lastDirs?.merge || "",
            base: lastDirs?.base || "",
        };
        nextDirs[target] = value;
        await context.globalState.update(LAST_DIRS_KEY, nextDirs);
        refreshRevView();
        diffCompareProvider.refresh(diffCompareState);
    }
    async function setRootPath(item) {
        const target = resolveRootTarget(item);
        if (!target) {
            vscode.window.showErrorMessage("未选择路径类型");
            return;
        }
        const current = buildDisplayRoots()[target];
        const picked = await pickFolder(`选择${formatRootLabel(target)}目录`, false, current);
        if (!picked)
            return;
        await updateRootPath(target, picked);
    }
    async function copyRootPath(item) {
        const target = resolveRootTarget(item);
        if (!target) {
            vscode.window.showErrorMessage("未选择路径类型");
            return;
        }
        const value = buildDisplayRoots()[target];
        if (!value) {
            vscode.window.showErrorMessage(`${formatRootLabel(target)}路径未设置`);
            return;
        }
        await vscode.env.clipboard.writeText(value);
        vscode.window.showInformationMessage(`${formatRootLabel(target)}路径已复制`);
    }
    async function clearRootPath(item) {
        const target = resolveRootTarget(item);
        if (!target) {
            vscode.window.showErrorMessage("未选择路径类型");
            return;
        }
        await updateRootPath(target, "");
    }
    async function openMergeFile(relPath, lineNo, revealFirstChange = true, loadDetail = true) {
        logMessage("INFO", "openMergeFile: start", { relPath, lineNo });
        const mergeRoot = await resolveMergeRoot();
        if (!mergeRoot) {
            vscode.window.showErrorMessage("缺少 merge 根目录信息");
            logMessage("WARN", "openMergeFile: missing merge root");
            return;
        }
        const mergePath = resolveMergePathContext(mergeRoot, relPath);
        const filePath = mergePath.filePath;
        logMessage("INFO", "openMergeFile: resolved file", { filePath });
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false,
        });
        if (lineNo && lineNo > 0) {
            const range = new vscode.Range(new vscode.Position(lineNo - 1, 0), new vscode.Position(lineNo - 1, 0));
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            return;
        }
        if (revealFirstChange && loadDetail) {
            logMessage("INFO", "openMergeFile: revealFirstChange skipped without analysis");
        }
    }
    function normalizeRevInput(raw) {
        if (!raw)
            return undefined;
        const value = raw.trim();
        if (!value)
            return undefined;
        if (value.toUpperCase() === "HEAD")
            return "HEAD";
        const cleaned = value.replace(/^r/i, "");
        if (!/^\d+$/.test(cleaned))
            return undefined;
        return cleaned;
    }
    function formatRevLabel(rev) {
        if (rev.toUpperCase() === "HEAD")
            return "HEAD";
        const cleaned = rev.replace(/^r/i, "");
        return `r${cleaned}`;
    }
    function filterRevItems(items, filter) {
        if (filter === "all")
            return items;
        return items.filter((item) => normalizeRevStatus(item.status) === filter);
    }
    function normalizeSlashes(value) {
        return value.replace(/\\/g, "/");
    }
    function joinUrl(base, relPath) {
        const left = base.replace(/\/+$/, "");
        const right = relPath.replace(/^\/+/, "");
        return `${left}/${right}`;
    }
    function decodeXml(value) {
        return value
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, "\"")
            .replace(/&apos;/g, "'");
    }
    function toRelativePath(rawPath, root) {
        const value = rawPath.trim();
        if (!value)
            return "";
        if (root.rootUrl && value.startsWith(root.rootUrl)) {
            return value.slice(root.rootUrl.length).replace(/^\/+/, "");
        }
        if (root.reposRoot && root.rootSuffix) {
            const fullPrefix = `${root.reposRoot}${root.rootSuffix}`;
            if (value.startsWith(fullPrefix)) {
                return value.slice(fullPrefix.length).replace(/^\/+/, "");
            }
        }
        if (root.rootSuffix && value.startsWith(root.rootSuffix)) {
            return value.slice(root.rootSuffix.length).replace(/^\/+/, "");
        }
        if (value.startsWith("/") || value.includes("://")) {
            return "";
        }
        const normalizedRoot = normalizeSlashes(root.rootPath);
        const normalizedValue = normalizeSlashes(value);
        if (normalizedValue.startsWith(normalizedRoot)) {
            return normalizedValue.slice(normalizedRoot.length).replace(/^\/+/, "");
        }
        return value.replace(/^\/+/, "");
    }
    function getDirGroupKey(relPath, depth) {
        const parts = splitRelPath(relPath);
        if (!parts.length)
            return "ROOT";
        const dirs = parts.slice(0, -1);
        if (!dirs.length)
            return "ROOT";
        const take = Math.min(depth, dirs.length);
        return dirs.slice(0, take).join("/");
    }
    function buildRevHeader(state) {
        const targetLabel = state.target === "branch" ? "分支" : "主线";
        const label = "提交范围";
        const counts = countRevItems(state.diffItems);
        const desc = `${formatRevLabel(state.startRev)} → ${formatRevLabel(state.endRev)} (${targetLabel}) · ${formatRevCounts(counts)}`;
        return new RevHeaderItem(label, desc);
    }
    function buildDirectoryNodes(items, depth, filter, mergeSummaryByPath) {
        const filtered = filterRevItems(items, filter);
        if (!filtered.length) {
            return [new RevHeaderItem("暂无变更")];
        }
        const groups = new Map();
        for (const item of filtered) {
            const key = getDirGroupKey(item.path, depth);
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)?.push(item);
        }
        const nodes = [];
        const keys = Array.from(groups.keys()).sort();
        for (const key of keys) {
            const groupItems = groups.get(key) || [];
            groupItems.sort((a, b) => a.path.localeCompare(b.path));
            const counts = countRevItems(groupItems);
            const group = new RevGroupItem(key, `文件 ${counts.total} · ${formatRevCounts(counts)}`);
            group.children = groupItems.map((item) => new RevFileItem(item.path, normalizeRevStatus(item.status), mergeSummaryByPath?.get(item.path)));
            nodes.push(group);
        }
        return nodes;
    }
    function formatLogMessage(message) {
        if (!message)
            return "";
        const first = message.split(/\r?\n/)[0]?.trim();
        return first || "";
    }
    function formatLogDate(date) {
        if (!date)
            return "";
        const parsed = new Date(date);
        if (Number.isNaN(parsed.getTime()))
            return date;
        return parsed.toLocaleString();
    }
    function buildCommitNodes(entries, filter, mergeSummaryByPath) {
        if (!entries || !entries.length) {
            return [new RevHeaderItem("暂无提交记录")];
        }
        const nodes = [];
        for (const entry of entries) {
            const filtered = filterRevItems(entry.items || [], filter);
            if (!filtered.length)
                continue;
            const label = `r${entry.revision}`;
            const message = formatLogMessage(entry.message);
            const metaParts = [];
            if (entry.author)
                metaParts.push(entry.author);
            const dateText = formatLogDate(entry.date);
            if (dateText)
                metaParts.push(dateText);
            const counts = countRevItems(filtered);
            const summary = formatRevCounts(counts);
            const description = message
                ? `${message} · ${summary}`
                : `${metaParts.join(" · ")}${metaParts.length ? " · " : ""}${summary}`;
            const tooltipLines = [
                label,
                entry.author ? `作者: ${entry.author}` : "",
                entry.date ? `时间: ${formatLogDate(entry.date)}` : "",
                message ? `说明: ${message}` : "",
                `范围: ${summary}`,
            ].filter(Boolean);
            const group = new RevGroupItem(label, description, tooltipLines.join("\n"));
            group.children = filtered.map((item) => new RevFileItem(item.path, normalizeRevStatus(item.status), mergeSummaryByPath?.get(item.path)));
            nodes.push(group);
        }
        if (!nodes.length) {
            return [new RevHeaderItem("暂无提交记录")];
        }
        return nodes;
    }
    function buildRevNodes(state) {
        const mode = getRevGroupMode();
        const filter = getRevChangeFilter();
        const header = buildRevHeader(state);
        if (mode === "commit") {
            return [
                header,
                ...buildCommitNodes(state.logEntries, filter, state.mergeSummaryByPath),
            ];
        }
        const depth = mode === "dir2" ? 2 : 1;
        return [
            header,
            ...buildDirectoryNodes(state.diffItems, depth, filter, state.mergeSummaryByPath),
        ];
    }
    async function runSvn(args, cwd) {
        return new Promise((resolve) => {
            const callId = createOperationId("svn");
            logMessage("INFO", "runSvn: start", {
                callId,
                cwd: cwd || "",
                args,
            });
            const proc = child_process.spawn("svn", args, {
                cwd,
                shell: true,
            });
            const stdoutChunks = [];
            const stderrChunks = [];
            proc.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
            proc.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
            proc.on("error", (err) => {
                const detail = getErrorDetail(err);
                const stderr = detail.message;
                logMessage("ERROR", "runSvn: spawn error", {
                    callId,
                    cwd: cwd || "",
                    args,
                    error: detail.message,
                    stack: detail.stack,
                });
                resolve({ stdout: "", stderr, code: 1 });
            });
            proc.on("close", (code) => {
                const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
                const stderr = Buffer.concat(stderrChunks).toString("utf-8");
                const exitCode = code ?? 0;
                logMessage(exitCode === 0 ? "INFO" : "WARN", "runSvn: done", {
                    callId,
                    cwd: cwd || "",
                    args,
                    code: exitCode,
                    stdout: summarizeLogText(stdout, 6),
                    stderr: summarizeLogText(stderr, 6),
                });
                resolve({ stdout, stderr, code: code ?? 0 });
            });
        });
    }
    async function getRootInfo(target) {
        const cached = revRootCache.get(target);
        if (cached)
            return cached;
        const rootPath = await resolveRoot(target);
        if (!rootPath)
            return undefined;
        const info = await runSvn(["info", "--xml", rootPath], rootPath);
        if (info.code !== 0) {
            throw new Error(info.stderr || "无法读取 SVN 信息");
        }
        const urlMatch = info.stdout.match(/<url>([^<]+)<\/url>/);
        const rootMatch = info.stdout.match(/<root>([^<]+)<\/root>/);
        const rootUrl = urlMatch ? decodeXml(urlMatch[1]) : "";
        if (!rootUrl) {
            throw new Error("未获取到 SVN URL");
        }
        const reposRoot = rootMatch ? decodeXml(rootMatch[1]) : undefined;
        const rootSuffix = reposRoot && rootUrl.startsWith(reposRoot)
            ? rootUrl.slice(reposRoot.length)
            : undefined;
        const root = {
            rootPath,
            rootUrl,
            reposRoot,
            rootSuffix,
        };
        revRootCache.set(target, root);
        return root;
    }
    async function getRootInfoForCompare(target) {
        const cached = diffCompareRootCache.get(target);
        if (cached)
            return cached;
        const rootPath = target === "merge" ? await resolveMergeRoot() : await resolveRoot(target);
        if (!rootPath)
            return undefined;
        const info = await runSvn(["info", "--xml", rootPath], rootPath);
        if (info.code !== 0) {
            throw new Error(info.stderr || "无法读取 SVN 信息");
        }
        const urlMatch = info.stdout.match(/<url>([^<]+)<\/url>/);
        const rootMatch = info.stdout.match(/<root>([^<]+)<\/root>/);
        const rootUrl = urlMatch ? decodeXml(urlMatch[1]) : "";
        if (!rootUrl) {
            throw new Error("未获取到 SVN URL");
        }
        const reposRoot = rootMatch ? decodeXml(rootMatch[1]) : undefined;
        const rootSuffix = reposRoot && rootUrl.startsWith(reposRoot)
            ? rootUrl.slice(reposRoot.length)
            : undefined;
        const root = {
            rootPath,
            rootUrl,
            reposRoot,
            rootSuffix,
        };
        diffCompareRootCache.set(target, root);
        return root;
    }
    async function fetchDiffItems(root, startRev, endRev) {
        const range = `${startRev}:${endRev}`;
        const resp = await runSvn(["diff", "--summarize", "-r", range, root.rootUrl], root.rootPath);
        if (resp.code !== 0) {
            throw new Error(resp.stderr || "获取提交范围差异失败");
        }
        return parseSummarizeOutput(resp.stdout, root);
    }
    function parseSummarizeOutput(output, root) {
        const items = [];
        for (const line of output.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const match = trimmed.match(/^([A-Z])\s+(.+)$/);
            if (!match)
                continue;
            const status = match[1];
            const rawPath = match[2].trim();
            const relPath = toRelativePath(rawPath, root);
            if (!relPath)
                continue;
            items.push({ status, path: relPath });
        }
        return items;
    }
    async function fetchLocalDiffItems(root, remoteRev) {
        const rev = normalizeRevInput(remoteRev) || "HEAD";
        const peg = `${root.rootUrl}@${rev}`;
        const resp = await runSvn(["diff", "--summarize", "--old", peg, "--new", root.rootPath], root.rootPath);
        if (resp.code !== 0) {
            throw new Error(resp.stderr || "鑾峰彇鏈湴宸紓澶辫触");
        }
        return parseSummarizeOutput(resp.stdout, root);
    }
    async function fetchLogEntries(root, startRev, endRev) {
        const range = `${startRev}:${endRev}`;
        const resp = await runSvn(["log", "--xml", "-v", "-r", range, root.rootUrl], root.rootPath);
        if (resp.code !== 0) {
            throw new Error(resp.stderr || "获取提交记录失败");
        }
        const entries = [];
        const blocks = resp.stdout.match(/<logentry[\s\S]*?<\/logentry>/g) || [];
        for (const block of blocks) {
            const revMatch = block.match(/revision=\"(\d+)\"/);
            if (!revMatch)
                continue;
            const revision = revMatch[1];
            const authorMatch = block.match(/<author>([\s\S]*?)<\/author>/);
            const dateMatch = block.match(/<date>([\s\S]*?)<\/date>/);
            const msgMatch = block.match(/<msg>([\s\S]*?)<\/msg>/);
            const items = [];
            const pathBlocks = block.match(/<path[^>]*>[\s\S]*?<\/path>/g) || [];
            for (const pathBlock of pathBlocks) {
                const actionMatch = pathBlock.match(/action=\"([A-Z])\"/);
                const action = actionMatch ? actionMatch[1] : "M";
                const rawPath = pathBlock
                    .replace(/^<path[^>]*>/, "")
                    .replace(/<\/path>$/, "");
                const decodedPath = decodeXml(rawPath);
                const relPath = toRelativePath(decodedPath, root);
                if (!relPath)
                    continue;
                items.push({ status: action, path: relPath });
            }
            entries.push({
                revision,
                author: authorMatch ? decodeXml(authorMatch[1]).trim() : undefined,
                date: dateMatch ? decodeXml(dateMatch[1]).trim() : undefined,
                message: msgMatch ? decodeXml(msgMatch[1]).trim() : undefined,
                items,
            });
        }
        return entries;
    }
    function parseFileLogEntriesFromXml(xml) {
        const entries = [];
        const blocks = xml.match(/<logentry[\s\S]*?<\/logentry>/g) || [];
        for (const block of blocks) {
            const revMatch = block.match(/revision=\"(\d+)\"/);
            if (!revMatch)
                continue;
            const revision = revMatch[1];
            const authorMatch = block.match(/<author>([\s\S]*?)<\/author>/);
            const dateMatch = block.match(/<date>([\s\S]*?)<\/date>/);
            const msgMatch = block.match(/<msg>([\s\S]*?)<\/msg>/);
            entries.push({
                revision,
                author: authorMatch ? decodeXml(authorMatch[1]).trim() : undefined,
                date: dateMatch ? decodeXml(dateMatch[1]).trim() : undefined,
                message: msgMatch ? decodeXml(msgMatch[1]).trim() : undefined,
            });
        }
        return entries;
    }
    async function fetchFileLogEntries(root, startRev, endRev, relPath) {
        const range = `${startRev}:${endRev}`;
        const fileUrl = joinUrl(root.rootUrl, relPath);
        const resp = await runSvn(["log", "--xml", "-r", range, fileUrl], root.rootPath);
        if (resp.code !== 0) {
            throw new Error(resp.stderr || "获取文件提交记录失败");
        }
        return parseFileLogEntriesFromXml(resp.stdout);
    }
    async function fetchFileLogEntriesLatest(root, relPath, limit = FILE_HISTORY_PICK_LIMIT) {
        const fileUrl = joinUrl(root.rootUrl, relPath);
        const resp = await runSvn(["log", "--xml", "-l", String(limit), fileUrl], root.rootPath);
        if (resp.code !== 0) {
            throw new Error(resp.stderr || "获取文件历史失败");
        }
        return parseFileLogEntriesFromXml(resp.stdout);
    }
    async function ensureLogEntries() {
        if (!revState)
            return;
        if (revState.logEntries)
            return;
        revState.logEntries = await fetchLogEntries(revState.root, revState.startRev, revState.endRev);
    }
    async function ensureFileLogEntries(relPath) {
        if (!revState)
            return [];
        const cached = revFileLogCache.get(relPath);
        if (cached)
            return cached;
        const entries = await fetchFileLogEntries(revState.root, revState.startRev, revState.endRev, relPath);
        revFileLogCache.set(relPath, entries);
        return entries;
    }
    function refreshRevView() {
        if (!revState) {
            revView.message = "未运行提交范围变更";
            revProvider.refresh([new RevHeaderItem("暂无提交范围数据")]);
            return;
        }
        const nodes = buildRevNodes(revState);
        const targetLabel = revState.target === "branch" ? "分支" : "主线";
        revView.message = `${formatRevLabel(revState.startRev)} → ${formatRevLabel(revState.endRev)} (${targetLabel})`;
        revProvider.refresh(nodes);
    }
    async function runRevRangeInternal(target, startRev, endRev) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "提交范围变更分析",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: "读取 SVN 信息..." });
            const root = await getRootInfo(target);
            if (!root) {
                throw new Error("未找到 SVN 根目录");
            }
            progress.report({ message: "获取变更清单..." });
            const diffItems = await fetchDiffItems(root, startRev, endRev);
            let logEntries;
            if (getRevGroupMode() === "commit") {
                progress.report({ message: "获取提交记录..." });
                logEntries = await fetchLogEntries(root, startRev, endRev);
            }
            revState = {
                target,
                startRev,
                endRev,
                root,
                diffItems,
                logEntries,
                diffByPath: new Map(),
                hunkStatusByPath: new Map(),
                mergeSummaryByPath: new Map(),
            };
            revFileLogCache.clear();
            diffCompareState = undefined;
            diffCompareProvider.refresh(diffCompareState);
            await context.globalState.update(REV_RANGE_KEY, {
                target,
                startRev,
                endRev,
            });
        });
        refreshRevView();
        void refreshRevMergeSummariesInBackground(undefined, true);
    }
    async function runRevRange() {
        const last = context.globalState.get(REV_RANGE_KEY);
        const targetPick = await vscode.window.showQuickPick([
            { label: "分支", value: "branch" },
            { label: "主线", value: "trunk" },
        ], {
            placeHolder: "选择提交范围目标",
        });
        if (!targetPick)
            return;
        const startInput = await vscode.window.showInputBox({
            prompt: "输入起始修订号（如 4903 或 r4903）",
            value: last?.startRev ? formatRevLabel(last.startRev) : "",
        });
        const startRev = normalizeRevInput(startInput);
        if (!startRev) {
            vscode.window.showErrorMessage("起始修订号无效");
            return;
        }
        const endInput = await vscode.window.showInputBox({
            prompt: "输入结束修订号（如 5120 或 HEAD）",
            value: last?.endRev ? formatRevLabel(last.endRev) : "",
        });
        const endRev = normalizeRevInput(endInput);
        if (!endRev) {
            vscode.window.showErrorMessage("结束修订号无效");
            return;
        }
        try {
            await runRevRangeInternal(targetPick.value, startRev, endRev);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function refreshRevChanges() {
        if (!revState) {
            await runRevRange();
            return;
        }
        try {
            await runRevRangeInternal(revState.target, revState.startRev, revState.endRev);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function runDiffCompareInternal(target, remoteRev) {
        const currentRevState = revState;
        if (!currentRevState) {
            vscode.window.showErrorMessage("请先运行提交范围变更");
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "差异对比",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: "读取 SVN 信息..." });
            const root = await getRootInfoForCompare(target);
            if (!root) {
                throw new Error("未找到 SVN 根目录");
            }
            progress.report({ message: "获取本地差异..." });
            const localItems = await fetchLocalDiffItems(root, remoteRev);
            progress.report({ message: "比对范围变更..." });
            const { entries, summary } = compareDiffItems(currentRevState.diffItems || [], localItems);
            const rangeLabel = `${formatRevLabel(currentRevState.startRev)} → ${formatRevLabel(currentRevState.endRev)} (${currentRevState.target === "branch" ? "分支" : "主线"})`;
            diffCompareState = {
                target,
                remoteRev: normalizeRevInput(remoteRev) || remoteRev || "HEAD",
                localItems,
                compareItems: entries,
                summary,
                rangeLabel,
            };
            diffCompareProvider.refresh(diffCompareState);
            await context.globalState.update(DIFF_COMPARE_TARGET_KEY, target);
            await context.globalState.update(DIFF_COMPARE_REMOTE_REV_KEY, remoteRev);
        });
    }
    async function compareDiffs() {
        if (!revState) {
            vscode.window.showErrorMessage("请先运行提交范围变更");
            return;
        }
        const lastTarget = context.globalState.get(DIFF_COMPARE_TARGET_KEY) ||
            "merge";
        const targetItems = [
            { label: "待合并", value: "merge" },
            { label: "分支", value: "branch" },
            { label: "主线", value: "trunk" },
        ];
        for (const item of targetItems) {
            item.picked = item.value === lastTarget;
        }
        const targetPick = await vscode.window.showQuickPick(targetItems, {
            placeHolder: "选择要对比的本地目录",
        });
        if (!targetPick)
            return;
        const lastRemote = context.globalState.get(DIFF_COMPARE_REMOTE_REV_KEY) || "HEAD";
        const remoteInput = await vscode.window.showInputBox({
            prompt: "输入远程修订号（默认 HEAD）",
            value: lastRemote,
        });
        if (remoteInput === undefined)
            return;
        const remoteRev = normalizeRevInput(remoteInput || lastRemote);
        if (!remoteRev) {
            vscode.window.showErrorMessage("远程修订号无效");
            return;
        }
        try {
            await runDiffCompareInternal(targetPick.value, remoteRev);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function refreshDiffCompare() {
        const lastTarget = context.globalState.get(DIFF_COMPARE_TARGET_KEY) ||
            diffCompareState?.target;
        const lastRemote = context.globalState.get(DIFF_COMPARE_REMOTE_REV_KEY) ||
            diffCompareState?.remoteRev ||
            "HEAD";
        if (!lastTarget) {
            await compareDiffs();
            return;
        }
        try {
            await runDiffCompareInternal(lastTarget, lastRemote);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function setRevGroupMode() {
        const items = [
            { label: "按一级目录分组", value: "dir1" },
            { label: "按二级目录分组", value: "dir2" },
            { label: "按提交记录分组", value: "commit" },
        ];
        const current = getRevGroupMode();
        for (const item of items) {
            item.picked = item.value === current;
        }
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "选择提交范围分组方式",
        });
        if (!picked)
            return;
        const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
        await config.update("revGroupMode", picked.value, vscode.ConfigurationTarget.Global);
        if (picked.value === "commit") {
            try {
                await ensureLogEntries();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(message);
            }
        }
        refreshRevView();
    }
    async function setRevChangeFilter() {
        const items = [
            { label: "全部", value: "all" },
            { label: "仅新增(A)", value: "A" },
            { label: "仅修改(M/R/C)", value: "M" },
            { label: "仅删除(D)", value: "D" },
        ];
        const current = getRevChangeFilter();
        for (const item of items) {
            item.picked = item.value === current;
        }
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "选择提交范围过滤条件",
        });
        if (!picked)
            return;
        const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
        await config.update("revChangeFilter", picked.value, vscode.ConfigurationTarget.Global);
        refreshRevView();
    }
    function parseFirstHunkStart(diffText) {
        if (!diffText)
            return undefined;
        const lines = diffText.split(/\r?\n/);
        for (const line of lines) {
            if (!line.startsWith("@@"))
                continue;
            const match = line.match(/^\@\@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? \@\@/);
            if (!match)
                continue;
            const start = Number(match[1]);
            if (!Number.isNaN(start) && start > 0) {
                return start;
            }
        }
        return undefined;
    }
    function parseRevHunkHeader(line) {
        const match = line.match(/^\@\@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? \@\@(.*)$/);
        if (!match)
            return undefined;
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        if (Number.isNaN(oldStart) ||
            Number.isNaN(oldCount) ||
            Number.isNaN(newStart) ||
            Number.isNaN(newCount)) {
            return undefined;
        }
        return {
            oldStart,
            oldCount,
            newStart,
            newCount,
            section: (match[5] || "").trim() || undefined,
        };
    }
    function parseRevFileDiff(diffText) {
        const lines = diffText.split(/\r?\n/);
        const headers = [];
        const hunks = [];
        let currentHunk;
        for (const line of lines) {
            if (line.startsWith("@@")) {
                const parsed = parseRevHunkHeader(line);
                if (!parsed) {
                    if (currentHunk) {
                        currentHunk.lines.push(line);
                    }
                    else {
                        headers.push(line);
                    }
                    continue;
                }
                currentHunk = {
                    index: hunks.length,
                    oldStart: parsed.oldStart,
                    oldCount: parsed.oldCount,
                    newStart: parsed.newStart,
                    newCount: parsed.newCount,
                    section: parsed.section,
                    lines: [line],
                };
                hunks.push(currentHunk);
                continue;
            }
            if (currentHunk &&
                (line.startsWith("Index: ") || line.startsWith("Property changes on: "))) {
                currentHunk = undefined;
                headers.push(line);
                continue;
            }
            if (currentHunk) {
                currentHunk.lines.push(line);
            }
            else {
                headers.push(line);
            }
        }
        return { headers, hunks };
    }
    function buildSingleHunkPatch(diff, hunk) {
        const lines = [...diff.headers, ...hunk.lines];
        const body = lines.join("\n").replace(/\n+$/, "");
        return `${body}\n`;
    }
    function normalizeRevCompareValue(value) {
        if (!value)
            return "";
        const normalized = normalizeRevInput(value);
        if (normalized)
            return normalized.toUpperCase();
        return value.trim().replace(/^r/i, "").toUpperCase();
    }
    function resolveRevHunkByLine(hunks, lineNo, useOldSide) {
        if (!hunks.length)
            return undefined;
        let nearest;
        let nearestDistance = Number.MAX_SAFE_INTEGER;
        for (const hunk of hunks) {
            const start = useOldSide ? hunk.oldStart : hunk.newStart;
            const count = useOldSide ? hunk.oldCount : hunk.newCount;
            const anchor = Math.max(1, start || 1);
            if (count > 0) {
                const end = start + count - 1;
                if (lineNo >= start && lineNo <= end) {
                    return hunk;
                }
                const distance = Math.min(Math.abs(lineNo - start), Math.abs(lineNo - end));
                if (distance < nearestDistance) {
                    nearest = hunk;
                    nearestDistance = distance;
                }
            }
            else {
                const distance = Math.abs(lineNo - anchor);
                if (distance < nearestDistance) {
                    nearest = hunk;
                    nearestDistance = distance;
                }
            }
        }
        return nearest;
    }
    function getRevHunkAnchorLine(hunk, useOldSide, lineCount) {
        const start = useOldSide ? hunk.oldStart : hunk.newStart;
        const count = useOldSide ? hunk.oldCount : hunk.newCount;
        let anchor = count > 0 ? start : Math.max(1, start || 1);
        if (!Number.isFinite(anchor) || anchor <= 0) {
            anchor = 1;
        }
        if (lineCount <= 0) {
            return 1;
        }
        return Math.min(Math.max(anchor, 1), lineCount);
    }
    function getRevCachePathKey(relPath) {
        return normalizeSlashes(relPath);
    }
    function normalizeMergeRelPath(relPath) {
        return normalizeSlashes(relPath).replace(/^\/+/, "");
    }
    function buildMergeRelPathCandidates(relPath) {
        const normalized = normalizeMergeRelPath(relPath);
        if (!normalized)
            return [];
        const candidates = new Set([normalized]);
        if (!revState) {
            return Array.from(candidates);
        }
        const prefixes = new Set();
        const rootBase = normalizeSlashes(path.basename(path.normalize(revState.root.rootPath || ""))).replace(/^\/+|\/+$/g, "");
        if (rootBase && rootBase !== ".") {
            prefixes.add(rootBase);
        }
        const suffixRaw = normalizeSlashes(revState.root.rootSuffix || "").replace(/^\/+|\/+$/g, "");
        if (suffixRaw) {
            const segments = suffixRaw.split("/").filter(Boolean);
            let relativeSegments = segments;
            if ((segments[0] === "branches" || segments[0] === "tags") &&
                segments.length >= 3) {
                relativeSegments = segments.slice(2);
            }
            else if (segments[0] === "trunk" && segments.length >= 2) {
                relativeSegments = segments.slice(1);
            }
            if (relativeSegments.length) {
                prefixes.add(relativeSegments.join("/"));
                prefixes.add(relativeSegments[relativeSegments.length - 1]);
            }
        }
        for (const rawPrefix of prefixes) {
            const prefix = normalizeSlashes(rawPrefix).replace(/^\/+|\/+$/g, "");
            if (!prefix)
                continue;
            if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
                continue;
            }
            candidates.add(`${prefix}/${normalized}`);
        }
        return Array.from(candidates);
    }
    function scoreMergeRelPathCandidate(mergeRoot, candidate) {
        const safeRel = candidate.replace(/\//g, path.sep);
        const fullPath = path.normalize(path.join(mergeRoot, safeRel));
        if (fs.existsSync(fullPath)) {
            return 100;
        }
        let score = 0;
        const parentPath = path.dirname(fullPath);
        if (fs.existsSync(parentPath)) {
            score += 50;
        }
        const parts = candidate.split("/").filter(Boolean);
        if (parts.length > 0) {
            const topPath = path.join(mergeRoot, parts[0]);
            if (fs.existsSync(topPath)) {
                score += 10;
            }
        }
        if (parts.length > 1) {
            const prefixPath = path.join(mergeRoot, parts.slice(0, -1).join(path.sep));
            if (fs.existsSync(prefixPath)) {
                score += 20;
            }
        }
        return score;
    }
    function resolveMergePathContext(mergeRoot, relPath) {
        const normalizedRelPath = normalizeMergeRelPath(relPath);
        const candidates = buildMergeRelPathCandidates(normalizedRelPath);
        const fallback = normalizedRelPath;
        let picked = candidates[0] || fallback;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const candidate of candidates) {
            const score = scoreMergeRelPathCandidate(mergeRoot, candidate);
            if (score > bestScore) {
                bestScore = score;
                picked = candidate;
                continue;
            }
            if (score === bestScore && candidate.length < picked.length) {
                picked = candidate;
            }
        }
        const suffix = normalizedRelPath ? `/${normalizedRelPath}` : "";
        const prefix = suffix && picked.endsWith(suffix)
            ? picked.slice(0, picked.length - suffix.length)
            : "";
        const applyRoot = prefix
            ? path.normalize(path.join(mergeRoot, prefix.replace(/\//g, path.sep)))
            : mergeRoot;
        const filePath = path.normalize(path.join(applyRoot, normalizedRelPath.replace(/\//g, path.sep)));
        return {
            normalizedRelPath,
            mappedRelPath: picked || fallback,
            prefix,
            applyRoot,
            filePath,
        };
    }
    async function ensureRevFileDiff(relPath, force = false) {
        if (!revState) {
            throw new Error("尚未运行提交范围变更");
        }
        const key = getRevCachePathKey(relPath);
        const cached = revState.diffByPath.get(key);
        if (cached && !force) {
            return cached;
        }
        const range = `${revState.startRev}:${revState.endRev}`;
        const fileUrl = joinUrl(revState.root.rootUrl, key);
        const diffResp = await runSvn(["diff", "-r", range, fileUrl], revState.root.rootPath);
        if (diffResp.code !== 0) {
            throw new Error(diffResp.stderr || "获取变更块失败");
        }
        const parsed = parseRevFileDiff(diffResp.stdout);
        revState.diffByPath.set(key, parsed);
        revState.hunkStatusByPath.delete(key);
        revState.mergeSummaryByPath.delete(key);
        return parsed;
    }
    function getMergeFileSnapshot(mergeRoot, relPath) {
        const mergePath = resolveMergePathContext(mergeRoot, relPath);
        const filePath = mergePath.filePath;
        if (!fs.existsSync(filePath)) {
            return { filePath, exists: false, mtimeMs: undefined };
        }
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                return { filePath, exists: false, mtimeMs: undefined };
            }
            return { filePath, exists: true, mtimeMs: stat.mtimeMs };
        }
        catch (err) {
            return { filePath, exists: false, mtimeMs: undefined };
        }
    }
    function isRevHunkStatusCacheValid(cache, mergeRoot, mergeFileExists, mergeFileMtimeMs) {
        if (cache.mergeRoot !== mergeRoot)
            return false;
        if (cache.mergeFileExists !== mergeFileExists)
            return false;
        return cache.mergeFileMtimeMs === mergeFileMtimeMs;
    }
    async function runPatchWithText(relPath, patchText, mergeRoot, dryRun, reverse = false, traceId) {
        const mergePath = resolveMergePathContext(mergeRoot, relPath);
        const patchRoot = mergePath.applyRoot;
        const trace = traceId || createOperationId("patch");
        logMessage("INFO", "runPatchWithText: start", {
            trace,
            relPath,
            dryRun,
            reverse,
            mergeRoot,
            patchRoot,
            mappedRelPath: mergePath.mappedRelPath,
            targetPath: mergePath.filePath,
        });
        const patchPath = buildTempPatchPath(`${relPath}-${dryRun ? "dry" : "apply"}-${reverse ? "reverse" : "forward"}`);
        try {
            fs.writeFileSync(patchPath, patchText, "utf8");
            const args = ["patch"];
            if (dryRun)
                args.push("--dry-run");
            if (reverse)
                args.push("--reverse-diff");
            args.push(patchPath, patchRoot);
            const resp = await runSvn(args, patchRoot);
            const combined = `${resp.stdout}\n${resp.stderr}`;
            const conflict = hasPatchConflict(combined);
            const skipped = hasPatchSkipped(combined);
            const alreadyApplied = hasPatchAlreadyApplied(combined);
            const ok = resp.code === 0 && !conflict && !skipped;
            logMessage(ok ? "INFO" : "WARN", "runPatchWithText: result", {
                trace,
                relPath,
                dryRun,
                reverse,
                code: resp.code,
                ok,
                conflict,
                skipped,
                alreadyApplied,
                output: summarizeLogText(combined, 6),
            });
            return {
                ok,
                conflict,
                skipped,
                alreadyApplied,
                code: resp.code,
                stdout: resp.stdout,
                stderr: resp.stderr,
            };
        }
        catch (err) {
            const detail = getErrorDetail(err);
            logMessage("ERROR", "runPatchWithText: exception", {
                trace,
                relPath,
                dryRun,
                reverse,
                error: detail.message,
                stack: detail.stack,
            });
            throw err;
        }
        finally {
            try {
                fs.unlinkSync(patchPath);
            }
            catch (err) {
                // ignore
            }
        }
    }
    async function detectRevHunkMergeStatus(relPath, diff, hunk, mergeRoot) {
        if (!hunk.lines.length)
            return "unknown";
        const patchText = buildSingleHunkPatch(diff, hunk);
        const forward = await runPatchWithText(relPath, patchText, mergeRoot, true, false);
        if (forward.ok) {
            if (forward.alreadyApplied) {
                return "merged";
            }
            return "unmerged";
        }
        const reverse = await runPatchWithText(relPath, patchText, mergeRoot, true, true);
        if (reverse.ok) {
            return "merged";
        }
        const snapshot = getMergeFileSnapshot(mergeRoot, relPath);
        if (snapshot.exists) {
            try {
                const mergeDoc = await vscode.workspace.openTextDocument(snapshot.filePath);
                const targetLines = mergeDoc.getText().split(/\r?\n/);
                const textCheck = evaluateRevHunkTextMerge(targetLines, hunk);
                if (textCheck.mergedByText) {
                    return "merged";
                }
                const textApply = evaluateRevHunkTextApply(targetLines, hunk);
                if (textApply.applicable) {
                    return "unmerged";
                }
            }
            catch (err) {
                logMessage("WARN", "detectRevHunkMergeStatus: text fallback failed", {
                    relPath,
                    hunkIndex: hunk.index,
                    error: String(err),
                });
            }
        }
        return "conflict";
    }
    function createDefaultRevFileMergeSummary() {
        return {
            total: 0,
            merged: 0,
            unmerged: 0,
            conflict: 0,
            unknown: 0,
        };
    }
    async function ensureRevHunkStatus(relPath, hunkIndex, force = false) {
        if (!revState)
            return "unknown";
        const key = getRevCachePathKey(relPath);
        const diff = await ensureRevFileDiff(key);
        if (hunkIndex < 0 || hunkIndex >= diff.hunks.length) {
            return "unknown";
        }
        const mergeRoot = getKnownMergeRoot();
        if (!mergeRoot)
            return "unknown";
        const snapshot = getMergeFileSnapshot(mergeRoot, key);
        const cached = revState.hunkStatusByPath.get(key);
        const shouldReuse = cached &&
            !force &&
            isRevHunkStatusCacheValid(cached, mergeRoot, snapshot.exists, snapshot.mtimeMs) &&
            cached.statuses.length === diff.hunks.length;
        let activeCache = cached;
        if (!shouldReuse) {
            activeCache = {
                statuses: new Array(diff.hunks.length),
                mergeRoot,
                mergeFileExists: snapshot.exists,
                mergeFileMtimeMs: snapshot.mtimeMs,
            };
            revState.hunkStatusByPath.set(key, activeCache);
        }
        if (!activeCache)
            return "unknown";
        if (!force && activeCache.statuses[hunkIndex] !== undefined) {
            return activeCache.statuses[hunkIndex] || "unknown";
        }
        let status = "unknown";
        try {
            status = await detectRevHunkMergeStatus(key, diff, diff.hunks[hunkIndex], mergeRoot);
        }
        catch (err) {
            status = "unknown";
            logMessage("WARN", "ensureRevHunkStatus failed", {
                relPath: key,
                hunkIndex,
                error: String(err),
            });
        }
        activeCache.statuses[hunkIndex] = status;
        return status;
    }
    async function ensureRevFileMergeSummary(relPath, force = false) {
        if (!revState) {
            return createDefaultRevFileMergeSummary();
        }
        const key = getRevCachePathKey(relPath);
        if (!force) {
            const cachedSummary = revState.mergeSummaryByPath.get(key);
            if (cachedSummary) {
                const mergeRoot = getKnownMergeRoot();
                if (!mergeRoot) {
                    return cachedSummary;
                }
                const snapshot = getMergeFileSnapshot(mergeRoot, key);
                const cache = revState.hunkStatusByPath.get(key);
                if (cache &&
                    cache.statuses.length === cachedSummary.total &&
                    isRevHunkStatusCacheValid(cache, mergeRoot, snapshot.exists, snapshot.mtimeMs)) {
                    return cachedSummary;
                }
            }
        }
        const diff = await ensureRevFileDiff(key);
        const summary = createDefaultRevFileMergeSummary();
        if (!diff.hunks.length) {
            revState.mergeSummaryByPath.set(key, summary);
            return summary;
        }
        summary.total = diff.hunks.length;
        for (const hunk of diff.hunks) {
            const status = await ensureRevHunkStatus(key, hunk.index, force);
            if (status === "merged") {
                summary.merged += 1;
            }
            else if (status === "unmerged") {
                summary.unmerged += 1;
            }
            else if (status === "conflict") {
                summary.conflict += 1;
            }
            else {
                summary.unknown += 1;
            }
        }
        revState.mergeSummaryByPath.set(key, summary);
        return summary;
    }
    function invalidateRevPathMergeCache(relPath) {
        if (!revState)
            return;
        const key = getRevCachePathKey(relPath);
        revState.hunkStatusByPath.delete(key);
        revState.mergeSummaryByPath.delete(key);
    }
    function getRevHunkStatusLabel(status) {
        if (status === "merged")
            return "已合并";
        if (status === "unmerged")
            return "未合并";
        if (status === "conflict")
            return "冲突";
        return "未知";
    }
    function buildRevHunkSnippetLines(hunk, side) {
        const snippet = [];
        for (let i = 1; i < hunk.lines.length; i += 1) {
            const line = hunk.lines[i];
            if (!line)
                continue;
            if (line.startsWith("\\"))
                continue;
            const prefix = line[0];
            if (prefix === " ") {
                snippet.push(line.slice(1));
                continue;
            }
            if (side === "old" && prefix === "-") {
                snippet.push(line.slice(1));
                continue;
            }
            if (side === "new" && prefix === "+") {
                snippet.push(line.slice(1));
            }
        }
        return trimSnippetLines(snippet);
    }
    function buildRevHunkChangedLines(hunk, side) {
        const lines = [];
        for (let i = 1; i < hunk.lines.length; i += 1) {
            const line = hunk.lines[i];
            if (!line)
                continue;
            if (line.startsWith("\\"))
                continue;
            const prefix = line[0];
            if (side === "old" && prefix === "-") {
                lines.push(line.slice(1));
            }
            else if (side === "new" && prefix === "+") {
                lines.push(line.slice(1));
            }
        }
        return trimSnippetLines(lines);
    }
    function buildRevHunkChangedRawLines(hunk, side) {
        const lines = [];
        for (let i = 1; i < hunk.lines.length; i += 1) {
            const line = hunk.lines[i];
            if (!line)
                continue;
            if (line.startsWith("\\"))
                continue;
            const prefix = line[0];
            if (side === "old" && prefix === "-") {
                lines.push(line.slice(1));
            }
            else if (side === "new" && prefix === "+") {
                lines.push(line.slice(1));
            }
        }
        return lines;
    }
    function getRevHunkChangeMode(hunk) {
        const oldLines = buildRevHunkChangedRawLines(hunk, "old");
        const newLines = buildRevHunkChangedRawLines(hunk, "new");
        if (!oldLines.length && !newLines.length)
            return "none";
        if (!oldLines.length)
            return "add";
        if (!newLines.length)
            return "delete";
        return "replace";
    }
    function getFirstPlusLineByOldSpace(hunk) {
        let oldLine = hunk.oldStart;
        for (let i = 1; i < hunk.lines.length; i += 1) {
            const line = hunk.lines[i] || "";
            if (line.startsWith("+"))
                return Math.max(1, oldLine || 1);
            if (line.startsWith(" ") || line.startsWith("-")) {
                oldLine += 1;
            }
        }
        return Math.max(1, hunk.oldStart || 1);
    }
    function getFirstPlusLineByNewSpace(hunk) {
        let newLine = hunk.newStart;
        for (let i = 1; i < hunk.lines.length; i += 1) {
            const line = hunk.lines[i] || "";
            if (line.startsWith("+"))
                return Math.max(1, newLine || 1);
            if (line.startsWith(" ") || line.startsWith("+")) {
                newLine += 1;
            }
        }
        return Math.max(1, hunk.newStart || 1);
    }
    function normalizeLooseSnippetSequence(lines) {
        return lines.map(normalizeStrictSnippetLine).filter((line) => !!line);
    }
    function findLooseSequenceRanges(snippetLines, targetLines) {
        const snippet = normalizeLooseSnippetSequence(snippetLines);
        if (!snippet.length || !targetLines.length)
            return [];
        const compactTarget = targetLines
            .map((line, idx) => ({
            text: normalizeStrictSnippetLine(line || ""),
            lineNo: idx + 1,
        }))
            .filter((item) => !!item.text);
        const size = snippet.length;
        if (size > compactTarget.length)
            return [];
        const ranges = [];
        for (let i = 0; i <= compactTarget.length - size; i += 1) {
            let ok = true;
            for (let j = 0; j < size; j += 1) {
                if (compactTarget[i + j].text !== snippet[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                ranges.push({
                    startLine: compactTarget[i].lineNo,
                    endLine: compactTarget[i + size - 1].lineNo,
                });
            }
        }
        return ranges;
    }
    function chooseNearestRange(ranges, expectedLine) {
        if (!ranges.length)
            return undefined;
        let picked = ranges[0];
        let bestDistance = Math.abs(picked.startLine - expectedLine);
        for (let i = 1; i < ranges.length; i += 1) {
            const dist = Math.abs(ranges[i].startLine - expectedLine);
            if (dist < bestDistance) {
                picked = ranges[i];
                bestDistance = dist;
            }
        }
        return picked;
    }
    function normalizeLooseLine(value) {
        return value.trim().replace(/\s+/g, " ");
    }
    function isMeaningfulKeyLine(line) {
        const normalized = normalizeLooseLine(line);
        if (!normalized)
            return false;
        if (normalized === "{" || normalized === "}")
            return false;
        if (normalized === "/// <summary>" || normalized === "/// </summary>")
            return false;
        if (normalized.length < 6)
            return false;
        if (!/[A-Za-z0-9_\u4e00-\u9fa5]/.test(normalized))
            return false;
        return true;
    }
    function findLooseLineMatches(line, targetLines) {
        const key = normalizeLooseLine(line);
        if (!key)
            return [];
        const matches = [];
        for (let idx = 0; idx < targetLines.length; idx += 1) {
            if (normalizeLooseLine(targetLines[idx] || "") === key) {
                matches.push(idx + 1);
            }
        }
        return matches;
    }
    function evaluateKeyLineWindowMatch(snippetLines, targetLines, windowRadius = 80) {
        const keyLines = snippetLines.filter(isMeaningfulKeyLine);
        if (!keyLines.length) {
            return {
                matched: 0,
                total: 0,
                anchor: undefined,
                ratio: 0,
                windowRadius,
            };
        }
        const keyMatches = keyLines.map((line) => findLooseLineMatches(line, targetLines));
        const anchorCandidates = Array.from(new Set(keyMatches.flatMap((items) => items))).slice(0, 500);
        let bestMatched = 0;
        let bestAnchor;
        for (const anchor of anchorCandidates) {
            const left = Math.max(1, anchor - windowRadius);
            const right = anchor + windowRadius;
            let matched = 0;
            for (const items of keyMatches) {
                if (items.some((lineNo) => lineNo >= left && lineNo <= right)) {
                    matched += 1;
                }
            }
            if (matched > bestMatched) {
                bestMatched = matched;
                bestAnchor = anchor;
            }
            if (bestMatched >= keyLines.length) {
                break;
            }
        }
        return {
            matched: bestMatched,
            total: keyLines.length,
            anchor: bestAnchor,
            ratio: keyLines.length > 0 ? bestMatched / keyLines.length : 0,
            windowRadius,
        };
    }
    function evaluateRevHunkTextMerge(targetLines, hunk) {
        const oldSnippet = buildRevHunkChangedLines(hunk, "old");
        const newSnippet = buildRevHunkChangedLines(hunk, "new");
        const oldMatches = oldSnippet.length
            ? findExactSnippetMatches(oldSnippet, targetLines)
            : [];
        const newMatches = newSnippet.length
            ? findExactSnippetMatches(newSnippet, targetLines)
            : [];
        let mergedByText = false;
        let relaxedUsed = false;
        let keyLineTotal = 0;
        let keyLineMatched = 0;
        let keyWindowAnchor;
        let keyWindowRadius = 80;
        let keyHitRatio = 0;
        if (newSnippet.length > 0 && oldSnippet.length === 0) {
            mergedByText = newMatches.length > 0;
        }
        else if (oldSnippet.length > 0 && newSnippet.length === 0) {
            mergedByText = oldMatches.length === 0;
        }
        else if (oldSnippet.length > 0 && newSnippet.length > 0) {
            mergedByText = newMatches.length > 0 && oldMatches.length === 0;
        }
        if (!mergedByText && newSnippet.length > 0) {
            const relaxed = evaluateKeyLineWindowMatch(newSnippet, targetLines, 80);
            relaxedUsed = true;
            keyLineTotal = relaxed.total;
            keyLineMatched = relaxed.matched;
            keyWindowAnchor = relaxed.anchor;
            keyWindowRadius = relaxed.windowRadius;
            keyHitRatio = relaxed.ratio;
            if (relaxed.total > 0) {
                const minHit = Math.min(3, relaxed.total);
                if (relaxed.matched >= minHit && relaxed.ratio >= 0.6) {
                    mergedByText = true;
                }
            }
        }
        return {
            mergedByText,
            oldSnippetLines: oldSnippet.length,
            newSnippetLines: newSnippet.length,
            oldMatches: oldMatches.slice(0, 50),
            newMatches: newMatches.slice(0, 50),
            relaxedUsed,
            keyLineTotal,
            keyLineMatched,
            keyWindowAnchor,
            keyWindowRadius,
            keyHitRatio,
        };
    }
    function evaluateRevHunkTextApply(targetLines, hunk) {
        const mode = getRevHunkChangeMode(hunk);
        if (mode === "none") {
            return {
                applicable: false,
                mode,
                reason: "none",
            };
        }
        const textCheck = evaluateRevHunkTextMerge(targetLines, hunk);
        if (textCheck.mergedByText) {
            return {
                applicable: false,
                mode,
                reason: "already-merged",
            };
        }
        const oldRaw = buildRevHunkChangedRawLines(hunk, "old");
        const newRaw = buildRevHunkChangedRawLines(hunk, "new");
        if (mode === "add") {
            const existingRanges = findLooseSequenceRanges(newRaw, targetLines);
            if (existingRanges.length) {
                return {
                    applicable: false,
                    mode,
                    reason: "add-new-exists",
                };
            }
            const oldContext = buildRevHunkSnippetLines(hunk, "old");
            const newContext = buildRevHunkSnippetLines(hunk, "new");
            const oldContextMatches = oldContext.length
                ? findExactSnippetMatches(oldContext, targetLines)
                : [];
            const newContextMatches = newContext.length
                ? findExactSnippetMatches(newContext, targetLines)
                : [];
            if (oldContextMatches.length || newContextMatches.length) {
                return {
                    applicable: true,
                    mode,
                    reason: "add-context-matched",
                };
            }
            return {
                applicable: false,
                mode,
                reason: "add-context-missing",
            };
        }
        const oldRanges = findLooseSequenceRanges(oldRaw, targetLines);
        if (oldRanges.length) {
            return {
                applicable: true,
                mode,
                reason: "old-range-found",
            };
        }
        return {
            applicable: false,
            mode,
            reason: "old-range-missing",
        };
    }
    function pickNearestLine(matches, expected) {
        if (!matches.length)
            return undefined;
        let best = matches[0];
        let bestDistance = Math.abs(best - expected);
        for (let idx = 1; idx < matches.length; idx += 1) {
            const candidate = matches[idx];
            const distance = Math.abs(candidate - expected);
            if (distance < bestDistance) {
                best = candidate;
                bestDistance = distance;
            }
        }
        return best;
    }
    async function resolveMergeLineByHunkContextDetailed(filePath, hunk, status) {
        const mergeDoc = await vscode.workspace.openTextDocument(filePath);
        const targetLines = mergeDoc.getText().split(/\r?\n/);
        const attempts = [];
        const sideOrder = status === "merged" ? ["new", "old"] : ["old", "new"];
        for (const side of sideOrder) {
            const candidates = [
                { strategy: "changed", snippet: buildRevHunkChangedLines(hunk, side) },
                { strategy: "full", snippet: buildRevHunkSnippetLines(hunk, side) },
            ];
            for (const candidate of candidates) {
                const snippet = candidate.snippet;
                if (!snippet.length)
                    continue;
                const matches = findExactSnippetMatches(snippet, targetLines);
                const expected = side === "old" ? hunk.oldStart : hunk.newStart;
                const attempt = {
                    side,
                    strategy: candidate.strategy,
                    snippetLineCount: snippet.length,
                    expectedLine: Math.max(1, expected || 1),
                    matches: matches.slice(0, 50),
                };
                attempts.push(attempt);
                if (!matches.length)
                    continue;
                const picked = pickNearestLine(matches, Math.max(1, expected || 1));
                if (picked && picked > 0) {
                    attempt.pickedLine = picked;
                    return {
                        lineNo: picked,
                        method: "match",
                        attempts,
                        mergeLineCount: targetLines.length,
                        matchedSide: side,
                        matchedStrategy: candidate.strategy,
                        matchedExpectedLine: attempt.expectedLine,
                        matchedLine: picked,
                    };
                }
            }
        }
        const fallback = status === "merged" ? hunk.newStart : hunk.oldStart;
        if (!targetLines.length) {
            return {
                lineNo: 1,
                method: "fallback",
                attempts,
                mergeLineCount: targetLines.length,
            };
        }
        return {
            lineNo: Math.min(Math.max(1, fallback || 1), targetLines.length),
            method: "fallback",
            attempts,
            mergeLineCount: targetLines.length,
        };
    }
    async function resolveMergeLineByHunkContext(filePath, hunk, status) {
        const detail = await resolveMergeLineByHunkContextDetailed(filePath, hunk, status);
        return detail.lineNo;
    }
    async function tryApplyRevHunkByText(relPath, hunk, filePath) {
        const mode = getRevHunkChangeMode(hunk);
        if (mode === "none") {
            return {
                ok: false,
                mode,
                message: "该变更块无可应用内容",
            };
        }
        const fileExists = fs.existsSync(filePath);
        const raw = fileExists ? fs.readFileSync(filePath, "utf8") : "";
        const hasCRLF = raw.includes("\r\n");
        const hadTrailingNewline = fileExists ? /\r?\n$/.test(raw) : false;
        const targetLines = fileExists ? raw.split(/\r?\n/) : [];
        const newRaw = buildRevHunkChangedRawLines(hunk, "new");
        const oldRaw = buildRevHunkChangedRawLines(hunk, "old");
        if (!fileExists) {
            if (mode !== "add") {
                return {
                    ok: false,
                    mode,
                    message: "目标文件不存在，无法执行替换或删除",
                };
            }
            const targetDir = path.dirname(filePath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            const eol = "\r\n";
            let output = newRaw.join(eol);
            if (newRaw.length && !output.endsWith(eol)) {
                output += eol;
            }
            fs.writeFileSync(filePath, output, "utf8");
            return {
                ok: true,
                mode,
                message: `目标文件不存在，已通过文本回退创建文件（${path.basename(filePath)}）`,
            };
        }
        const textCheck = evaluateRevHunkTextMerge(targetLines, hunk);
        if (textCheck.mergedByText) {
            return {
                ok: true,
                alreadyMerged: true,
                mode,
                message: "文本匹配判定该变更块已合并",
            };
        }
        if (mode === "add") {
            const existingRanges = findLooseSequenceRanges(newRaw, targetLines);
            if (existingRanges.length) {
                return {
                    ok: true,
                    alreadyMerged: true,
                    mode,
                    message: "已存在相同新增文本",
                };
            }
            const locate = await resolveMergeLineByHunkContextDetailed(filePath, hunk, "unmerged");
            let insertLine = locate.lineNo;
            if (locate.matchedLine &&
                locate.matchedExpectedLine &&
                locate.matchedSide) {
                const plusExpected = locate.matchedSide === "old"
                    ? getFirstPlusLineByOldSpace(hunk)
                    : getFirstPlusLineByNewSpace(hunk);
                insertLine = plusExpected + (locate.matchedLine - locate.matchedExpectedLine);
            }
            else {
                insertLine = getFirstPlusLineByNewSpace(hunk);
            }
            insertLine = Math.min(Math.max(insertLine, 1), targetLines.length + 1);
            targetLines.splice(insertLine - 1, 0, ...newRaw);
            const eol = hasCRLF ? "\r\n" : "\n";
            let output = targetLines.join(eol);
            if (hadTrailingNewline && !output.endsWith(eol)) {
                output += eol;
            }
            fs.writeFileSync(filePath, output, "utf8");
            return {
                ok: true,
                mode,
                message: `已通过文本匹配插入新增块（L${insertLine}）`,
            };
        }
        const oldRanges = findLooseSequenceRanges(oldRaw, targetLines);
        if (!oldRanges.length) {
            if (newRaw.length) {
                const newRanges = findLooseSequenceRanges(newRaw, targetLines);
                if (newRanges.length) {
                    return {
                        ok: true,
                        alreadyMerged: true,
                        mode,
                        message: "未找到旧文本，但新文本已存在",
                    };
                }
            }
            return {
                ok: false,
                mode,
                message: "文本匹配未找到可替换区间",
            };
        }
        const expected = Math.max(1, hunk.oldStart || hunk.newStart || 1);
        const pickedRange = chooseNearestRange(oldRanges, expected);
        if (!pickedRange) {
            return {
                ok: false,
                mode,
                message: "未找到可应用的匹配区间",
            };
        }
        const replaceCount = pickedRange.endLine - pickedRange.startLine + 1;
        const nextLines = mode === "delete" ? [] : newRaw;
        targetLines.splice(pickedRange.startLine - 1, replaceCount, ...nextLines);
        const eol = hasCRLF ? "\r\n" : "\n";
        let output = targetLines.join(eol);
        if (hadTrailingNewline && !output.endsWith(eol)) {
            output += eol;
        }
        fs.writeFileSync(filePath, output, "utf8");
        return {
            ok: true,
            mode,
            message: mode === "delete"
                ? `已通过文本匹配删除旧块（L${pickedRange.startLine}-L${pickedRange.endLine}）`
                : `已通过文本匹配替换块（L${pickedRange.startLine}-L${pickedRange.endLine}）`,
        };
    }
    function summarizeLogText(raw, maxLines = 8) {
        const trimmed = (raw || "").trim();
        if (!trimmed)
            return "(空)";
        const lines = trimmed.split(/\r?\n/);
        if (lines.length <= maxLines)
            return lines.join("\n");
        return `${lines.slice(0, maxLines).join("\n")}\n...(${lines.length - maxLines} 行省略)`;
    }
    function buildHunkHeaderText(hunk) {
        return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.section ? ` ${hunk.section}` : ""}`;
    }
    async function buildRevHunkDebugLog(relPath, hunkIndex) {
        if (!revState) {
            throw new Error("尚未运行提交范围变更");
        }
        const key = getRevCachePathKey(relPath);
        const diff = await ensureRevFileDiff(key);
        const hunk = diff.hunks[hunkIndex];
        if (!hunk) {
            throw new Error("未找到对应变更块");
        }
        const status = await ensureRevHunkStatus(key, hunk.index, false);
        const mergeRoot = getKnownMergeRoot();
        const lines = [];
        lines.push("# SVN Merge Annotator Hunk Debug");
        lines.push(`时间: ${new Date().toISOString()}`);
        lines.push(`文件: ${key}`);
        lines.push(`范围: ${formatRevLabel(revState.startRev)} -> ${formatRevLabel(revState.endRev)}`);
        lines.push(`块: ${hunk.index + 1}`);
        lines.push(`状态: ${getRevHunkStatusLabel(status)} (${status})`);
        lines.push(`Hunk: ${buildHunkHeaderText(hunk)}`);
        if (!mergeRoot) {
            lines.push("MergeRoot: 未设置");
            return lines.join("\n");
        }
        const snapshot = getMergeFileSnapshot(mergeRoot, key);
        lines.push(`MergeRoot: ${mergeRoot}`);
        lines.push(`MergeFile: ${snapshot.filePath}`);
        lines.push(`MergeExists: ${snapshot.exists ? "true" : "false"}`);
        if (snapshot.exists) {
            lines.push(`MergeMtime: ${snapshot.mtimeMs || 0}`);
        }
        const patchText = rewritePatchPaths(buildSingleHunkPatch(diff, hunk), revState.root.rootUrl);
        const forward = await runPatchWithText(key, patchText, mergeRoot, true, false);
        const reverse = await runPatchWithText(key, patchText, mergeRoot, true, true);
        lines.push(`DryRunForward: ok=${forward.ok} code=${forward.code} conflict=${forward.conflict} skipped=${forward.skipped} alreadyApplied=${forward.alreadyApplied}`);
        lines.push(`DryRunReverse: ok=${reverse.ok} code=${reverse.code} conflict=${reverse.conflict} skipped=${reverse.skipped} alreadyApplied=${reverse.alreadyApplied}`);
        lines.push(`ForwardOut:\n${summarizeLogText(`${forward.stdout}\n${forward.stderr}`)}`);
        lines.push(`ReverseOut:\n${summarizeLogText(`${reverse.stdout}\n${reverse.stderr}`)}`);
        if (snapshot.exists) {
            try {
                const mergeDoc = await vscode.workspace.openTextDocument(snapshot.filePath);
                const targetLines = mergeDoc.getText().split(/\r?\n/);
                const textCheck = evaluateRevHunkTextMerge(targetLines, hunk);
                const textApply = evaluateRevHunkTextApply(targetLines, hunk);
                lines.push(`TextFallback: merged=${textCheck.mergedByText} oldLines=${textCheck.oldSnippetLines} newLines=${textCheck.newSnippetLines} relaxed=${textCheck.relaxedUsed} keyMatched=${textCheck.keyLineMatched}/${textCheck.keyLineTotal} keyRatio=${textCheck.keyHitRatio.toFixed(2)} keyAnchor=${textCheck.keyWindowAnchor || "-"} keyRadius=${textCheck.keyWindowRadius} oldMatches=${textCheck.oldMatches.length ? textCheck.oldMatches.join(",") : "(none)"} newMatches=${textCheck.newMatches.length ? textCheck.newMatches.join(",") : "(none)"}`);
                lines.push(`TextApplyable: canApply=${textApply.applicable} mode=${textApply.mode} reason=${textApply.reason}`);
            }
            catch (err) {
                lines.push(`TextFallback: error=${String(err)}`);
            }
        }
        if (snapshot.exists) {
            const locate = await resolveMergeLineByHunkContextDetailed(snapshot.filePath, hunk, status);
            lines.push(`Locate: line=${locate.lineNo} method=${locate.method} mergeLines=${locate.mergeLineCount}`);
            for (const attempt of locate.attempts) {
                const matchesText = attempt.matches.length
                    ? attempt.matches.join(",")
                    : "(none)";
                lines.push(`  - side=${attempt.side} strategy=${attempt.strategy} snippet=${attempt.snippetLineCount} expected=${attempt.expectedLine} picked=${attempt.pickedLine || "-"} matches=${matchesText}`);
            }
        }
        const changedOld = buildRevHunkChangedLines(hunk, "old");
        const changedNew = buildRevHunkChangedLines(hunk, "new");
        lines.push("ChangedOld:");
        lines.push(changedOld.length ? summarizeLogText(changedOld.join("\n"), 12) : "(空)");
        lines.push("ChangedNew:");
        lines.push(changedNew.length ? summarizeLogText(changedNew.join("\n"), 12) : "(空)");
        return lines.join("\n");
    }
    async function resolveCurrentRevHunkContext(document, lineNo) {
        if (!revState)
            return undefined;
        if (document.uri.scheme !== "svnrev")
            return undefined;
        const relPath = decodeURIComponent(document.uri.path.replace(/^\/+/, ""));
        const rev = new URLSearchParams(document.uri.query).get("rev") || "";
        const useOldSide = normalizeRevCompareValue(rev) ===
            normalizeRevCompareValue(revState.startRev);
        const diff = await ensureRevFileDiff(relPath);
        const hunk = resolveRevHunkByLine(diff.hunks, lineNo, useOldSide);
        if (!hunk)
            return undefined;
        const status = await ensureRevHunkStatus(relPath, hunk.index, false);
        return {
            relPath,
            rev,
            diff,
            hunk,
            status,
        };
    }
    async function refreshRevMergeSummariesInBackground(targetPaths, force = false) {
        if (!revState)
            return;
        const token = ++revMergeSummaryScanToken;
        const allPaths = targetPaths?.length
            ? targetPaths
            : revState.diffItems.map((item) => item.path);
        const deduped = Array.from(new Set(allPaths.map((item) => getRevCachePathKey(item))));
        for (let idx = 0; idx < deduped.length; idx += 1) {
            if (token !== revMergeSummaryScanToken) {
                return;
            }
            const relPath = deduped[idx];
            try {
                await ensureRevFileMergeSummary(relPath, force);
            }
            catch (err) {
                logMessage("WARN", "refreshRevMergeSummariesInBackground failed", {
                    relPath,
                    error: String(err),
                });
            }
            if ((idx + 1) % 10 === 0) {
                refreshRevView();
            }
        }
        if (token === revMergeSummaryScanToken) {
            refreshRevView();
        }
    }
    function findRevStatusByPath(relPath) {
        if (!revState?.diffItems?.length)
            return undefined;
        const normalized = normalizeSlashes(relPath);
        const match = revState.diffItems.find((item) => normalizeSlashes(item.path) === normalized);
        return match?.status;
    }
    function normalizeSnippetLine(value) {
        return value.replace(/\s+/g, "");
    }
    function trimSnippetLines(lines) {
        let start = 0;
        while (start < lines.length && !normalizeSnippetLine(lines[start])) {
            start += 1;
        }
        let end = lines.length - 1;
        while (end >= start && !normalizeSnippetLine(lines[end])) {
            end -= 1;
        }
        if (start > end)
            return [];
        return lines.slice(start, end + 1);
    }
    function buildLinePreview(text) {
        const trimmed = text.trim();
        if (trimmed.length <= 80)
            return trimmed;
        return `${trimmed.slice(0, 77)}...`;
    }
    function findSnippetMatches(snippetLines, targetLines) {
        if (!snippetLines.length || !targetLines.length)
            return [];
        const normalizedSnippet = snippetLines.map(normalizeSnippetLine);
        const total = targetLines.length;
        const size = normalizedSnippet.length;
        if (size > total)
            return [];
        const matches = [];
        for (let i = 0; i <= total - size; i += 1) {
            let ok = true;
            for (let j = 0; j < size; j += 1) {
                const snippetValue = normalizedSnippet[j];
                const targetValue = normalizeSnippetLine(targetLines[i + j] || "");
                if (!snippetValue) {
                    if (targetValue) {
                        ok = false;
                        break;
                    }
                }
                else if (!targetValue.includes(snippetValue)) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                matches.push(i + 1);
            }
        }
        return matches;
    }
    function normalizeStrictSnippetLine(value) {
        return value.replace(/\s+/g, " ").trim();
    }
    function findExactSnippetMatches(snippetLines, targetLines) {
        if (!snippetLines.length || !targetLines.length)
            return [];
        const normalizedSnippet = snippetLines
            .map(normalizeStrictSnippetLine)
            .filter((line) => !!line);
        if (!normalizedSnippet.length)
            return [];
        const compactTarget = targetLines
            .map((line, idx) => ({
            text: normalizeStrictSnippetLine(line || ""),
            lineNo: idx + 1,
        }))
            .filter((item) => !!item.text);
        const total = compactTarget.length;
        const size = normalizedSnippet.length;
        if (size > total)
            return [];
        const matches = [];
        for (let i = 0; i <= total - size; i += 1) {
            let ok = true;
            for (let j = 0; j < size; j += 1) {
                const snippetValue = normalizedSnippet[j];
                const targetValue = compactTarget[i + j].text;
                if (snippetValue !== targetValue) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                matches.push(compactTarget[i].lineNo);
            }
        }
        return matches;
    }
    function hasPatchConflict(output) {
        if (!output)
            return false;
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (/^C\s/.test(trimmed))
                return true;
        }
        if (output.includes(".svnpatch.rej"))
            return true;
        return false;
    }
    function hasPatchSkipped(output) {
        if (!output)
            return false;
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (/^Skipped\s+/i.test(trimmed))
                return true;
            if (/^>\s*Skipped\s+/i.test(trimmed))
                return true;
            if (/^Summary of conflicts:\s*$/i.test(trimmed))
                continue;
            if (/^Skipped paths:\s*\d+/i.test(trimmed))
                return true;
            if (/obstructed by unversioned node/i.test(trimmed))
                return true;
        }
        return false;
    }
    function hasPatchAlreadyApplied(output) {
        if (!output)
            return false;
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (/already applied/i.test(trimmed))
                return true;
            if (/hunk .*already applied/i.test(trimmed))
                return true;
        }
        return false;
    }
    function hasSvnAlreadyVersioned(output) {
        if (!output)
            return false;
        return (/already under version control/i.test(output) ||
            /already versioned/i.test(output) ||
            /is already a versioned item/i.test(output) ||
            /W150002/i.test(output) ||
            /W150003/i.test(output));
    }
    function hasSvnUnversionedStatus(output) {
        if (!output)
            return false;
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trimStart();
            if (!trimmed)
                continue;
            if (trimmed.startsWith("?")) {
                return true;
            }
        }
        return false;
    }
    async function ensureSvnTracked(targetPath, opId, reason) {
        if (!targetPath) {
            return {
                ok: false,
                action: "failed",
                message: "目标路径为空，无法加入 SVN 跟踪",
            };
        }
        if (!fs.existsSync(targetPath)) {
            return {
                ok: true,
                action: "skipped-missing",
                message: "目标不存在，跳过 svn add",
            };
        }
        let cwd = path.dirname(targetPath);
        try {
            const stat = fs.statSync(targetPath);
            if (stat.isDirectory()) {
                cwd = targetPath;
            }
        }
        catch (err) {
            // ignore
        }
        logMessage("INFO", "ensureSvnTracked: start", {
            opId,
            reason,
            targetPath,
            cwd,
        });
        const statusResp = await runSvn(["status", targetPath], cwd);
        const statusOutput = `${statusResp.stdout}\n${statusResp.stderr}`;
        const unversioned = statusResp.code === 0 ? hasSvnUnversionedStatus(statusResp.stdout) : true;
        logMessage("INFO", "ensureSvnTracked: status", {
            opId,
            reason,
            targetPath,
            code: statusResp.code,
            unversioned,
            output: summarizeLogText(statusOutput, 6),
        });
        if (statusResp.code === 0 && !unversioned) {
            return {
                ok: true,
                action: "already-tracked",
                message: "目标已在 SVN 跟踪中",
                statusOutput,
            };
        }
        const addResp = await runSvn(["add", "--parents", "--force", targetPath], cwd);
        const addOutput = `${addResp.stdout}\n${addResp.stderr}`;
        const alreadyVersioned = hasSvnAlreadyVersioned(addOutput);
        if (addResp.code === 0 || alreadyVersioned) {
            return {
                ok: true,
                action: alreadyVersioned ? "already-tracked" : "added",
                message: alreadyVersioned
                    ? "目标已在 SVN 跟踪中"
                    : "已加入 SVN 跟踪",
                statusOutput,
                addOutput,
            };
        }
        return {
            ok: false,
            action: "failed",
            message: `svn add 失败（code=${addResp.code}）`,
            statusOutput,
            addOutput,
        };
    }
    function buildTempPatchPath(relPath) {
        const safeName = relPath.replace(/[\\\/:]+/g, "_");
        const filename = `svn-merge-annotator-${Date.now()}-${safeName}.patch`;
        return path.join(os.tmpdir(), filename);
    }
    function rewritePatchPaths(diffText, rootUrl) {
        if (!diffText || !rootUrl)
            return diffText;
        const normalizedRoot = rootUrl.replace(/\/+$/, "");
        const lines = diffText.split(/\r?\n/);
        const rewrite = (value) => {
            if (value.startsWith(normalizedRoot)) {
                return value.slice(normalizedRoot.length).replace(/^\/+/, "");
            }
            return value;
        };
        return lines
            .map((line) => {
            if (line.startsWith("Index: ")) {
                const raw = line.slice("Index: ".length).trim();
                return `Index: ${rewrite(raw)}`;
            }
            if (line.startsWith("--- ") || line.startsWith("+++ ")) {
                const match = line.match(/^(---|\+\+\+)\s+(\S+)(.*)$/);
                if (!match)
                    return line;
                const prefix = match[1];
                const pathPart = rewrite(match[2]);
                const rest = match[3] || "";
                return `${prefix} ${pathPart}${rest}`;
            }
            if (line.startsWith("Property changes on: ")) {
                const raw = line.slice("Property changes on: ".length).trim();
                return `Property changes on: ${rewrite(raw)}`;
            }
            return line;
        })
            .join("\n");
    }
    async function ensureMergeFileReady(relPath, status) {
        const mergeRoot = await resolveMergeRoot();
        if (!mergeRoot) {
            vscode.window.showErrorMessage("缺少 merge 根目录信息");
            return undefined;
        }
        const mergePath = resolveMergePathContext(mergeRoot, relPath);
        const filePath = mergePath.filePath;
        if (fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    vscode.window.showErrorMessage("该变更是目录，无法直接打开");
                    return undefined;
                }
            }
            catch (err) {
                // ignore
            }
            return { mergeRoot, filePath };
        }
        const normalizedStatus = status ? normalizeRevStatus(status) : "M";
        if (normalizedStatus === "A") {
            const action = await vscode.window.showWarningMessage("待合并目录不存在该新增文件，是否先一键变更到待合并？", "一键变更到待合并", "取消");
            if (action !== "一键变更到待合并") {
                return undefined;
            }
            const applied = await applyRevChangeToMergeByPath(relPath, normalizedStatus);
            if (!applied) {
                return undefined;
            }
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage("补丁已应用，但文件仍未生成");
                return undefined;
            }
            return { mergeRoot, filePath };
        }
        vscode.window.showErrorMessage("待合并目录不存在该文件");
        return undefined;
    }
    async function resolveRevDiffStartLine(relPath, startRev, endRev) {
        if (!revState)
            return undefined;
        const range = `${startRev}:${endRev}`;
        const fileUrl = joinUrl(revState.root.rootUrl, relPath);
        const resp = await runSvn(["diff", "-r", range, fileUrl], revState.root.rootPath);
        if (resp.code !== 0) {
            logMessage("WARN", "resolveRevDiffStartLine: diff failed", {
                relPath,
                error: resp.stderr,
            });
            return undefined;
        }
        return parseFirstHunkStart(resp.stdout);
    }
    async function openRevDiff(item) {
        if (!item)
            return;
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        await openRevDiffForPath(item.relPath, revState.startRev, revState.endRev);
    }
    async function openRevMergeFile(item) {
        if (!item)
            return;
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        const status = normalizeRevStatus(item.status);
        if (status === "D") {
            vscode.window.showErrorMessage("该文件在范围内为删除，无法定位");
            return;
        }
        const ready = await ensureMergeFileReady(item.relPath, status);
        if (!ready)
            return;
        let lineNo;
        try {
            lineNo = await resolveRevDiffStartLine(item.relPath, revState.startRev, revState.endRev);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logMessage("WARN", "openRevMergeFile: resolve diff failed", {
                relPath: item.relPath,
                error: message,
            });
        }
        await openMergeFile(item.relPath, lineNo, false, false);
        if (!lineNo) {
            vscode.window.showInformationMessage("未找到差异位置，已打开文件");
        }
    }
    async function resolveActiveRevHunkInput() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "svnrev") {
            return undefined;
        }
        const context = await resolveCurrentRevHunkContext(editor.document, editor.selection.active.line + 1);
        if (!context)
            return undefined;
        return { relPath: context.relPath, hunkIndex: context.hunk.index };
    }
    async function copyRevHunkDebugLog(relPath, hunkIndex) {
        let resolvedPath = relPath;
        let resolvedIndex = hunkIndex;
        if (!resolvedPath || resolvedIndex === undefined) {
            const input = await resolveActiveRevHunkInput();
            if (!input) {
                vscode.window.showErrorMessage("未找到当前变更块");
                return;
            }
            resolvedPath = input.relPath;
            resolvedIndex = input.hunkIndex;
        }
        if (!resolvedPath || resolvedIndex === undefined)
            return;
        try {
            const logText = await buildRevHunkDebugLog(resolvedPath, resolvedIndex);
            await vscode.env.clipboard.writeText(logText);
            vscode.window.showInformationMessage("已复制变更块日志");
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function openMergeByHunkContext(relPath, hunkIndex) {
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        let resolvedPath = relPath;
        let resolvedIndex = hunkIndex;
        if (!resolvedPath || resolvedIndex === undefined) {
            const input = await resolveActiveRevHunkInput();
            if (!input) {
                vscode.window.showErrorMessage("未找到当前变更块");
                return;
            }
            resolvedPath = input.relPath;
            resolvedIndex = input.hunkIndex;
        }
        if (!resolvedPath || resolvedIndex === undefined)
            return;
        const key = getRevCachePathKey(resolvedPath);
        const fileStatus = findRevStatusByPath(key) || "M";
        const ready = await ensureMergeFileReady(key, fileStatus);
        if (!ready) {
            if (normalizeRevStatus(fileStatus) === "D") {
                vscode.window.showInformationMessage("待合并目录中该文件不存在，可能已删除");
            }
            return;
        }
        const diff = await ensureRevFileDiff(key);
        const hunk = diff.hunks[resolvedIndex];
        if (!hunk) {
            vscode.window.showErrorMessage("未找到对应变更块");
            return;
        }
        const status = await ensureRevHunkStatus(key, hunk.index, false);
        const lineNo = await resolveMergeLineByHunkContext(ready.filePath, hunk, status);
        await openMergeFile(key, lineNo, false, false);
    }
    async function applyRevHunkToMerge(relPath, hunkIndex) {
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        let resolvedPath = relPath;
        let resolvedIndex = hunkIndex;
        const opId = createOperationId("hunk-merge");
        let finishProgress = () => { };
        const progressDone = new Promise((resolve) => {
            finishProgress = resolve;
        });
        const progressPromise = vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "SVN Merge Annotator",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: `正在合并变更块（${opId}）` });
            await progressDone;
        });
        const busy = vscode.window.setStatusBarMessage("$(sync~spin) SVN Merge Annotator: 正在合并变更块...");
        logMessage("INFO", "applyRevHunkToMerge: start", {
            opId,
            relPath,
            hunkIndex,
        });
        try {
            if (!resolvedPath || resolvedIndex === undefined) {
                const input = await resolveActiveRevHunkInput();
                if (!input) {
                    vscode.window.showErrorMessage("未找到当前变更块");
                    return;
                }
                resolvedPath = input.relPath;
                resolvedIndex = input.hunkIndex;
            }
            if (!resolvedPath || resolvedIndex === undefined) {
                vscode.window.showErrorMessage("缺少变更块信息，无法执行合并");
                return;
            }
            const key = getRevCachePathKey(resolvedPath);
            logMessage("INFO", "applyRevHunkToMerge: resolved input", {
                opId,
                key,
                hunkIndex: resolvedIndex,
            });
            const diff = await ensureRevFileDiff(key);
            const hunk = diff.hunks[resolvedIndex];
            if (!hunk) {
                vscode.window.showErrorMessage("未找到对应变更块");
                return;
            }
            const currentStatus = await ensureRevHunkStatus(key, hunk.index, false);
            if (currentStatus === "merged") {
                vscode.window.showInformationMessage("该变更块已合并，无需重复应用");
                return;
            }
            const mergeRoot = await resolveMergeRoot();
            if (!mergeRoot) {
                vscode.window.showErrorMessage("缺少 merge 根目录信息");
                return;
            }
            const mergePath = resolveMergePathContext(mergeRoot, key);
            const targetPath = mergePath.filePath;
            const normalizedRel = mergePath.normalizedRelPath;
            const beforeSnapshot = captureFileSnapshotForDebug(targetPath);
            logMessage("INFO", "applyRevHunkToMerge: merge path context", {
                opId,
                mergeRoot,
                applyRoot: mergePath.applyRoot,
                mappedRelPath: mergePath.mappedRelPath,
                targetPath,
                beforeSnapshot,
            });
            const targetDir = path.extname(normalizedRel)
                ? path.dirname(targetPath)
                : targetPath;
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            const rawPatch = buildSingleHunkPatch(diff, hunk);
            const patchText = rewritePatchPaths(rawPatch, revState.root.rootUrl);
            const dryRun = await runPatchWithText(key, patchText, mergeRoot, true, false, `${opId}:dry`);
            const hunkMode = getRevHunkChangeMode(hunk);
            const targetFileExists = fs.existsSync(targetPath);
            const forceTextFallback = hunkMode === "add" && !targetFileExists && !!dryRun.alreadyApplied;
            logMessage("INFO", "applyRevHunkToMerge: dry-run summary", {
                opId,
                code: dryRun.code,
                ok: dryRun.ok,
                skipped: dryRun.skipped,
                conflict: dryRun.conflict,
                alreadyApplied: dryRun.alreadyApplied,
                hunkMode,
                targetFileExists,
                forceTextFallback,
            });
            if (!dryRun.ok || forceTextFallback) {
                let textApply;
                try {
                    textApply = await tryApplyRevHunkByText(key, hunk, targetPath);
                }
                catch (err) {
                    textApply = {
                        ok: false,
                        mode: getRevHunkChangeMode(hunk),
                        message: "文本匹配回退执行异常",
                        detail: String(err),
                    };
                }
                if (textApply.ok) {
                    let svnTrackResult;
                    if (hunkMode === "add") {
                        svnTrackResult = await ensureSvnTracked(targetPath, opId, "applyRevHunkToMerge:text-fallback");
                        if (!svnTrackResult.ok) {
                            vscode.window.showWarningMessage(`变更块已应用，但加入 SVN 跟踪失败：${svnTrackResult.message}`);
                        }
                    }
                    invalidateRevPathMergeCache(key);
                    await ensureRevFileMergeSummary(key, true);
                    const finalStatus = await ensureRevHunkStatus(key, hunk.index, true);
                    refreshRevView();
                    diffLensEmitter.fire();
                    if (finalStatus === "merged") {
                        vscode.window.showInformationMessage(textApply.alreadyMerged
                            ? textApply.message || "该变更块已合并（文本匹配判定）"
                            : textApply.message || "该变更块已通过文本匹配应用");
                    }
                    else {
                        vscode.window.showWarningMessage(`已执行文本合并，但当前状态为${getRevHunkStatusLabel(finalStatus)}，请点“复制日志”排查`);
                    }
                    logMessage("INFO", "applyRevHunkToMerge: applied by text fallback", {
                        opId,
                        relPath: key,
                        hunkIndex: hunk.index,
                        mode: textApply.mode,
                        alreadyMerged: !!textApply.alreadyMerged,
                        message: textApply.message,
                        detail: textApply.detail,
                        finalStatus,
                        dryRunCode: dryRun.code,
                        dryRunStdout: dryRun.stdout,
                        dryRunStderr: dryRun.stderr,
                        dryRunAlreadyApplied: dryRun.alreadyApplied,
                        forceTextFallback,
                        svnTrackResult,
                        beforeSnapshot,
                        afterSnapshot: captureFileSnapshotForDebug(targetPath),
                    });
                    return;
                }
                vscode.window.showErrorMessage("该变更块应用失败或存在冲突，已中止");
                logMessage("WARN", "applyRevHunkToMerge: dry-run failed", {
                    opId,
                    relPath: key,
                    hunkIndex: hunk.index,
                    code: dryRun.code,
                    stdout: dryRun.stdout,
                    stderr: dryRun.stderr,
                    textFallbackMode: textApply?.mode,
                    textFallbackReason: textApply?.message,
                    textFallbackDetail: textApply?.detail,
                    dryRunAlreadyApplied: dryRun.alreadyApplied,
                    forceTextFallback,
                    beforeSnapshot,
                    afterSnapshot: captureFileSnapshotForDebug(targetPath),
                });
                return;
            }
            const applyResp = await runPatchWithText(key, patchText, mergeRoot, false, false, `${opId}:apply`);
            if (!applyResp.ok) {
                vscode.window.showErrorMessage("该变更块应用失败");
                logMessage("WARN", "applyRevHunkToMerge: apply failed", {
                    opId,
                    relPath: key,
                    hunkIndex: hunk.index,
                    code: applyResp.code,
                    stdout: applyResp.stdout,
                    stderr: applyResp.stderr,
                    beforeSnapshot,
                    afterSnapshot: captureFileSnapshotForDebug(targetPath),
                });
                return;
            }
            let svnTrackResult;
            if (hunkMode === "add") {
                svnTrackResult = await ensureSvnTracked(targetPath, opId, "applyRevHunkToMerge:patch-apply");
                if (!svnTrackResult.ok) {
                    vscode.window.showWarningMessage(`变更块已应用，但加入 SVN 跟踪失败：${svnTrackResult.message}`);
                }
            }
            invalidateRevPathMergeCache(key);
            await ensureRevFileMergeSummary(key, true);
            const finalStatus = await ensureRevHunkStatus(key, hunk.index, true);
            refreshRevView();
            diffLensEmitter.fire();
            if (finalStatus === "merged") {
                vscode.window.showInformationMessage("该变更块已应用到待合并目录");
                logMessage("INFO", "applyRevHunkToMerge: finished", {
                    opId,
                    relPath: key,
                    hunkIndex: hunk.index,
                    finalStatus,
                    svnTrackResult,
                    beforeSnapshot,
                    afterSnapshot: captureFileSnapshotForDebug(targetPath),
                });
            }
            else {
                vscode.window.showWarningMessage(`补丁执行完成，但当前状态为${getRevHunkStatusLabel(finalStatus)}，请点“复制日志”排查`);
                logMessage("WARN", "applyRevHunkToMerge: finished with non-merged status", {
                    opId,
                    relPath: key,
                    hunkIndex: hunk.index,
                    finalStatus,
                    svnTrackResult,
                    beforeSnapshot,
                    afterSnapshot: captureFileSnapshotForDebug(targetPath),
                });
            }
        }
        catch (err) {
            const detail = getErrorDetail(err);
            logMessage("ERROR", "applyRevHunkToMerge failed", {
                opId,
                relPath: resolvedPath || relPath,
                hunkIndex: resolvedIndex ?? hunkIndex,
                error: detail.message,
                stack: detail.stack,
            });
            vscode.window.showErrorMessage(`合并变更块失败: ${detail.message}`);
        }
        finally {
            busy.dispose();
            finishProgress();
            await progressPromise;
        }
    }
    async function openMergeAtDiffLine() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("当前没有可用的编辑器");
            return;
        }
        if (editor.document.uri.scheme !== "svnrev") {
            vscode.window.showErrorMessage("当前不是提交范围对比文件");
            return;
        }
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        const relPath = decodeURIComponent(editor.document.uri.path.replace(/^\/+/, ""));
        const status = findRevStatusByPath(relPath) || "M";
        if (normalizeRevStatus(status) === "D") {
            vscode.window.showErrorMessage("该文件在范围内为删除，无法定位");
            return;
        }
        const ready = await ensureMergeFileReady(relPath, status);
        if (!ready)
            return;
        const lineNo = editor.selection.active.line + 1;
        await openMergeFile(relPath, lineNo, false, false);
    }
    async function openMergeBySelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("当前没有可用的编辑器");
            return;
        }
        if (editor.document.uri.scheme !== "svnrev") {
            vscode.window.showErrorMessage("当前不是提交范围对比文件");
            return;
        }
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        const selectionText = editor.document.getText(editor.selection);
        if (!selectionText || !selectionText.trim()) {
            vscode.window.showErrorMessage("请先选择代码片段");
            return;
        }
        const relPath = decodeURIComponent(editor.document.uri.path.replace(/^\/+/, ""));
        const status = findRevStatusByPath(relPath) || "M";
        if (normalizeRevStatus(status) === "D") {
            vscode.window.showErrorMessage("该文件在范围内为删除，无法定位");
            return;
        }
        const ready = await ensureMergeFileReady(relPath, status);
        if (!ready)
            return;
        const mergeDoc = await vscode.workspace.openTextDocument(ready.filePath);
        const snippetLines = trimSnippetLines(selectionText.split(/\r?\n/));
        if (!snippetLines.length) {
            vscode.window.showErrorMessage("选择内容为空");
            return;
        }
        const targetLines = mergeDoc.getText().split(/\r?\n/);
        const matches = findSnippetMatches(snippetLines, targetLines);
        if (!matches.length) {
            vscode.window.showErrorMessage("未在待合并文件中找到匹配片段");
            return;
        }
        let lineNo = matches[0];
        if (matches.length > 1) {
            const picks = matches.slice(0, 200).map((line) => ({
                label: `L${line}`,
                description: buildLinePreview(targetLines[line - 1] || ""),
                lineNo: line,
            }));
            const picked = await vscode.window.showQuickPick(picks, {
                placeHolder: `找到 ${matches.length} 处匹配，选择跳转位置`,
                matchOnDescription: true,
            });
            if (!picked)
                return;
            lineNo = picked.lineNo;
        }
        await openMergeFile(relPath, lineNo, false, false);
    }
    async function applyRevChangeToMergeByPath(relPath, status) {
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return false;
        }
        const opId = createOperationId("file-merge");
        let finishProgress = () => { };
        const progressDone = new Promise((resolve) => {
            finishProgress = resolve;
        });
        const progressPromise = vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "SVN Merge Annotator",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: `正在一键更新到待合并（${opId}）` });
            await progressDone;
        });
        const busy = vscode.window.setStatusBarMessage("$(sync~spin) SVN Merge Annotator: 正在一键更新到待合并...");
        logMessage("INFO", "applyRevChangeToMergeByPath: start", {
            opId,
            relPath,
            status,
        });
        try {
            const mergeRoot = await resolveMergeRoot();
            if (!mergeRoot) {
                vscode.window.showErrorMessage("缺少 merge 根目录信息");
                return false;
            }
            const range = `${revState.startRev}:${revState.endRev}`;
            const fileUrl = joinUrl(revState.root.rootUrl, normalizeSlashes(relPath));
            const diffResp = await runSvn(["diff", "-r", range, fileUrl], revState.root.rootPath);
            if (diffResp.code !== 0) {
                const message = diffResp.stderr || "获取差异失败";
                vscode.window.showErrorMessage(message);
                return false;
            }
            if (!diffResp.stdout.trim()) {
                vscode.window.showInformationMessage("该文件在范围内无可应用差异");
                return false;
            }
            const normalizedPatch = rewritePatchPaths(diffResp.stdout, revState.root.rootUrl);
            const patchPath = buildTempPatchPath(relPath);
            try {
                const normalizedStatus = normalizeRevStatus(status);
                const mergePath = resolveMergePathContext(mergeRoot, relPath);
                const patchRoot = mergePath.applyRoot;
                const beforeSnapshot = captureFileSnapshotForDebug(mergePath.filePath);
                logMessage("INFO", "applyRevChangeToMergeByPath: merge path context", {
                    opId,
                    mergeRoot,
                    patchRoot,
                    mappedRelPath: mergePath.mappedRelPath,
                    targetPath: mergePath.filePath,
                    normalizedStatus,
                    beforeSnapshot,
                });
                if (normalizedStatus === "A") {
                    const targetPath = mergePath.filePath;
                    const targetDir = path.extname(mergePath.normalizedRelPath)
                        ? path.dirname(targetPath)
                        : targetPath;
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                }
                fs.writeFileSync(patchPath, normalizedPatch, "utf8");
                const dryResp = await runSvn(["patch", "--dry-run", patchPath, patchRoot], patchRoot);
                const dryCombined = `${dryResp.stdout}\n${dryResp.stderr}`;
                const dryConflict = hasPatchConflict(dryCombined);
                const drySkipped = hasPatchSkipped(dryCombined);
                const dryAlreadyApplied = hasPatchAlreadyApplied(dryCombined);
                const forceTextFallback = normalizedStatus === "A" &&
                    dryAlreadyApplied &&
                    !fs.existsSync(mergePath.filePath);
                logMessage("INFO", "applyRevChangeToMergeByPath: dry-run summary", {
                    opId,
                    code: dryResp.code,
                    conflict: dryConflict,
                    skipped: drySkipped,
                    alreadyApplied: dryAlreadyApplied,
                    forceTextFallback,
                    output: summarizeLogText(dryCombined, 6),
                });
                if (dryResp.code !== 0 ||
                    dryConflict ||
                    drySkipped ||
                    forceTextFallback) {
                    if (normalizedStatus === "A" && (drySkipped || forceTextFallback)) {
                        const parsed = parseRevFileDiff(diffResp.stdout);
                        if (parsed.hunks.length > 0) {
                            let allOk = true;
                            const fallbackMessages = [];
                            for (const hunk of parsed.hunks) {
                                const textApply = await tryApplyRevHunkByText(relPath, hunk, mergePath.filePath);
                                fallbackMessages.push(textApply.message);
                                if (!textApply.ok) {
                                    allOk = false;
                                    break;
                                }
                            }
                            if (allOk) {
                                let svnTrackResult;
                                if (normalizedStatus === "A") {
                                    svnTrackResult = await ensureSvnTracked(mergePath.filePath, opId, "applyRevChangeToMergeByPath:text-fallback");
                                    if (!svnTrackResult.ok) {
                                        const message = `新增文件已应用，但加入 SVN 跟踪失败：${svnTrackResult.message}`;
                                        vscode.window.showErrorMessage(message);
                                        logMessage("WARN", "applyRevChangeToMergeByPath: track failed", {
                                            opId,
                                            relPath,
                                            svnTrackResult,
                                        });
                                        return false;
                                    }
                                }
                                invalidateRevPathMergeCache(relPath);
                                const summary = await ensureRevFileMergeSummary(relPath, true);
                                refreshRevView();
                                diffLensEmitter.fire();
                                vscode.window.showInformationMessage(summary.total > 0
                                    ? `已通过文本回退应用新增文件（已合并 ${summary.merged}/${summary.total}）`
                                    : "已通过文本回退应用新增文件");
                                logMessage("INFO", "applyRevChangeToMerge: applied by text fallback", {
                                    opId,
                                    relPath,
                                    status: normalizedStatus,
                                    fallbackMessages,
                                    dryAlreadyApplied,
                                    forceTextFallback,
                                    dryStdout: dryResp.stdout,
                                    dryStderr: dryResp.stderr,
                                    svnTrackResult,
                                    beforeSnapshot,
                                    afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                                });
                                return true;
                            }
                        }
                    }
                    vscode.window.showErrorMessage("补丁应用出现冲突，已中止");
                    logMessage("WARN", "applyRevChangeToMerge: conflict", {
                        opId,
                        relPath,
                        stdout: dryResp.stdout,
                        stderr: dryResp.stderr,
                        skipped: drySkipped,
                        alreadyApplied: dryAlreadyApplied,
                        forceTextFallback,
                        beforeSnapshot,
                        afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                    });
                    return false;
                }
                const applyResp = await runSvn(["patch", patchPath, patchRoot], patchRoot);
                if (applyResp.code !== 0) {
                    const message = applyResp.stderr || "补丁应用失败";
                    vscode.window.showErrorMessage(message);
                    logMessage("WARN", "applyRevChangeToMergeByPath: apply failed", {
                        opId,
                        relPath,
                        code: applyResp.code,
                        output: summarizeLogText(`${applyResp.stdout}\n${applyResp.stderr}`, 6),
                        beforeSnapshot,
                        afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                    });
                    return false;
                }
                let svnTrackResult;
                if (normalizedStatus === "A") {
                    svnTrackResult = await ensureSvnTracked(mergePath.filePath, opId, "applyRevChangeToMergeByPath:patch-apply");
                    if (!svnTrackResult.ok) {
                        const message = `新增文件已应用，但加入 SVN 跟踪失败：${svnTrackResult.message}`;
                        vscode.window.showErrorMessage(message);
                        logMessage("WARN", "applyRevChangeToMergeByPath: track failed", {
                            opId,
                            relPath,
                            svnTrackResult,
                            beforeSnapshot,
                            afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                        });
                        return false;
                    }
                }
                invalidateRevPathMergeCache(relPath);
                const summary = await ensureRevFileMergeSummary(relPath, true);
                refreshRevView();
                diffLensEmitter.fire();
                if (summary.total > 0 && summary.merged === 0 && summary.unmerged === summary.total) {
                    vscode.window.showWarningMessage("补丁执行完成，但该文件仍未合并任何变更块，请检查路径映射或点“复制日志”排查");
                    logMessage("WARN", "applyRevChangeToMergeByPath: finished with zero merged", {
                        opId,
                        relPath,
                        summary,
                        svnTrackResult,
                        beforeSnapshot,
                        afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                    });
                    return false;
                }
                vscode.window.showInformationMessage(summary.total > 0
                    ? `已应用到待合并目录（已合并 ${summary.merged}/${summary.total}）`
                    : "已应用到待合并目录");
                logMessage("INFO", "applyRevChangeToMergeByPath: finished", {
                    opId,
                    relPath,
                    summary,
                    svnTrackResult,
                    beforeSnapshot,
                    afterSnapshot: captureFileSnapshotForDebug(mergePath.filePath),
                });
                return true;
            }
            finally {
                try {
                    fs.unlinkSync(patchPath);
                }
                catch (err) {
                    // 清理失败不影响主流程
                }
            }
        }
        catch (err) {
            const detail = getErrorDetail(err);
            logMessage("ERROR", "applyRevChangeToMergeByPath failed", {
                opId,
                relPath,
                status,
                error: detail.message,
                stack: detail.stack,
            });
            vscode.window.showErrorMessage(`一键更新到待合并失败: ${detail.message}`);
            return false;
        }
        finally {
            busy.dispose();
            finishProgress();
            await progressPromise;
        }
    }
    async function applyRevChangeToMerge(item) {
        if (!item) {
            vscode.window.showErrorMessage("未选择文件，无法一键更新到待合并");
            return;
        }
        await applyRevChangeToMergeByPath(item.relPath, item.status);
    }
    async function openRevDiffForPath(relPath, leftRev, rightRev) {
        const safeRelPath = relPath.replace(/\\/g, "/");
        const left = vscode.Uri.from({
            scheme: "svnrev",
            path: `/${safeRelPath}`,
            query: `rev=${encodeURIComponent(leftRev)}`,
        });
        const right = vscode.Uri.from({
            scheme: "svnrev",
            path: `/${safeRelPath}`,
            query: `rev=${encodeURIComponent(rightRev)}`,
        });
        const title = `${safeRelPath} (${formatRevLabel(leftRev)} → ${formatRevLabel(rightRev)})`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
    }
    function resolveCompareFilePath(input) {
        if (input instanceof FileItem || input instanceof RevFileItem) {
            return normalizeSlashes(input.relPath);
        }
        if (input instanceof vscode.Uri) {
            if (input.scheme !== "file") {
                return undefined;
            }
            const absolutePath = path.normalize(input.fsPath);
            const tryResolveByRoot = (rootDir) => {
                if (!rootDir)
                    return undefined;
                const normalizedRoot = path.normalize(rootDir);
                const relative = path.relative(normalizedRoot, absolutePath);
                if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
                    return undefined;
                }
                return normalizeSlashes(relative);
            };
            const rootsToTry = [
                state.roots?.merge,
                state.roots?.branch,
                state.roots?.trunk,
            ];
            for (const rootDir of rootsToTry) {
                const rel = tryResolveByRoot(rootDir);
                if (rel)
                    return rel;
            }
            const lastDirs = context.globalState.get(LAST_DIRS_KEY);
            for (const rootDir of [lastDirs?.merge, lastDirs?.branch, lastDirs?.trunk]) {
                const rel = tryResolveByRoot(rootDir);
                if (rel)
                    return rel;
            }
            const workspace = vscode.workspace.getWorkspaceFolder(input);
            if (workspace) {
                const relative = path.relative(workspace.uri.fsPath, absolutePath);
                if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
                    return normalizeSlashes(relative);
                }
            }
            return normalizeSlashes(path.basename(absolutePath));
        }
        if (typeof input === "string" && input.trim()) {
            return normalizeSlashes(input.trim());
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return undefined;
        const detail = state.fileDetailByPath.get(editor.document.fileName);
        if (detail?.path) {
            return normalizeSlashes(detail.path);
        }
        const scheme = editor.document.uri.scheme;
        if (scheme === "svnrev" || scheme === SVN_REV_COMPARE_SCHEME) {
            const relPath = decodeURIComponent(editor.document.uri.path.replace(/^\/+/, ""));
            if (relPath) {
                return normalizeSlashes(relPath);
            }
        }
        if (scheme === "file") {
            const asRelative = vscode.workspace.asRelativePath(editor.document.uri, false);
            if (asRelative && asRelative !== editor.document.uri.fsPath) {
                return normalizeSlashes(asRelative);
            }
            return normalizeSlashes(path.basename(editor.document.uri.fsPath));
        }
        return undefined;
    }
    function formatCompareSourceLabel(source) {
        if (source === "local") {
            return "本地";
        }
        return formatRootLabel(source);
    }
    async function pickCompareSource(placeHolder, preferred) {
        const items = [
            { label: "分支", value: "branch" },
            { label: "主线", value: "trunk" },
            { label: "本地", value: "local" },
        ];
        for (const item of items) {
            item.picked = item.value === preferred;
        }
        const picked = await vscode.window.showQuickPick(items, { placeHolder });
        return picked?.value;
    }
    async function pickFileRevisionForCompare(relPath, target, sideLabel) {
        if (target === "local") {
            throw new Error(`${sideLabel}选择了本地来源，无需选择历史版本`);
        }
        const root = await getRootInfo(target);
        if (!root) {
            throw new Error(`缺少${formatRootLabel(target)}目录配置`);
        }
        const cacheKey = [
            target,
            root.rootUrl,
            normalizeSlashes(relPath),
            FILE_HISTORY_PICK_LIMIT,
        ].join("|");
        let entries = fileHistoryCompareCache.get(cacheKey);
        if (!entries) {
            entries = await fetchFileLogEntriesLatest(root, relPath, FILE_HISTORY_PICK_LIMIT);
            fileHistoryCompareCache.set(cacheKey, entries);
        }
        if (!entries.length) {
            throw new Error(`${formatRootLabel(target)}下该文件暂无历史: ${relPath}`);
        }
        const picks = entries.map((entry) => {
            const message = formatLogMessage(entry.message);
            const detailParts = [];
            if (entry.author)
                detailParts.push(entry.author);
            const dateText = formatLogDate(entry.date);
            if (dateText)
                detailParts.push(dateText);
            return {
                label: `r${entry.revision}`,
                description: message || "",
                detail: detailParts.join(" · "),
                revision: entry.revision,
            };
        });
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: `${sideLabel}：选择${formatRootLabel(target)}历史版本`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return picked?.revision;
    }
    async function openCompareRevDiffForPath(relPath, leftTarget, leftRev, rightTarget, rightRev) {
        if (leftTarget === "local" || rightTarget === "local") {
            throw new Error("本地来源请使用本地文件对比流程");
        }
        const safeRelPath = relPath.replace(/\\/g, "/");
        const left = vscode.Uri.from({
            scheme: SVN_REV_COMPARE_SCHEME,
            path: `/${safeRelPath}`,
            query: `target=${encodeURIComponent(leftTarget)}&rev=${encodeURIComponent(leftRev)}`,
        });
        const right = vscode.Uri.from({
            scheme: SVN_REV_COMPARE_SCHEME,
            path: `/${safeRelPath}`,
            query: `target=${encodeURIComponent(rightTarget)}&rev=${encodeURIComponent(rightRev)}`,
        });
        const title = `${safeRelPath} (左:${formatRootLabel(leftTarget)} ${formatRevLabel(leftRev)} → 右:${formatRootLabel(rightTarget)} ${formatRevLabel(rightRev)})`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
    }
    async function pickLocalFileForCompare(relPath, sideLabel) {
        const enableEnhancedLocalPick = context.globalState.get("compare.localFilePicker.enhanced", true);
        if (enableEnhancedLocalPick) {
            return pickLocalFileForCompareEnhanced(relPath, sideLabel);
        }
        const workspaces = vscode.workspace.workspaceFolders || [];
        if (!workspaces.length) {
            throw new Error("当前没有打开的工作区目录，无法选择本地文件");
        }
        const normalizedRelPath = normalizeSlashes(relPath);
        const targetFileName = path
            .basename(normalizedRelPath || "")
            .trim()
            .toLowerCase();
        const excludePattern = "**/{.git,.svn,node_modules,dist,build,out,.idea,.vscode}/**";
        const preferredIncludePattern = targetFileName
            ? `**/${targetFileName}`
            : "**/*";
        let candidates = await vscode.workspace.findFiles(preferredIncludePattern, excludePattern, 800);
        if (targetFileName) {
            candidates = candidates.filter((uri) => path.basename(uri.fsPath).toLowerCase() === targetFileName);
        }
        if (!candidates.length && targetFileName) {
            const allCandidates = await vscode.workspace.findFiles("**/*", excludePattern, 3000);
            candidates = allCandidates.filter((uri) => path.basename(uri.fsPath).toLowerCase() === targetFileName);
        }
        if (!candidates.length) {
            throw new Error(`当前工作区未找到同名本地文件: ${targetFileName || relPath}`);
        }
        const normalizedRelLower = normalizedRelPath.toLowerCase();
        const picks = candidates.map((uri) => {
            const filePath = path.normalize(uri.fsPath);
            const workspace = vscode.workspace.getWorkspaceFolder(uri);
            const workspaceName = workspace?.name || "工作区外";
            const relInWorkspace = workspace
                ? normalizeSlashes(path.relative(workspace.uri.fsPath, filePath))
                : normalizeSlashes(filePath);
            const relLower = relInWorkspace.toLowerCase();
            const fileNameLower = path.basename(filePath).toLowerCase();
            let score = 4;
            if (normalizedRelLower && relLower === normalizedRelLower) {
                score = 0;
            }
            else if (normalizedRelLower &&
                relLower.endsWith(`/${normalizedRelLower}`)) {
                score = 1;
            }
            else if (targetFileName && fileNameLower === targetFileName) {
                score = 2;
            }
            else {
                score = 3;
            }
            return {
                label: path.basename(filePath),
                description: relInWorkspace,
                detail: workspaceName,
                fsPath: filePath,
                score,
                sortKey: `${workspaceName}/${relInWorkspace}`.toLowerCase(),
            };
        });
        picks.sort((a, b) => {
            if (a.score !== b.score)
                return a.score - b.score;
            return a.sortKey.localeCompare(b.sortKey);
        });
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: `${sideLabel}：选择本地文件（文件名：${targetFileName || relPath}）`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return picked?.fsPath;
    }
    async function pickLocalFileForCompareEnhanced(relPath, sideLabel) {
        const pickOpId = createOperationId("local-pick");
        logMessage("INFO", "pickLocalFileForCompareEnhanced: start", {
            opId: pickOpId,
            relPath,
            sideLabel,
        });
        const searchRootMap = new Map();
        const addSearchRoot = (rootPath, label) => {
            if (!rootPath)
                return;
            const normalizedRoot = path.normalize(rootPath);
            if (!path.isAbsolute(normalizedRoot))
                return;
            try {
                if (!fs.statSync(normalizedRoot).isDirectory())
                    return;
            }
            catch {
                return;
            }
            const key = normalizeSlashes(normalizedRoot).toLowerCase();
            const existing = searchRootMap.get(key);
            if (existing) {
                if (label && existing.label !== label && !existing.label.includes(label)) {
                    existing.label = `${existing.label} | ${label}`;
                }
                return;
            }
            searchRootMap.set(key, {
                rootPath: normalizedRoot,
                label: label || path.basename(normalizedRoot) || normalizedRoot,
                key,
            });
        };
        const workspaces = vscode.workspace.workspaceFolders || [];
        for (const workspace of workspaces) {
            addSearchRoot(workspace.uri.fsPath, workspace.name);
        }
        addSearchRoot(state.roots?.branch, "分支根目录");
        addSearchRoot(state.roots?.trunk, "主线根目录");
        addSearchRoot(state.roots?.merge, "合并根目录");
        const searchRoots = Array.from(searchRootMap.values());
        logMessage("INFO", "pickLocalFileForCompareEnhanced: roots resolved", {
            opId: pickOpId,
            rootCount: searchRoots.length,
            roots: searchRoots.map((root) => ({
                label: root.label,
                rootPath: root.rootPath,
            })),
            workspaceCount: workspaces.length,
            configuredRoots: {
                branch: state.roots?.branch,
                trunk: state.roots?.trunk,
                merge: state.roots?.merge,
            },
        });
        if (!searchRoots.length) {
            logMessage("WARN", "pickLocalFileForCompareEnhanced: no roots", {
                opId: pickOpId,
            });
            throw new Error("当前没有可搜索目录，请先打开工作区或配置分支/主线/合并目录");
        }
        const searchStatsByKey = new Map();
        for (const root of searchRoots) {
            searchStatsByKey.set(root.key, {
                label: root.label,
                rootPath: root.rootPath,
                directHit: 0,
                preferredTotal: 0,
                preferredMatched: 0,
                fallbackTotal: 0,
                fallbackMatched: 0,
            });
        }
        const normalizedRelPath = normalizeSlashes(relPath).replace(/^\/+/, "");
        const targetFileNameRaw = path.basename(normalizedRelPath || "").trim();
        const targetFileName = targetFileNameRaw.toLowerCase();
        const excludePattern = "**/{.git,.svn,node_modules,dist,build,out,.idea,.vscode}/**";
        const preferredIncludePattern = targetFileNameRaw
            ? `**/${targetFileNameRaw}`
            : "**/*";
        const candidateByKey = new Map();
        const candidateRootLabelByKey = new Map();
        let duplicateCandidateCount = 0;
        const addCandidate = (uri, rootLabel) => {
            const normalizedFilePath = path.normalize(uri.fsPath);
            const key = normalizeSlashes(normalizedFilePath).toLowerCase();
            if (!candidateByKey.has(key)) {
                candidateByKey.set(key, vscode.Uri.file(normalizedFilePath));
            }
            else {
                duplicateCandidateCount += 1;
            }
            if (rootLabel && !candidateRootLabelByKey.has(key)) {
                candidateRootLabelByKey.set(key, rootLabel);
            }
        };
        const hasExcludedSegment = (filePath) => {
            const lowerPath = normalizeSlashes(path.normalize(filePath)).toLowerCase();
            const excludedSegments = [
                "/.git/",
                "/.svn/",
                "/node_modules/",
                "/dist/",
                "/build/",
                "/out/",
                "/.idea/",
                "/.vscode/",
            ];
            return excludedSegments.some((segment) => lowerPath.includes(segment));
        };
        const relPathForFs = normalizedRelPath.split("/").join(path.sep);
        if (normalizedRelPath) {
            for (const root of searchRoots) {
                const directPath = path.normalize(path.join(root.rootPath, relPathForFs));
                const relInRoot = path.relative(root.rootPath, directPath);
                if (relInRoot.startsWith("..") || path.isAbsolute(relInRoot)) {
                    continue;
                }
                if (hasExcludedSegment(directPath)) {
                    continue;
                }
                try {
                    if (fs.statSync(directPath).isFile()) {
                        addCandidate(vscode.Uri.file(directPath), root.label);
                        const stat = searchStatsByKey.get(root.key);
                        if (stat) {
                            stat.directHit += 1;
                        }
                    }
                }
                catch {
                    // 忽略不存在或不可访问的路径
                }
            }
        }
        logMessage("INFO", "pickLocalFileForCompareEnhanced: direct path scan done", {
            opId: pickOpId,
            normalizedRelPath,
            targetFileName,
            targetFileNameRaw,
            uniqueCandidateCount: candidateByKey.size,
            duplicateCandidateCount,
            stats: Array.from(searchStatsByKey.values()).map((stat) => ({
                label: stat.label,
                rootPath: stat.rootPath,
                directHit: stat.directHit,
            })),
        });
        const preferredSearchResults = await Promise.all(searchRoots.map(async (root) => {
            try {
                const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root.rootPath, preferredIncludePattern), excludePattern, 5000);
                return { root, uris };
            }
            catch {
                return { root, uris: [] };
            }
        }));
        for (const result of preferredSearchResults) {
            const stat = searchStatsByKey.get(result.root.key);
            if (stat) {
                stat.preferredTotal = result.uris.length;
            }
            let matchedInRoot = 0;
            for (const uri of result.uris) {
                if (!targetFileName || path.basename(uri.fsPath).toLowerCase() === targetFileName) {
                    addCandidate(uri, result.root.label);
                    matchedInRoot += 1;
                }
            }
            if (stat) {
                stat.preferredMatched = matchedInRoot;
            }
        }
        logMessage("INFO", "pickLocalFileForCompareEnhanced: preferred search done", {
            opId: pickOpId,
            normalizedRelPath,
            targetFileName,
            targetFileNameRaw,
            uniqueCandidateCount: candidateByKey.size,
            duplicateCandidateCount,
            stats: Array.from(searchStatsByKey.values()).map((stat) => ({
                label: stat.label,
                rootPath: stat.rootPath,
                directHit: stat.directHit,
                preferredTotal: stat.preferredTotal,
                preferredMatched: stat.preferredMatched,
            })),
        });
        if (candidateByKey.size <= 1 && targetFileName) {
            logMessage("INFO", "pickLocalFileForCompareEnhanced: fallback search start", {
                opId: pickOpId,
                targetFileName,
                targetFileNameRaw,
                reason: candidateByKey.size === 0 ? "no-candidate" : "low-candidate",
                rootCount: searchRoots.length,
            });
            const fallbackResults = await Promise.all(searchRoots.map(async (root) => {
                try {
                    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root.rootPath, "**/*"), excludePattern, 12000);
                    return { root, uris };
                }
                catch {
                    return { root, uris: [] };
                }
            }));
            for (const result of fallbackResults) {
                const stat = searchStatsByKey.get(result.root.key);
                if (stat) {
                    stat.fallbackTotal = result.uris.length;
                }
                let matchedInRoot = 0;
                for (const uri of result.uris) {
                    if (path.basename(uri.fsPath).toLowerCase() === targetFileName) {
                        addCandidate(uri, result.root.label);
                        matchedInRoot += 1;
                    }
                }
                if (stat) {
                    stat.fallbackMatched = matchedInRoot;
                }
            }
            logMessage("INFO", "pickLocalFileForCompareEnhanced: fallback search done", {
                opId: pickOpId,
                targetFileNameRaw,
                uniqueCandidateCount: candidateByKey.size,
                duplicateCandidateCount,
                stats: Array.from(searchStatsByKey.values()).map((stat) => ({
                    label: stat.label,
                    rootPath: stat.rootPath,
                    fallbackTotal: stat.fallbackTotal,
                    fallbackMatched: stat.fallbackMatched,
                })),
            });
        }
        const candidates = Array.from(candidateByKey.values());
        if (!candidates.length) {
            logMessage("WARN", "pickLocalFileForCompareEnhanced: no candidates", {
                opId: pickOpId,
                relPath,
                normalizedRelPath,
                targetFileName,
                uniqueCandidateCount: candidateByKey.size,
                duplicateCandidateCount,
            });
            throw new Error(`当前可搜索目录未找到同名本地文件: ${targetFileName || relPath}`);
        }
        const findSearchRootForFile = (filePath) => {
            const normalizedFile = normalizeSlashes(path.normalize(filePath)).toLowerCase();
            let matched;
            for (const root of searchRoots) {
                if (normalizedFile === root.key || normalizedFile.startsWith(`${root.key}/`)) {
                    if (!matched || root.key.length > matched.key.length) {
                        matched = root;
                    }
                }
            }
            return matched;
        };
        const normalizedRelLower = normalizedRelPath.toLowerCase();
        const picks = candidates.map((uri) => {
            const filePath = path.normalize(uri.fsPath);
            const fileKey = normalizeSlashes(filePath).toLowerCase();
            const workspace = vscode.workspace.getWorkspaceFolder(uri);
            const searchRoot = findSearchRootForFile(filePath);
            const relInWorkspace = workspace
                ? normalizeSlashes(path.relative(workspace.uri.fsPath, filePath))
                : "";
            const relInSearchRoot = searchRoot
                ? normalizeSlashes(path.relative(searchRoot.rootPath, filePath))
                : "";
            const displayRelPath = relInSearchRoot || relInWorkspace || normalizeSlashes(filePath);
            const relLower = displayRelPath.toLowerCase();
            const fileNameLower = path.basename(filePath).toLowerCase();
            let score = 4;
            if (normalizedRelLower && relLower === normalizedRelLower) {
                score = 0;
            }
            else if (normalizedRelLower &&
                relLower.endsWith(`/${normalizedRelLower}`)) {
                score = 1;
            }
            else if (targetFileName && fileNameLower === targetFileName) {
                score = 2;
            }
            else {
                score = 3;
            }
            const detailParts = [];
            if (workspace?.name) {
                detailParts.push(workspace.name);
            }
            const rootLabel = searchRoot?.label || candidateRootLabelByKey.get(fileKey);
            if (rootLabel && !detailParts.includes(rootLabel)) {
                detailParts.push(rootLabel);
            }
            if (!detailParts.length) {
                detailParts.push("工作区外");
            }
            return {
                label: path.basename(filePath),
                description: displayRelPath,
                detail: detailParts.join(" | "),
                fsPath: filePath,
                score,
                sortKey: `${detailParts.join("|")}/${displayRelPath}`.toLowerCase(),
            };
        });
        picks.sort((a, b) => {
            if (a.score !== b.score)
                return a.score - b.score;
            return a.sortKey.localeCompare(b.sortKey);
        });
        logMessage("INFO", "pickLocalFileForCompareEnhanced: quickPick ready", {
            opId: pickOpId,
            candidateCount: candidates.length,
            pickCount: picks.length,
            duplicateCandidateCount,
            topPicks: picks.slice(0, 20).map((pick) => ({
                score: pick.score,
                label: pick.label,
                description: pick.description,
                detail: pick.detail,
                fsPath: pick.fsPath,
            })),
        });
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: `${sideLabel}：选择本地文件（文件名：${targetFileName || relPath}）`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return picked?.fsPath;
    }
    function buildCompareRevUri(relPath, target, rev) {
        const safeRelPath = relPath.replace(/\\/g, "/");
        return vscode.Uri.from({
            scheme: SVN_REV_COMPARE_SCHEME,
            path: `/${safeRelPath}`,
            query: `target=${encodeURIComponent(target)}&rev=${encodeURIComponent(rev)}`,
        });
    }
    function formatLocalFileLabel(filePath) {
        const uri = vscode.Uri.file(filePath);
        const workspace = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspace) {
            return filePath;
        }
        const rel = normalizeSlashes(path.relative(workspace.uri.fsPath, filePath));
        return `${workspace.name}/${rel}`;
    }
    function formatCompareSideLabel(selection) {
        if (selection.source === "local") {
            if (!selection.localFilePath) {
                return "本地";
            }
            return `本地 ${formatLocalFileLabel(selection.localFilePath)}`;
        }
        if (!selection.rev) {
            return formatCompareSourceLabel(selection.source);
        }
        return `${formatCompareSourceLabel(selection.source)} ${formatRevLabel(selection.rev)}`;
    }
    function buildCompareSideUri(relPath, selection) {
        if (selection.source === "local") {
            if (!selection.localFilePath) {
                throw new Error("本地文件未选择");
            }
            return vscode.Uri.file(selection.localFilePath);
        }
        if (!selection.rev) {
            throw new Error(`${formatCompareSourceLabel(selection.source)}版本未选择`);
        }
        return buildCompareRevUri(relPath, selection.source, selection.rev);
    }
    async function openCompareDiffForPath(relPath, leftSelection, rightSelection) {
        const left = buildCompareSideUri(relPath, leftSelection);
        const right = buildCompareSideUri(relPath, rightSelection);
        const safeRelPath = relPath.replace(/\\/g, "/");
        const title = `${safeRelPath} (左:${formatCompareSideLabel(leftSelection)} -> 右:${formatCompareSideLabel(rightSelection)})`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
    }
    async function compareFileHistory(item) {
        const relPath = resolveCompareFilePath(item);
        if (!relPath) {
            vscode.window.showErrorMessage("未识别到文件路径，请在文件项上右键触发");
            return;
        }
        const leftTarget = await pickCompareSource("选择左侧来源（分支/主线）");
        if (!leftTarget)
            return;
        let leftRev;
        try {
            leftRev = await pickFileRevisionForCompare(relPath, leftTarget, "左侧");
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
            return;
        }
        if (!leftRev)
            return;
        const defaultRight = leftTarget === "branch" ? "trunk" : "branch";
        const rightTarget = await pickCompareSource("选择右侧来源（分支/主线）", defaultRight);
        if (!rightTarget)
            return;
        let rightRev;
        try {
            rightRev = await pickFileRevisionForCompare(relPath, rightTarget, "右侧");
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
            return;
        }
        if (!rightRev)
            return;
        try {
            await openCompareRevDiffForPath(relPath, leftTarget, leftRev, rightTarget, rightRev);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function compareFileHistoryV2(item) {
        const relPath = resolveCompareFilePath(item);
        if (!relPath) {
            vscode.window.showErrorMessage("未识别到文件路径，请在文件项上右键触发");
            return;
        }
        const leftSource = await pickCompareSource("选择左侧来源（分支/主线/本地）");
        if (!leftSource)
            return;
        let leftSelection;
        try {
            if (leftSource === "local") {
                const localFilePath = await pickLocalFileForCompare(relPath, "左侧");
                if (!localFilePath)
                    return;
                leftSelection = {
                    source: "local",
                    localFilePath,
                };
            }
            else {
                const leftRev = await pickFileRevisionForCompare(relPath, leftSource, "左侧");
                if (!leftRev)
                    return;
                leftSelection = {
                    source: leftSource,
                    rev: leftRev,
                };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
            return;
        }
        const defaultRight = leftSource === "branch"
            ? "trunk"
            : leftSource === "trunk"
                ? "branch"
                : "branch";
        const rightSource = await pickCompareSource("选择右侧来源（分支/主线/本地）", defaultRight);
        if (!rightSource)
            return;
        let rightSelection;
        try {
            if (rightSource === "local") {
                const localFilePath = await pickLocalFileForCompare(relPath, "右侧");
                if (!localFilePath)
                    return;
                rightSelection = {
                    source: "local",
                    localFilePath,
                };
            }
            else {
                const rightRev = await pickFileRevisionForCompare(relPath, rightSource, "右侧");
                if (!rightRev)
                    return;
                rightSelection = {
                    source: rightSource,
                    rev: rightRev,
                };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
            return;
        }
        try {
            await openCompareDiffForPath(relPath, leftSelection, rightSelection);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
    async function showRevFileHistory(item) {
        if (!item) {
            vscode.window.showErrorMessage("未选择文件");
            return;
        }
        if (!revState) {
            vscode.window.showErrorMessage("尚未运行提交范围变更");
            return;
        }
        let entries = [];
        try {
            entries = await ensureFileLogEntries(item.relPath);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
            return;
        }
        if (!entries.length) {
            vscode.window.showInformationMessage("该文件在范围内无提交记录");
            return;
        }
        const picks = entries.map((entry, index) => {
            const message = formatLogMessage(entry.message);
            const detailParts = [];
            if (entry.author)
                detailParts.push(entry.author);
            const dateText = formatLogDate(entry.date);
            if (dateText)
                detailParts.push(dateText);
            return {
                label: `r${entry.revision}`,
                description: message || "",
                detail: detailParts.join(" · "),
                index,
            };
        });
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: "选择要查看的修订（将与前一条修订对比）",
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked)
            return;
        const current = entries[picked.index];
        const previous = entries[picked.index + 1];
        if (!previous) {
            vscode.window.showInformationMessage("已是最早修订，无法与前一条对比");
            return;
        }
        await openRevDiffForPath(item.relPath, previous.revision, current.revision);
    }
    context.subscriptions.push(vscode.commands.registerCommand("svnMergeAnnotator.runRevRange", runRevRange), vscode.commands.registerCommand("svnMergeAnnotator.refreshRevChanges", refreshRevChanges), vscode.commands.registerCommand("svnMergeAnnotator.setRevGroupMode", setRevGroupMode), vscode.commands.registerCommand("svnMergeAnnotator.setRevChangeFilter", setRevChangeFilter), vscode.commands.registerCommand("svnMergeAnnotator.compareDiffs", compareDiffs), vscode.commands.registerCommand("svnMergeAnnotator.refreshDiffCompare", refreshDiffCompare), vscode.commands.registerCommand("svnMergeAnnotator.openRevDiff", openRevDiff), vscode.commands.registerCommand("svnMergeAnnotator.openRevMergeFile", openRevMergeFile), vscode.commands.registerCommand("svnMergeAnnotator.applyRevChangeToMerge", applyRevChangeToMerge), vscode.commands.registerCommand("svnMergeAnnotator.openMergeAtDiffLine", openMergeAtDiffLine), vscode.commands.registerCommand("svnMergeAnnotator.openMergeByHunkContext", openMergeByHunkContext), vscode.commands.registerCommand("svnMergeAnnotator.copyRevHunkDebugLog", copyRevHunkDebugLog), vscode.commands.registerCommand("svnMergeAnnotator.applyRevHunkToMerge", applyRevHunkToMerge), vscode.commands.registerCommand("svnMergeAnnotator.openMergeBySelection", openMergeBySelection), vscode.commands.registerCommand("svnMergeAnnotator.setRootPath", setRootPath), vscode.commands.registerCommand("svnMergeAnnotator.copyRootPath", copyRootPath), vscode.commands.registerCommand("svnMergeAnnotator.clearRootPath", clearRootPath), vscode.commands.registerCommand("svnMergeAnnotator.showRevFileHistory", showRevFileHistory), vscode.commands.registerCommand("svnMergeAnnotator.compareFileHistory", compareFileHistoryV2), vscode.commands.registerCommand("svnMergeAnnotator.showLogs", () => {
        output.show(true);
    }));
}
function deactivate() {
    return;
}
async function pickFolder(prompt, canSkip = false, defaultPath) {
    const options = {
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: canSkip ? "选择或取消" : "选择",
        title: prompt,
    };
    if (defaultPath) {
        options.defaultUri = vscode.Uri.file(defaultPath);
    }
    const result = await vscode.window.showOpenDialog(options);
    if (!result || result.length === 0) {
        return canSkip ? "" : undefined;
    }
    return result[0].fsPath;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=extension.js.map
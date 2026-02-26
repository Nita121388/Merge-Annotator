import * as vscode from "vscode";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as child_process from "child_process";
import { URL } from "url";

type AnalysisRoots = {
  branch?: string;
  trunk?: string;
  merge?: string;
  base?: string;
};

type FileSummary = {
  path: string;
  total_lines: number;
  has_changes?: boolean;
  file_origin?: string;
  error?: string;
};

type LineMeta = {
  merge_no: number;
  origin: string;
  branch_no?: number | null;
  trunk_no?: number | null;
  base_no?: number | null;
};

type AIExplain = {
  merge_reason?: string;
  reason?: string;
  impact?: string;
  risk?: string;
  note?: string;
  source?: string;
  updated_at?: string;
};

type BlockDiff = {
  merge?: string;
  branch?: string;
  trunk?: string;
};

type BlockConflict = {
  note?: string;
  left_preview?: string[];
  right_preview?: string[];
  left_count?: number;
  right_count?: number;
};

type Block = {
  start: number;
  end: number;
  origin: string;
  branch_start?: number;
  branch_end?: number;
  trunk_start?: number;
  trunk_end?: number;
  base_start?: number;
  base_end?: number;
  ai_explain?: AIExplain;
  diff?: BlockDiff;
  conflict?: BlockConflict;
};

type FileDetail = {
  path: string;
  line_meta: LineMeta[];
  blocks: Block[];
};

type FilesResponse = {
  files: FileSummary[];
  roots?: AnalysisRoots;
};

type FileSummaryStat = {
  path: string;
  block_total: number;
  annotated_blocks: number;
  risk_blocks: number;
  manual_blocks: number;
  conflict_blocks: number;
  has_annotated?: boolean;
  has_risk?: boolean;
};

type SummaryTotals = {
  file_total: number;
  file_annotated: number;
  file_risk: number;
  block_total: number;
  block_annotated: number;
  block_risk: number;
  block_manual: number;
  block_conflict: number;
};

type SummaryResponse = {
  files: FileSummaryStat[];
  totals?: SummaryTotals;
};

type StatusResponse = {
  state?: string;
  total?: number;
  current?: number;
  percent?: number;
  path?: string;
  message?: string;
};

type AnalyzeResponse = {
  analysis_id: string;
  state?: string;
};

type JumpTarget = "branch" | "trunk" | "base" | "merge";

type HistoryItem = {
  id: string;
  created_at?: string;
  finished_at?: string;
  state?: string;
  roots?: AnalysisRoots;
  file_count?: number;
  error?: string;
  available?: boolean;
};

type HistoryResponse = {
  items: HistoryItem[];
};

type AnnotationFilter = "all" | "annotated" | "unannotated" | "risk";

type NotesGroupBy = "file" | "origin" | "risk";

type BackendStatus = "unknown" | "starting" | "running" | "stopped" | "error";

type LastDirs = {
  branch: string;
  trunk: string;
  merge: string;
  base?: string;
};

type AIAnnotateItem = {
  path: string;
  start: number;
  end: number;
  explain: AIExplain;
};

type AIAnnotateRequest = {
  analysis_id: string;
  items: AIAnnotateItem[];
};

type EngineConfig = {
  api_base?: string;
  ui_base?: string;
  engine_root?: string;
  start_command?: string;
  updated_at?: string;
};

type RevRangeTarget = "branch" | "trunk";
type RevGroupMode = "dir1" | "dir2" | "commit";
type RevChangeFilter = "all" | "A" | "M" | "D";

type RevChangeItem = {
  status: string;
  path: string;
};

type RevLogEntry = {
  revision: string;
  author?: string;
  date?: string;
  message?: string;
  items: RevChangeItem[];
};

type RevFileLogEntry = {
  revision: string;
  author?: string;
  date?: string;
  message?: string;
};

type RootInfo = {
  rootPath: string;
  rootUrl: string;
  reposRoot?: string;
  rootSuffix?: string;
};

type RevChangeState = {
  target: RevRangeTarget;
  startRev: string;
  endRev: string;
  root: RootInfo;
  diffItems: RevChangeItem[];
  logEntries?: RevLogEntry[];
};

const LAST_DIRS_KEY = "lastDirs";
const LAST_ANALYSIS_ID_KEY = "lastAnalysisId";
const REV_RANGE_KEY = "revRangeState";

class BackendClient {
  private baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async analyze(payload: Record<string, unknown>): Promise<AnalyzeResponse> {
    return requestJson("POST", `${this.baseUrl}/api/analyze`, payload);
  }

  async status(analysisId: string): Promise<StatusResponse> {
    return requestJson(
      "GET",
      `${this.baseUrl}/api/status?analysis_id=${encodeURIComponent(analysisId)}`
    );
  }

  async files(analysisId: string): Promise<FilesResponse> {
    return requestJson(
      "GET",
      `${this.baseUrl}/api/files?analysis_id=${encodeURIComponent(analysisId)}`
    );
  }

  async summary(analysisId: string): Promise<SummaryResponse> {
    return requestJson(
      "GET",
      `${this.baseUrl}/api/summary?analysis_id=${encodeURIComponent(analysisId)}`
    );
  }

  async file(analysisId: string, relPath: string): Promise<FileDetail> {
    return requestJson(
      "GET",
      `${this.baseUrl}/api/file?analysis_id=${encodeURIComponent(
        analysisId
      )}&path=${encodeURIComponent(relPath)}`
    );
  }

  async history(limit?: number): Promise<HistoryResponse> {
    const query = limit ? `?limit=${limit}` : "";
    return requestJson("GET", `${this.baseUrl}/api/history${query}`);
  }

  async annotate(payload: AIAnnotateRequest): Promise<any> {
    return requestJson("POST", `${this.baseUrl}/api/ai/annotate`, payload);
  }
}

class FileItem extends vscode.TreeItem {
  relPath: string;
  constructor(summary: FileSummary, label?: string, stats?: FileSummaryStat) {
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
        descriptionParts.push(
          `批注${stats.annotated_blocks}/${stats.block_total}`
        );
      } else {
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
  relPath: string;
  children: Array<FileItem | DirectoryItem> = [];
  childDirs: Map<string, DirectoryItem> = new Map();
  fileCount = 0;
  annotatedCount = 0;
  riskCount = 0;
  constructor(label: string, relPath: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.relPath = relPath;
    this.contextValue = "dir";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class LegendRowItem extends vscode.TreeItem {
  constructor(label: string, description: string, iconPath?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "legendRow";
    if (iconPath) {
      this.iconPath = iconPath;
    }
  }
}

class LegendGroupItem extends vscode.TreeItem {
  children: LegendRowItem[];
  constructor(context: vscode.ExtensionContext) {
    super("颜色图例", vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "legendGroup";
    this.iconPath = new vscode.ThemeIcon("symbol-color");
    const iconBase = context.asAbsolutePath(path.join("resources", "icons"));
    const manualIcon = context.asAbsolutePath(
      path.join("resources", "icons", "manual.svg")
    );
    const conflictIcon = context.asAbsolutePath(
      path.join("resources", "icons", "conflict.svg")
    );
    this.children = [
      new LegendRowItem(
        "分支改动",
        "橙色",
        path.join(iconBase, "legend-branch.svg")
      ),
      new LegendRowItem(
        "主线改动",
        "蓝色",
        path.join(iconBase, "legend-trunk.svg")
      ),
      new LegendRowItem(
        "共同一致",
        "绿色",
        path.join(iconBase, "legend-common.svg")
      ),
      new LegendRowItem(
        "手工调整",
        "紫色",
        path.join(iconBase, "legend-manual.svg")
      ),
      new LegendRowItem(
        "冲突块",
        "红色",
        path.join(iconBase, "legend-conflict.svg")
      ),
      new LegendRowItem(
        "未知归属",
        "灰色",
        path.join(iconBase, "legend-unknown.svg")
      ),
      new LegendRowItem("Gutter 图标-手工批注", "manual", manualIcon),
      new LegendRowItem("Gutter 图标-冲突块", "conflict", conflictIcon),
    ];
  }
}

type TreeNode = FileItem | DirectoryItem | LegendGroupItem | LegendRowItem;

function splitRelPath(relPath: string) {
  return relPath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function normalizeRevStatus(status: string) {
  const upper = status.toUpperCase();
  if (upper === "A" || upper === "D") return upper;
  return "M";
}

function getRevStatusIcon(status: string) {
  const normalized = normalizeRevStatus(status);
  if (normalized === "A") {
    return new vscode.ThemeIcon("diff-added");
  }
  if (normalized === "D") {
    return new vscode.ThemeIcon("diff-removed");
  }
  return new vscode.ThemeIcon("diff-modified");
}

function countRevItems(items: RevChangeItem[]) {
  let add = 0;
  let del = 0;
  let mod = 0;
  for (const item of items) {
    const normalized = normalizeRevStatus(item.status);
    if (normalized === "A") {
      add += 1;
    } else if (normalized === "D") {
      del += 1;
    } else {
      mod += 1;
    }
  }
  return { total: items.length, add, mod, del };
}

function formatRevCounts(counts: { total: number; add: number; mod: number; del: number }) {
  return `A${counts.add} M${counts.mod} D${counts.del}`;
}

function updateDirectoryDescription(dir: DirectoryItem) {
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

function buildFileTree(
  files: FileSummary[],
  summaryByPath?: Map<string, FileSummaryStat>
) {
  const root = new DirectoryItem("__root__", "");
  for (const summary of files) {
    const parts = splitRelPath(summary.path);
    const stats = summaryByPath?.get(summary.path);
    const annotatedFile = stats ? stats.annotated_blocks > 0 : false;
    const riskFile = stats ? stats.risk_blocks > 0 : false;
    if (!parts.length) {
      root.children.push(new FileItem(summary, undefined, stats));
      root.fileCount += 1;
      if (annotatedFile) root.annotatedCount += 1;
      if (riskFile) root.riskCount += 1;
      updateDirectoryDescription(root);
      continue;
    }
    let current = root;
    const dirStack: DirectoryItem[] = [root];
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
      if (annotatedFile) dir.annotatedCount += 1;
      if (riskFile) dir.riskCount += 1;
      updateDirectoryDescription(dir);
    }
  }
  return root.children;
}

class FileTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | void> =
    new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> =
    this._onDidChangeTreeData.event;

  private nodes: TreeNode[] = [];
  private legendNode: LegendGroupItem;

  constructor(context: vscode.ExtensionContext) {
    this.legendNode = new LegendGroupItem(context);
  }

  refresh(files: FileSummary[] = [], summaryByPath?: Map<string, FileSummaryStat>) {
    this.nodes = [this.legendNode, ...buildFileTree(files || [], summaryByPath)];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    if (!element) {
      return Promise.resolve(this.nodes);
    }
    if (element instanceof LegendGroupItem) {
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
  relPath: string;
  count: number;
  constructor(relPath: string, count: number) {
    super(relPath, vscode.TreeItemCollapsibleState.Collapsed);
    this.relPath = relPath;
    this.count = count;
    this.description = `${count}条`;
    this.tooltip = `${relPath}\n批注数: ${count}`;
    this.contextValue = "noteFile";
  }
}

class NoteBlockItem extends vscode.TreeItem {
  relPath: string;
  block: Block;
  constructor(relPath: string, block: Block, label?: string) {
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
  key: string;
  entries: Array<{ relPath: string; block: Block }> = [];
  constructor(key: string, count: number) {
    super(key, vscode.TreeItemCollapsibleState.Collapsed);
    this.key = key;
    this.description = `${count}条`;
    this.contextValue = "noteGroup";
  }
}

class NotesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  > = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private notesByFile: Map<string, Block[]> = new Map();
  private groupBy: NotesGroupBy = "file";
  private totalNotes = 0;
  private emptyMessage = "暂无批注";

  refresh(
    notesByFile: Map<string, Block[]>,
    totalNotes: number,
    emptyMessage?: string,
    groupBy?: NotesGroupBy
  ) {
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

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      if (this.groupBy === "file") {
        const items: NotesFileItem[] = [];
        const keys = Array.from(this.notesByFile.keys()).sort();
        for (const key of keys) {
          const blocks = this.notesByFile.get(key) || [];
          if (!blocks.length) continue;
          items.push(new NotesFileItem(key, blocks.length));
        }
        if (!items.length) {
          const placeholder = new vscode.TreeItem(this.emptyMessage);
          placeholder.contextValue = "notePlaceholder";
          return Promise.resolve([placeholder]);
        }
        return Promise.resolve(items);
      }
      const entries: Array<{ relPath: string; block: Block }> = [];
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
      const groupMap = new Map<string, Array<{ relPath: string; block: Block }>>();
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
          if (a.relPath === b.relPath) return a.block.start - b.block.start;
          return a.relPath.localeCompare(b.relPath);
        })
        .map(
          (entry) =>
            new NoteBlockItem(
              entry.relPath,
              entry.block,
              `${entry.relPath} · L${entry.block.start}-L${entry.block.end}`
            )
        );
      return Promise.resolve(items);
    }
    return Promise.resolve([]);
  }
}

class RevHeaderItem extends vscode.TreeItem {
  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "revHeader";
  }
}

class RevGroupItem extends vscode.TreeItem {
  children: vscode.TreeItem[] = [];
  constructor(label: string, description?: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = description;
    if (tooltip) {
      this.tooltip = tooltip;
    }
    this.contextValue = "revGroup";
  }
}

class RevFileItem extends vscode.TreeItem {
  relPath: string;
  status: string;
  constructor(relPath: string, status: string) {
    super(relPath, vscode.TreeItemCollapsibleState.None);
    this.relPath = relPath;
    this.status = status;
    this.description = status;
    this.tooltip = `${status} ${relPath}`;
    this.contextValue = "revFile";
    this.command = {
      command: "svnMergeAnnotator.openRevDiff",
      title: "打开差异",
      arguments: [this],
    };
    this.iconPath = getRevStatusIcon(status);
  }
}

class RevChangeTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  > = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private nodes: vscode.TreeItem[] = [];

  refresh(nodes: vscode.TreeItem[]) {
    this.nodes = nodes;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve(this.nodes);
    }
    if (element instanceof RevGroupItem) {
      return Promise.resolve(element.children);
    }
    return Promise.resolve([]);
  }
}

class DecorationManager {
  private types: Record<string, vscode.TextEditorDecorationType>;
  private gutterTypes: Record<string, vscode.TextEditorDecorationType>;
  constructor(context: vscode.ExtensionContext) {
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
    const manualIcon = context.asAbsolutePath(
      path.join("resources", "icons", "manual.svg")
    );
    const conflictIcon = context.asAbsolutePath(
      path.join("resources", "icons", "conflict.svg")
    );
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

  apply(
    editor: vscode.TextEditor,
    lineMeta: LineMeta[],
    blocks: Block[] | undefined,
    showCommon: boolean,
    showOnlyRisk: boolean
  ) {
    const doc = editor.document;
    const rangesByOrigin: Record<string, vscode.Range[]> = {
      branch: [],
      trunk: [],
      common: [],
      manual: [],
      conflict: [],
      unknown: [],
    };

    const grouped: Record<string, number[]> = {
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

    const manualGutters = buildGutterRanges(
      blocks,
      "manual",
      riskLineSet,
      doc.lineCount
    );
    const conflictGutters = buildGutterRanges(
      blocks,
      "conflict",
      riskLineSet,
      doc.lineCount
    );
    editor.setDecorations(this.gutterTypes.manual, manualGutters);
    editor.setDecorations(this.gutterTypes.conflict, conflictGutters);
  }
}

type AnalysisState = {
  analysisId?: string;
  roots?: AnalysisRoots;
  allFiles: FileSummary[];
  files: FileSummary[];
  fileDetailByPath: Map<string, FileDetail>;
  fileDetailByRelPath: Map<string, FileDetail>;
  notesByRelPath: Map<string, Block[]>;
  notesLoaded: boolean;
  notesLoading: boolean;
  annotationIndex: Map<string, boolean>;
  annotationIndexLoaded: boolean;
  annotationIndexLoading: boolean;
  summaryByPath: Map<string, FileSummaryStat>;
  summaryLoaded: boolean;
  summaryLoading: boolean;
};

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("svnMergeAnnotator").get(key, fallback);
}

async function requestJson(
  method: string,
  urlStr: string,
  payload?: Record<string, unknown>
): Promise<any> {
  const url = new URL(urlStr);
  const data = payload ? Buffer.from(JSON.stringify(payload), "utf-8") : undefined;
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const options: http.RequestOptions = {
    method,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    headers: {
      "Content-Type": "application/json",
    },
  };
  if (data) {
    options.headers = { ...options.headers, "Content-Length": data.length };
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        let parsed: any = {};
        if (body) {
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            return reject(new Error("返回内容无法解析为 JSON"));
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          const detail = parsed?.detail || `请求失败: ${res.statusCode}`;
          return reject(new Error(detail));
        }
        resolve(parsed);
      });
    });
    req.on("error", (err) => reject(err));
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function buildLineRanges(lines: number[], totalLines: number): vscode.Range[] {
  if (!lines.length) return [];
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: vscode.Range[] = [];
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

function makeRange(startLine: number, endLine: number, totalLines: number) {
  const safeStart = Math.max(0, Math.min(startLine, totalLines - 1));
  const safeEnd = Math.max(0, Math.min(endLine + 1, totalLines));
  return new vscode.Range(
    new vscode.Position(safeStart, 0),
    new vscode.Position(safeEnd, 0)
  );
}

function buildGutterRanges(
  blocks: Block[] | undefined,
  origin: string,
  riskLineSet: Set<number> | null,
  totalLines: number
): vscode.Range[] {
  if (!blocks || blocks.length === 0) return [];
  const ranges: vscode.Range[] = [];
  for (const block of blocks) {
    if (block.origin !== origin) continue;
    const lineIndex = block.start - 1;
    if (lineIndex < 0 || lineIndex >= totalLines) continue;
    if (riskLineSet && !riskLineSet.has(lineIndex)) {
      continue;
    }
    ranges.push(makeRange(lineIndex, lineIndex, totalLines));
  }
  return ranges;
}

function buildRiskLineSet(blocks: Block[] | undefined): Set<number> {
  const set = new Set<number>();
  if (!blocks || blocks.length === 0) return set;
  for (const block of blocks) {
    if (!hasRisk(block.ai_explain)) continue;
    for (let i = block.start; i <= block.end; i += 1) {
      set.add(i - 1);
    }
  }
  return set;
}

function formatHover(block: Block): vscode.MarkdownString {
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
  } else {
    md.appendMarkdown(`- 暂无 AI 批注\n`);
  }
  return md;
}

function formatBlockDetailText(block: Block): string {
  const lines: string[] = [];
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
    if (ai.merge_reason) lines.push(`合并理由: ${ai.merge_reason}`);
    if (ai.reason) lines.push(`原因: ${ai.reason}`);
    if (ai.impact) lines.push(`影响: ${ai.impact}`);
    if (ai.risk) lines.push(`风险: ${ai.risk}`);
    if (ai.note) lines.push(`备注: ${ai.note}`);
    if (ai.source) lines.push(`来源: ${ai.source}`);
    if (ai.updated_at) lines.push(`更新时间: ${ai.updated_at}`);
  }
  return lines.join("\n");
}

function formatFileOrigin(origin?: string) {
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

function formatOriginLabel(origin?: string) {
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

function formatHistoryTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function isNewFileOrigin(origin?: string) {
  return origin === "branch_new" || origin === "trunk_new" || origin === "merge_only";
}

function hasExplain(ai?: AIExplain) {
  if (!ai) return false;
  return Boolean(
    ai.merge_reason ||
      ai.reason ||
      ai.impact ||
      ai.risk ||
      ai.note ||
      ai.source ||
      ai.updated_at
  );
}

function hasRisk(ai?: AIExplain) {
  if (!ai || !ai.risk) return false;
  return ai.risk.trim().length > 0;
}

function buildNoteTitle(block: Block) {
  const ai = block.ai_explain;
  if (!ai) return `未批注 · ${formatOriginLabel(block.origin)}`;
  if (ai.merge_reason) return `合并理由: ${ai.merge_reason}`;
  if (ai.reason) return `原因: ${ai.reason}`;
  if (ai.risk) return `风险: ${ai.risk}`;
  if (ai.note) return `备注: ${ai.note}`;
  return "AI批注";
}

function buildNoteBaseLines(relPath: string, block: Block) {
  const lines: string[] = [];
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

function appendAiLines(lines: string[], ai?: AIExplain) {
  if (!ai) {
    lines.push("AI批注: 暂无");
    return;
  }
  if (ai.merge_reason) lines.push(`合并理由: ${ai.merge_reason}`);
  if (ai.reason) lines.push(`原因: ${ai.reason}`);
  if (ai.impact) lines.push(`影响: ${ai.impact}`);
  if (ai.risk) lines.push(`风险: ${ai.risk}`);
  if (ai.note) lines.push(`备注: ${ai.note}`);
  if (ai.source) lines.push(`来源: ${ai.source}`);
  if (ai.updated_at) lines.push(`更新时间: ${ai.updated_at}`);
}

function extractSnippet(text: string | undefined, maxLines: number) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `... (共${lines.length}行)`];
}

function formatNoteCopyText(relPath: string, block: Block) {
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

function formatNoteTooltip(relPath: string, block: Block) {
  const lines = buildNoteBaseLines(relPath, block);
  const snippet = extractSnippet(block.diff?.merge, 6);
  if (snippet.length) {
    lines.push("合并片段:");
    lines.push(...snippet);
  }
  appendAiLines(lines, block.ai_explain);
  return lines.join("\n");
}

function extractNotes(detail: FileDetail): Block[] {
  if (!detail?.blocks) return [];
  const includeAll = getConfig("notesIncludeAllBlocks", true);
  if (includeAll) return detail.blocks;
  return detail.blocks.filter((block) => hasExplain(block.ai_explain));
}

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new FileTreeProvider(context);
  const notesProvider = new NotesTreeProvider();
  const revProvider = new RevChangeTreeProvider();
  const decorations = new DecorationManager(context);
  const output = vscode.window.createOutputChannel("SVN Merge Annotator");
  const state: AnalysisState = {
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
  let revState: RevChangeState | undefined;
  const revRootCache = new Map<RevRangeTarget, RootInfo>();
  const revFileLogCache = new Map<string, RevFileLogEntry[]>();
  let backendProcess: child_process.ChildProcess | undefined;
  let backendStartInProgress = false;
  let backendManaged = false;
  let backendStatus: BackendStatus = "unknown";
  let backendHealthTimer: NodeJS.Timeout | undefined;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = "svnMergeAnnotator.backendActions";
  statusBar.text = "$(question) Backend: 未知";
  statusBar.tooltip = "点击管理后端服务";
  statusBar.show();

  const filesView = vscode.window.createTreeView("svnMergeAnnotator.files", {
    treeDataProvider: treeProvider,
  });
  const notesView = vscode.window.createTreeView("svnMergeAnnotator.notes", {
    treeDataProvider: notesProvider,
  });
  const revView = vscode.window.createTreeView("svnMergeAnnotator.revChanges", {
    treeDataProvider: revProvider,
  });
  context.subscriptions.push(filesView, notesView, revView, output, statusBar);

  const revContentProvider: vscode.TextDocumentContentProvider = {
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
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("svnrev", revContentProvider)
  );

  function logMessage(
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    detail?: Record<string, unknown>
  ) {
    const enabled = getConfig("debugLogging", true);
    if (!enabled) return;
    const timestamp = new Date().toISOString();
    const suffix = detail ? ` | ${JSON.stringify(detail)}` : "";
    output.appendLine(`[${timestamp}] [${level}] ${message}${suffix}`);
  }

  function getLocalAppData() {
    const local = process.env.LOCALAPPDATA;
    if (local) return local;
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      return path.join(userProfile, "AppData", "Local");
    }
    return undefined;
  }

  function getEngineConfigPath() {
    const local = getLocalAppData();
    if (!local) return undefined;
    return path.join(local, "svn-merge-annotator", "engine", "engine.json");
  }

  function readEngineConfig(): EngineConfig | undefined {
    const configPath = getEngineConfigPath();
    if (!configPath || !fs.existsSync(configPath)) return undefined;
    try {
      const raw = fs.readFileSync(configPath, "utf-8").trim();
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return undefined;
      const config: EngineConfig = {};
      if (typeof parsed.api_base === "string") config.api_base = parsed.api_base;
      if (typeof parsed.ui_base === "string") config.ui_base = parsed.ui_base;
      if (typeof parsed.engine_root === "string")
        config.engine_root = parsed.engine_root;
      if (typeof parsed.start_command === "string")
        config.start_command = parsed.start_command;
      if (typeof parsed.updated_at === "string")
        config.updated_at = parsed.updated_at;
      return config;
    } catch (err) {
      logMessage("WARN", "engine.json 读取失败", { error: String(err) });
      return undefined;
    }
  }

  function writeEngineConfig(next: EngineConfig) {
    const configPath = getEngineConfigPath();
    if (!configPath) return;
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const payload = {
        api_base: next.api_base || "",
        ui_base: next.ui_base || "",
        engine_root: next.engine_root || "",
        start_command: next.start_command || "",
        updated_at: next.updated_at || new Date().toISOString(),
      };
      fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      logMessage("WARN", "engine.json 写入失败", { error: String(err) });
    }
  }

  function getBackendUrl() {
    const engineConfig = readEngineConfig();
    const fromEngine = (engineConfig?.api_base || "").trim();
    const fallback = (getConfig("backendUrl", "http://localhost:18000") || "")
      .trim();
    const url = fromEngine || fallback;
    return url.replace(/\/+$/, "");
  }

  function setBackendStatus(status: BackendStatus, detail?: string) {
    backendStatus = status;
    let text = "$(question) Backend: 未知";
    switch (status) {
      case "starting":
        text = "$(sync~spin) Backend: 启动中";
        break;
      case "running":
        text = "$(play-circle) Backend: 运行中";
        break;
      case "stopped":
        text = "$(circle-slash) Backend: 未启动";
        break;
      case "error":
        text = "$(error) Backend: 异常";
        break;
      default:
        break;
    }
    statusBar.text = text;
    const url = getBackendUrl();
    const extra = detail ? `\n${detail}` : "";
    statusBar.tooltip = `后端地址: ${url}${extra}`;
  }

  async function checkBackendHealth() {
    const url = `${getBackendUrl()}/api/health`;
    try {
      await requestJson("GET", url);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function refreshBackendStatus(silent = true) {
    if (backendStartInProgress) return;
    const ok = await checkBackendHealth();
    if (ok) {
      setBackendStatus("running");
    } else {
      setBackendStatus("stopped");
    }
    if (!silent) {
      const message = ok ? "后端已在运行" : "后端未启动";
      vscode.window.showInformationMessage(message);
    }
  }

  async function resolveBackendRoot(allowPick: boolean) {
    const engineConfig = readEngineConfig();
    const engineRoot = (engineConfig?.engine_root || "").trim();
    if (engineRoot) {
      return engineRoot;
    }
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    let backendRoot = (config.get<string>("backendRoot", "") || "").trim();
    if (!backendRoot && allowPick) {
      const picked = await pickFolder("选择后端目录（backend）", false);
      if (!picked) {
        return undefined;
      }
      backendRoot = picked;
      await config.update(
        "backendRoot",
        backendRoot,
        vscode.ConfigurationTarget.Global
      );
    }
    return backendRoot || undefined;
  }

  async function openBackendLogs() {
    output.show(true);
    const backendRoot = await resolveBackendRoot(false);
    if (!backendRoot) {
      vscode.window.showInformationMessage("未配置后端目录，无法定位日志文件");
      return;
    }
    const outPath = path.join(backendRoot, "uvicorn.out.log");
    const errPath = path.join(backendRoot, "uvicorn.err.log");
    const candidates = [outPath, errPath];
    let opened = false;
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      opened = true;
    }
    if (!opened) {
      vscode.window.showInformationMessage("未发现后端日志文件");
    }
  }

  async function backendActions() {
    const actions: Array<{ label: string; value: string; detail?: string }> = [];
    if (backendStatus !== "running") {
      actions.push({ label: "启动后端", value: "start" });
    }
    if (backendStatus === "running") {
      actions.push({ label: "重启后端", value: "restart" });
      actions.push({ label: "停止后端", value: "stop" });
    }
    actions.push({ label: "打开后端日志", value: "logs" });
    actions.push({ label: "打开设置", value: "settings" });
    const pick = await vscode.window.showQuickPick(actions, {
      placeHolder: "选择后端操作",
    });
    if (!pick) return;
    if (pick.value === "start") {
      await startBackend();
      return;
    }
    if (pick.value === "restart") {
      await restartBackend();
      return;
    }
    if (pick.value === "stop") {
      await stopBackend();
      return;
    }
    if (pick.value === "logs") {
      await openBackendLogs();
      return;
    }
    if (pick.value === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "svnMergeAnnotator"
      );
    }
  }

  async function stopBackend() {
    if (backendStartInProgress) {
      vscode.window.showInformationMessage("后端正在启动中，稍后再试");
      return;
    }
    if (backendManaged && backendProcess && backendProcess.exitCode === null) {
      const proc = backendProcess;
      setBackendStatus("stopped");
      proc.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 3000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      backendManaged = false;
      vscode.window.showInformationMessage("后端已停止");
      return;
    }
    const running = await checkBackendHealth();
    if (running) {
      setBackendStatus("running");
      vscode.window.showWarningMessage("后端非插件托管，无法自动停止");
      return;
    }
    setBackendStatus("stopped");
    vscode.window.showInformationMessage("后端未运行");
  }

  async function restartBackend() {
    const running = await checkBackendHealth();
    if (backendManaged && backendProcess && backendProcess.exitCode === null) {
      await stopBackend();
      await startBackend();
      return;
    }
    if (running && !backendManaged) {
      vscode.window.showWarningMessage("后端非插件托管，无法自动重启");
      return;
    }
    await startBackend();
  }

  async function startBackend() {
    if (backendStartInProgress) {
      vscode.window.showInformationMessage("后端正在启动中");
      return;
    }
    backendStartInProgress = true;
    setBackendStatus("starting");
    output.show(true);
    try {
      const alreadyRunning = await checkBackendHealth();
      if (alreadyRunning) {
        setBackendStatus("running");
        vscode.window.showInformationMessage("后端已在运行");
        return;
      }

      const backendRoot = await resolveBackendRoot(true);
      if (!backendRoot) {
        setBackendStatus("stopped");
        return;
      }
      if (!fs.existsSync(backendRoot)) {
        setBackendStatus("error", "后端目录不存在");
        vscode.window.showErrorMessage("后端目录不存在，请检查配置");
        return;
      }

      const engineConfig: EngineConfig = readEngineConfig() || {};
      const customCommand = (getConfig("backendStartCommand", "") || "").trim();
      const engineCommand = (engineConfig.start_command || "").trim();
      let command = customCommand || engineCommand;
      let useScript = false;
      if (!command) {
        if (process.platform === "win32") {
          const scriptPath = path.join(backendRoot, "scripts", "run_backend.ps1");
          if (fs.existsSync(scriptPath)) {
            command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
            useScript = true;
          }
        }
        if (!command) {
          command =
            "python -m uvicorn app.main:app --host 0.0.0.0 --port 18000";
        }
      }

      const rawBackendUrl = (getConfig("backendUrl", "http://localhost:18000") ||
        "").trim();
      const apiBase =
        rawBackendUrl || (engineConfig.api_base || "").trim() || "http://localhost:18000";
      const uiBase =
        (engineConfig.ui_base || "").trim() || "http://localhost:5173";
      writeEngineConfig({
        ...engineConfig,
        engine_root: backendRoot,
        api_base: apiBase,
        ui_base: uiBase,
        start_command: command,
        updated_at: new Date().toISOString(),
      });

      logMessage("INFO", "startBackend: spawn", {
        command,
        cwd: backendRoot,
      });
      backendManaged = false;
      backendProcess = child_process.spawn(command, {
        shell: true,
        cwd: backendRoot,
        windowsHide: true,
      });
      backendProcess.stdout?.on("data", (data) => {
        output.appendLine(String(data).trimEnd());
      });
      backendProcess.stderr?.on("data", (data) => {
        output.appendLine(String(data).trimEnd());
      });
      backendProcess.on("exit", (code) => {
        logMessage("INFO", "startBackend: exit", { code });
        if (backendManaged) {
          setBackendStatus("stopped", "后端已退出");
        }
        backendManaged = false;
      });

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "启动后端服务",
          cancellable: true,
        },
        async (progress, token) => {
          const startTime = Date.now();
          const timeoutMs = 20000;
          while (Date.now() - startTime < timeoutMs) {
            if (token.isCancellationRequested) {
              vscode.window.showInformationMessage("已取消等待后端启动");
              return;
            }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            progress.report({ message: `等待后端就绪... ${elapsed}s` });
            if (await checkBackendHealth()) {
              const alive = backendProcess && backendProcess.exitCode === null;
              backendManaged = Boolean(alive) && !useScript;
              const note = backendManaged ? "（插件托管）" : "（非插件托管）";
              setBackendStatus("running", `后端已启动${note}`);
              vscode.window.showInformationMessage("后端已启动");
              return;
            }
            await delay(500);
          }
          setBackendStatus("error", "启动超时");
          const action = await vscode.window.showErrorMessage(
            "后端启动超时，请检查日志或设置",
            "打开日志",
            "打开设置"
          );
          if (action === "打开日志") {
            await openBackendLogs();
          } else if (action === "打开设置") {
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "svnMergeAnnotator"
            );
          }
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBackendStatus("error", message);
      vscode.window.showErrorMessage(`启动后端失败: ${message}`);
      logMessage("ERROR", "startBackend: failed", { error: message });
    } finally {
      backendStartInProgress = false;
    }
  }

  function normalizePath(value?: string) {
    if (!value) return "";
    let normalized = path.normalize(value);
    const root = path.parse(normalized).root;
    if (normalized !== root) {
      normalized = normalized.replace(/[\\\/]+$/, "");
    }
    return normalized.toLowerCase();
  }

  function isSamePath(a?: string, b?: string) {
    if (!a || !b) return false;
    return normalizePath(a) === normalizePath(b);
  }

  function sanitizeRoots(roots?: AnalysisRoots): AnalysisRoots {
    const result: AnalysisRoots = { ...(roots || {}) };
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

  context.subscriptions.push(
    notesView.onDidChangeVisibility(async (event) => {
      if (!event.visible) return;
      if (!state.analysisId) return;
      if (state.notesLoaded || state.notesLoading) return;
      await refreshNotes();
    })
  );

  function updateNotesBadge(total: number) {
    notesView.badge =
      total > 0 ? { value: total, tooltip: `${total}条批注` } : undefined;
  }

  function refreshNotesViewFromCache() {
    const allowed = new Set(state.files.map((item) => item.path));
    const filtered = new Map<string, Block[]>();
    let totalNotes = 0;
    for (const [relPath, blocks] of state.notesByRelPath.entries()) {
      if (!allowed.has(relPath)) continue;
      if (!blocks.length) continue;
      filtered.set(relPath, blocks);
      totalNotes += blocks.length;
    }
    const emptyMessage = state.notesLoaded
      ? "暂无批注"
      : "尚未生成批注（执行“刷新 Notes”）";
    notesProvider.refresh(filtered, totalNotes, emptyMessage, getNotesGroupBy());
    updateNotesBadge(totalNotes);
  }

  const hoverProvider = vscode.languages.registerHoverProvider({ scheme: "file" }, {
    provideHover(document, position) {
      const detail = state.fileDetailByPath.get(document.fileName);
      if (!detail) return;
      const lineNo = position.line + 1;
      const block = detail.blocks.find(
        (item) => lineNo >= item.start && lineNo <= item.end
      );
      if (!block) return;
      return new vscode.Hover(formatHover(block));
    },
  });
  context.subscriptions.push(hoverProvider);

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { scheme: "file" },
    {
      provideCodeLenses(document) {
        const detail = state.fileDetailByPath.get(document.fileName);
        if (!detail) return [];
        const lenses: vscode.CodeLens[] = [];
        for (const block of detail.blocks || []) {
          const lineIndex = Math.max(0, block.start - 1);
          const range = new vscode.Range(
            new vscode.Position(lineIndex, 0),
            new vscode.Position(lineIndex, 0)
          );
          lenses.push(
            new vscode.CodeLens(range, {
              title: "合并理由",
              command: "svnMergeAnnotator.showBlockDetail",
              arguments: [block, detail.path],
            })
          );
          lenses.push(
            new vscode.CodeLens(range, {
              title: "写入批注",
              command: "svnMergeAnnotator.annotateBlock",
              arguments: [block, detail.path],
            })
          );
          if (block.branch_start && state.roots?.branch) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: "跳转 Branch",
                command: "svnMergeAnnotator.jumpTo",
                arguments: ["branch", detail.path, block.branch_start],
              })
            );
          }
          if (block.trunk_start && state.roots?.trunk) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: "跳转 Trunk",
                command: "svnMergeAnnotator.jumpTo",
                arguments: ["trunk", detail.path, block.trunk_start],
              })
            );
          }
          if (block.base_start && state.roots?.base) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: "跳转 Base",
                command: "svnMergeAnnotator.jumpTo",
                arguments: ["base", detail.path, block.base_start],
              })
            );
          }
        }
        return lenses;
      },
    }
  );
  context.subscriptions.push(codeLensProvider);

  function applyDecorationsForEditor(
    editor: vscode.TextEditor,
    detail: FileDetail
  ) {
    const showCommon = getConfig("showCommonLines", false);
    const showOnlyRisk = getConfig("showOnlyRiskLines", false);
    decorations.apply(
      editor,
      detail.line_meta || [],
      detail.blocks,
      showCommon,
      showOnlyRisk
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const detail = state.fileDetailByPath.get(editor.document.fileName);
      if (!detail) return;
      applyDecorationsForEditor(editor, detail);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("svnMergeAnnotator.showCommonLines") ||
        event.affectsConfiguration("svnMergeAnnotator.showOnlyRiskLines")
      ) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const detail = state.fileDetailByPath.get(editor.document.fileName);
          if (detail) {
            applyDecorationsForEditor(editor, detail);
          }
        }
      }
      if (
        event.affectsConfiguration("svnMergeAnnotator.showOnlyChangedFiles") ||
        event.affectsConfiguration("svnMergeAnnotator.hideNewFiles") ||
        event.affectsConfiguration("svnMergeAnnotator.annotationFilter")
      ) {
        applyFileFilters();
      }
      if (event.affectsConfiguration("svnMergeAnnotator.notesGroupBy")) {
        refreshNotesViewFromCache();
      }
      if (
        event.affectsConfiguration("svnMergeAnnotator.revGroupMode") ||
        event.affectsConfiguration("svnMergeAnnotator.revChangeFilter")
      ) {
        void (async () => {
          if (getRevGroupMode() === "commit") {
            try {
              await ensureLogEntries();
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              vscode.window.showErrorMessage(message);
            }
          }
          refreshRevView();
        })();
      }
    })
  );

  function getAnnotationFilter(): AnnotationFilter {
    const value = getConfig<AnnotationFilter>("annotationFilter", "all");
    if (value === "annotated" || value === "unannotated" || value === "risk") {
      return value;
    }
    return "all";
  }

  function getNotesGroupBy(): NotesGroupBy {
    const value = getConfig<NotesGroupBy>("notesGroupBy", "file");
    if (value === "origin" || value === "risk") return value;
    return "file";
  }

  function getRevGroupMode(): RevGroupMode {
    const value = getConfig<RevGroupMode>("revGroupMode", "dir1");
    if (value === "dir2" || value === "commit") return value;
    return "dir1";
  }

  function getRevChangeFilter(): RevChangeFilter {
    const value = getConfig<RevChangeFilter>("revChangeFilter", "all");
    if (value === "A" || value === "M" || value === "D") return value;
    return "all";
  }

  function isAnnotatedDetail(detail: FileDetail) {
    return (detail.blocks || []).some((block) => hasExplain(block.ai_explain));
  }

  function buildSummaryStatFromDetail(detail: FileDetail): FileSummaryStat {
    const blocks = detail.blocks || [];
    let annotatedBlocks = 0;
    let riskBlocks = 0;
    let manualBlocks = 0;
    let conflictBlocks = 0;
    for (const block of blocks) {
      const ai = block.ai_explain;
      if (hasExplain(ai)) {
        annotatedBlocks += 1;
      }
      if (hasRisk(ai)) {
        riskBlocks += 1;
      }
      if (ai?.source === "manual") {
        manualBlocks += 1;
      }
      if (block.origin === "conflict") {
        conflictBlocks += 1;
      }
    }
    return {
      path: detail.path,
      block_total: blocks.length,
      annotated_blocks: annotatedBlocks,
      risk_blocks: riskBlocks,
      manual_blocks: manualBlocks,
      conflict_blocks: conflictBlocks,
      has_annotated: annotatedBlocks > 0,
      has_risk: riskBlocks > 0,
    };
  }

  function updateAnnotationIndexForDetail(relPath: string, detail: FileDetail) {
    const annotated = isAnnotatedDetail(detail);
    state.annotationIndex.set(relPath, annotated);
    if (state.summaryByPath.size) {
      state.summaryByPath.set(relPath, buildSummaryStatFromDetail(detail));
    }
    return annotated;
  }

  function resolveAnnotationStatus(relPath: string) {
    const summary = state.summaryByPath.get(relPath);
    if (summary) {
      return summary.annotated_blocks > 0;
    }
    if (state.annotationIndex.has(relPath)) {
      return state.annotationIndex.get(relPath);
    }
    const detail = state.fileDetailByRelPath.get(relPath);
    if (!detail) return undefined;
    return updateAnnotationIndexForDetail(relPath, detail);
  }

  function resolveRiskStatus(relPath: string) {
    const summary = state.summaryByPath.get(relPath);
    if (summary) {
      return summary.risk_blocks > 0;
    }
    const detail = state.fileDetailByRelPath.get(relPath);
    if (!detail) return undefined;
    return detail.blocks.some((block) => hasRisk(block.ai_explain));
  }

  function updateFilesViewMessage() {
    const annotationFilter = getAnnotationFilter();
    if (annotationFilter === "all") {
      filesView.message = undefined;
      return;
    }
    const label =
      annotationFilter === "annotated"
        ? "已批注"
        : annotationFilter === "unannotated"
          ? "未批注"
          : "仅风险";
    const suffix = state.annotationIndexLoading ? "（索引构建中）" : "";
    filesView.message = `批注筛选: ${label}${suffix}`;
  }

  async function refreshAnnotationIndex() {
    const annotationFilter = getAnnotationFilter();
    if (annotationFilter === "all") return;
    if (!state.analysisId) return;
    if (state.annotationIndexLoading) return;
    if (state.summaryLoaded && state.summaryByPath.size) {
      const nextIndex = new Map<string, boolean>();
      for (const [relPath, stat] of state.summaryByPath.entries()) {
        nextIndex.set(relPath, stat.annotated_blocks > 0);
      }
      state.annotationIndex = nextIndex;
      state.annotationIndexLoaded = true;
      updateFilesViewMessage();
      applyFileFilters();
      return;
    }
    const filesToScan = state.allFiles || [];
    if (!filesToScan.length) return;
    state.annotationIndexLoading = true;
    updateFilesViewMessage();
    const client = new BackendClient(getBackendUrl());
    const nextIndex = new Map<string, boolean>();
    const nextSummary = new Map<string, FileSummaryStat>();
    let cancelled = false;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "SVN Merge Annotator 构建批注索引",
          cancellable: true,
        },
        async (progress, token) => {
          const total = filesToScan.length;
          for (let i = 0; i < filesToScan.length; i += 1) {
            if (token.isCancellationRequested) {
              cancelled = true;
              break;
            }
            const file = filesToScan[i];
            progress.report({
              message: `${i + 1}/${total} ${file.path}`,
              increment: (1 / total) * 100,
            });
            const detail = await getFileDetail(file.path, client);
            const stat = buildSummaryStatFromDetail(detail);
            nextSummary.set(file.path, stat);
            nextIndex.set(file.path, stat.annotated_blocks > 0);
          }
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logMessage("ERROR", "refreshAnnotationIndex failed", { error: message });
      vscode.window.showErrorMessage(`构建批注索引失败: ${message}`);
      return;
    } finally {
      state.annotationIndexLoading = false;
    }
    if (cancelled) {
      for (const [key, value] of nextIndex.entries()) {
        state.annotationIndex.set(key, value);
      }
      for (const [key, value] of nextSummary.entries()) {
        state.summaryByPath.set(key, value);
      }
      state.annotationIndexLoaded = false;
      updateFilesViewMessage();
      return;
    }
    state.annotationIndex = nextIndex;
    state.annotationIndexLoaded = true;
    if (nextSummary.size) {
      state.summaryByPath = nextSummary;
      state.summaryLoaded = true;
    }
    updateFilesViewMessage();
    applyFileFilters();
  }

  function filterFiles(files: FileSummary[]) {
    const showOnlyChanged = getConfig("showOnlyChangedFiles", true);
    const hideNewFiles = getConfig("hideNewFiles", false);
    const annotationFilter = getAnnotationFilter();
    return files.filter((item) => {
      if (showOnlyChanged && !item.has_changes) return false;
      if (hideNewFiles && isNewFileOrigin(item.file_origin)) return false;
      if (annotationFilter === "risk") {
        const risk = resolveRiskStatus(item.path);
        if (risk === false) return false;
      } else if (annotationFilter !== "all") {
        const annotated = resolveAnnotationStatus(item.path);
        if (annotated !== undefined) {
          if (annotationFilter === "annotated" && !annotated) return false;
          if (annotationFilter === "unannotated" && annotated) return false;
        }
      }
      return true;
    });
  }

  function applyFileFilters() {
    const annotationFilter = getAnnotationFilter();
    if (
      annotationFilter !== "all" &&
      !state.annotationIndexLoaded &&
      !state.annotationIndexLoading
    ) {
      void refreshAnnotationIndex();
    }
    state.files = filterFiles(state.allFiles || []);
    treeProvider.refresh(state.files || [], state.summaryByPath);
    refreshNotesViewFromCache();
    updateFilesViewMessage();
  }

  async function loadSummary(analysisId: string, client: BackendClient) {
    if (state.summaryLoading) return;
    state.summaryLoading = true;
    try {
      const resp = await client.summary(analysisId);
      const nextMap = new Map<string, FileSummaryStat>();
      const nextIndex = new Map<string, boolean>();
      for (const item of resp.files || []) {
        if (!item?.path) continue;
        nextMap.set(item.path, item);
        nextIndex.set(item.path, item.annotated_blocks > 0);
      }
      state.summaryByPath = nextMap;
      state.summaryLoaded = true;
      state.annotationIndex = nextIndex;
      state.annotationIndexLoaded = true;
      updateFilesViewMessage();
      applyFileFilters();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logMessage("WARN", "loadSummary failed", { error: message });
    } finally {
      state.summaryLoading = false;
    }
  }

  async function loadFiles(analysisId: string, client: BackendClient) {
    logMessage("INFO", "loadFiles", { analysisId });
    const result = await client.files(analysisId);
    state.allFiles = result.files || [];
    state.roots = sanitizeRoots(result.roots || {});
    logMessage("INFO", "loadFiles: roots", {
      branch: state.roots.branch,
      trunk: state.roots.trunk,
      merge: state.roots.merge,
      base: state.roots.base,
    });
    const lastDirs = context.globalState.get<LastDirs>(LAST_DIRS_KEY);
    if (lastDirs) {
      if (!state.roots.branch && lastDirs.branch) {
        state.roots.branch = lastDirs.branch;
      }
      if (!state.roots.trunk && lastDirs.trunk) {
        state.roots.trunk = lastDirs.trunk;
      }
      if (!state.roots.merge && lastDirs.merge) {
        state.roots.merge = lastDirs.merge;
      }
      if (!state.roots.base && lastDirs.base) {
        state.roots.base = lastDirs.base;
      }
    }
    state.fileDetailByPath.clear();
    state.fileDetailByRelPath.clear();
    state.notesByRelPath.clear();
    state.notesLoaded = false;
    state.summaryByPath.clear();
    state.summaryLoaded = false;
    state.summaryLoading = false;
    state.annotationIndex.clear();
    state.annotationIndexLoaded = false;
    state.annotationIndexLoading = false;
    applyFileFilters();
    void loadSummary(analysisId, client);
    await updateHistory(analysisId);
    if (getConfig("autoLoadNotes", false)) {
      await refreshNotes();
    }
  }

  async function getFileDetail(relPath: string, client: BackendClient) {
    const cached = state.fileDetailByRelPath.get(relPath);
    if (cached) return cached;
    const detail = await client.file(state.analysisId || "", relPath);
    state.fileDetailByRelPath.set(relPath, detail);
    return detail;
  }

  function updateNotesCacheForDetail(relPath: string, detail: FileDetail) {
    const notes = extractNotes(detail);
    if (notes.length) {
      state.notesByRelPath.set(relPath, notes);
    } else {
      state.notesByRelPath.delete(relPath);
    }
    updateAnnotationIndexForDetail(relPath, detail);
    refreshNotesViewFromCache();
  }

  async function resolveMergeRoot(): Promise<string | undefined> {
    logMessage("INFO", "resolveMergeRoot: start");
    if (state.roots?.merge) {
      logMessage("INFO", "resolveMergeRoot: using roots.merge", {
        merge: state.roots.merge,
      });
      return state.roots.merge;
    }
    const lastDirs = context.globalState.get<LastDirs>(LAST_DIRS_KEY);
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

  async function resolveRoot(target: JumpTarget): Promise<string | undefined> {
    logMessage("INFO", "resolveRoot: start", { target });
    if (target === "merge") {
      return resolveMergeRoot();
    }
    const lastDirs = context.globalState.get<LastDirs>(LAST_DIRS_KEY);
    const mergeRoot = state.roots?.merge || lastDirs?.merge;
    const candidate = state.roots ? state.roots[target] : undefined;
    if (candidate) {
      if (mergeRoot && isSamePath(candidate, mergeRoot)) {
        logMessage("WARN", "resolveRoot: root equals merge, ignored", {
          target,
          path: candidate,
          merge: mergeRoot,
        });
      } else {
        logMessage("INFO", "resolveRoot: using roots", {
          target,
          path: candidate,
        });
        return candidate;
      }
    }
    const fallback =
      target === "branch"
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
      } else {
        state.roots = state.roots || {};
        state.roots[target] = fallback;
        logMessage("INFO", "resolveRoot: using lastDirs", {
        target,
        path: fallback,
      });
      return fallback;
      }
    }
    const prompt =
      target === "branch"
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

  async function openMergeFile(
    relPath: string,
    lineNo?: number,
    revealFirstChange = true
  ) {
    logMessage("INFO", "openMergeFile: start", { relPath, lineNo });
    if (!state.analysisId) {
      vscode.window.showErrorMessage("请先运行分析或加载分析ID");
      return;
    }
    const mergeRoot = await resolveMergeRoot();
    if (!mergeRoot) {
      vscode.window.showErrorMessage("缺少 merge 根目录信息");
      logMessage("WARN", "openMergeFile: missing merge root");
      return;
    }
    const safeRel = relPath.replace(/\//g, path.sep);
    const filePath = path.normalize(path.join(mergeRoot, safeRel));
    logMessage("INFO", "openMergeFile: resolved file", { filePath });
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
    });

    const client = new BackendClient(getBackendUrl());
    const detail = await getFileDetail(relPath, client);
    state.fileDetailByPath.set(doc.fileName, detail);
    applyDecorationsForEditor(editor, detail);
    updateNotesCacheForDetail(relPath, detail);
    if (lineNo && lineNo > 0) {
      const range = new vscode.Range(
        new vscode.Position(lineNo - 1, 0),
        new vscode.Position(lineNo - 1, 0)
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      return;
    }
    if (revealFirstChange) {
      const firstChanged = detail.blocks.find(
        (item) => item.origin && item.origin !== "common"
      );
      if (firstChanged) {
        const range = new vscode.Range(
          new vscode.Position(firstChanged.start - 1, 0),
          new vscode.Position(firstChanged.start - 1, 0)
        );
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  async function openFile(item: FileItem) {
    if (!item) return;
    await openMergeFile(item.relPath);
  }

  async function openAt(target: JumpTarget, relPath: string, lineNo?: number) {
    logMessage("INFO", "openAt: start", { target, relPath, lineNo });
    if (target === "merge") {
      await openMergeFile(relPath, lineNo, false);
      return;
    }
    const rootDir = await resolveRoot(target);
    if (!rootDir) {
      vscode.window.showErrorMessage(`缺少 ${target} 根目录信息`);
      logMessage("WARN", "openAt: missing root", { target });
      return;
    }
    const safeRel = relPath.replace(/\//g, path.sep);
    const filePath = path.normalize(path.join(rootDir, safeRel));
    const exists = fs.existsSync(filePath);
    logMessage("INFO", "openAt: resolved file", {
      target,
      filePath,
      exists,
    });
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
      });
      if (lineNo && lineNo > 0) {
        const range = new vscode.Range(
          new vscode.Position(lineNo - 1, 0),
          new vscode.Position(lineNo - 1, 0)
        );
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `打开 ${target} 文件失败: ${filePath} (${message})`
      );
      logMessage("ERROR", "openAt: open failed", {
        target,
        filePath,
        error: message,
      });
    }
  }

  async function runAnalysis() {
    const lastDirs = context.globalState.get<LastDirs>(LAST_DIRS_KEY);
    let branchDir = "";
    let trunkDir = "";
    let mergeDir = "";
    let baseDir = "";

    if (lastDirs?.branch && lastDirs?.trunk && lastDirs?.merge) {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "使用上次路径",
            description: `${lastDirs.branch} | ${lastDirs.trunk} | ${lastDirs.merge}`,
            value: "reuse",
          },
          { label: "重新选择", value: "pick" },
        ],
        { placeHolder: "选择分析路径方式" }
      );
      if (!pick) return;
      if (pick.value === "reuse") {
        branchDir = lastDirs.branch;
        trunkDir = lastDirs.trunk;
        mergeDir = lastDirs.merge;
        baseDir = lastDirs.base || "";
      }
    }

    if (!branchDir) {
      const picked = await pickFolder("选择 Branch 目录", false, lastDirs?.branch);
      if (!picked) return;
      branchDir = picked;
    }
    if (!trunkDir) {
      const picked = await pickFolder("选择 Trunk 目录", false, lastDirs?.trunk);
      if (!picked) return;
      trunkDir = picked;
    }
    if (!mergeDir) {
      const picked = await pickFolder("选择 Merge 目录", false, lastDirs?.merge);
      if (!picked) return;
      mergeDir = picked;
    }
    if (!baseDir) {
      const picked = await pickFolder(
        "选择 Base 目录（可取消）",
        true,
        lastDirs?.base
      );
      baseDir = picked || "";
    }

    state.roots = sanitizeRoots({
      branch: branchDir,
      trunk: trunkDir,
      merge: mergeDir,
      base: baseDir || undefined,
    });
    await context.globalState.update(LAST_DIRS_KEY, {
      branch: branchDir,
      trunk: trunkDir,
      merge: mergeDir,
      base: baseDir || "",
    });
    logMessage("INFO", "runAnalysis: cache roots", {
      branch: branchDir,
      trunk: trunkDir,
      merge: mergeDir,
      base: baseDir || "",
    });

    const client = new BackendClient(getBackendUrl());
    const payload: Record<string, unknown> = {
      branch_dir: branchDir,
      trunk_dir: trunkDir,
      merge_dir: mergeDir,
      base_dir: baseDir || null,
    };

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "SVN Merge Annotator 分析中",
        cancellable: true,
      },
      async (progress, token) => {
        const result = await client.analyze(payload);
        const analysisId = result.analysis_id;
        state.analysisId = analysisId;
        progress.report({ message: `analysis_id=${analysisId}` });
        while (true) {
          if (token.isCancellationRequested) {
            break;
          }
          let status: StatusResponse | undefined;
          try {
            status = await client.status(analysisId);
          } catch (err) {
            break;
          }
          if (status?.percent !== undefined) {
            progress.report({
              increment: 0,
              message: `${status.percent}% ${status.path || ""}`.trim(),
            });
          }
          if (status?.state === "done") {
            break;
          }
          if (status?.state === "error") {
            throw new Error(status.message || "分析失败");
          }
          await delay(1000);
        }
      }
    );

    if (state.analysisId) {
      await context.globalState.update(LAST_DIRS_KEY, {
        branch: branchDir,
        trunk: trunkDir,
        merge: mergeDir,
        base: baseDir || "",
      });
      await loadFiles(state.analysisId, client);
    }
  }

  async function loadById() {
    const lastId = context.globalState.get<string>(LAST_ANALYSIS_ID_KEY) || "";
    const input = await vscode.window.showInputBox({
      prompt: "输入 analysis_id",
      placeHolder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      value: lastId,
    });
    if (!input) return;
    const client = new BackendClient(getBackendUrl());
    state.analysisId = input.trim();
    try {
      await loadFiles(state.analysisId, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  }

  async function refresh() {
    if (!state.analysisId) {
      vscode.window.showErrorMessage("尚未加载分析ID");
      return;
    }
    const client = new BackendClient(getBackendUrl());
    try {
      await loadFiles(state.analysisId, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  }

  async function refreshNotes() {
    if (!state.analysisId) {
      vscode.window.showErrorMessage("尚未加载分析ID");
      return;
    }
    const filesToScan = state.files || [];
    if (!filesToScan.length) {
      vscode.window.showInformationMessage("当前文件列表为空，无法生成 Notes");
      return;
    }
    if (state.notesLoading) {
      return;
    }
    state.notesLoading = true;
    const client = new BackendClient(getBackendUrl());
    const notesByRelPath = new Map<string, Block[]>();
    const annotationIndex = new Map<string, boolean>();
    const summaryIndex = new Map<string, FileSummaryStat>();
    let totalNotes = 0;
    let cancelled = false;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "SVN Merge Annotator 生成 Notes",
          cancellable: true,
        },
        async (progress, token) => {
          const total = filesToScan.length;
          for (let i = 0; i < filesToScan.length; i += 1) {
            if (token.isCancellationRequested) {
              cancelled = true;
              break;
            }
            const file = filesToScan[i];
            progress.report({
              message: `${i + 1}/${total} ${file.path}`,
              increment: (1 / total) * 100,
            });
            const detail = await getFileDetail(file.path, client);
            const stat = buildSummaryStatFromDetail(detail);
            annotationIndex.set(file.path, stat.annotated_blocks > 0);
            summaryIndex.set(file.path, stat);
            const notes = extractNotes(detail);
            if (notes.length) {
              notesByRelPath.set(file.path, notes);
              totalNotes += notes.length;
            }
          }
        }
      );
      state.notesByRelPath = notesByRelPath;
      state.notesLoaded = true;
      if (!cancelled) {
        state.annotationIndex = annotationIndex;
        state.annotationIndexLoaded = true;
        state.summaryByPath = summaryIndex;
        state.summaryLoaded = true;
      } else if (annotationIndex.size) {
        for (const [key, value] of annotationIndex.entries()) {
          state.annotationIndex.set(key, value);
        }
        for (const [key, value] of summaryIndex.entries()) {
          state.summaryByPath.set(key, value);
        }
      }
      notesProvider.refresh(
        notesByRelPath,
        totalNotes,
        "暂无批注",
        getNotesGroupBy()
      );
      updateNotesBadge(totalNotes);
      updateFilesViewMessage();
      if (!cancelled) {
        applyFileFilters();
      }
    } finally {
      state.notesLoading = false;
    }
  }

  async function showHistory() {
    const client = new BackendClient(getBackendUrl());
    let history: HistoryItem[] = [];
    try {
      const limit = Math.max(1, getConfig("analysisHistoryLimit", 20));
      const resp = await client.history(limit);
      history = resp.items || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`获取分析历史失败: ${message}`);
      return;
    }
    if (!history.length) {
      vscode.window.showInformationMessage("暂无分析历史");
      return;
    }
    type HistoryPick = vscode.QuickPickItem & { value: string };
    const copyButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("copy"),
      tooltip: "复制 analysis_id",
    };
    const historyMap = new Map<string, HistoryItem>();
    const items: HistoryPick[] = history.map((item) => {
      historyMap.set(item.id, item);
      const time = formatHistoryTime(item.created_at || item.finished_at);
      const rootInfo = item.roots
        ? `B:${item.roots.branch || "-"} T:${item.roots.trunk || "-"} M:${
            item.roots.merge || "-"
          }`
        : "";
      const stateLabel = item.state ? ` · ${item.state}` : "";
      const availableLabel =
        item.available === false ? " · 已失效" : "";
      return {
        label: item.id,
        description: `${time}${stateLabel}${availableLabel}`,
        detail: rootInfo,
        value: item.id,
        buttons: [copyButton],
      };
    });

    const quickPick = vscode.window.createQuickPick<HistoryPick>();
    quickPick.title = "分析历史";
    quickPick.placeholder = "选择要加载的 analysis_id（右侧可复制）";
    quickPick.items = items;

    const disposeAll = () => {
      quickPick.dispose();
    };

    quickPick.onDidTriggerItemButton(async (event) => {
      await vscode.env.clipboard.writeText(event.item.value);
      vscode.window.showInformationMessage("analysis_id 已复制");
    });

    quickPick.onDidAccept(async () => {
      const pick = quickPick.selectedItems[0];
      if (!pick) {
        disposeAll();
        return;
      }
      const pickedItem = historyMap.get(pick.value);
      if (pickedItem && pickedItem.available === false) {
        vscode.window.showErrorMessage("分析结果已失效，请重新分析");
        disposeAll();
        return;
      }
      const client = new BackendClient(getBackendUrl());
      state.analysisId = pick.value;
      try {
        await loadFiles(state.analysisId, client);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(message);
      }
      disposeAll();
    });

    quickPick.onDidHide(disposeAll);
    quickPick.show();
  }

  function normalizeRevInput(raw?: string): string | undefined {
    if (!raw) return undefined;
    const value = raw.trim();
    if (!value) return undefined;
    if (value.toUpperCase() === "HEAD") return "HEAD";
    const cleaned = value.replace(/^r/i, "");
    if (!/^\d+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  function formatRevLabel(rev: string) {
    if (rev.toUpperCase() === "HEAD") return "HEAD";
    const cleaned = rev.replace(/^r/i, "");
    return `r${cleaned}`;
  }

  function filterRevItems(items: RevChangeItem[], filter: RevChangeFilter) {
    if (filter === "all") return items;
    return items.filter((item) => normalizeRevStatus(item.status) === filter);
  }

  function normalizeSlashes(value: string) {
    return value.replace(/\\/g, "/");
  }

  function joinUrl(base: string, relPath: string) {
    const left = base.replace(/\/+$/, "");
    const right = relPath.replace(/^\/+/, "");
    return `${left}/${right}`;
  }

  function decodeXml(value: string) {
    return value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'");
  }

  function toRelativePath(rawPath: string, root: RootInfo) {
    const value = rawPath.trim();
    if (!value) return "";
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

  function getDirGroupKey(relPath: string, depth: number) {
    const parts = splitRelPath(relPath);
    if (!parts.length) return "ROOT";
    const dirs = parts.slice(0, -1);
    if (!dirs.length) return "ROOT";
    const take = Math.min(depth, dirs.length);
    return dirs.slice(0, take).join("/");
  }

  function buildRevHeader(state: RevChangeState) {
    const targetLabel = state.target === "branch" ? "分支" : "主线";
    const label = "提交范围";
    const counts = countRevItems(state.diffItems);
    const desc = `${formatRevLabel(state.startRev)} → ${formatRevLabel(
      state.endRev
    )} (${targetLabel}) · ${formatRevCounts(counts)}`;
    return new RevHeaderItem(label, desc);
  }

  function buildDirectoryNodes(
    items: RevChangeItem[],
    depth: number,
    filter: RevChangeFilter
  ) {
    const filtered = filterRevItems(items, filter);
    if (!filtered.length) {
      return [new RevHeaderItem("暂无变更")];
    }
    const groups = new Map<string, RevChangeItem[]>();
    for (const item of filtered) {
      const key = getDirGroupKey(item.path, depth);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)?.push(item);
    }
    const nodes: RevGroupItem[] = [];
    const keys = Array.from(groups.keys()).sort();
    for (const key of keys) {
      const groupItems = groups.get(key) || [];
      groupItems.sort((a, b) => a.path.localeCompare(b.path));
      const counts = countRevItems(groupItems);
      const group = new RevGroupItem(
        key,
        `文件 ${counts.total} · ${formatRevCounts(counts)}`
      );
      group.children = groupItems.map(
        (item) => new RevFileItem(item.path, normalizeRevStatus(item.status))
      );
      nodes.push(group);
    }
    return nodes;
  }

  function formatLogMessage(message?: string) {
    if (!message) return "";
    const first = message.split(/\r?\n/)[0]?.trim();
    return first || "";
  }

  function formatLogDate(date?: string) {
    if (!date) return "";
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleString();
  }

  function buildCommitNodes(
    entries: RevLogEntry[] | undefined,
    filter: RevChangeFilter
  ) {
    if (!entries || !entries.length) {
      return [new RevHeaderItem("暂无提交记录")];
    }
    const nodes: RevGroupItem[] = [];
    for (const entry of entries) {
      const filtered = filterRevItems(entry.items || [], filter);
      if (!filtered.length) continue;
      const label = `r${entry.revision}`;
      const message = formatLogMessage(entry.message);
      const metaParts = [];
      if (entry.author) metaParts.push(entry.author);
      const dateText = formatLogDate(entry.date);
      if (dateText) metaParts.push(dateText);
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
      group.children = filtered.map(
        (item) => new RevFileItem(item.path, normalizeRevStatus(item.status))
      );
      nodes.push(group);
    }
    if (!nodes.length) {
      return [new RevHeaderItem("暂无提交记录")];
    }
    return nodes;
  }

  function buildRevNodes(state: RevChangeState) {
    const mode = getRevGroupMode();
    const filter = getRevChangeFilter();
    const header = buildRevHeader(state);
    if (mode === "commit") {
      return [header, ...buildCommitNodes(state.logEntries, filter)];
    }
    const depth = mode === "dir2" ? 2 : 1;
    return [header, ...buildDirectoryNodes(state.diffItems, depth, filter)];
  }

  async function runSvn(
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const proc = child_process.spawn("svn", args, {
        cwd,
        shell: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      proc.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      proc.on("error", (err) => {
        const stderr = err instanceof Error ? err.message : String(err);
        resolve({ stdout: "", stderr, code: 1 });
      });
      proc.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  async function getRootInfo(target: RevRangeTarget): Promise<RootInfo | undefined> {
    const cached = revRootCache.get(target);
    if (cached) return cached;
    const rootPath = await resolveRoot(target);
    if (!rootPath) return undefined;
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
    const rootSuffix =
      reposRoot && rootUrl.startsWith(reposRoot)
        ? rootUrl.slice(reposRoot.length)
        : undefined;
    const root: RootInfo = {
      rootPath,
      rootUrl,
      reposRoot,
      rootSuffix,
    };
    revRootCache.set(target, root);
    return root;
  }

  async function fetchDiffItems(
    root: RootInfo,
    startRev: string,
    endRev: string
  ) {
    const range = `${startRev}:${endRev}`;
    const resp = await runSvn(
      ["diff", "--summarize", "-r", range, root.rootUrl],
      root.rootPath
    );
    if (resp.code !== 0) {
      throw new Error(resp.stderr || "获取提交范围差异失败");
    }
    const items: RevChangeItem[] = [];
    for (const line of resp.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([A-Z])\s+(.+)$/);
      if (!match) continue;
      const status = match[1];
      const rawPath = match[2].trim();
      const relPath = toRelativePath(rawPath, root);
      if (!relPath) continue;
      items.push({ status, path: relPath });
    }
    return items;
  }

  async function fetchLogEntries(
    root: RootInfo,
    startRev: string,
    endRev: string
  ) {
    const range = `${startRev}:${endRev}`;
    const resp = await runSvn(
      ["log", "--xml", "-v", "-r", range, root.rootUrl],
      root.rootPath
    );
    if (resp.code !== 0) {
      throw new Error(resp.stderr || "获取提交记录失败");
    }
    const entries: RevLogEntry[] = [];
    const blocks = resp.stdout.match(/<logentry[\s\S]*?<\/logentry>/g) || [];
    for (const block of blocks) {
      const revMatch = block.match(/revision=\"(\d+)\"/);
      if (!revMatch) continue;
      const revision = revMatch[1];
      const authorMatch = block.match(/<author>([\s\S]*?)<\/author>/);
      const dateMatch = block.match(/<date>([\s\S]*?)<\/date>/);
      const msgMatch = block.match(/<msg>([\s\S]*?)<\/msg>/);
      const items: RevChangeItem[] = [];
      const pathBlocks = block.match(/<path[^>]*>[\s\S]*?<\/path>/g) || [];
      for (const pathBlock of pathBlocks) {
        const actionMatch = pathBlock.match(/action=\"([A-Z])\"/);
        const action = actionMatch ? actionMatch[1] : "M";
        const rawPath = pathBlock
          .replace(/^<path[^>]*>/, "")
          .replace(/<\/path>$/, "");
        const decodedPath = decodeXml(rawPath);
        const relPath = toRelativePath(decodedPath, root);
        if (!relPath) continue;
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

  async function fetchFileLogEntries(
    root: RootInfo,
    startRev: string,
    endRev: string,
    relPath: string
  ) {
    const range = `${startRev}:${endRev}`;
    const fileUrl = joinUrl(root.rootUrl, relPath);
    const resp = await runSvn(
      ["log", "--xml", "-r", range, fileUrl],
      root.rootPath
    );
    if (resp.code !== 0) {
      throw new Error(resp.stderr || "获取文件提交记录失败");
    }
    const entries: RevFileLogEntry[] = [];
    const blocks = resp.stdout.match(/<logentry[\s\S]*?<\/logentry>/g) || [];
    for (const block of blocks) {
      const revMatch = block.match(/revision=\"(\d+)\"/);
      if (!revMatch) continue;
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

  async function ensureLogEntries() {
    if (!revState) return;
    if (revState.logEntries) return;
    revState.logEntries = await fetchLogEntries(
      revState.root,
      revState.startRev,
      revState.endRev
    );
  }

  async function ensureFileLogEntries(relPath: string) {
    if (!revState) return [];
    const cached = revFileLogCache.get(relPath);
    if (cached) return cached;
    const entries = await fetchFileLogEntries(
      revState.root,
      revState.startRev,
      revState.endRev,
      relPath
    );
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
    revView.message = `${formatRevLabel(revState.startRev)} → ${formatRevLabel(
      revState.endRev
    )} (${targetLabel})`;
    revProvider.refresh(nodes);
  }

  async function runRevRangeInternal(
    target: RevRangeTarget,
    startRev: string,
    endRev: string
  ) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "提交范围变更分析",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "读取 SVN 信息..." });
        const root = await getRootInfo(target);
        if (!root) {
          throw new Error("未找到 SVN 根目录");
        }
        progress.report({ message: "获取变更清单..." });
        const diffItems = await fetchDiffItems(root, startRev, endRev);
        let logEntries: RevLogEntry[] | undefined;
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
        };
        revFileLogCache.clear();
        await context.globalState.update(REV_RANGE_KEY, {
          target,
          startRev,
          endRev,
        });
      }
    );
    refreshRevView();
  }

  async function runRevRange() {
    const last = context.globalState.get<{
      target?: RevRangeTarget;
      startRev?: string;
      endRev?: string;
    }>(REV_RANGE_KEY);
    type TargetPick = vscode.QuickPickItem & { value: RevRangeTarget };
    const targetPick = await vscode.window.showQuickPick<TargetPick>(
      [
        { label: "分支", value: "branch" as RevRangeTarget },
        { label: "主线", value: "trunk" as RevRangeTarget },
      ],
      {
        placeHolder: "选择提交范围目标",
      }
    );
    if (!targetPick) return;
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
    } catch (err) {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  }

  async function setRevGroupMode() {
    type ModePick = vscode.QuickPickItem & { value: RevGroupMode };
    const items: ModePick[] = [
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
    if (!picked) return;
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    await config.update(
      "revGroupMode",
      picked.value,
      vscode.ConfigurationTarget.Global
    );
    if (picked.value === "commit") {
      try {
        await ensureLogEntries();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(message);
      }
    }
    refreshRevView();
  }

  async function setRevChangeFilter() {
    type FilterPick = vscode.QuickPickItem & { value: RevChangeFilter };
    const items: FilterPick[] = [
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
    if (!picked) return;
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    await config.update(
      "revChangeFilter",
      picked.value,
      vscode.ConfigurationTarget.Global
    );
    refreshRevView();
  }

  async function openRevDiff(item?: RevFileItem) {
    if (!item) return;
    if (!revState) {
      vscode.window.showErrorMessage("尚未运行提交范围变更");
      return;
    }
    await openRevDiffForPath(
      item.relPath,
      revState.startRev,
      revState.endRev
    );
  }

  async function openRevDiffForPath(
    relPath: string,
    leftRev: string,
    rightRev: string
  ) {
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
    const title = `${safeRelPath} (${formatRevLabel(leftRev)} → ${formatRevLabel(
      rightRev
    )})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  async function showRevFileHistory(item?: RevFileItem) {
    if (!item) {
      vscode.window.showErrorMessage("未选择文件");
      return;
    }
    if (!revState) {
      vscode.window.showErrorMessage("尚未运行提交范围变更");
      return;
    }
    let entries: RevFileLogEntry[] = [];
    try {
      entries = await ensureFileLogEntries(item.relPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
      return;
    }
    if (!entries.length) {
      vscode.window.showInformationMessage("该文件在范围内无提交记录");
      return;
    }
    type RevPick = vscode.QuickPickItem & { index: number };
    const picks: RevPick[] = entries.map((entry, index) => {
      const message = formatLogMessage(entry.message);
      const detailParts = [];
      if (entry.author) detailParts.push(entry.author);
      const dateText = formatLogDate(entry.date);
      if (dateText) detailParts.push(dateText);
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
    if (!picked) return;
    const current = entries[picked.index];
    const previous = entries[picked.index + 1];
    if (!previous) {
      vscode.window.showInformationMessage("已是最早修订，无法与前一条对比");
      return;
    }
    await openRevDiffForPath(item.relPath, previous.revision, current.revision);
  }

  async function showLegend() {
    const lines = [
      "颜色图例:",
      "branch: 橙色",
      "trunk: 蓝色",
      "common: 绿色",
      "manual: 紫色",
      "conflict: 红色",
      "unknown: 灰色",
      "Gutter 图标: manual/conflict",
    ];
    vscode.window.showInformationMessage(lines.join(" | "));
  }

  async function setAnnotationFilter() {
    const current = getAnnotationFilter();
    type FilterPick = vscode.QuickPickItem & { value: AnnotationFilter };
    const items: FilterPick[] = [
      { label: "全部", description: "不过滤文件", value: "all" },
      { label: "已批注", description: "仅显示已批注文件", value: "annotated" },
      { label: "未批注", description: "仅显示未批注文件", value: "unannotated" },
      { label: "仅风险", description: "仅显示存在风险批注文件", value: "risk" },
    ];
    for (const item of items) {
      item.picked = item.value === current;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择批注筛选",
      matchOnDescription: true,
    });
    if (!picked) return;
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    await config.update(
      "annotationFilter",
      picked.value,
      vscode.ConfigurationTarget.Global
    );
    if (picked.value !== "all" && state.analysisId) {
      void refreshAnnotationIndex();
    }
  }

  async function setNotesGroupBy() {
    const current = getNotesGroupBy();
    type GroupPick = vscode.QuickPickItem & { value: NotesGroupBy };
    const items: GroupPick[] = [
      { label: "按文件", description: "以文件为分组", value: "file" },
      { label: "按来源", description: "按改动来源分组", value: "origin" },
      { label: "按风险", description: "按风险有无分组", value: "risk" },
    ];
    for (const item of items) {
      item.picked = item.value === current;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择批注分组方式",
      matchOnDescription: true,
    });
    if (!picked) return;
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    await config.update(
      "notesGroupBy",
      picked.value,
      vscode.ConfigurationTarget.Global
    );
    refreshNotesViewFromCache();
  }

  async function toggleConfigBoolean(key: string, label: string) {
    const config = vscode.workspace.getConfiguration("svnMergeAnnotator");
    const current = config.get<boolean>(key, false);
    const next = !current;
    await config.update(key, next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`${label}: ${next ? "开启" : "关闭"}`);
  }

  async function openMergeBlock(
    target?: NoteBlockItem | string,
    lineNo?: number
  ) {
    if (!target) return;
    if (target instanceof NoteBlockItem) {
      await openMergeFile(target.relPath, target.block.start, false);
      return;
    }
    if (typeof target === "string") {
      await openMergeFile(target, lineNo, false);
    }
  }

  async function copyNote(target?: NoteBlockItem | Block, relPath?: string) {
    let block: Block | undefined;
    let resolvedPath = relPath;

    if (target instanceof NoteBlockItem) {
      block = target.block;
      resolvedPath = target.relPath;
    } else if (target && (target as Block).start) {
      block = target as Block;
    }

    if (!block) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("当前没有可用的编辑器");
        return;
      }
      const detail = state.fileDetailByPath.get(editor.document.fileName);
      if (!detail) {
        vscode.window.showErrorMessage("当前文件未加载分析详情");
        return;
      }
      const lineNo = editor.selection.active.line + 1;
      const found = detail.blocks.find(
        (item) => lineNo >= item.start && lineNo <= item.end
      );
      if (!found) {
        vscode.window.showErrorMessage("当前行不在合并块内");
        return;
      }
      block = found;
      resolvedPath = detail.path;
    }

    if (!block) {
      vscode.window.showErrorMessage("未找到可复制的批注块");
      return;
    }
    if (!resolvedPath) {
      vscode.window.showErrorMessage("缺少文件路径信息，无法复制");
      return;
    }
    const text = formatNoteCopyText(resolvedPath, block);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage("已复制批注内容");
  }

  async function annotateBlock(block?: Block, relPath?: string) {
    if (!state.analysisId) {
      vscode.window.showErrorMessage("尚未加载分析ID");
      return;
    }
    let targetBlock = block;
    let targetPath = relPath;
    if (!targetBlock) {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("当前没有可用的编辑器");
        return;
      }
      const detail = state.fileDetailByPath.get(editor.document.fileName);
      if (!detail) {
        vscode.window.showErrorMessage("当前文件未加载分析详情");
        return;
      }
      const lineNo = editor.selection.active.line + 1;
      targetBlock = detail.blocks.find(
        (item) => lineNo >= item.start && lineNo <= item.end
      );
      targetPath = detail.path;
    }
    if (!targetBlock || !targetPath) {
      vscode.window.showErrorMessage("未找到可写入的合并块");
      return;
    }

    const mergeReason = await vscode.window.showInputBox({
      prompt: "输入合并理由（必填）",
      value: targetBlock.ai_explain?.merge_reason || "",
    });
    if (!mergeReason) {
      vscode.window.showErrorMessage("合并理由不能为空");
      return;
    }
    const reason = await vscode.window.showInputBox({
      prompt: "输入原因（可选）",
      value: targetBlock.ai_explain?.reason || "",
    });
    const impact = await vscode.window.showInputBox({
      prompt: "输入影响（可选）",
      value: targetBlock.ai_explain?.impact || "",
    });
    const risk = await vscode.window.showInputBox({
      prompt: "输入风险（可选）",
      value: targetBlock.ai_explain?.risk || "",
    });
    const note = await vscode.window.showInputBox({
      prompt: "输入备注（可选）",
      value: targetBlock.ai_explain?.note || "",
    });
    const explain: AIExplain = {
      merge_reason: mergeReason,
      reason: reason || "",
      impact: impact || "",
      risk: risk || "",
      note: note || "",
      source: "manual",
      updated_at: new Date().toISOString(),
    };
    const client = new BackendClient(getBackendUrl());
    try {
      await client.annotate({
        analysis_id: state.analysisId,
        items: [
          {
            path: targetPath,
            start: targetBlock.start,
            end: targetBlock.end,
            explain,
          },
        ],
      });
      targetBlock.ai_explain = explain;
      const cached = state.fileDetailByRelPath.get(targetPath);
      if (cached) {
        updateNotesCacheForDetail(targetPath, cached);
      } else {
        updateNotesCacheForDetail(targetPath, {
          path: targetPath,
          line_meta: [],
          blocks: [targetBlock],
        });
      }
      vscode.window.showInformationMessage("批注已写回");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  }

  async function updateHistory(analysisId: string) {
    await context.globalState.update(LAST_ANALYSIS_ID_KEY, analysisId);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("svnMergeAnnotator.runAnalysis", runAnalysis),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.startBackend",
      startBackend
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.stopBackend",
      stopBackend
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.restartBackend",
      restartBackend
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.backendActions",
      backendActions
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.openBackendLogs",
      openBackendLogs
    ),
    vscode.commands.registerCommand("svnMergeAnnotator.refresh", refresh),
    vscode.commands.registerCommand("svnMergeAnnotator.loadById", loadById),
    vscode.commands.registerCommand("svnMergeAnnotator.openFile", openFile),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.openMergeBlock",
      openMergeBlock
    ),
    vscode.commands.registerCommand("svnMergeAnnotator.refreshNotes", refreshNotes),
    vscode.commands.registerCommand("svnMergeAnnotator.showHistory", showHistory),
    vscode.commands.registerCommand("svnMergeAnnotator.runRevRange", runRevRange),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.refreshRevChanges",
      refreshRevChanges
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.setRevGroupMode",
      setRevGroupMode
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.setRevChangeFilter",
      setRevChangeFilter
    ),
    vscode.commands.registerCommand("svnMergeAnnotator.openRevDiff", openRevDiff),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.showRevFileHistory",
      showRevFileHistory
    ),
    vscode.commands.registerCommand("svnMergeAnnotator.copyNote", copyNote),
    vscode.commands.registerCommand("svnMergeAnnotator.annotateBlock", annotateBlock),
    vscode.commands.registerCommand("svnMergeAnnotator.showLegend", showLegend),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.setAnnotationFilter",
      setAnnotationFilter
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.setNotesGroupBy",
      setNotesGroupBy
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.toggleHideNewFiles",
      () => toggleConfigBoolean("hideNewFiles", "隐藏新增文件")
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.toggleShowOnlyChanged",
      () => toggleConfigBoolean("showOnlyChangedFiles", "仅显示改动文件")
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.toggleShowOnlyRiskLines",
      () => toggleConfigBoolean("showOnlyRiskLines", "仅显示风险行")
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.toggleShowCommonLines",
      () => toggleConfigBoolean("showCommonLines", "显示 common 行")
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.showBlockDetail",
      async (block: Block, relPath?: string) => {
        if (!block) return;
        const action = await vscode.window.showInformationMessage(
          formatBlockDetailText(block),
          "复制批注"
        );
        if (action === "复制批注") {
          await copyNote(block, relPath);
        }
      }
    ),
    vscode.commands.registerCommand(
      "svnMergeAnnotator.jumpTo",
      (target: JumpTarget, relPath: string, lineNo?: number) => {
        if (!target || !relPath) return;
        openAt(target, relPath, lineNo);
      }
    ),
    vscode.commands.registerCommand("svnMergeAnnotator.showLogs", () => {
      output.show(true);
    })
  );

  void refreshBackendStatus(true);
  backendHealthTimer = setInterval(() => {
    void refreshBackendStatus(true);
  }, 5000);
  context.subscriptions.push({
    dispose: () => {
      if (backendHealthTimer) {
        clearInterval(backendHealthTimer);
      }
    },
  });

  context.subscriptions.push(decorations);
}

export function deactivate() {
  return;
}

async function pickFolder(
  prompt: string,
  canSkip = false,
  defaultPath?: string
) {
  const options: vscode.OpenDialogOptions = {
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

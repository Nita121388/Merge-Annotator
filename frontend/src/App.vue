<template>
  <div class="app">
    <header class="topbar panel">
      <div class="path-group">
        <div class="field">
          <label>Branch</label>
          <div class="path-row">
            <input v-model="branchDir" placeholder="E:\\" />
            <button class="ghost" type="button" @click="pickDir('branch')">
              选择
            </button>
          </div>
        </div>
        <div class="field">
          <label>Trunk</label>
          <div class="path-row">
            <input v-model="trunkDir" placeholder="E:\\" />
            <button class="ghost" type="button" @click="pickDir('trunk')">
              选择
            </button>
          </div>
        </div>
        <div class="field">
          <label>Merge</label>
          <div class="path-row">
            <input v-model="mergeDir" placeholder="E:\\" />
            <button class="ghost" type="button" @click="pickDir('merge')">
              选择
            </button>
          </div>
        </div>
        <div class="field">
          <label>Base (optional)</label>
          <div class="path-row">
            <input v-model="baseDir" placeholder="E:\\" />
            <button class="ghost" type="button" @click="pickDir('base')">
              选择
            </button>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="primary" :disabled="loading" @click="runAnalysis">
          Analyze
        </button>
        <div class="status-block">
          <div class="status-row">
            <div class="status">{{ statusText }}</div>
            <span class="status-pill" :class="`state-${statusState}`">
              {{ statusLabel }}
            </span>
          </div>
          <div v-if="loading" class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: `${progressPercent}%` }"
            ></div>
          </div>
          <div v-if="loading && progress.path" class="progress-path">
            当前文件：{{ progress.path }}
          </div>
        </div>
      </div>
    </header>

    <section class="panel legend">
      <div class="legend-title">颜色说明</div>
      <div class="legend-items">
        <div class="legend-item">
          <span class="legend-swatch origin-branch"></span>
          <span class="legend-text">分支改动 (Branch)</span>
        </div>
        <div class="legend-item">
          <span class="legend-swatch origin-trunk"></span>
          <span class="legend-text">主线改动 (Trunk)</span>
        </div>
        <div class="legend-item">
          <span class="legend-swatch origin-common"></span>
          <span class="legend-text">共同一致 (Common)</span>
        </div>
        <div class="legend-item">
          <span class="legend-swatch origin-manual"></span>
          <span class="legend-text">手工调整 (Manual)</span>
        </div>
        <div class="legend-item">
          <span class="legend-swatch origin-conflict"></span>
          <span class="legend-text">冲突块 (Conflict)</span>
        </div>
        <div class="legend-item">
          <span class="legend-swatch origin-unknown"></span>
          <span class="legend-text">未知归属 (Unknown)</span>
        </div>
      </div>
      <div class="legend-note">黄色描边表示当前选中的块范围。</div>
    </section>

    <div class="layout">
      <aside class="sidebar-column">
        <div class="panel history-panel">
          <div class="panel-title">
            <span>History</span>
            <span class="count-chip">{{ history.length }}</span>
          </div>
          <div class="panel-body">
            <div v-if="!history.length" class="placeholder">
              No history.
            </div>
            <button
              v-for="item in history"
              :key="item.id"
              class="history-item"
              :class="{ active: item.id === analysisId }"
              :title="historyTitle(item)"
              @click="openHistory(item)"
            >
              <div class="history-id">{{ item.id.slice(0, 8) }}</div>
              <div class="history-meta">
                {{ formatHistoryTime(item) }} · {{ item.file_count ?? "-" }} files
                <span v-if="item.state"> · {{ item.state }}</span>
                <span v-if="item.available === false"> · 已失效</span>
              </div>
            </button>
          </div>
        </div>

        <div class="panel sidebar">
          <div class="panel-title">Files</div>
          <div class="panel-body">
            <div v-if="!files.length" class="placeholder">
              No analysis loaded.
            </div>
            <button
              v-for="item in files"
              :key="item.path"
              class="file-item"
              :class="{ active: item.path === selectedPath }"
              @click="selectFile(item.path)"
            >
              <div class="file-path">{{ item.path }}</div>
              <div class="file-meta">
                <span>{{ item.total_lines }} lines</span>
                <span v-if="item.has_changes">changed</span>
                <span
                  v-if="item.file_origin === 'branch_new'"
                  class="file-tag tag-branch"
                >
                  分支新增
                </span>
                <span
                  v-else-if="item.file_origin === 'trunk_new'"
                  class="file-tag tag-trunk"
                >
                  主线新增
                </span>
              </div>
            </button>
          </div>
        </div>
      </aside>

      <main class="panel code">
        <div class="panel-title">
          <span>Code</span>
          <select v-model="viewMode">
            <option value="merge">merge</option>
            <option value="branch">branch</option>
            <option value="trunk">trunk</option>
            <option value="base">base</option>
          </select>
          <div class="nav-actions">
            <button
              class="nav-btn"
              :disabled="!conflictBlocks.length"
              @click="jumpConflict(-1)"
            >
              Prev conflict
            </button>
            <button
              class="nav-btn"
              :disabled="!conflictBlocks.length"
              @click="jumpConflict(1)"
            >
              Next conflict
            </button>
          </div>
        </div>
        <div class="panel-body code-body">
          <div v-if="!fileData" class="placeholder">Select a file.</div>
          <div v-else class="code-lines">
            <div
              v-for="line in displayLines"
              :key="line.key"
              :id="line.key"
              class="code-line"
              :class="[
                `origin-${line.origin}`,
                { 'origin-conflict-strong': line.origin === 'conflict' },
              ]"
              :data-active="isActiveLine(line.no) ? 'true' : 'false'"
            >
              <span class="line-no">{{ line.no }}</span>
              <span class="line-text">{{ line.text || " " }}</span>
            </div>
          </div>
        </div>
      </main>

      <aside class="panel notes">
        <div class="panel-title">
          <span>Notes</span>
          <span class="count-chip">{{ blocks.length }}</span>
        </div>
        <div class="panel-body">
          <div v-if="!blocks.length" class="placeholder">
            Annotations will appear here.
          </div>
          <div v-else class="note-list">
            <article
              v-for="block in blocks"
              :key="block.id"
              class="note-card"
              :class="{ active: block.id === activeBlockId }"
              @click="activateBlock(block)"
            >
              <div class="note-header">
                <span class="badge" :class="`origin-${block.origin}`">
                  {{ block.origin }}
                </span>
                <span class="range">L{{ block.start }}-{{ block.end }}</span>
                <button class="note-copy" @click.stop="copyNote(block)">
                  {{ copiedId === block.id ? "已复制" : "复制" }}
                </button>
              </div>
              <div class="note-actions">
                <button @click.stop="jumpTo('merge', block.start)">Merge</button>
                <button
                  v-if="block.branch_start"
                  @click.stop="jumpTo('branch', block.branch_start)"
                >
                  Branch
                </button>
                <button
                  v-if="block.trunk_start"
                  @click.stop="jumpTo('trunk', block.trunk_start)"
                >
                  Trunk
                </button>
                <button
                  v-if="block.base_start"
                  @click.stop="jumpTo('base', block.base_start)"
                >
                  Base
                </button>
              </div>
              <div v-if="block.svn" class="note-meta">
                <span v-if="block.svn.rev">r{{ block.svn.rev }}</span>
                <span v-if="block.svn.author">{{ block.svn.author }}</span>
                <span v-if="block.svn.date">{{ block.svn.date }}</span>
                <span v-if="block.svn.lines">{{ block.svn.lines }} lines</span>
              </div>
              <div v-if="block.ai_explain" class="ai-box">
                <div class="ai-title">AI</div>
                <div v-if="block.ai_explain.merge_reason" class="ai-line">
                  合并理由: {{ block.ai_explain.merge_reason }}
                </div>
                <div v-if="block.ai_explain.reason" class="ai-line">
                  Reason: {{ block.ai_explain.reason }}
                </div>
                <div v-if="block.ai_explain.impact" class="ai-line">
                  Impact: {{ block.ai_explain.impact }}
                </div>
                <div v-if="block.ai_explain.risk" class="ai-line">
                  Risk: {{ block.ai_explain.risk }}
                </div>
                <div v-if="block.ai_explain.note" class="ai-line">
                  Note: {{ block.ai_explain.note }}
                </div>
                <div v-if="block.ai_explain.source" class="ai-line">
                  Source: {{ block.ai_explain.source }}
                </div>
                <div v-if="block.ai_explain.updated_at" class="ai-line">
                  Updated: {{ block.ai_explain.updated_at }}
                </div>
              </div>
              <div v-if="block.conflict" class="conflict-box">
                <div class="conflict-title">Conflict</div>
                <div v-if="block.conflict.left_preview" class="conflict-side">
                  <div class="conflict-label">
                    Left ({{ block.conflict.left_count || 0 }})
                  </div>
                  <div class="conflict-lines">
                    <div
                      v-for="(line, idx) in conflictLines(block, 'left')"
                      :key="`left-${idx}`"
                      class="conflict-line"
                      :class="{ 'conflict-match': isLineInMerge(block, line) }"
                    >
                      <span class="conflict-no">{{ idx + 1 }}</span>
                      <span class="conflict-text">{{ line || " " }}</span>
                    </div>
                  </div>
                </div>
                <div v-if="block.conflict.right_preview" class="conflict-side">
                  <div class="conflict-label">
                    Right ({{ block.conflict.right_count || 0 }})
                  </div>
                  <div class="conflict-lines">
                    <div
                      v-for="(line, idx) in conflictLines(block, 'right')"
                      :key="`right-${idx}`"
                      class="conflict-line"
                      :class="{ 'conflict-match': isLineInMerge(block, line) }"
                    >
                      <span class="conflict-no">{{ idx + 1 }}</span>
                      <span class="conflict-text">{{ line || " " }}</span>
                    </div>
                  </div>
                </div>
                <button
                  v-if="conflictHasMore(block)"
                  class="conflict-toggle"
                  @click.stop="toggleConflict(block.id)"
                >
                  {{ isConflictExpanded(block.id) ? "收起" : "展开" }}
                </button>
              </div>
            </article>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from "vue";

const branchDir = ref("");
const trunkDir = ref("");
const mergeDir = ref("");
const baseDir = ref("");
const analysisId = ref("");
const files = ref([]);
const selectedPath = ref("");
const fileData = ref(null);
const viewMode = ref("merge");
const loading = ref(false);
const error = ref("");
const history = ref([]);
const LAST_FORM_KEY = "svn_merge_annotator_last_form_v1";
const HISTORY_LIMIT = 50;
const progress = ref({
  state: "idle",
  percent: 0,
  current: 0,
  total: 0,
  path: "",
  message: "",
});
const expandedConflicts = ref(new Set());
const mergeLineCache = new WeakMap();
const activeBlockId = ref("");
const copiedId = ref("");
let progressTimer = null;

const statusText = computed(() => {
  if (loading.value) {
    const total = progress.value.total || 0;
    const current = progress.value.current || 0;
    const percent = progress.value.percent || 0;
    if (total > 0) {
      return `Analyzing... ${percent}% (${current}/${total})`;
    }
    return "Analyzing...";
  }
  if (error.value) return error.value;
  if (progress.value.state === "done" && analysisId.value) {
    return `已完成 · analysis_id=${analysisId.value}`;
  }
  if (analysisId.value) return `analysis_id=${analysisId.value}`;
  return "Idle";
});

const statusState = computed(() => {
  if (loading.value) return "running";
  if (error.value || progress.value.state === "error") return "error";
  if (progress.value.state === "done") return "done";
  if (analysisId.value) return "ready";
  return "idle";
});

const statusLabel = computed(() => {
  if (loading.value) return "进行中";
  if (error.value || progress.value.state === "error") return "失败";
  if (progress.value.state === "done") return "已完成";
  if (analysisId.value) return "已加载";
  return "空闲";
});

const progressPercent = computed(() => {
  const value = Number(progress.value.percent || 0);
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
});

const blocks = computed(() => {
  if (!fileData.value) return [];
  return fileData.value.blocks.map((block, index) => ({
    id: `${fileData.value.path}-${index}`,
    file_path: fileData.value.path,
    ...block,
  }));
});

const displayLines = computed(() => {
  if (!fileData.value) return [];
  const versions = fileData.value.versions || {};
  const lines = versions[viewMode.value] || [];
  const originMap = buildOriginMap(viewMode.value, fileData.value.line_meta);
  return lines.map((text, index) => {
    const no = index + 1;
    const origin = originMap.get(no) || "unknown";
    return {
      no,
      text,
      origin,
      key: `line-${viewMode.value}-${no}`,
    };
  });
});

const conflictBlocks = computed(() => {
  return blocks.value.filter((block) => block.origin === "conflict");
});

function buildOriginMap(mode, meta) {
  const map = new Map();
  if (!meta) return map;
  for (const item of meta) {
    if (mode === "merge") {
      map.set(item.merge_no, item.origin);
    } else if (mode === "branch" && item.branch_no) {
      map.set(item.branch_no, item.origin);
    } else if (mode === "trunk" && item.trunk_no) {
      map.set(item.trunk_no, item.origin);
    } else if (mode === "base" && item.base_no) {
      map.set(item.base_no, item.origin);
    }
  }
  return map;
}

async function runAnalysis() {
  if (!branchDir.value || !trunkDir.value || !mergeDir.value) {
    error.value = "Please fill all directories.";
    return;
  }
  branchDir.value = normalizePath(branchDir.value);
  trunkDir.value = normalizePath(trunkDir.value);
  mergeDir.value = normalizePath(mergeDir.value);
  baseDir.value = normalizePath(baseDir.value);
  saveLastForm();
  error.value = "";
  loading.value = true;
  progress.value = {
    state: "running",
    percent: 0,
    current: 0,
    total: 0,
    path: "",
    message: "",
  };
  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch_dir: branchDir.value,
        trunk_dir: trunkDir.value,
        merge_dir: mergeDir.value,
        base_dir: baseDir.value || null,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Analyze failed");
    analysisId.value = data.analysis_id;
    updateUrlAnalysis(analysisId.value);
    startProgressPolling();
  } catch (err) {
    error.value = err.message;
    loading.value = false;
    stopProgressPolling();
  } finally {
    if (!loading.value) {
      stopProgressPolling();
    }
  }
}

async function loadFiles() {
  if (!analysisId.value) return;
  const resp = await fetch(`/api/files?analysis_id=${analysisId.value}`);
  const data = await resp.json();
  if (!resp.ok) {
    error.value = data.detail || "analysis_id not found";
    return;
  }
  files.value = data.files || [];
  if (files.value.length) {
    selectFile(files.value[0].path);
  }
  await loadHistory();
}

async function selectFile(path) {
  selectedPath.value = path;
  const resp = await fetch(
    `/api/file?analysis_id=${analysisId.value}&path=${encodeURIComponent(path)}`
  );
  const data = await resp.json();
  fileData.value = data;
  viewMode.value = "merge";
  expandedConflicts.value = new Set();
  activeBlockId.value = "";
}

function stopProgressPolling() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgressPolling() {
  stopProgressPolling();
  progressTimer = setInterval(async () => {
    if (!analysisId.value) return;
    try {
      const resp = await fetch(`/api/status?analysis_id=${analysisId.value}`);
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 404) {
          loading.value = false;
          stopProgressPolling();
          await loadFiles();
          return;
        }
        throw new Error(data.detail || "Status unavailable");
      }
      progress.value = { ...progress.value, ...data };
      if (data.state === "done") {
        loading.value = false;
        stopProgressPolling();
        await loadFiles();
      } else if (data.state === "error") {
        loading.value = false;
        stopProgressPolling();
        error.value = data.message || "Analyze failed";
      }
    } catch (err) {
      loading.value = false;
      stopProgressPolling();
      error.value = err.message || "Analyze failed";
    }
  }, 1000);
}

async function pickDir(target) {
  error.value = "";
  try {
    const resp = await fetch("/api/pick-dir");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Pick directory failed");
    if (!data.path) return;
    if (target === "branch") branchDir.value = data.path;
    if (target === "trunk") trunkDir.value = data.path;
    if (target === "merge") mergeDir.value = data.path;
    if (target === "base") baseDir.value = data.path;
    saveLastForm();
  } catch (err) {
    error.value = err.message || "Pick directory failed";
  }
}

function normalizePath(value) {
  if (!value) return "";
  return value.trim().replace(/\//g, "\\");
}

function saveLastForm() {
  try {
    const payload = {
      branch_dir: branchDir.value,
      trunk_dir: trunkDir.value,
      merge_dir: mergeDir.value,
      base_dir: baseDir.value,
    };
    localStorage.setItem(LAST_FORM_KEY, JSON.stringify(payload));
  } catch (err) {
    return;
  }
}

function loadLastForm() {
  try {
    const raw = localStorage.getItem(LAST_FORM_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.branch_dir) branchDir.value = parsed.branch_dir;
    if (parsed.trunk_dir) trunkDir.value = parsed.trunk_dir;
    if (parsed.merge_dir) mergeDir.value = parsed.merge_dir;
    if (parsed.base_dir) baseDir.value = parsed.base_dir;
  } catch (err) {
    return;
  }
}

async function loadHistory() {
  try {
    const resp = await fetch(`/api/history?limit=${HISTORY_LIMIT}`);
    const data = await resp.json();
    if (!resp.ok) return;
    history.value = data.items || [];
  } catch (err) {
    return;
  }
}

function formatHistoryTime(item) {
  const raw = item?.created_at || "";
  if (!raw) return "-";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString();
}

function historyTitle(item) {
  if (!item) return "";
  const roots = item.roots || {};
  const parts = [];
  if (roots.branch) parts.push(`Branch: ${roots.branch}`);
  if (roots.trunk) parts.push(`Trunk: ${roots.trunk}`);
  if (roots.merge) parts.push(`Merge: ${roots.merge}`);
  if (roots.base) parts.push(`Base: ${roots.base}`);
  return parts.join("\n");
}

function openHistory(item) {
  if (!item || !item.id) return;
  if (item.available === false) {
    error.value = "分析结果已失效，请重新分析";
    return;
  }
  const roots = item.roots || {};
  analysisId.value = item.id;
  if (roots.branch) branchDir.value = roots.branch;
  if (roots.trunk) trunkDir.value = roots.trunk;
  if (roots.merge) mergeDir.value = roots.merge;
  if (roots.base) baseDir.value = roots.base;
  saveLastForm();
  error.value = "";
  loading.value = true;
  updateUrlAnalysis(item.id);
  startProgressPolling();
}

function updateUrlAnalysis(id) {
  if (!id) return;
  const url = new URL(window.location.href);
  url.searchParams.set("analysis", id);
  window.history.replaceState({}, "", url);
}

function jumpTo(mode, lineNo) {
  viewMode.value = mode;
  nextTick(() => {
    const el = document.getElementById(`line-${mode}-${lineNo}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function activateBlock(block) {
  if (!block) return;
  activeBlockId.value = block.id;
  const range = getBlockRange(block, viewMode.value);
  if (range) {
    jumpTo(viewMode.value, range.start);
  }
}

function isActiveLine(lineNo) {
  if (!activeBlockId.value) return false;
  const block = blocks.value.find((item) => item.id === activeBlockId.value);
  if (!block) return false;
  const range = getBlockRange(block, viewMode.value);
  if (!range) return false;
  return lineNo >= range.start && lineNo <= range.end;
}

function getBlockRange(block, mode) {
  if (!block) return null;
  if (mode === "merge") return { start: block.start, end: block.end };
  if (mode === "branch" && block.branch_start && block.branch_end) {
    return { start: block.branch_start, end: block.branch_end };
  }
  if (mode === "trunk" && block.trunk_start && block.trunk_end) {
    return { start: block.trunk_start, end: block.trunk_end };
  }
  if (mode === "base" && block.base_start && block.base_end) {
    return { start: block.base_start, end: block.base_end };
  }
  return null;
}

function jumpConflict(direction) {
  if (!conflictBlocks.value.length) return;
  let index = conflictBlocks.value.findIndex(
    (block) => block.id === activeBlockId.value
  );
  if (index === -1) {
    index = direction > 0 ? -1 : 0;
  }
  const nextIndex =
    (index + direction + conflictBlocks.value.length) %
    conflictBlocks.value.length;
  const nextBlock = conflictBlocks.value[nextIndex];
  if (nextBlock) {
    activateBlock(nextBlock);
  }
}

function isConflictExpanded(id) {
  return expandedConflicts.value.has(id);
}

function toggleConflict(id) {
  const next = new Set(expandedConflicts.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedConflicts.value = next;
}

function conflictHasMore(block) {
  if (!block.conflict) return false;
  const left = block.conflict.left_full || [];
  const right = block.conflict.right_full || [];
  const leftPreview = block.conflict.left_preview || [];
  const rightPreview = block.conflict.right_preview || [];
  return left.length > leftPreview.length || right.length > rightPreview.length;
}

function conflictLines(block, side) {
  if (!block.conflict) return [];
  const full = side === "left" ? block.conflict.left_full : block.conflict.right_full;
  if (isConflictExpanded(block.id)) {
    return full && full.length ? full : [];
  }
  if (!full || !full.length) return [];
  if (full.length <= 10) return full;
  const head = full.slice(0, 6);
  const tail = full.slice(-3);
  const gap = full.length - head.length - tail.length;
  return [...head, `... (${gap} more lines)`, ...tail];
}

function isLineInMerge(block, line) {
  if (!block || !line) return false;
  let cached = mergeLineCache.get(block);
  if (!cached) {
    const mergeText = block.diff?.merge || "";
    cached = new Set(mergeText.split("\n"));
    mergeLineCache.set(block, cached);
  }
  return cached.has(line);
}

function buildNoteCopyText(block) {
  const lines = [];
  lines.push(`文件: ${block.file_path || ""}`);
  lines.push(`范围(merge): L${block.start}-L${block.end}`);
  if (block.branch_start && block.branch_end) {
    lines.push(`范围(branch): L${block.branch_start}-L${block.branch_end}`);
  }
  if (block.trunk_start && block.trunk_end) {
    lines.push(`范围(trunk): L${block.trunk_start}-L${block.trunk_end}`);
  }
  if (block.base_start && block.base_end) {
    lines.push(`范围(base): L${block.base_start}-L${block.base_end}`);
  }
  lines.push(`来源: ${block.origin}`);
  if (block.svn) {
    const svn = block.svn;
    const svnParts = [];
    if (svn.rev) svnParts.push(`r${svn.rev}`);
    if (svn.author) svnParts.push(svn.author);
    if (svn.date) svnParts.push(svn.date);
    if (svn.lines) svnParts.push(`${svn.lines} lines`);
    if (svnParts.length) lines.push(`SVN: ${svnParts.join(" ")}`);
  }
  if (block.ai_explain) {
    const ai = block.ai_explain;
    if (ai.merge_reason) lines.push(`合并理由: ${ai.merge_reason}`);
    if (ai.reason) lines.push(`Reason: ${ai.reason}`);
    if (ai.impact) lines.push(`Impact: ${ai.impact}`);
    if (ai.risk) lines.push(`Risk: ${ai.risk}`);
    if (ai.note) lines.push(`Note: ${ai.note}`);
    if (ai.source) lines.push(`Source: ${ai.source}`);
    if (ai.updated_at) lines.push(`Updated: ${ai.updated_at}`);
  }
  if (block.conflict) {
    const conflict = block.conflict;
    if (conflict.note) lines.push(`Conflict: ${conflict.note}`);
    if (conflict.left_count || conflict.right_count) {
      lines.push(
        `ConflictLines: left=${conflict.left_count || 0}, right=${conflict.right_count || 0}`
      );
    }
  }
  return lines.join("\n");
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      ok ? resolve() : reject(new Error("copy failed"));
    } catch (err) {
      document.body.removeChild(textarea);
      reject(err);
    }
  });
}

function copyNote(block) {
  const text = buildNoteCopyText(block);
  copyText(text)
    .then(() => {
      copiedId.value = block.id;
      setTimeout(() => {
        if (copiedId.value === block.id) copiedId.value = "";
      }, 1500);
    })
    .catch((err) => {
      error.value = err.message || "复制失败";
    });
}

function loadAnalysisFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("analysis");
  if (id) {
    analysisId.value = id;
    loading.value = true;
    startProgressPolling();
  }
}

onMounted(() => {
  loadLastForm();
  loadHistory();
  loadAnalysisFromUrl();
});
</script>

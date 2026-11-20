// Pure data, Git status/diff parsing, ChangeSlice & ReviewThread store, commit message derivation,
// review dispatch formatting, and Catppuccin Mocha palette helpers.
// Keep free of Herdr, GPUI, and Node-specific imports.

export const MOD_NAME = "git-status";
export const REVIEW_FILENAME = "herdr-review.json";
export const LEGACY_NOTES_FILENAME = "herdr-agent-notes.json";
export const NOTES_FILENAME = REVIEW_FILENAME;
export const SHARED_BUMP_KEY = "git-status.bump";
export const UNATTRIBUTED_SLICE_ID = "__unattributed__";

// Prevent read-only git calls from touching .git/index or fsmonitor cookies (avoids watch loops).
export const GIT_READ_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

export const CATPPUCCIN_MOCHA_FALLBACK = {
  background: "#1e1e2e",
  surface: "#181825",
  chrome: "#181825",
  canvas: "#11111b",
  popover: "#181825",
  raised: "#313244",
  hover: "#313244",
  selected: "#3b3c4f",
  border: "#313244",
  input: "#585b70",
  foreground: "#cdd6f4",
  muted: "#bac2de",
  dim: "#7f849c",
  accent: "#cba6f7",
  accent_foreground: "#11111b",
  solid: "#cdd6f4",
  solid_foreground: "#11111b",
  ansi1: "#f38ba8", // red
  ansi2: "#a6e3a1", // green
  ansi3: "#f9e2af", // yellow
  ansi4: "#89b4fa", // blue
  ansi5: "#f5c2e7", // pink
  ansi6: "#94e2d5", // teal
};

export function withAlpha(color, alphaHex) {
  const raw = typeof color === "string" ? color.trim() : "";
  const alpha = String(alphaHex || "ff").replace(/^#/, "").slice(0, 2).padStart(2, "0");
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1], g = raw[2], b = raw[3];
    return `#${r}${r}${g}${g}${b}${b}${alpha}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) {
    return `${raw.slice(0, 7)}${alpha}`.toLowerCase();
  }
  return `#cba6f7${alpha}`;
}

export function resolvePalette(themeColors = {}) {
  const t = { ...CATPPUCCIN_MOCHA_FALLBACK, ...(themeColors || {}) };
  return {
    base: t.background,
    mantle: t.surface || t.chrome,
    crust: t.canvas,
    popover: t.popover || t.surface,
    surface0: t.raised,
    hover: t.hover || t.raised,
    selected: t.selected || t.raised,
    border: t.border,
    input: t.input || t.border,
    text: t.foreground,
    subtext: t.muted,
    dim: t.dim,
    mauve: t.accent,
    mauveFg: t.accent_foreground,
    solid: t.solid,
    solidFg: t.solid_foreground,
    red: t.ansi1,
    green: t.ansi2,
    yellow: t.ansi3,
    blue: t.ansi4,
    teal: t.ansi6,
  };
}

export function normalizeSlashes(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function normalizeRepoPath(filePath, repoRoot = "") {
  let clean = normalizeSlashes(filePath).trim();
  if (!clean) return "";
  if (repoRoot) {
    const rootClean = normalizeSlashes(repoRoot).replace(/\/+$/, "");
    if (rootClean) {
      const lowerClean = clean.toLowerCase();
      const lowerRoot = rootClean.toLowerCase();
      if (lowerClean === lowerRoot) return "";
      if (lowerClean.startsWith(`${lowerRoot}/`)) {
        clean = clean.slice(rootClean.length + 1);
      }
    }
  }
  clean = clean.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return clean;
}

export function splitFilePath(repoPath) {
  const clean = normalizeRepoPath(repoPath);
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: clean };
  return {
    dir: clean.slice(0, idx + 1),
    name: clean.slice(idx + 1),
  };
}

export function joinPosixPath(base, rel) {
  const left = normalizeSlashes(base).replace(/\/+$/, "");
  const right = normalizeSlashes(rel).replace(/^\/+/, "");
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

export function resolveWorkspaceLocation({
  spaces = [],
  panes = [],
  focused = null,
  props = null,
  lastCwdBySpace = null,
} = {}) {
  if (props?.cwd) {
    return {
      spaceId: focused?.space ?? null,
      tabId: focused?.tab ?? null,
      cwd: props.cwd,
      on: props.on ?? null,
      branch: null,
    };
  }

  const activeSpace =
    spaces.find((s) => s.active) ??
    (focused?.space ? spaces.find((s) => s.id === focused.space) : null) ??
    null;

  const tabs = activeSpace?.tabs ?? [];
  const activeTab =
    tabs.find((t) => t.active) ??
    (focused?.tab ? tabs.find((t) => t.id === focused.tab) : null) ??
    tabs[0] ??
    null;

  const focusedPane = focused?.pane ? panes.find((p) => p.pane === focused.pane) : null;
  const tabTerminalPane = activeTab
    ? panes.find((p) => p.tab === activeTab.id && p.terminal && p.cwd)
    : null;
  const spaceTabIds = new Set(tabs.map((t) => t.id));
  const spaceTerminalPane = panes.find((p) => spaceTabIds.has(p.tab) && p.terminal && p.cwd) ?? null;

  const directTerminalCwd = (focusedPane?.terminal ? focusedPane.cwd : null) || focused?.cwd || null;
  if (directTerminalCwd && activeSpace?.id && lastCwdBySpace instanceof Map) {
    lastCwdBySpace.set(activeSpace.id, directTerminalCwd);
  }
  const rememberedCwd =
    activeSpace?.id && lastCwdBySpace instanceof Map ? lastCwdBySpace.get(activeSpace.id) ?? null : null;

  const cwd =
    directTerminalCwd ||
    tabTerminalPane?.cwd ||
    rememberedCwd ||
    spaceTerminalPane?.cwd ||
    activeSpace?.folder ||
    null;

  const on =
    focused?.pane === null && focused?.terminal?.includes("/")
      ? focused.terminal.split("/")[0]
      : activeSpace?.machine ?? null;

  const branch =
    (focusedPane?.terminal ? focusedPane.branch : null) ||
    tabTerminalPane?.branch ||
    spaceTerminalPane?.branch ||
    activeSpace?.branch ||
    null;

  return {
    spaceId: activeSpace?.id ?? null,
    spaceName: activeSpace?.name ?? "",
    tabId: activeTab?.id ?? null,
    cwd,
    on,
    branch,
  };
}

export function locationKey(loc) {
  return JSON.stringify({ cwd: loc?.cwd ?? null, on: loc?.on ?? null });
}

export function planPaneToggle({
  spaces = [],
  panes = [],
  focused = null,
  modName = MOD_NAME,
  direction = "right",
} = {}) {
  const space =
    spaces.find((s) => s.active) ??
    (focused?.space ? spaces.find((s) => s.id === focused.space) : null) ??
    null;
  const tabs = space?.tabs ?? [];
  const activeTab =
    tabs.find((t) => t.active) ??
    (focused?.tab ? tabs.find((t) => t.id === focused.tab) : null) ??
    tabs[0] ??
    null;

  if (!space || !activeTab) {
    return { command: "tab.new", args: { name: "Git Review", mod: modName } };
  }

  const tabPanes = panes.filter((p) => p.tab === activeTab.id);
  const existing = tabPanes.find((p) => p.mod === modName);
  if (existing) {
    if (tabPanes.length <= 1) {
      return { command: "tab.close", args: { id: activeTab.id, confirmed: true } };
    }
    return { command: "pane.close", args: { pane: existing.pane } };
  }

  const targetPane =
    focused?.pane && tabPanes.some((p) => p.pane === focused.pane)
      ? focused.pane
      : tabPanes[0]?.pane ?? null;

  if (targetPane) {
    return {
      command: "pane.split",
      args: { direction, pane: targetPane, mod: modName },
    };
  }

  return {
    command: "tab.new",
    args: { name: "Git Review", space: space.id, mod: modName },
  };
}

// ============================================================================
// GIT STATUS, NUMSTAT, STAGING, & DIFF PARSING
// ============================================================================

export function parsePorcelainStatusZ(stdout, limit = 1000) {
  const rawTokens = String(stdout ?? "").split("\0");
  const entries = [];
  let total = 0;

  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i];
    if (!token || token.length < 4) continue;
    const xy = token.slice(0, 2);
    if (xy === "!!") continue;

    const x = xy[0];
    const y = xy[1];
    const path = normalizeRepoPath(token.slice(3));
    let origPath = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      if (i + 1 < rawTokens.length && rawTokens[i + 1]) {
        origPath = normalizeRepoPath(rawTokens[i + 1]);
        i += 1;
      }
    }
    if (!path) continue;
    total += 1;
    if (entries.length >= limit) continue;

    const fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const hasStaged = !fresh && x !== " ";
    const hasUnstaged = fresh || y !== " ";
    const staged = hasStaged && !hasUnstaged;
    const partiallyStaged = hasStaged && hasUnstaged;

    let status = "M";
    if (conflict) status = "U";
    else if (x === "R" || y === "R") status = "R";
    else if (xy === "D " || xy === " D" || (y === "D" && !hasStaged)) status = "D";
    else if (fresh || x === "A" || y === "A") status = "A";
    else if (x === "D") status = "D";

    const { dir, name } = splitFilePath(path);
    entries.push({
      path,
      origPath,
      dir,
      name,
      xy,
      status,
      fresh,
      conflict,
      hasStaged,
      hasUnstaged,
      staged,
      partiallyStaged,
    });
  }

  return { entries, limited: total > limit, total };
}

export function parseNumstatZ(stdout) {
  const stats = {};
  const tokens = String(stdout ?? "").split("\0");
  for (const entry of tokens) {
    if (!entry) continue;
    const parts = entry.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const path = normalizeRepoPath(rest.join("\t"));
    if (!path) continue;
    const prev = stats[path] ?? { add: 0, del: 0, binary: false };
    const binary = a === "-" || d === "-";
    stats[path] = {
      add: prev.add + (binary ? 0 : Number(a) || 0),
      del: prev.del + (binary ? 0 : Number(d) || 0),
      binary: prev.binary || binary,
    };
  }
  return stats;
}

export function mergeStatusAndStats(entries, stagedStats = {}, unstagedStats = {}, untrackedLineCounts = {}) {
  return entries.map((entry) => {
    const st =
      stagedStats[entry.path] ??
      (entry.origPath ? stagedStats[entry.origPath] : null) ??
      { add: 0, del: 0, binary: false };
    const un = unstagedStats[entry.path] ?? { add: 0, del: 0, binary: false };
    const untrackedLines = entry.fresh ? untrackedLineCounts[entry.path] ?? 0 : 0;
    const stagedAdd = st.add;
    const stagedDel = st.del;
    const unstagedAdd = entry.fresh ? untrackedLines : un.add;
    const unstagedDel = un.del;
    return {
      ...entry,
      stagedAdd,
      stagedDel,
      unstagedAdd,
      unstagedDel,
      additions: stagedAdd + unstagedAdd,
      deletions: stagedDel + unstagedDel,
      binary: Boolean(st.binary || un.binary),
    };
  });
}

export function stageCommandArgs(file, hasHead) {
  if (!file?.path) return null;
  if (file.staged) {
    return hasHead ? ["reset", "HEAD", "--", file.path] : ["rm", "--cached", "-r", "--", file.path];
  }
  const paths = file.origPath && file.origPath !== file.path ? [file.origPath, file.path] : [file.path];
  return ["add", "-A", "--", ...paths];
}

export function stagePathsCommandArgs(gitFiles, shouldStage, hasHead) {
  if (!Array.isArray(gitFiles) || gitFiles.length === 0) return null;
  const paths = [];
  for (const f of gitFiles) {
    if (f.origPath && f.origPath !== f.path) paths.push(f.origPath);
    if (f.path) paths.push(f.path);
  }
  const unique = [...new Set(paths)];
  if (!unique.length) return null;
  if (!shouldStage) {
    return hasHead ? ["reset", "HEAD", "--", ...unique] : ["rm", "--cached", "-r", "--", ...unique];
  }
  return ["add", "-A", "--", ...unique];
}

export function stageAllCommandArgs(files, hasHead) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const allStaged = files.every((f) => f.staged);
  if (allStaged) {
    return hasHead ? ["reset", "HEAD"] : ["rm", "--cached", "-r", "."];
  }
  return ["add", "-A"];
}

export function countLines(text) {
  if (!text) return 0;
  const normalized = String(text).replace(/\r\n/g, "\n");
  return normalized.split("\n").length - Number(normalized.endsWith("\n"));
}

export function untab(text) {
  return String(text ?? "").replace(/[^\t]*\t/g, (segment) => {
    const prefix = segment.slice(0, -1);
    return prefix.padEnd(prefix.length - (prefix.length % 4) + 4, " ");
  });
}

export function parseDiffLines(lines) {
  let oldLine = null;
  let newLine = null;
  return (lines ?? []).map((rawLine) => {
    const line = String(rawLine ?? "").replace(/\r$/, "");
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "@", lineNumber: null, text: untab(line) };
    }
    if (line.startsWith("── ")) {
      oldLine = null;
      newLine = null;
      return { kind: "section", lineNumber: null, text: line };
    }
    const kind = line[0];
    if (kind === "+") {
      const num = newLine !== null ? newLine++ : null;
      return { kind: "+", lineNumber: num, text: untab(line) };
    }
    if (kind === "-") {
      const num = oldLine !== null ? oldLine++ : null;
      return { kind: "-", lineNumber: num, text: untab(line) };
    }
    if (kind === " ") {
      if (oldLine !== null) oldLine += 1;
      const num = newLine !== null ? newLine++ : null;
      return { kind: " ", lineNumber: num, text: untab(line) };
    }
    return { kind: "meta", lineNumber: null, text: untab(line) };
  });
}

export function sliceUnifiedHunks(diffStdout) {
  const all = String(diffStdout ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const firstHunk = all.findIndex((line) => line.startsWith("@@"));
  if (firstHunk < 0) return [];
  return all.slice(firstHunk);
}

export function buildUntrackedDiffLines(text, maxLines = 400) {
  if (text === null || text === undefined) {
    return ["Cannot preview this file (binary, too large, or unreadable)"];
  }
  if (String(text).includes("\0")) {
    return ["Binary file · no text diff"];
  }
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\n$/, "");
  const rawLines = normalized ? normalized.split("\n") : [];
  const total = countLines(text);
  const shown = rawLines.slice(0, maxLines).map((l) => `+${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`);
  const out = [`@@ -0,0 +1,${total} @@`, ...shown];
  if (rawLines.length > maxLines) {
    out.push(`… (${rawLines.length - maxLines} more lines omitted)`);
  }
  return out;
}

export function buildFullFileDiffLines({
  fresh = false,
  hasHead = true,
  status = "M",
  binary = false,
  stagedOut = "",
  unstagedOut = "",
  untrackedText = null,
  maxLines = 500,
} = {}) {
  if (fresh || (!hasHead && status === "A" && !stagedOut && untrackedText !== null)) {
    return buildUntrackedDiffLines(untrackedText, maxLines);
  }
  const stagedHunks = sliceUnifiedHunks(stagedOut);
  const unstagedHunks = sliceUnifiedHunks(unstagedOut);

  let combined = [];
  if (stagedHunks.length && unstagedHunks.length) {
    combined = [
      "── Staged changes ──",
      ...stagedHunks,
      "── Unstaged changes ──",
      ...unstagedHunks,
    ];
  } else if (stagedHunks.length) {
    combined = stagedHunks;
  } else if (unstagedHunks.length) {
    combined = unstagedHunks;
  } else {
    return [binary ? "Binary file changed" : "No text diff available"];
  }

  const trimmed = combined.slice(0, maxLines).map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l));
  if (combined.length > maxLines) {
    trimmed.push(`… (${combined.length - maxLines} more diff lines omitted)`);
  }
  return trimmed;
}

export function extractNoteDiffInfo(item) {
  const rawHunk = typeof item?.diffHunk === "string" ? item.diffHunk.replace(/\r\n/g, "\n").trim() : "";
  const explicitRange = typeof item?.lineRange === "string" ? item.lineRange.trim() : "";

  if (!rawHunk) {
    return { lineRange: explicitRange, hasDiff: false, lines: [] };
  }

  if (!rawHunk.includes("\n") && /^L?\d+(?:\s*[-–:]\s*L?\d+)?$/i.test(rawHunk)) {
    const formatted = /^L/i.test(rawHunk) ? rawHunk : `L${rawHunk}`;
    return { lineRange: explicitRange || formatted, hasDiff: false, lines: [] };
  }

  let derivedRange = explicitRange;
  if (!derivedRange) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(rawHunk);
    if (match) {
      const start = Number(match[1]);
      const count = match[2] !== undefined ? Number(match[2]) : 1;
      const end = count > 1 ? start + count - 1 : start;
      derivedRange = end > start ? `L${start}-L${end}` : `L${start}`;
    }
  }

  const lines = rawHunk.split("\n");
  return {
    lineRange: derivedRange,
    hasDiff: lines.length > 0,
    lines,
  };
}

// ============================================================================
// V2 REVIEW DOCUMENT: SLICES, THREADS, SUGGESTED COMMIT (& V1 MIGRATION)
// ============================================================================

export function normalizeSliceFile(raw) {
  if (typeof raw === "string") {
    const fp = normalizeRepoPath(raw);
    return fp ? { filePath: fp } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const filePath = normalizeRepoPath(raw.filePath ?? raw.path ?? "");
  if (!filePath) return null;
  const summary = String(raw.summary ?? raw.description ?? "").replace(/\s+/g, " ").trim();
  const lineRange = String(raw.lineRange ?? raw.lines ?? "").trim();
  const diffHunk = typeof (raw.diffHunk ?? raw.diff) === "string" ? (raw.diffHunk ?? raw.diff).replace(/\r\n/g, "\n").trimEnd() : "";

  const entry = { filePath };
  if (summary) entry.summary = summary;
  if (lineRange) entry.lineRange = lineRange;
  if (diffHunk) entry.diffHunk = diffHunk;
  return entry;
}

export function normalizeSlice(raw, fallbackId = "slice-1", indexOrder = 0) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? raw.summary ?? "").replace(/\s+/g, " ").trim();
  const rawFiles = Array.isArray(raw.files)
    ? raw.files
    : raw.filePath
      ? [{ filePath: raw.filePath, lineRange: raw.lineRange, diffHunk: raw.diffHunk }]
      : [];

  const seenPaths = new Set();
  const files = [];
  for (const item of rawFiles) {
    const normalized = normalizeSliceFile(item);
    if (!normalized || seenPaths.has(normalized.filePath)) continue;
    seenPaths.add(normalized.filePath);
    files.push(normalized);
  }

  if (!title || files.length === 0) return null;

  const id = String(raw.id ?? "").trim() || fallbackId;
  const rationale = String(raw.rationale ?? raw.why ?? "").trim();
  const agentName = String(raw.agentName ?? raw.agent ?? "").trim();
  const parsedTime = raw.timestamp ? Date.parse(String(raw.timestamp)) : NaN;
  const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : indexOrder;

  const slice = {
    id,
    title,
    timestamp,
    order,
    files,
  };
  if (rationale) slice.rationale = rationale;
  if (agentName) slice.agentName = agentName;
  return slice;
}

export function normalizeReviewMessage(raw, fallbackId = "m-1") {
  if (!raw || typeof raw !== "object") return null;
  const body = String(raw.body ?? raw.text ?? "").trim();
  if (!body) return null;
  const role = raw.role === "agent" ? "agent" : "user";
  const author = String(raw.author ?? (role === "agent" ? "pi" : "you")).trim() || (role === "agent" ? "pi" : "you");
  const parsedTime = raw.timestamp ? Date.parse(String(raw.timestamp)) : NaN;
  const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
  return {
    id: String(raw.id ?? "").trim() || fallbackId,
    author,
    role,
    body,
    timestamp,
  };
}

const VALID_THREAD_STATUSES = new Set(["draft", "open", "addressed", "resolved"]);

export function normalizeThread(raw, fallbackId = "t-1") {
  if (!raw || typeof raw !== "object") return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((m, idx) => normalizeReviewMessage(m, `${fallbackId}-m${idx + 1}`))
    .filter(Boolean);

  if (messages.length === 0 && typeof raw.body === "string" && raw.body.trim()) {
    const single = normalizeReviewMessage(
      { body: raw.body, author: raw.author, role: raw.role, timestamp: raw.createdAt },
      `${fallbackId}-m1`,
    );
    if (single) messages.push(single);
  }
  if (messages.length === 0) return null;

  const id = String(raw.id ?? "").trim() || fallbackId;
  const status = VALID_THREAD_STATUSES.has(raw.status) ? raw.status : "draft";
  const filePath = raw.filePath ? normalizeRepoPath(raw.filePath) : "";
  const sliceId = String(raw.sliceId ?? "").trim();
  const lineNumber = Number.isFinite(Number(raw.lineNumber)) && Number(raw.lineNumber) > 0 ? Number(raw.lineNumber) : null;
  const lineRange = String(raw.lineRange ?? (lineNumber ? `L${lineNumber}` : "")).trim();
  const codeExcerpt = typeof raw.codeExcerpt === "string" ? raw.codeExcerpt.replace(/\r\n/g, "\n").trimEnd() : "";

  const createdParsed = raw.createdAt ? Date.parse(String(raw.createdAt)) : NaN;
  const createdAt = Number.isFinite(createdParsed) ? new Date(createdParsed).toISOString() : messages[0].timestamp;
  const updatedParsed = raw.updatedAt ? Date.parse(String(raw.updatedAt)) : NaN;
  const updatedAt = Number.isFinite(updatedParsed)
    ? new Date(updatedParsed).toISOString()
    : messages[messages.length - 1].timestamp;

  const thread = {
    id,
    status,
    createdAt,
    updatedAt,
    messages,
  };
  if (sliceId) thread.sliceId = sliceId;
  if (filePath) thread.filePath = filePath;
  if (lineNumber !== null) thread.lineNumber = lineNumber;
  if (lineRange) thread.lineRange = lineRange;
  if (codeExcerpt) thread.codeExcerpt = codeExcerpt;
  return thread;
}

export function normalizeOverview(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const text = raw.replace(/\r\n/g, "\n").trim();
    if (!text) return null;
    return {
      text,
      updatedAt: new Date(0).toISOString(),
    };
  }
  if (typeof raw !== "object") return null;
  const text = String(raw.text ?? raw.summary ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const agentName = String(raw.agentName ?? raw.agent ?? "").trim();
  const parsedTime = raw.updatedAt ? Date.parse(String(raw.updatedAt)) : NaN;
  const updatedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
  return {
    text,
    ...(agentName ? { agentName } : {}),
    updatedAt,
  };
}

export function normalizeSuggestedCommit(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const [first, ...rest] = trimmed.split(/\r?\n/);
    const body = rest.join("\n").trim();
    return {
      subject: first.trim(),
      ...(body ? { body } : {}),
      updatedAt: new Date(0).toISOString(),
    };
  }
  if (typeof raw !== "object") return null;
  const subject = String(raw.subject ?? raw.message ?? "").replace(/\s+/g, " ").trim();
  if (!subject) return null;
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim() : "";
  const agentName = String(raw.agentName ?? "").trim();
  const parsedTime = raw.updatedAt ? Date.parse(String(raw.updatedAt)) : NaN;
  const updatedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
  return {
    subject,
    ...(body ? { body } : {}),
    ...(agentName ? { agentName } : {}),
    updatedAt,
  };
}

export function emptyReviewDocument() {
  return {
    version: 2,
    overview: null,
    suggestedCommit: null,
    slices: [],
    threads: [],
  };
}

/**
 * Parses a v2 `herdr-review.json` document (or migrates v1 `notes` seamlessly).
 */
export function parseReviewDocument(jsonText, legacyNotesText = "") {
  const source = jsonText && String(jsonText).trim() ? String(jsonText) : String(legacyNotesText ?? "");
  if (!source.trim()) return emptyReviewDocument();

  try {
    const parsed = JSON.parse(source);

    // Migrate v1 `{ notes: [...] }` or bare note array into 1-file Slices
    if (Array.isArray(parsed) || (Array.isArray(parsed?.notes) && !Array.isArray(parsed?.slices))) {
      const rawNotes = Array.isArray(parsed) ? parsed : parsed.notes;
      const slices = [];
      for (let i = 0; i < rawNotes.length; i++) {
        const n = rawNotes[i];
        const s = normalizeSlice(
          {
            id: n?.id || `s-${i + 1}`,
            title: n?.summary ?? n?.title,
            agentName: n?.agentName ?? n?.agent,
            timestamp: n?.timestamp,
            order: i + 1,
            files: [
              {
                filePath: n?.filePath ?? n?.path,
                lineRange: n?.lineRange ?? n?.lines,
                diffHunk: n?.diffHunk ?? n?.diff,
              },
            ],
          },
          `s-${i + 1}`,
          i + 1,
        );
        if (s) slices.push(s);
      }
      return {
        version: 2,
        overview: null,
        suggestedCommit: null,
        slices,
        threads: [],
      };
    }

    const slices = [];
    const seenSlices = new Set();
    const rawSlices = Array.isArray(parsed?.slices) ? parsed.slices : [];
    for (let i = 0; i < rawSlices.length; i++) {
      const s = normalizeSlice(rawSlices[i], `s-${i + 1}`, i + 1);
      if (!s || seenSlices.has(s.id)) continue;
      seenSlices.add(s.id);
      slices.push(s);
    }
    slices.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || Date.parse(a.timestamp) - Date.parse(b.timestamp));

    const threads = [];
    const seenThreads = new Set();
    const rawThreads = Array.isArray(parsed?.threads) ? parsed.threads : [];
    for (let i = 0; i < rawThreads.length; i++) {
      const th = normalizeThread(rawThreads[i], `t-${i + 1}`);
      if (!th || seenThreads.has(th.id)) continue;
      seenThreads.add(th.id);
      threads.push(th);
    }

    const overview = normalizeOverview(parsed?.overview);
    const suggestedCommit = normalizeSuggestedCommit(parsed?.suggestedCommit);
    return {
      version: 2,
      overview,
      suggestedCommit,
      slices,
      threads,
    };
  } catch {
    return emptyReviewDocument();
  }
}

export function serializeReviewDocument(doc) {
  const normalized = parseReviewDocument(JSON.stringify(doc ?? emptyReviewDocument()));
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function upsertSlicesInDocument(
  docText,
  {
    slices: incomingSlices = [],
    overview = undefined,
    suggestedCommit = undefined,
    replaceAll = false,
    nowIso = new Date().toISOString(),
    createId = () => `s-${Date.now()}`,
  } = {},
) {
  const doc = parseReviewDocument(docText);
  const baseList = replaceAll ? [] : [...doc.slices];
  const upserted = [];

  for (let i = 0; i < incomingSlices.length; i++) {
    const raw = incomingSlices[i];
    const matchIdx = baseList.findIndex(
      (existing) =>
        (raw?.id && existing.id === raw.id) ||
        (!raw?.id && raw?.title && existing.title.toLowerCase() === String(raw.title).trim().toLowerCase()),
    );
    const prev = matchIdx >= 0 ? baseList[matchIdx] : null;
    const normalized = normalizeSlice(
      {
        ...prev,
        ...raw,
        id: raw?.id || prev?.id || createId(),
        timestamp: raw?.timestamp || nowIso,
        order: raw?.order ?? prev?.order ?? baseList.length + i + 1,
      },
      createId(),
      baseList.length + i + 1,
    );
    if (!normalized) continue;
    if (matchIdx >= 0) baseList[matchIdx] = normalized;
    else baseList.push(normalized);
    upserted.push(normalized);
  }

  let nextOverview = doc.overview;
  if (overview === null) {
    nextOverview = null;
  } else if (overview !== undefined) {
    nextOverview = normalizeOverview(
      typeof overview === "string"
        ? { text: overview, updatedAt: nowIso }
        : { ...overview, updatedAt: overview.updatedAt || nowIso },
    );
  }

  let nextCommit = doc.suggestedCommit;
  if (suggestedCommit === null) {
    nextCommit = null;
  } else if (suggestedCommit !== undefined) {
    nextCommit = normalizeSuggestedCommit(
      typeof suggestedCommit === "string"
        ? { subject: suggestedCommit, updatedAt: nowIso }
        : { ...suggestedCommit, updatedAt: suggestedCommit.updatedAt || nowIso },
    );
  }

  const nextDoc = {
    version: 2,
    overview: nextOverview,
    suggestedCommit: nextCommit,
    slices: baseList,
    threads: doc.threads,
  };
  return {
    upserted,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function removeSliceFromDocument(docText, sliceId) {
  const doc = parseReviewDocument(docText);
  const nextSlices = doc.slices.filter((s) => s.id !== sliceId);
  const nextDoc = { ...doc, slices: nextSlices };
  return {
    removed: doc.slices.length - nextSlices.length,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function addCommentToDocument(
  docText,
  {
    threadId = "",
    sliceId = "",
    filePath = "",
    lineNumber = null,
    lineRange = "",
    codeExcerpt = "",
    author = "you",
    role = "user",
    body = "",
    status = undefined,
  } = {},
  {
    nowIso = new Date().toISOString(),
    createId = () => `t-${Date.now()}`,
  } = {},
) {
  const trimmedBody = String(body ?? "").trim();
  if (!trimmedBody) throw new Error("Comment body cannot be empty.");

  const doc = parseReviewDocument(docText);
  const threads = [...doc.threads];
  const msg = normalizeReviewMessage(
    {
      id: `m-${createId()}`,
      author,
      role,
      body: trimmedBody,
      timestamp: nowIso,
    },
    `m-${Date.now()}`,
  );

  let targetThread = null;
  if (threadId) {
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      const existing = threads[idx];
      const nextStatus =
        status && VALID_THREAD_STATUSES.has(status)
          ? status
          : role === "agent"
            ? "addressed"
            : "draft";
      targetThread = {
        ...existing,
        status: nextStatus,
        updatedAt: nowIso,
        messages: [...existing.messages, msg],
      };
      threads[idx] = targetThread;
    }
  }

  if (!targetThread) {
    const nextStatus = status && VALID_THREAD_STATUSES.has(status) ? status : role === "agent" ? "addressed" : "draft";
    targetThread = normalizeThread(
      {
        id: threadId || createId(),
        sliceId,
        filePath,
        lineNumber,
        lineRange,
        codeExcerpt,
        status: nextStatus,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: [msg],
      },
      createId(),
    );
    threads.push(targetThread);
  }

  const nextDoc = { ...doc, threads };
  return {
    thread: targetThread,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function setThreadStatusInDocument(docText, threadId, status, nowIso = new Date().toISOString()) {
  if (!VALID_THREAD_STATUSES.has(status)) throw new Error(`Invalid thread status: ${status}`);
  const doc = parseReviewDocument(docText);
  let updated = false;
  const threads = doc.threads.map((t) => {
    if (t.id !== threadId) return t;
    updated = true;
    return { ...t, status, updatedAt: nowIso };
  });
  const nextDoc = { ...doc, threads };
  return {
    updated,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function deleteThreadFromDocument(docText, threadId) {
  const doc = parseReviewDocument(docText);
  const threads = doc.threads.filter((t) => t.id !== threadId);
  const nextDoc = { ...doc, threads };
  return {
    removed: doc.threads.length - threads.length,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function promoteDraftThreadsToOpen(docText, nowIso = new Date().toISOString()) {
  const doc = parseReviewDocument(docText);
  let promotedCount = 0;
  const threads = doc.threads.map((t) => {
    if (t.status !== "draft") return t;
    promotedCount += 1;
    return { ...t, status: "open", updatedAt: nowIso };
  });
  const openThreads = threads.filter((t) => t.status === "open");
  const nextDoc = { ...doc, threads };
  return {
    promotedCount,
    openThreads,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

export function pruneCleanStateInDocument(docText, dirtyPathsSet, { dropResolvedThreads = true } = {}) {
  const doc = parseReviewDocument(docText);
  const keep = dirtyPathsSet instanceof Set ? dirtyPathsSet : new Set(dirtyPathsSet ?? []);

  const slices = [];
  let removedSlices = 0;
  for (const s of doc.slices) {
    const remainingFiles = s.files.filter((f) => keep.has(f.filePath));
    if (remainingFiles.length > 0) {
      slices.push({ ...s, files: remainingFiles });
    } else {
      removedSlices += 1;
    }
  }

  const threads = doc.threads.filter((t) => {
    if (t.status === "resolved" && dropResolvedThreads) return false;
    if (t.filePath && !keep.has(t.filePath) && t.status === "resolved") return false;
    return true;
  });

  const nextDoc = {
    version: 2,
    overview: keep.size === 0 ? null : doc.overview,
    suggestedCommit: keep.size === 0 ? null : doc.suggestedCommit,
    slices,
    threads,
  };
  return {
    removedSlices,
    removedThreads: doc.threads.length - threads.length,
    doc: nextDoc,
    text: serializeReviewDocument(nextDoc),
  };
}

// ============================================================================
// VIEW BUILDERS: BY-SLICE GROUPS (WITH UNATTRIBUTED TRUST BUCKET) & BY-FILE
// ============================================================================

export function countActiveReviewThreads(threads = []) {
  let draft = 0, open = 0, addressed = 0, resolved = 0;
  for (const t of threads) {
    if (t.status === "draft") draft += 1;
    else if (t.status === "open") open += 1;
    else if (t.status === "addressed") addressed += 1;
    else if (t.status === "resolved") resolved += 1;
  }
  return {
    draft,
    open,
    addressed,
    resolved,
    actionableForSubmit: draft + open,
    unresolvedTotal: draft + open,
  };
}

function threadMatchesQuery(thread, q) {
  if (!q) return true;
  if (thread.filePath && thread.filePath.toLowerCase().includes(q)) return true;
  return thread.messages.some(
    (m) => m.body.toLowerCase().includes(q) || m.author.toLowerCase().includes(q),
  );
}

/**
 * Builds logical Slice review cards over live `gitFiles`, guaranteeing 100% visibility of all
 * uncommitted changes by placing any unclaimed files into an `Unattributed Changes` bucket.
 */
export function buildSliceGroups(gitFiles = [], slices = [], threads = [], { filter = "ALL", query = "" } = {}) {
  const fileMap = new Map(gitFiles.map((f) => [f.path, f]));
  const claimedPaths = new Set();
  const rawGroups = [];

  for (const slice of slices) {
    const items = [];
    for (const sf of slice.files) {
      const liveFile = fileMap.get(sf.filePath);
      if (!liveFile) continue;
      claimedPaths.add(sf.filePath);
      const itemThreads = threads.filter(
        (t) => t.filePath === sf.filePath && (!t.sliceId || t.sliceId === slice.id),
      );
      items.push({
        filePath: sf.filePath,
        gitFile: liveFile,
        summary: sf.summary || "",
        lineRange: sf.lineRange || "",
        diffHunk: sf.diffHunk || "",
        threads: itemThreads,
      });
    }

    const sliceLevelThreads = threads.filter((t) => t.sliceId === slice.id && !t.filePath);
    if (items.length === 0 && sliceLevelThreads.filter((t) => t.status !== "resolved").length === 0) {
      continue;
    }

    rawGroups.push(createSliceGroupRecord(slice, items, sliceLevelThreads, false));
  }

  // Trust invariant: collect every dirty file in `git status` not claimed by any active Slice
  const unattributedFiles = gitFiles.filter((f) => !claimedPaths.has(f.path));
  if (unattributedFiles.length > 0) {
    const items = unattributedFiles.map((liveFile) => ({
      filePath: liveFile.path,
      gitFile: liveFile,
      summary: "",
      lineRange: "",
      diffHunk: "",
      threads: threads.filter((t) => t.filePath === liveFile.path),
    }));
    rawGroups.push(
      createSliceGroupRecord(
        {
          id: UNATTRIBUTED_SLICE_ID,
          title: "Unattributed / Manual Changes",
          rationale: "Modified files in git status not yet grouped into an agent change slice.",
          timestamp: new Date(0).toISOString(),
        },
        items,
        threads.filter((t) => t.sliceId === UNATTRIBUTED_SLICE_ID && !t.filePath),
        true,
      ),
    );
  }

  const normFilter = String(filter || "ALL").toUpperCase();
  const q = String(query ?? "").trim().toLowerCase();

  return rawGroups.filter((group) => {
    if (normFilter === "STAGED" && !group.hasStaged) return false;
    if (normFilter === "UNSTAGED" && !group.hasUnstaged) return false;
    if (normFilter === "OPEN" && group.activeThreadCount === 0) return false;

    if (!q) return true;
    if (group.title.toLowerCase().includes(q)) return true;
    if (group.rationale && group.rationale.toLowerCase().includes(q)) return true;
    if (group.agentName && group.agentName.toLowerCase().includes(q)) return true;
    if (group.sliceThreads.some((t) => threadMatchesQuery(t, q))) return true;
    return group.items.some(
      (item) =>
        item.filePath.toLowerCase().includes(q) ||
        (item.summary && item.summary.toLowerCase().includes(q)) ||
        item.threads.some((t) => threadMatchesQuery(t, q)),
    );
  });
}

function createSliceGroupRecord(slice, items, sliceThreads, isUnattributed) {
  const gitFiles = items.map((i) => i.gitFile).filter(Boolean);
  const additions = gitFiles.reduce((acc, f) => acc + (f.additions || 0), 0);
  const deletions = gitFiles.reduce((acc, f) => acc + (f.deletions || 0), 0);
  const hasStaged = gitFiles.some((f) => f.hasStaged);
  const hasUnstaged = gitFiles.some((f) => f.hasUnstaged);
  const staged = gitFiles.length > 0 && gitFiles.every((f) => f.staged);
  const partiallyStaged = hasStaged && hasUnstaged;

  const seenThreadIds = new Set();
  const allThreads = [];
  for (const t of [...sliceThreads, ...items.flatMap((i) => i.threads)]) {
    if (!seenThreadIds.has(t.id)) {
      seenThreadIds.add(t.id);
      allThreads.push(t);
    }
  }
  const activeThreadCount = allThreads.filter((t) => t.status !== "resolved").length;

  return {
    id: slice.id,
    title: slice.title,
    rationale: slice.rationale || "",
    agentName: slice.agentName || "",
    timestamp: slice.timestamp,
    isUnattributed,
    items,
    gitFiles,
    sliceThreads,
    allThreads,
    activeThreadCount,
    additions,
    deletions,
    hasStaged,
    hasUnstaged,
    staged,
    partiallyStaged,
  };
}

export function filterFilesForReview(gitFiles = [], slices = [], threads = [], { filter = "ALL", query = "" } = {}) {
  const normFilter = String(filter || "ALL").toUpperCase();
  const q = String(query ?? "").trim().toLowerCase();

  return gitFiles.filter((file) => {
    const fileThreads = threads.filter((t) => t.filePath === file.path);
    const activeThreads = fileThreads.filter((t) => t.status !== "resolved");
    if (normFilter === "STAGED" && !file.hasStaged) return false;
    if (normFilter === "UNSTAGED" && !file.hasUnstaged) return false;
    if (normFilter === "OPEN" && activeThreads.length === 0) return false;

    if (!q) return true;
    if (file.path.toLowerCase().includes(q)) return true;
    if (fileThreads.some((t) => threadMatchesQuery(t, q))) return true;
    const matchingSlices = slices.filter((s) => s.files.some((sf) => sf.filePath === file.path));
    return matchingSlices.some(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.rationale && s.rationale.toLowerCase().includes(q)) ||
        s.files.some((sf) => sf.filePath === file.path && sf.summary && sf.summary.toLowerCase().includes(q)),
    );
  });
}

// ============================================================================
// REVIEW DISPATCH PROMPT & COMMIT SUGGESTION HELPERS
// ============================================================================

export function formatReviewDispatchPrompt(threads = [], slices = []) {
  const active = threads.filter((t) => t.status === "open" || t.status === "draft");
  if (active.length === 0) return "";

  const sliceTitleById = new Map(slices.map((s) => [s.id, s.title]));
  const lines = [
    `Code review feedback (${active.length} comment${active.length === 1 ? "" : "s"}) from Herdr Git Review:`,
    "",
  ];

  for (let i = 0; i < active.length; i++) {
    const t = active[i];
    const targetParts = [];
    if (t.filePath) targetParts.push(`\`${t.filePath}\``);
    if (t.lineRange) targetParts.push(`(${t.lineRange})`);
    if (t.sliceId && sliceTitleById.has(t.sliceId)) {
      targetParts.push(`— Slice: "${sliceTitleById.get(t.sliceId)}"`);
    }
    const headerTarget = targetParts.length ? targetParts.join(" ") : "General";
    lines.push(`${i + 1}. [Thread \`${t.id}\`] ${headerTarget}`);
    if (t.codeExcerpt) {
      lines.push(`   Code: \`${t.codeExcerpt.replace(/\s+/g, " ").trim().slice(0, 140)}\``);
    }
    for (const m of t.messages) {
      lines.push(`   - ${m.role === "agent" ? `Agent (${m.author})` : "Reviewer"}: ${m.body}`);
    }
    lines.push("");
  }

  lines.push(
    "Please address each review thread above, reply to each `threadId` using `review_threads` (`action: \"reply\"`, `status: \"addressed\"`), and keep `record_change_slices` + `suggestedCommit` updated.",
  );
  return lines.join("\n");
}

export function deriveOverviewInfo({ files = [], slices = [], overview = null } = {}) {
  const additions = files.reduce((acc, f) => acc + (f.additions || 0), 0);
  const deletions = files.reduce((acc, f) => acc + (f.deletions || 0), 0);

  if (overview?.text) {
    return {
      text: overview.text,
      agentName: overview.agentName || "",
      updatedAt: overview.updatedAt || "",
      synthesized: false,
      additions,
      deletions,
    };
  }

  if (!files.length) return null;

  const dirtyPaths = new Set(files.map((f) => f.path));
  const activeSlices = slices.filter((s) => s.files.some((sf) => dirtyPaths.has(sf.filePath)));
  if (activeSlices.length === 1) {
    const s = activeSlices[0];
    return {
      text: s.rationale ? `${s.title} — ${s.rationale}` : s.title,
      agentName: s.agentName || "",
      updatedAt: s.timestamp || "",
      synthesized: true,
      additions,
      deletions,
    };
  }
  if (activeSlices.length > 1) {
    return {
      text: activeSlices.map((s, i) => `${i + 1}. ${s.title}`).join(" · "),
      agentName: activeSlices[0].agentName || "",
      updatedAt: activeSlices[0].timestamp || "",
      synthesized: true,
      additions,
      deletions,
    };
  }

  return {
    text: `${files.length} uncommitted file${files.length === 1 ? "" : "s"} in working tree — no agent summary recorded yet.`,
    agentName: "",
    updatedAt: "",
    synthesized: true,
    additions,
    deletions,
  };
}

export function deriveCommitSuggestion({ files = [], slices = [], suggestedCommit = null } = {}) {
  if (!files.length) return { subject: "", body: "" };

  const stagedFiles = files.filter((f) => f.hasStaged);
  const targetPaths = new Set((stagedFiles.length > 0 ? stagedFiles : files).map((f) => f.path));

  // If user staged a specific subset that cleanly matches a subset of slices, scope the suggestion to those slices
  if (stagedFiles.length > 0 && stagedFiles.length < files.length && slices.length > 1) {
    const matchingSlices = slices.filter((s) => s.files.some((sf) => targetPaths.has(sf.filePath)));
    if (matchingSlices.length === 1) {
      return {
        subject: matchingSlices[0].title,
        body: matchingSlices[0].rationale || "",
      };
    }
    if (matchingSlices.length > 1 && matchingSlices.length < slices.length) {
      return {
        subject: matchingSlices[0].title,
        body: matchingSlices.map((s) => `- ${s.title}`).join("\n"),
      };
    }
  }

  if (suggestedCommit?.subject) {
    return {
      subject: suggestedCommit.subject,
      body: suggestedCommit.body || "",
    };
  }

  const activeSlices = slices.filter((s) => s.files.some((sf) => targetPaths.has(sf.filePath)));
  if (activeSlices.length === 1) {
    return {
      subject: activeSlices[0].title,
      body: activeSlices[0].rationale || "",
    };
  }
  if (activeSlices.length > 1) {
    return {
      subject: activeSlices[0].title,
      body: activeSlices.map((s) => `- ${s.title}`).join("\n"),
    };
  }

  const names = [...targetPaths].slice(0, 3).map((p) => splitFilePath(p).name);
  const more = targetPaths.size > 3 ? ` (+${targetPaths.size - 3} more)` : "";
  return {
    subject: `Update ${names.join(", ")}${more}`,
    body: "",
  };
}

export function buildGitCommitCommands({ subject, body = "", hasStagedFiles = false } = {}) {
  const cleanSubject = String(subject ?? "").trim();
  if (!cleanSubject) return [];
  const cleanBody = String(body ?? "").trim();
  const commitArgs = ["commit", "-m", cleanSubject];
  if (cleanBody) commitArgs.push("-m", cleanBody);
  return hasStagedFiles ? [commitArgs] : [["add", "-A"], commitArgs];
}

export function computeFooterCounts(files = [], slices = [], threads = []) {
  let staged = 0;
  let unstaged = 0;
  for (const f of files) {
    if (f.hasStaged) staged += 1;
    if (f.hasUnstaged) unstaged += 1;
  }
  const threadStats = countActiveReviewThreads(threads);
  return {
    staged,
    unstaged,
    slices: slices.length,
    ...threadStats,
  };
}

export function formatRelativeTime(isoTimestamp, nowMs = Date.now()) {
  const ts = Date.parse(isoTimestamp);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

// Pure data, Git status/diff parsing, AgentChangeNote schema, filtering, and palette helpers.
// Keep this module free of Herdr, GPUI, and Node-specific imports so it runs identically in
// gpui-shell, the agent CLI, and `node --test`.

export const MOD_NAME = "git-status";
export const NOTES_FILENAME = "herdr-agent-notes.json";
export const SHARED_BUMP_KEY = "git-status.bump";

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

/**
 * Safely normalizes `#rgb`, `#rrggbb`, or `#rrggbbaa` and applies a 2-hex-digit alpha suffix.
 */
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

/**
 * Normalizes a file path to a clean repo-relative POSIX path (e.g. `src/auth/session.ts`).
 */
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

/**
 * Resolves the active workspace's working directory and machine without losing context when a
 * mod pane (such as `git-status` itself, where `pane.cwd` is null) holds keyboard focus.
 */
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

/**
 * Decides how `mod.open:git-status` toggles the workspace pane in the active tab.
 */
export function planPaneToggle({ spaces = [], panes = [], focused = null, modName = MOD_NAME, direction = "right" } = {}) {
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
    return { command: "tab.new", args: { name: "Git Changes", mod: modName } };
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
    args: { name: "Git Changes", space: space.id, mod: modName },
  };
}

/**
 * Parses `git status --porcelain=v1 -z` output, including rename/copy pairs (`R`/`C`),
 * untracked files (`??`), unmerged conflicts (`U`, `AA`, `DD`), and staged/unstaged flags.
 */
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

/**
 * Parses `git diff [--cached] --numstat -z --no-renames` output.
 */
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
    const st = stagedStats[entry.path] ?? (entry.origPath ? stagedStats[entry.origPath] : null) ?? { add: 0, del: 0, binary: false };
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

/**
 * Builds git argument list to toggle staging on a single file safely (even on unborn HEAD).
 */
export function stageCommandArgs(file, hasHead) {
  if (!file?.path) return null;
  if (file.staged) {
    return hasHead ? ["reset", "HEAD", "--", file.path] : ["rm", "--cached", "-r", "--", file.path];
  }
  const paths = file.origPath && file.origPath !== file.path ? [file.origPath, file.path] : [file.path];
  return ["add", "-A", "--", ...paths];
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

/**
 * Parses unified diff lines (or raw `+/-` snippet lines) into structured rows with optional line numbers.
 */
export function parseDiffLines(lines) {
  let oldLine = null;
  let newLine = null;
  return (lines ?? []).map((rawLine) => {
    const line = String(rawLine ?? "").replace(/\r$/, "");
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "@", text: untab(line) };
    }
    if (line.startsWith("── ")) {
      oldLine = null;
      newLine = null;
      return { kind: "section", text: line };
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

/**
 * Extracts displayable line range & diff snippet lines from an `AgentChangeNote`.
 * Supports both standalone line-range values in `diffHunk` (e.g. `"L24-L35"`) and unified/raw diff blocks.
 */
export function extractNoteDiffInfo(note) {
  const rawHunk = typeof note?.diffHunk === "string" ? note.diffHunk.replace(/\r\n/g, "\n").trim() : "";
  const explicitRange = typeof note?.lineRange === "string" ? note.lineRange.trim() : "";

  if (!rawHunk) {
    return { lineRange: explicitRange, hasDiff: false, lines: [] };
  }

  // Standalone short line-range string in diffHunk, e.g. "L24-L35" or "24-35"
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

/**
 * Validates and normalizes a discrete `AgentChangeNote`.
 */
export function normalizeAgentNote(raw, fallbackId = "note") {
  if (!raw || typeof raw !== "object") return null;
  const filePath = normalizeRepoPath(raw.filePath ?? raw.path ?? "");
  const summary = String(raw.summary ?? raw.description ?? "").replace(/\s+/g, " ").trim();
  if (!filePath || !summary) return null;

  const id = String(raw.id ?? "").trim() || fallbackId;
  const agentRaw = String(raw.agentName ?? raw.agent ?? "").trim();
  const timestampRaw = String(raw.timestamp ?? "").trim();
  const parsedTime = timestampRaw ? Date.parse(timestampRaw) : NaN;
  const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
  const diffHunkRaw = typeof (raw.diffHunk ?? raw.diff) === "string" ? (raw.diffHunk ?? raw.diff).replace(/\r\n/g, "\n").trimEnd() : "";
  const lineRangeRaw = typeof (raw.lineRange ?? raw.lines) === "string" ? (raw.lineRange ?? raw.lines).trim() : "";

  const note = {
    id,
    filePath,
    summary,
    timestamp,
  };
  if (agentRaw) note.agentName = agentRaw;
  if (diffHunkRaw) note.diffHunk = diffHunkRaw;
  if (lineRangeRaw) note.lineRange = lineRangeRaw;
  return note;
}

export function parseNotesDocument(jsonText) {
  if (!jsonText || !String(jsonText).trim()) return [];
  try {
    const parsed = JSON.parse(String(jsonText));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.notes) ? parsed.notes : [];
    const seen = new Set();
    const notes = [];
    for (let i = 0; i < list.length; i++) {
      const normalized = normalizeAgentNote(list[i], `note-${i + 1}`);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      notes.push(normalized);
    }
    notes.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return notes;
  } catch {
    return [];
  }
}

export function serializeNotesDocument(notes) {
  const clean = [];
  const seen = new Set();
  for (let i = 0; i < (notes ?? []).length; i++) {
    const normalized = normalizeAgentNote(notes[i], `note-${i + 1}`);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    clean.push(normalized);
  }
  clean.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return `${JSON.stringify({ version: 1, notes: clean }, null, 2)}\n`;
}

export function appendNoteToDocument(jsonText, input, { nowIso = new Date().toISOString(), createId = () => `n-${Date.now()}` } = {}) {
  const existing = parseNotesDocument(jsonText);
  const candidate = normalizeAgentNote(
    {
      ...input,
      id: input?.id || createId(),
      timestamp: input?.timestamp || nowIso,
    },
    createId(),
  );
  if (!candidate) {
    throw new Error("AgentChangeNote requires both filePath and summary.");
  }
  const filtered = existing.filter((n) => n.id !== candidate.id);
  const next = [candidate, ...filtered];
  return {
    note: candidate,
    notes: next,
    text: serializeNotesDocument(next),
  };
}

export function removeNoteFromDocument(jsonText, noteId) {
  const existing = parseNotesDocument(jsonText);
  const next = existing.filter((n) => n.id !== noteId);
  return {
    removed: existing.length - next.length,
    notes: next,
    text: serializeNotesDocument(next),
  };
}

export function clearNotesInDocument(jsonText, { filePath = null, keepPaths = null } = {}) {
  const existing = parseNotesDocument(jsonText);
  let next = [];
  if (keepPaths instanceof Set) {
    next = existing.filter((n) => keepPaths.has(n.filePath));
  } else if (filePath) {
    const target = normalizeRepoPath(filePath);
    next = existing.filter((n) => n.filePath !== target);
  }
  return {
    removed: existing.length - next.length,
    notes: next,
    text: serializeNotesDocument(next),
  };
}

export function groupNotesByFile(notes) {
  const map = new Map();
  for (const note of notes ?? []) {
    const path = normalizeRepoPath(note.filePath);
    if (!path) continue;
    const bucket = map.get(path);
    if (bucket) bucket.push(note);
    else map.set(path, [note]);
  }
  return map;
}

export function filterFiles(files, notesByFile, { filter = "ALL", query = "" } = {}) {
  const normalizedFilter = String(filter || "ALL").toUpperCase();
  const q = String(query ?? "").trim().toLowerCase();

  return (files ?? []).filter((file) => {
    const fileNotes = notesByFile instanceof Map ? notesByFile.get(file.path) ?? [] : [];
    if (normalizedFilter === "STAGED" && !file.hasStaged) return false;
    if (normalizedFilter === "UNSTAGED" && !file.hasUnstaged) return false;
    if (normalizedFilter === "NOTES" && fileNotes.length === 0) return false;

    if (!q) return true;
    if (file.path.toLowerCase().includes(q)) return true;
    if (file.origPath && file.origPath.toLowerCase().includes(q)) return true;

    return fileNotes.some(
      (n) =>
        n.summary.toLowerCase().includes(q) ||
        (n.agentName && n.agentName.toLowerCase().includes(q)) ||
        (n.lineRange && n.lineRange.toLowerCase().includes(q)),
    );
  });
}

export function computeFooterCounts(files, notesByFile) {
  let staged = 0;
  let unstaged = 0;
  let notes = 0;
  for (const f of files ?? []) {
    if (f.hasStaged) staged += 1;
    if (f.hasUnstaged) unstaged += 1;
    if (notesByFile instanceof Map) {
      notes += (notesByFile.get(f.path) ?? []).length;
    }
  }
  return { staged, unstaged, notes };
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

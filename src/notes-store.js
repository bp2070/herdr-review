import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GIT_READ_ARGS,
  LEGACY_NOTES_FILENAME,
  REVIEW_FILENAME,
  addCommentToDocument,
  buildUntrackedDiffLines,
  deleteThreadFromDocument,
  emptyReviewDocument,
  normalizeRepoPath,
  parsePorcelainStatusZ,
  parseReviewDocument,
  pruneCleanStateInDocument,
  removeSliceFromDocument,
  serializeReviewDocument,
  setThreadStatusInDocument,
  sliceUnifiedHunks,
  upsertSlicesInDocument,
} from "../mods/git-status/model.js";

function safeRealpath(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return fsSync.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      return path.join(safeRealpath(parent), path.basename(resolved));
    }
    return resolved;
  }
}

export function resolveRepoRelativePath(rawFilePath, cwd, repoRoot) {
  const raw = String(rawFilePath ?? "").trim();
  if (!raw) return "";
  const realRoot = safeRealpath(repoRoot);
  const realCwd = safeRealpath(cwd);
  const candidate = path.isAbsolute(raw)
    ? safeRealpath(raw)
    : safeRealpath(path.resolve(realCwd, raw));
  const rel = path.relative(realRoot, candidate);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return normalizeRepoPath(rel);
  }
  return normalizeRepoPath(raw, realRoot);
}

export function resolveGitPaths(cwd = process.cwd()) {
  const realCwd = safeRealpath(cwd);
  const repoRootRaw = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: realCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const repoRoot = safeRealpath(repoRootRaw);
  const gitDirRaw = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const gitDir = safeRealpath(path.resolve(repoRoot, gitDirRaw));
  const reviewFile = path.join(gitDir, REVIEW_FILENAME);
  const legacyNotesFile = path.join(gitDir, LEGACY_NOTES_FILENAME);
  return { repoRoot, gitDir, reviewFile, notesFile: reviewFile, legacyNotesFile };
}

export function captureAutoDiffHunk(repoRoot, repoRelativePath) {
  for (const extra of [[], ["--cached"]]) {
    try {
      const out = execFileSync(
        "git",
        [...GIT_READ_ARGS, "diff", ...extra, "--no-ext-diff", "--no-textconv", "--no-color", "-U2", "--", repoRelativePath],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const hunks = sliceUnifiedHunks(out);
      if (hunks.length > 0) {
        return hunks.slice(0, 45).join("\n");
      }
    } catch {
      // Ignore diff capture errors
    }
  }
  try {
    execFileSync("git", [...GIT_READ_ARGS, "ls-files", "--error-unmatch", "--", repoRelativePath], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    try {
      const text = fsSync.readFileSync(path.join(repoRoot, repoRelativePath), "utf8");
      if (!text.includes("\0")) {
        return buildUntrackedDiffLines(text, 25).join("\n");
      }
    } catch {
      // Ignore unreadable file
    }
  }
  return "";
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}

async function readReviewRaw(reviewFile, legacyNotesFile) {
  const current = await readTextIfExists(reviewFile);
  if (current.trim()) return current;
  const legacy = await readTextIfExists(legacyNotesFile);
  if (legacy.trim()) {
    return serializeReviewDocument(parseReviewDocument("", legacy));
  }
  return "";
}

async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      await fs.writeFile(filePath, content, "utf8");
      await fs.unlink(tempPath).catch(() => {});
      return;
    }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function readReviewState({ cwd = process.cwd() } = {}) {
  const { repoRoot, gitDir, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const raw = await readReviewRaw(reviewFile, legacyNotesFile);
  const doc = parseReviewDocument(raw);
  return { repoRoot, gitDir, reviewFile, doc };
}

export async function upsertReviewSlices({
  cwd = process.cwd(),
  slices = [],
  overview = undefined,
  suggestedCommit = undefined,
  replaceAll = false,
  agentName = "pi",
  autoHunk = true,
} = {}) {
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const current = await readReviewRaw(reviewFile, legacyNotesFile);

  const normalizedIncoming = slices.map((s) => {
    const rawFiles = Array.isArray(s.files)
      ? s.files
      : s.filePath
        ? [{ filePath: s.filePath, summary: s.fileSummary, lineRange: s.lineRange, diffHunk: s.diffHunk }]
        : [];
    const files = rawFiles
      .map((f) => {
        const entry = typeof f === "string" ? { filePath: f } : { ...f };
        const normPath = resolveRepoRelativePath(entry.filePath, cwd, repoRoot);
        if (!normPath) return null;
        let diffHunk = entry.diffHunk;
        if (!diffHunk && autoHunk) {
          diffHunk = captureAutoDiffHunk(repoRoot, normPath);
        }
        return {
          ...entry,
          filePath: normPath,
          ...(diffHunk ? { diffHunk } : {}),
        };
      })
      .filter(Boolean);

    return {
      ...s,
      agentName: s.agentName || agentName,
      files,
    };
  });

  const overviewInput =
    overview && typeof overview === "object"
      ? { ...overview, agentName: overview.agentName || agentName }
      : typeof overview === "string"
        ? { text: overview, agentName }
        : overview;

  const commitInput =
    suggestedCommit && typeof suggestedCommit === "object"
      ? { ...suggestedCommit, agentName: suggestedCommit.agentName || agentName }
      : suggestedCommit;

  const result = upsertSlicesInDocument(current, {
    slices: normalizedIncoming,
    overview: overviewInput,
    suggestedCommit: commitInput,
    replaceAll,
    nowIso: new Date().toISOString(),
    createId: () => `s-${randomUUID().slice(0, 8)}`,
  });

  await writeAtomic(reviewFile, result.text);
  return {
    repoRoot,
    reviewFile,
    upserted: result.upserted,
    doc: result.doc,
  };
}

export async function removeReviewSlice({ cwd = process.cwd(), id } = {}) {
  if (!id) throw new Error("Slice id is required.");
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const current = await readReviewRaw(reviewFile, legacyNotesFile);
  const result = removeSliceFromDocument(current, id);
  if (result.removed > 0) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, removed: result.removed, doc: result.doc };
}

export async function addReviewComment({
  cwd = process.cwd(),
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
} = {}) {
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const current = await readReviewRaw(reviewFile, legacyNotesFile);
  const normFile = filePath ? resolveRepoRelativePath(filePath, cwd, repoRoot) : "";

  const result = addCommentToDocument(
    current,
    {
      threadId,
      sliceId,
      filePath: normFile,
      lineNumber,
      lineRange,
      codeExcerpt,
      author,
      role,
      body,
      status,
    },
    {
      nowIso: new Date().toISOString(),
      createId: () => `t-${randomUUID().slice(0, 8)}`,
    },
  );

  await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, thread: result.thread, doc: result.doc };
}

export async function updateReviewThreadStatus({ cwd = process.cwd(), threadId, status } = {}) {
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const current = await readReviewRaw(reviewFile, legacyNotesFile);
  const result = setThreadStatusInDocument(current, threadId, status, new Date().toISOString());
  if (result.updated) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, updated: result.updated, doc: result.doc };
}

export async function deleteReviewThread({ cwd = process.cwd(), threadId } = {}) {
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  const current = await readReviewRaw(reviewFile, legacyNotesFile);
  const result = deleteThreadFromDocument(current, threadId);
  if (result.removed > 0) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, removed: result.removed, doc: result.doc };
}

export async function pruneOrClearReviewState({ cwd = process.cwd(), pruneClean = false } = {}) {
  const { repoRoot, reviewFile, legacyNotesFile } = resolveGitPaths(cwd);
  if (!pruneClean) {
    const emptyText = serializeReviewDocument(emptyReviewDocument());
    await writeAtomic(reviewFile, emptyText);
    await fs.unlink(legacyNotesFile).catch(() => {});
    return { repoRoot, reviewFile, doc: emptyReviewDocument() };
  }

  const current = await readReviewRaw(reviewFile, legacyNotesFile);
  const statusOut = execFileSync(
    "git",
    [...GIT_READ_ARGS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = parsePorcelainStatusZ(statusOut, 10000);
  const dirtyPaths = new Set(parsed.entries.map((e) => e.path));
  const result = pruneCleanStateInDocument(current, dirtyPaths, { dropResolvedThreads: true });
  await writeAtomic(reviewFile, result.text);
  return {
    repoRoot,
    reviewFile,
    removedSlices: result.removedSlices,
    removedThreads: result.removedThreads,
    doc: result.doc,
  };
}

// Backward-compatible v1 helper exports
export async function addAgentNote({
  cwd = process.cwd(),
  filePath,
  summary,
  agentName,
  diffHunk,
  lineRange,
  autoHunk = false,
  id,
} = {}) {
  const res = await upsertReviewSlices({
    cwd,
    agentName,
    autoHunk,
    slices: [
      {
        id,
        title: summary,
        agentName,
        files: [{ filePath, lineRange, diffHunk }],
      },
    ],
  });
  const s = res.upserted[0];
  const f = s?.files?.[0] ?? {};
  return {
    repoRoot: res.repoRoot,
    notesFile: res.reviewFile,
    note: {
      id: s.id,
      filePath: f.filePath,
      summary: s.title,
      agentName: s.agentName,
      timestamp: s.timestamp,
      diffHunk: f.diffHunk,
      lineRange: f.lineRange,
    },
    total: res.doc.slices.length,
  };
}

export async function listAgentNotes({ cwd = process.cwd(), filePath = "" } = {}) {
  const { repoRoot, reviewFile, doc } = await readReviewState({ cwd });
  const target = filePath ? resolveRepoRelativePath(filePath, cwd, repoRoot) : "";
  const notes = [];
  for (const s of doc.slices) {
    for (const f of s.files) {
      if (target && f.filePath !== target) continue;
      notes.push({
        id: s.id,
        filePath: f.filePath,
        summary: f.summary || s.title,
        sliceTitle: s.title,
        agentName: s.agentName,
        timestamp: s.timestamp,
        diffHunk: f.diffHunk,
        lineRange: f.lineRange,
      });
    }
  }
  return { repoRoot, notesFile: reviewFile, notes, doc };
}

export async function removeAgentNote({ cwd = process.cwd(), id } = {}) {
  const res = await removeReviewSlice({ cwd, id });
  return { repoRoot: res.repoRoot, notesFile: res.reviewFile, removed: res.removed, remaining: res.doc.slices.length };
}

export async function clearAgentNotes({ cwd = process.cwd(), pruneClean = false } = {}) {
  const res = await pruneOrClearReviewState({ cwd, pruneClean });
  return {
    repoRoot: res.repoRoot,
    notesFile: res.reviewFile,
    removed: res.removedSlices ?? 0,
    remaining: res.doc.slices.length,
  };
}

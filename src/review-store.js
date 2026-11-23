import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GIT_READ_ARGS,
  REVIEW_FILENAME,
  addCommentToDocument,
  buildUntrackedDiffLines,
  deleteThreadFromDocument,
  emptyReviewDocument,
  normalizeRepoPath,
  parsePorcelainStatusZ,
  parseReviewDocument,
  pruneCleanStateInDocument,
  removeTopicFromDocument,
  serializeReviewDocument,
  setThreadStatusInDocument,
  sliceUnifiedHunks,
  upsertTopicsInDocument,
} from "../mods/review/model.js";

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
  return { repoRoot, gitDir, reviewFile };
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

function readHeadSha(repoRoot) {
  try {
    const out = execFileSync("git", [...GIT_READ_ARGS, "rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readDirtyPathsSet(repoRoot) {
  try {
    const statusOut = execFileSync(
      "git",
      [...GIT_READ_ARGS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = parsePorcelainStatusZ(statusOut, 10000);
    return new Set(parsed.entries.map((e) => e.path));
  } catch {
    return null;
  }
}

export async function readReviewState({ cwd = process.cwd() } = {}) {
  const { repoRoot, gitDir, reviewFile } = resolveGitPaths(cwd);
  const raw = await readTextIfExists(reviewFile);
  if (!raw.trim()) {
    return { repoRoot, gitDir, reviewFile, doc: emptyReviewDocument() };
  }
  const parsedDoc = parseReviewDocument(raw);
  const dirtyPaths = readDirtyPathsSet(repoRoot);
  const headSha = readHeadSha(repoRoot);
  if (dirtyPaths) {
    const headChanged = Boolean(headSha && parsedDoc.headSha && headSha !== parsedDoc.headSha);
    const hasCleanTopicFiles = parsedDoc.topics.some((t) =>
      t.files.some((f) => !dirtyPaths.has(f.filePath)),
    );
    const hasStaleEmptyState =
      dirtyPaths.size === 0 &&
      Boolean(
        parsedDoc.headSha ||
          parsedDoc.overview ||
          parsedDoc.suggestedCommit ||
          parsedDoc.topics.length > 0 ||
          parsedDoc.threads.some((t) => t.status === "resolved"),
      );
    if (headChanged || hasCleanTopicFiles || hasStaleEmptyState) {
      const pruned = pruneCleanStateInDocument(raw, dirtyPaths, {
        dropResolvedThreads: true,
        headSha,
      });
      await writeAtomic(reviewFile, pruned.text).catch(() => {});
      return { repoRoot, gitDir, reviewFile, doc: pruned.doc };
    }
  }
  return { repoRoot, gitDir, reviewFile, doc: parsedDoc };
}

export async function upsertReviewTopics({
  cwd = process.cwd(),
  topics = [],
  overview = undefined,
  suggestedCommit = undefined,
  replaceAll = false,
  agentName = "pi",
  autoHunk = true,
} = {}) {
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  const headSha = readHeadSha(repoRoot);
  let current = await readTextIfExists(reviewFile);
  if (current.trim() && !replaceAll) {
    const dirtyPaths = readDirtyPathsSet(repoRoot);
    if (dirtyPaths) {
      current = pruneCleanStateInDocument(current, dirtyPaths, {
        dropResolvedThreads: true,
        headSha,
      }).text;
    }
  }

  const normalizedIncoming = topics.map((t) => {
    const rawFiles = Array.isArray(t.files) ? t.files : [];
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
      ...t,
      agentName: t.agentName || agentName,
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

  const result = upsertTopicsInDocument(current, {
    topics: normalizedIncoming,
    overview: overviewInput,
    suggestedCommit: commitInput,
    headSha,
    replaceAll,
    nowIso: new Date().toISOString(),
    createId: () => `tpc-${randomUUID().slice(0, 8)}`,
  });

  await writeAtomic(reviewFile, result.text);
  return {
    repoRoot,
    reviewFile,
    upserted: result.upserted,
    doc: result.doc,
  };
}

export async function removeReviewTopic({ cwd = process.cwd(), id } = {}) {
  if (!id) throw new Error("Topic id is required.");
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(reviewFile);
  const result = removeTopicFromDocument(current, id);
  if (result.removed > 0) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, removed: result.removed, doc: result.doc };
}

export async function addReviewComment({
  cwd = process.cwd(),
  threadId = "",
  topicId = "",
  filePath = "",
  lineNumber = null,
  lineRange = "",
  codeExcerpt = "",
  author = "you",
  role = "user",
  body = "",
  status = undefined,
} = {}) {
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(reviewFile);
  const normFile = filePath ? resolveRepoRelativePath(filePath, cwd, repoRoot) : "";

  const result = addCommentToDocument(
    current,
    {
      threadId,
      topicId,
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
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(reviewFile);
  const result = setThreadStatusInDocument(current, threadId, status, new Date().toISOString());
  if (result.updated) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, updated: result.updated, doc: result.doc };
}

export async function deleteReviewThread({ cwd = process.cwd(), threadId } = {}) {
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(reviewFile);
  const result = deleteThreadFromDocument(current, threadId);
  if (result.removed > 0) await writeAtomic(reviewFile, result.text);
  return { repoRoot, reviewFile, removed: result.removed, doc: result.doc };
}

export async function pruneOrClearReviewState({ cwd = process.cwd(), pruneClean = false } = {}) {
  const { repoRoot, reviewFile } = resolveGitPaths(cwd);
  if (!pruneClean) {
    const emptyText = serializeReviewDocument(emptyReviewDocument());
    await writeAtomic(reviewFile, emptyText);
    return { repoRoot, reviewFile, doc: emptyReviewDocument() };
  }

  const current = await readTextIfExists(reviewFile);
  const statusOut = execFileSync(
    "git",
    [...GIT_READ_ARGS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = parsePorcelainStatusZ(statusOut, 10000);
  const dirtyPaths = new Set(parsed.entries.map((e) => e.path));
  const headSha = readHeadSha(repoRoot);
  const result = pruneCleanStateInDocument(current, dirtyPaths, {
    dropResolvedThreads: true,
    headSha,
  });
  await writeAtomic(reviewFile, result.text);
  return {
    repoRoot,
    reviewFile,
    removedTopics: result.removedTopics,
    removedThreads: result.removedThreads,
    doc: result.doc,
  };
}

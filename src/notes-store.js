import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  NOTES_FILENAME,
  GIT_READ_ARGS,
  appendNoteToDocument,
  clearNotesInDocument,
  normalizeRepoPath,
  parseNotesDocument,
  parsePorcelainStatusZ,
  removeNoteFromDocument,
  sliceUnifiedHunks,
} from "../mods/git-status/model.js";

function safeRealpath(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return fsSync.realpathSync.native(resolved);
  } catch {
    // Target file might be deleted in working tree; canonicalize nearest existing ancestor
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
  const candidate = path.isAbsolute(raw) ? safeRealpath(raw) : safeRealpath(path.resolve(realCwd, raw));
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
  const notesFile = path.join(gitDir, NOTES_FILENAME);
  return { repoRoot, gitDir, notesFile };
}

export function captureAutoDiffHunk(repoRoot, repoRelativePath) {
  for (const extra of [[], ["--cached"]]) {
    try {
      const out = execFileSync(
        "git",
        [...GIT_READ_ARGS, "diff", ...extra, "--no-ext-diff", "--no-textconv", "--no-color", "-U1", "--", repoRelativePath],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const hunks = sliceUnifiedHunks(out);
      if (hunks.length > 0) {
        return hunks.slice(0, 40).join("\n");
      }
    } catch {
      // Ignore diff capture errors
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

export async function listAgentNotes({ cwd = process.cwd(), filePath = "" } = {}) {
  const { repoRoot, notesFile } = resolveGitPaths(cwd);
  const raw = await readTextIfExists(notesFile);
  const all = parseNotesDocument(raw);
  if (!filePath) return { repoRoot, notesFile, notes: all };
  const target = resolveRepoRelativePath(filePath, cwd, repoRoot);
  return {
    repoRoot,
    notesFile,
    notes: all.filter((n) => n.filePath === target),
  };
}

export async function addAgentNote({
  cwd = process.cwd(),
  filePath,
  summary,
  agentName,
  diffHunk,
  lineRange,
  autoHunk = false,
  id,
  timestamp,
} = {}) {
  const { repoRoot, notesFile } = resolveGitPaths(cwd);
  const normalizedPath = resolveRepoRelativePath(filePath, cwd, repoRoot);

  if (!normalizedPath) {
    throw new Error("A repository-relative filePath is required.");
  }

  let resolvedHunk = diffHunk;
  if (!resolvedHunk && autoHunk) {
    resolvedHunk = captureAutoDiffHunk(repoRoot, normalizedPath);
  }

  const current = await readTextIfExists(notesFile);
  const result = appendNoteToDocument(
    current,
    {
      id,
      filePath: normalizedPath,
      summary,
      agentName,
      timestamp,
      diffHunk: resolvedHunk,
      lineRange,
    },
    {
      nowIso: new Date().toISOString(),
      createId: () => `n-${randomUUID().slice(0, 8)}`,
    },
  );
  await writeAtomic(notesFile, result.text);
  return { repoRoot, notesFile, note: result.note, total: result.notes.length };
}

export async function removeAgentNote({ cwd = process.cwd(), id } = {}) {
  if (!id) throw new Error("Note id is required.");
  const { repoRoot, notesFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(notesFile);
  const result = removeNoteFromDocument(current, id);
  if (result.removed > 0) {
    await writeAtomic(notesFile, result.text);
  }
  return { repoRoot, notesFile, removed: result.removed, remaining: result.notes.length };
}

export async function clearAgentNotes({ cwd = process.cwd(), filePath = "", pruneClean = false } = {}) {
  const { repoRoot, notesFile } = resolveGitPaths(cwd);
  const current = await readTextIfExists(notesFile);

  let keepPaths = null;
  let targetPath = null;
  if (pruneClean) {
    const statusOut = execFileSync(
      "git",
      [...GIT_READ_ARGS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = parsePorcelainStatusZ(statusOut, 10000);
    keepPaths = new Set(parsed.entries.map((e) => e.path));
  } else if (filePath) {
    targetPath = resolveRepoRelativePath(filePath, cwd, repoRoot);
  }

  const result = clearNotesInDocument(current, { filePath: targetPath, keepPaths });
  await writeAtomic(notesFile, result.text);
  return { repoRoot, notesFile, removed: result.removed, remaining: result.notes.length };
}

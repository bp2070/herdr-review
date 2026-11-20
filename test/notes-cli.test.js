import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "bin", "herdr-git-note.mjs");

test("herdr-git-note CLI stores discrete notes in <git-dir>/herdr-agent-notes.json without dirtying git status, including linked worktrees", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-git-notes-test-"));
  const mainRepo = path.join(tmpRoot, "main");
  const linkedWt = path.join(tmpRoot, "linked-wt");

  try {
    await fs.mkdir(mainRepo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });

    await fs.mkdir(path.join(mainRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(mainRepo, "src", "poller.ts"), "export const delay = 1000;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: mainRepo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: mainRepo });

    // Modify file in main repo and record note with --auto-hunk
    await fs.writeFile(path.join(mainRepo, "src", "poller.ts"), "export const delay = calcJitter(200);\n", "utf8");
    const addOut = execFileSync(
      process.execPath,
      [
        cliPath,
        "add",
        "--cwd",
        mainRepo,
        "--file",
        "src/poller.ts",
        "--summary",
        "Replaced fixed delay with jittered backoff",
        "--agent",
        "pi",
        "--auto-hunk",
        "--json",
      ],
      { encoding: "utf8" },
    );
    const added = JSON.parse(addOut);
    assert.equal(added.note.filePath, "src/poller.ts");
    assert.equal(added.note.agentName, "pi");
    assert.match(added.note.diffHunk, /calcJitter/);

    // Verify git status only sees src/poller.ts (notes file inside .git is invisible to git status)
    const statusMain = execFileSync("git", ["status", "--porcelain=v1"], { cwd: mainRepo, encoding: "utf8" }).trim();
    assert.equal(statusMain, "M src/poller.ts");

    // Create linked worktree and verify isolated per-worktree <git-dir> storage
    execFileSync("git", ["worktree", "add", "-b", "feat-wt", linkedWt], { cwd: mainRepo });
    const listWtEmpty = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", linkedWt, "--json"], { encoding: "utf8" }),
    );
    assert.equal(listWtEmpty.notes.length, 0);

    execFileSync(
      process.execPath,
      [
        cliPath,
        "add",
        "--cwd",
        linkedWt,
        "--file",
        "src/poller.ts",
        "--summary",
        "Worktree-specific note",
        "--agent",
        "subagent",
      ],
      { encoding: "utf8" },
    );

    const listWtAfter = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", linkedWt, "--json"], { encoding: "utf8" }),
    );
    assert.equal(listWtAfter.notes.length, 1);
    assert.equal(listWtAfter.notes[0].agentName, "subagent");

    // Linked worktree git status remains completely clean!
    const statusWt = execFileSync("git", ["status", "--porcelain=v1"], { cwd: linkedWt, encoding: "utf8" }).trim();
    assert.equal(statusWt, "");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

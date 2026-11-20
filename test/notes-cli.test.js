import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addReviewComment } from "../src/notes-store.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "bin", "herdr-git-note.mjs");

test("herdr-git-note CLI stores multi-file slices, suggested commits, and thread replies in <git-dir>/herdr-review.json across worktrees", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-git-review-test-"));
  const mainRepo = path.join(tmpRoot, "main");
  const linkedWt = path.join(tmpRoot, "linked-wt");

  try {
    await fs.mkdir(mainRepo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });

    await fs.mkdir(path.join(mainRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(mainRepo, "src", "poller.ts"), "export const delay = 1000;\n", "utf8");
    await fs.writeFile(path.join(mainRepo, "src", "types.ts"), "export type Config = {};\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: mainRepo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: mainRepo });

    await fs.writeFile(path.join(mainRepo, "src", "poller.ts"), "export const delay = calcJitter(200);\n", "utf8");
    await fs.writeFile(path.join(mainRepo, "src", "types.ts"), "export type Config = { maxJitterMs: number };\n", "utf8");

    const sliceOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cliPath,
          "slice",
          "--cwd",
          mainRepo,
          "--title",
          "Add configurable jitter to outbox poller",
          "--overview",
          "Introduces bounded exponential backoff jitter in the outbox poller.",
          "--files",
          "src/poller.ts,src/types.ts",
          "--commit",
          "feat(outbox): add configurable retry jitter",
          "--agent",
          "pi",
          "--json",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(sliceOut.upserted.length, 1);
    assert.equal(sliceOut.upserted[0].files.length, 2);
    assert.match(sliceOut.doc.overview.text, /bounded exponential backoff/);
    assert.equal(sliceOut.doc.suggestedCommit.subject, "feat(outbox): add configurable retry jitter");
    assert.match(sliceOut.upserted[0].files[0].diffHunk, /calcJitter/);

    // Simulate reviewer comment + CLI agent reply
    const userThread = await addReviewComment({
      cwd: mainRepo,
      filePath: "src/poller.ts",
      lineNumber: 1,
      lineRange: "L1",
      author: "you",
      role: "user",
      body: "Clamp maxJitterMs to 5000",
      status: "open",
    });

    const replyOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cliPath,
          "reply",
          "--cwd",
          mainRepo,
          "--thread",
          userThread.thread.id,
          "--body",
          "Clamped maxJitterMs to 5000ms.",
          "--agent",
          "pi",
          "--json",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(replyOut.thread.status, "addressed");
    assert.equal(replyOut.thread.messages.length, 2);

    // Ensure git status only sees the 2 source files
    const statusMain = execFileSync("git", ["status", "--porcelain=v1"], { cwd: mainRepo, encoding: "utf8" }).trim();
    assert.equal(statusMain, "M src/poller.ts\n M src/types.ts");

    // Linked worktree isolation check
    execFileSync("git", ["worktree", "add", "-b", "feat-wt", linkedWt], { cwd: mainRepo });
    const listWt = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", linkedWt, "--json"], { encoding: "utf8" }),
    );
    assert.equal(listWt.doc.slices.length, 0);
    assert.equal(listWt.doc.threads.length, 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

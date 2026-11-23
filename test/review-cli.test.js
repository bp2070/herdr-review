import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addReviewComment } from "../src/review-store.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoDir, "bin", "herdr-review.mjs");

test("herdr-review CLI stores multi-file topics, overview, suggested commits, and thread replies in <git-dir>/herdr-review.json across worktrees", async () => {
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

    const topicOut = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cliPath,
          "topic",
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
    assert.equal(topicOut.upserted.length, 1);
    assert.equal(topicOut.upserted[0].files.length, 2);
    assert.match(topicOut.doc.overview.text, /bounded exponential backoff/);
    assert.equal(topicOut.doc.suggestedCommit.subject, "feat(outbox): add configurable retry jitter");
    assert.match(topicOut.upserted[0].files[0].diffHunk, /calcJitter/);

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

    const statusMain = execFileSync("git", ["status", "--porcelain=v1"], { cwd: mainRepo, encoding: "utf8" }).trim();
    assert.equal(statusMain, "M src/poller.ts\n M src/types.ts");

    execFileSync("git", ["worktree", "add", "-b", "feat-wt", linkedWt], { cwd: mainRepo });
    const listWt = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", linkedWt, "--json"], { encoding: "utf8" }),
    );
    assert.equal(listWt.doc.topics.length, 0);
    assert.equal(listWt.doc.threads.length, 0);

    // Committing changes in mainRepo automatically clears stale overview, suggestedCommit, and committed topics
    execFileSync("git", ["add", "."], { cwd: mainRepo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feat(outbox): add configurable retry jitter"], {
      cwd: mainRepo,
    });
    const listAfterCommit = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", mainRepo, "--json"], { encoding: "utf8" }),
    );
    assert.equal(listAfterCommit.doc.overview, null);
    assert.equal(listAfterCommit.doc.suggestedCommit, null);
    assert.equal(listAfterCommit.doc.topics.length, 0);
    assert.equal(listAfterCommit.doc.headSha, null);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("herdr-review CLI preserves summary on single-file revert and resets it when a partial commit advances HEAD", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-review-headsha-"));
  const repo = path.join(tmpRoot, "repo");

  try {
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "c.ts"), "export const c = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: repo });

    const head1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf8");
    await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = 2;\n", "utf8");

    const upserted = JSON.parse(
      execFileSync(process.execPath, [cliPath, "upsert-json"], {
        input: JSON.stringify({
          cwd: repo,
          overview: "Updates a and b together.",
          suggestedCommit: { subject: "feat: update a and b" },
          topics: [
            {
              id: "tpc-ab",
              title: "Update a and b",
              files: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }],
            },
          ],
        }),
        encoding: "utf8",
      }),
    );
    assert.equal(upserted.doc.headSha, head1);

    // Reverting one file in the topic (without committing) + partial upsert keeps overview & suggestedCommit
    execFileSync("git", ["checkout", "--", "src/b.ts"], { cwd: repo });
    await fs.writeFile(path.join(repo, "src", "c.ts"), "export const c = 2;\n", "utf8");
    const partialUpsert = JSON.parse(
      execFileSync(process.execPath, [cliPath, "upsert-json"], {
        input: JSON.stringify({
          cwd: repo,
          topics: [{ id: "tpc-c", title: "Update c", files: [{ filePath: "src/c.ts" }] }],
        }),
        encoding: "utf8",
      }),
    );
    assert.equal(partialUpsert.doc.headSha, head1);
    assert.equal(partialUpsert.doc.overview?.text, "Updates a and b together.");
    assert.equal(partialUpsert.doc.suggestedCommit?.subject, "feat: update a and b");

    // Committing only src/a.ts advances HEAD, clearing stale overview & suggestedCommit while keeping tpc-c
    execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feat: update a"], { cwd: repo });
    const head2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(head2, head1);

    const afterPartialCommit = JSON.parse(
      execFileSync(process.execPath, [cliPath, "list", "--cwd", repo, "--json"], { encoding: "utf8" }),
    );
    assert.equal(afterPartialCommit.doc.headSha, head2);
    assert.equal(afterPartialCommit.doc.overview, null);
    assert.equal(afterPartialCommit.doc.suggestedCommit, null);
    assert.equal(afterPartialCommit.doc.topics.length, 1);
    assert.equal(afterPartialCommit.doc.topics[0].id, "tpc-c");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

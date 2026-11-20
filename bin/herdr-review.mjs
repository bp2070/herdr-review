#!/usr/bin/env node
import fs from "node:fs";
import {
  addReviewComment,
  pruneOrClearReviewState,
  readReviewState,
  removeReviewTopic,
  updateReviewThreadStatus,
  upsertReviewTopics,
} from "../src/review-store.js";

function usage() {
  return `Usage:
  herdr-review topic --title <text> --files <p1,p2> [--overview <text>] [--rationale <text>] [--commit <subject>] [--body <text>] [--agent <name>] [--cwd <dir>] [--json]
  herdr-review reply --thread <id> --body <text> [--status addressed|open|resolved] [--agent <name>] [--cwd <dir>] [--json]
  herdr-review list [--cwd <dir>] [--json]
  herdr-review remove --id <topic-id> [--cwd <dir>] [--json]
  herdr-review clear [--prune-clean] [--cwd <dir>] [--json]
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "prune-clean" || key === "replace-all" || key === "help") {
      args[key] = true;
    } else {
      args[key] = argv[++i] ?? "";
    }
  }
  return args;
}

function detectDefaultAgent() {
  if (process.env.HERDR_AGENT) return process.env.HERDR_AGENT;
  if (process.env.PI_SUBAGENT_NAME) return process.env.PI_SUBAGENT_NAME;
  if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
  if (Object.keys(process.env).some((k) => k.startsWith("PI_"))) return "pi";
  if (process.env.CLAUDECODE) return "claude";
  return "agent";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  if (!sub || sub === "help" || args.help) {
    process.stdout.write(usage());
    return;
  }
  const cwd = args.cwd || process.cwd();

  if (sub === "topic") {
    const files = String(args.files || args.file || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const suggestedCommit = args.commit
      ? { subject: args.commit, ...(args.body ? { body: args.body } : {}) }
      : undefined;
    const overview = args.overview || undefined;
    const topics = args.title
      ? [
          {
            id: args.id,
            title: args.title,
            rationale: args.rationale || "",
            files,
          },
        ]
      : [];
    const res = await upsertReviewTopics({
      cwd,
      agentName: args.agent || detectDefaultAgent(),
      replaceAll: Boolean(args["replace-all"]),
      overview,
      suggestedCommit,
      topics,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.upserted.length > 0) {
      process.stdout.write(`Upserted topic "${res.upserted[0]?.title}" (${res.doc.topics.length} topics total)\n`);
    } else {
      process.stdout.write(`Updated review overview/commit (${res.doc.topics.length} topics total)\n`);
    }
    return;
  }

  if (sub === "upsert-json") {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const incoming = Array.isArray(payload.topics)
      ? payload.topics
      : Array.isArray(payload.slices)
        ? payload.slices
        : [];
    const res = await upsertReviewTopics({
      cwd: payload.cwd || cwd,
      topics: incoming,
      overview: payload.overview,
      suggestedCommit: payload.suggestedCommit,
      replaceAll: Boolean(payload.replaceAll),
      agentName: payload.agentName || detectDefaultAgent(),
      autoHunk: payload.autoHunk !== false,
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  if (sub === "reply-json") {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const targetCwd = payload.cwd || cwd;
    const who = payload.agentName || detectDefaultAgent();
    const updatedIds = [];
    for (const r of payload.replies ?? []) {
      const saved = await addReviewComment({
        cwd: targetCwd,
        threadId: r.threadId,
        author: who,
        role: "agent",
        body: r.body,
        status: r.status || "addressed",
      });
      updatedIds.push(saved.thread.id);
    }
    process.stdout.write(`${JSON.stringify({ updatedIds })}\n`);
    return;
  }

  if (sub === "reply") {
    if (args.status && !args.body) {
      const res = await updateReviewThreadStatus({ cwd, threadId: args.thread || args.id, status: args.status });
      if (args.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else process.stdout.write(`Updated thread ${args.thread || args.id} -> ${args.status}\n`);
      return;
    }
    const res = await addReviewComment({
      cwd,
      threadId: args.thread || args.id,
      author: args.agent || detectDefaultAgent(),
      role: "agent",
      body: args.body,
      status: args.status || "addressed",
    });
    if (args.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else process.stdout.write(`Replied to thread ${res.thread.id} (${res.thread.status})\n`);
    return;
  }

  if (sub === "list") {
    const res = await readReviewState({ cwd });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    const { topics, threads, overview, suggestedCommit } = res.doc;
    if (overview?.text) {
      process.stdout.write(`Overview: ${overview.text}\n`);
    }
    if (suggestedCommit?.subject) {
      process.stdout.write(`Suggested Commit: ${suggestedCommit.subject}\n`);
    }
    if (topics.length === 0) {
      process.stdout.write("No change topics recorded.\n");
    } else {
      for (const t of topics) {
        const paths = t.files.map((f) => f.filePath).join(", ");
        process.stdout.write(`[${t.id}] ${t.title} (${paths})\n`);
      }
    }
    if (threads.length > 0) {
      process.stdout.write(`\nReview Threads (${threads.length}):\n`);
      for (const t of threads) {
        const last = t.messages[t.messages.length - 1];
        process.stdout.write(`  [${t.id}] (${t.status}) ${t.filePath || "general"}: ${last?.body || ""}\n`);
      }
    }
    return;
  }

  if (sub === "remove") {
    const res = await removeReviewTopic({ cwd, id: args.id });
    if (args.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else process.stdout.write(`Removed ${res.removed} topic(s)\n`);
    return;
  }

  if (sub === "clear") {
    const res = await pruneOrClearReviewState({ cwd, pruneClean: Boolean(args["prune-clean"]) });
    if (args.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    else process.stdout.write(`Cleaned review state (${res.doc.topics.length} topics, ${res.doc.threads.length} threads remaining)\n`);
    return;
  }

  throw new Error(`Unknown command: ${sub}\n\n${usage()}`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});

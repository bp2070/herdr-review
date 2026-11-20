#!/usr/bin/env node
import fs from "node:fs";
import {
  addAgentNote,
  clearAgentNotes,
  listAgentNotes,
  removeAgentNote,
} from "../src/notes-store.js";

function usage() {
  return `Usage:
  herdr-git-note add --file <path> --summary <text> [--agent <name>] [--lines <L1-L9>] [--hunk <diff|->] [--auto-hunk] [--cwd <dir>] [--json]
  herdr-git-note list [--file <path>] [--cwd <dir>] [--json]
  herdr-git-note remove --id <note-id> [--cwd <dir>] [--json]
  herdr-git-note clear [--file <path>] [--prune-clean] [--cwd <dir>] [--json]
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
    if (key === "json" || key === "auto-hunk" || key === "prune-clean" || key === "help") {
      args[key] = true;
    } else {
      args[key] = argv[++i] ?? "";
    }
  }
  return args;
}

function detectDefaultAgent() {
  if (process.env.HERDR_AGENT) return process.env.HERDR_AGENT;
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

  if (sub === "add") {
    let diffHunk = args.hunk ?? "";
    if (diffHunk === "-") {
      diffHunk = fs.readFileSync(0, "utf8");
    }
    const res = await addAgentNote({
      cwd,
      filePath: args.file || args.path,
      summary: args.summary || args.desc,
      agentName: args.agent || detectDefaultAgent(),
      lineRange: args.lines || args["line-range"] || "",
      diffHunk,
      autoHunk: Boolean(args["auto-hunk"]),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(`Recorded note ${res.note.id} on ${res.note.filePath} (${res.total} total)\n`);
    }
    return;
  }

  if (sub === "list") {
    const res = await listAgentNotes({ cwd, filePath: args.file || args.path || "" });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.notes.length === 0) {
      process.stdout.write("No agent change notes recorded.\n");
    } else {
      for (const n of res.notes) {
        const who = n.agentName ? `[${n.agentName}] ` : "";
        const range = n.lineRange ? ` (${n.lineRange})` : "";
        process.stdout.write(`${n.id}  ${n.filePath}${range}  ${who}${n.summary}\n`);
      }
    }
    return;
  }

  if (sub === "remove") {
    const res = await removeAgentNote({ cwd, id: args.id });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(`Removed ${res.removed} note(s) (${res.remaining} remaining)\n`);
    }
    return;
  }

  if (sub === "clear") {
    const res = await clearAgentNotes({
      cwd,
      filePath: args.file || args.path || "",
      pruneClean: Boolean(args["prune-clean"]),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(`Cleared ${res.removed} note(s) (${res.remaining} remaining)\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${sub}\n\n${usage()}`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});

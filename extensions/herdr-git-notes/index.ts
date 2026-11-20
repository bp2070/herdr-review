import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const extDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(extDir, "..", "..", "bin", "herdr-git-note.mjs");

function runCliJson(args: string[], stdinPayload?: unknown): any {
  const out = execFileSync("node", [cliPath, ...args], {
    input: stdinPayload !== undefined ? JSON.stringify(stdinPayload) : undefined,
    encoding: "utf8",
    stdio: [stdinPayload !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function safeRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      return path.join(safeRealpath(parent), path.basename(resolved));
    }
    return resolved;
  }
}

function resolveTrackedGitTarget(rawPath: string, baseCwd: string): { repoRoot: string; filePath: string } | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  const absCandidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseCwd, rawPath);
  const startDir = path.dirname(absCandidate);

  try {
    const repoRootRaw = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const realRoot = safeRealpath(repoRootRaw);
    const realTarget = safeRealpath(absCandidate);
    const rel = path.relative(realRoot, realTarget).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || rel.startsWith(".git/") || rel === ".git") return null;

    try {
      execFileSync("git", ["check-ignore", "-q", "--", rel], {
        cwd: realRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return null;
    } catch {
      // Exit code 1 => not ignored
    }

    return { repoRoot: realRoot, filePath: rel };
  } catch {
    return null;
  }
}

const SliceFileSchema = Type.Object({
  filePath: Type.String({
    description: "Repository-relative or absolute path to a file belonging to this logical slice",
  }),
  summary: Type.Optional(
    Type.String({
      description: "Optional 1-line note specific to this file's role within the slice",
    }),
  ),
  lineRange: Type.Optional(
    Type.String({
      description: "Optional line range such as 'L18-L32'",
    }),
  ),
  diffHunk: Type.Optional(
    Type.String({
      description: "Optional specific diff hunk; omit to auto-capture live git diff",
    }),
  ),
});

const SliceEntrySchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Optional stable slice ID when updating an existing slice",
    }),
  ),
  title: Type.String({
    description: "Concise 1-line headline describing this logical group of changes",
  }),
  rationale: Type.Optional(
    Type.String({
      description: "Optional 1-2 sentence explanation of why this slice was made or key trade-offs",
    }),
  ),
  order: Type.Optional(
    Type.Number({
      description: "Optional reading order (1, 2, 3...)",
    }),
  ),
  files: Type.Array(SliceFileSchema, {
    description: "Files affected by this logical change slice",
  }),
});

const SuggestedCommitSchema = Type.Object({
  subject: Type.String({
    description: "Concise 1-line commit subject summarizing the active changeset",
  }),
  body: Type.Optional(
    Type.String({
      description: "Optional multi-line commit body (e.g. bullet points for key slices)",
    }),
  ),
});

export const RecordChangeSlicesParams = Type.Object({
  action: Type.Optional(
    StringEnum(["upsert", "list", "remove", "clear"] as const, {
      description: "Operation to perform (defaults to 'upsert')",
    }),
  ),
  overview: Type.Optional(
    Type.String({
      description:
        "High-level 1-3 sentence overall summary of the changeset displayed at the top of Herdr Git Review",
    }),
  ),
  slices: Type.Optional(
    Type.Array(SliceEntrySchema, {
      description: "Logical change slices grouping related file modifications for code review",
    }),
  ),
  suggestedCommit: Type.Optional(SuggestedCommitSchema),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: "When true on 'upsert', replaces all previous slices with this fresh set",
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: "Slice ID when action is 'remove'",
    }),
  ),
  pruneClean: Type.Optional(
    Type.Boolean({
      description: "When action is 'clear', remove only slices/resolved-threads for clean committed files",
    }),
  ),
  agentName: Type.Optional(
    Type.String({
      description: "Optional agent identifier override (defaults to 'pi' or active subagent)",
    }),
  ),
});

export type RecordChangeSlicesInput = Static<typeof RecordChangeSlicesParams>;

const ThreadReplyEntrySchema = Type.Object({
  threadId: Type.String({
    description: "Target review thread ID (e.g. 't-1234abcd')",
  }),
  body: Type.String({
    description: "Concise response explaining how the review comment was addressed or answered",
  }),
  status: Type.Optional(
    StringEnum(["addressed", "open", "resolved"] as const, {
      description: "Updated thread status (defaults to 'addressed')",
    }),
  ),
});

export const ReviewThreadsParams = Type.Object({
  action: StringEnum(["list", "reply", "resolve"] as const, {
    description: "'list' open/active threads, 'reply' to reviewer comments, or 'resolve' a thread",
  }),
  replies: Type.Optional(
    Type.Array(ThreadReplyEntrySchema, {
      description: "One or more thread replies (when action is 'reply')",
    }),
  ),
  threadId: Type.Optional(
    Type.String({
      description: "Single thread ID (for single 'reply' or 'resolve')",
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: "Reply text when replying to a single threadId",
    }),
  ),
  status: Type.Optional(
    StringEnum(["addressed", "open", "resolved"] as const, {
      description: "Optional status override for single reply",
    }),
  ),
});

function detectAgentName(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.PI_SUBAGENT_NAME) return process.env.PI_SUBAGENT_NAME;
  if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
  if (process.env.HERDR_AGENT) return process.env.HERDR_AGENT;
  return "pi";
}

export default function herdrGitReviewExtension(pi: ExtensionAPI) {
  const unattributedEdits = new Map<string, { repoRoot: string; filePath: string }>();
  let updatedOverviewThisRun = false;
  let updatedSuggestedCommitThisRun = false;
  let remindedThisRun = false;

  const markSliceFilesRecorded = (repoRoot: string, paths: string[]) => {
    for (const fp of paths) {
      unattributedEdits.delete(`${repoRoot.toLowerCase()}\0${fp}`);
    }
  };

  pi.registerTool({
    name: "record_change_slices",
    label: "Record Change Slices",
    description:
      "Record a high-level overall summary, logical multi-file Change Slices, and a suggested commit message in <git-dir>/herdr-review.json for Herdr's Git Review workspace pane.",
    promptSnippet:
      "Record an overall summary, logical review Slices, and a suggested commit message for Herdr Git Review",
    promptGuidelines: [
      "After modifying or creating repository files with `edit` or `write`, call `record_change_slices` with a concise high-level `overview`, logical `slices` grouping related file changes by intent, and an up-to-date `suggestedCommit` (`{ subject, body? }`).",
    ],
    parameters: RecordChangeSlicesParams,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { action: params.action ?? "upsert" } };
      }

      const action = params.action ?? "upsert";
      const cwd = ctx.cwd;

      if (action === "list") {
        const res = runCliJson(["list", "--cwd", cwd, "--json"]);
        const lines: string[] = [];
        if (res.doc.overview?.text) {
          lines.push(`Overview: ${res.doc.overview.text}`);
        }
        if (res.doc.suggestedCommit?.subject) {
          lines.push(`Suggested Commit: ${res.doc.suggestedCommit.subject}`);
        }
        if (res.doc.slices.length === 0) {
          lines.push("No change slices recorded.");
        } else {
          for (const s of res.doc.slices) {
            const filesList = s.files.map((f: any) => f.filePath).join(", ");
            lines.push(`[${s.id}] ${s.title} (${filesList})`);
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { action: "list", totalSlices: res.doc.slices.length },
        };
      }

      if (action === "remove") {
        if (!params.id) throw new Error("`id` is required when action is 'remove'.");
        const res = runCliJson(["remove", "--cwd", cwd, "--id", params.id, "--json"]);
        return {
          content: [{ type: "text", text: `Removed ${res.removed} slice(s) (${res.doc.slices.length} remaining).` }],
          details: { action: "remove", totalSlices: res.doc.slices.length },
        };
      }

      if (action === "clear") {
        const extra = params.pruneClean ? ["--prune-clean"] : [];
        const res = runCliJson(["clear", "--cwd", cwd, ...extra, "--json"]);
        return {
          content: [
            {
              type: "text",
              text: `Cleaned review state (${res.doc.slices.length} slice(s), ${res.doc.threads.length} thread(s) remaining).`,
            },
          ],
          details: { action: "clear", totalSlices: res.doc.slices.length },
        };
      }

      const slices = Array.isArray(params.slices) ? params.slices : [];
      if (slices.length === 0 && !params.suggestedCommit && !params.overview) {
        throw new Error("Provide `slices`, `overview`, and/or `suggestedCommit` when action is 'upsert'.");
      }

      // Resolve absolute file paths against ctx.cwd first so subdirectory paths are never double-prefixed
      let effectiveCwd = cwd;
      const resolvedSlices = slices.map((s) => ({
        ...s,
        files: s.files.map((f) => {
          const absFile = path.isAbsolute(f.filePath) ? f.filePath : path.resolve(cwd, f.filePath);
          return { ...f, filePath: absFile };
        }),
      }));

      const firstAbsFile = resolvedSlices[0]?.files?.[0]?.filePath;
      if (firstAbsFile) {
        effectiveCwd = path.dirname(firstAbsFile);
      }

      const saved = runCliJson(["upsert-json"], {
        cwd: effectiveCwd,
        slices: resolvedSlices,
        overview: params.overview,
        suggestedCommit: params.suggestedCommit,
        replaceAll: Boolean(params.replaceAll),
        agentName: detectAgentName(params.agentName),
        autoHunk: true,
      });

      const recordedPaths = saved.upserted.flatMap((s: any) => s.files.map((f: any) => f.filePath));
      markSliceFilesRecorded(saved.repoRoot, recordedPaths);
      if (params.overview) updatedOverviewThisRun = true;
      if (params.suggestedCommit?.subject) updatedSuggestedCommitThisRun = true;

      const commitMsg = saved.doc.suggestedCommit?.subject
        ? ` | commit: "${saved.doc.suggestedCommit.subject}"`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${saved.upserted.length} slice(s) across ${recordedPaths.length} file entry/entries (${saved.doc.slices.length} total slices)${commitMsg}.`,
          },
        ],
        details: {
          action: "upsert",
          upsertedSlices: saved.upserted.length,
          totalSlices: saved.doc.slices.length,
        },
      };
    },

    renderCall(args, theme) {
      const action = args.action ?? "upsert";
      if (action === "upsert") {
        const count = Array.isArray(args.slices) ? args.slices.length : 0;
        const commitInfo = args.suggestedCommit?.subject ? ` "${args.suggestedCommit.subject}"` : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("record_change_slices "))}${theme.fg("accent", `${count} slice(s)`)}${theme.fg("muted", commitInfo)}`,
          0,
          0,
        );
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("record_change_slices "))}${theme.fg("muted", action)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const textBlock = result.content?.find((c) => c.type === "text");
      const summary = textBlock && "text" in textBlock ? textBlock.text : "";
      return new Text(theme.fg(result.isError ? "error" : "dim", summary), 0, 0);
    },
  });

  pi.registerTool({
    name: "review_threads",
    label: "Review Threads",
    description:
      "List open code-review threads from Herdr Git Review or post agent replies marking threads as addressed.",
    promptSnippet:
      "List or reply to inline code-review threads submitted from the Herdr Git Review pane",
    promptGuidelines: [
      "When addressing review comments from Herdr Git Review, reply to each `[Thread id]` via `review_threads` (`action: 'reply'`, `status: 'addressed'`) explaining the fix or answer.",
    ],
    parameters: ReviewThreadsParams,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { action: params.action } };
      }

      const cwd = ctx.cwd;
      if (params.action === "list") {
        const res = runCliJson(["list", "--cwd", cwd, "--json"]);
        const active = res.doc.threads.filter((t: any) => t.status !== "resolved");
        if (active.length === 0) {
          return {
            content: [{ type: "text", text: "No open or active review threads." }],
            details: { action: "list", count: 0 },
          };
        }
        const lines = active.map((t: any) => {
          const loc = [t.filePath, t.lineRange].filter(Boolean).join(" ");
          const msgs = t.messages.map((m: any) => `  ${m.author} (${m.role}): ${m.body}`).join("\n");
          return `[${t.id}] (${t.status}) ${loc || "General"}\n${msgs}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n\n") }],
          details: { action: "list", count: active.length },
        };
      }

      if (params.action === "resolve") {
        if (!params.threadId) throw new Error("`threadId` is required when action is 'resolve'.");
        const res = runCliJson(["reply", "--cwd", cwd, "--thread", params.threadId, "--status", "resolved", "--json"]);
        return {
          content: [
            {
              type: "text",
              text: res.updated ? `Resolved thread ${params.threadId}.` : `Thread ${params.threadId} not found.`,
            },
          ],
          details: { action: "resolve", updated: res.updated },
        };
      }

      const replies =
        Array.isArray(params.replies) && params.replies.length > 0
          ? params.replies
          : params.threadId && params.body
            ? [{ threadId: params.threadId, body: params.body, status: params.status }]
            : [];

      if (replies.length === 0) {
        throw new Error("Provide `replies` (or `threadId` + `body`) when action is 'reply'.");
      }

      const res = runCliJson(["reply-json"], {
        cwd,
        agentName: detectAgentName(),
        replies,
      });

      return {
        content: [
          {
            type: "text",
            text: `Replied to ${res.updatedIds.length} review thread(s): ${res.updatedIds.join(", ")}.`,
          },
        ],
        details: { action: "reply", count: res.updatedIds.length },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("review_threads "))}${theme.fg("accent", args.action)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const textBlock = result.content?.find((c) => c.type === "text");
      const summary = textBlock && "text" in textBlock ? textBlock.text : "";
      return new Text(theme.fg(result.isError ? "error" : "dim", summary), 0, 0);
    },
  });

  pi.on("agent_start", async () => {
    unattributedEdits.clear();
    updatedOverviewThisRun = false;
    updatedSuggestedCommitThisRun = false;
    remindedThisRun = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const state = runCliJson(["list", "--cwd", ctx.cwd, "--json"]);
      const openCount = state.doc.threads.filter((t: any) => t.status === "open").length;
      const openHint =
        openCount > 0
          ? ` There ${openCount === 1 ? "is 1 open review thread" : `are ${openCount} open review threads`} in this repository—use \`review_threads\` to inspect or reply as you address them.`
          : "";
      event.systemPromptOptions.sections.herdr_git_review =
        `Keep Herdr Git Review updated via \`record_change_slices\` (or \`tools.record_change_slices\` in \`codemode\`): provide a concise high-level \`overview\`, group related edits into logical \`slices\`, and set \`suggestedCommit\`.${openHint}`;
    } catch {
      delete event.systemPromptOptions.sections.herdr_git_review;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      const rawPath = (event.input as { path?: unknown } | undefined)?.path;
      if (typeof rawPath === "string") {
        const target = resolveTrackedGitTarget(rawPath, ctx.cwd);
        if (target) {
          unattributedEdits.set(`${target.repoRoot.toLowerCase()}\0${target.filePath}`, target);
        }
      }
    }
  });

  pi.on("agent_before_settle", async (event) => {
    if (remindedThisRun || unattributedEdits.size === 0) return;
    remindedThisRun = true;
    const files = [...unattributedEdits.values()].map((t) => t.filePath);
    unattributedEdits.clear();

    const extras: string[] = [];
    if (!updatedOverviewThisRun) extras.push("a high-level `overview`");
    if (!updatedSuggestedCommitThisRun) extras.push("an up-to-date `suggestedCommit` (`{ subject, body? }`)");
    const extraText = extras.length ? `, along with ${extras.join(" and ")}` : "";

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "herdr-git-review-reminder",
          content: `You modified repository file(s) not yet grouped in Herdr Git Review: ${files.join(", ")}. Call \`record_change_slices\` to group them by logical intent${extraText}, then conclude briefly.`,
          display: false,
        },
      ],
      continue: true,
    };
  });

  const handleReviewCommand = async (args: string, ctx: any) => {
    const sub = (args || "list").trim().toLowerCase();
    try {
      if (sub === "prune") {
        const res = runCliJson(["clear", "--cwd", ctx.cwd, "--prune-clean", "--json"]);
        ctx.ui.notify(
          `Pruned clean review items (${res.doc.slices.length} slices, ${res.doc.threads.length} threads remaining).`,
          "info",
        );
        return;
      }
      if (sub === "clear") {
        runCliJson(["clear", "--cwd", ctx.cwd, "--json"]);
        ctx.ui.notify("Cleared all slices, threads, overview, and suggested commit.", "info");
        return;
      }
      const { doc } = runCliJson(["list", "--cwd", ctx.cwd, "--json"]);
      const lines: string[] = [];
      if (doc.overview?.text) {
        lines.push(`Overview: ${doc.overview.text}`);
      }
      if (doc.suggestedCommit?.subject) {
        lines.push(`Commit: ${doc.suggestedCommit.subject}`);
      }
      lines.push(`Slices: ${doc.slices.length} | Threads: ${doc.threads.filter((t: any) => t.status !== "resolved").length} active`);
      for (const s of doc.slices.slice(0, 5)) {
        lines.push(`• ${s.title} (${s.files.length}f)`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (err: any) {
      ctx.ui.notify(`Git review error: ${err?.message ?? err}`, "error");
    }
  };

  pi.registerCommand("git-review", {
    description: "Inspect, prune, or clear Herdr Git Review slices and threads in the current repository",
    handler: handleReviewCommand,
  });
  pi.registerCommand("git-notes", {
    description: "Alias for /git-review",
    handler: handleReviewCommand,
  });
}

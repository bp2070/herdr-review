import { execFileSync } from "node:child_process";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  addAgentNote,
  clearAgentNotes,
  listAgentNotes,
  removeAgentNote,
  resolveGitPaths,
  resolveRepoRelativePath,
} from "../../src/notes-store.js";

const NoteEntrySchema = Type.Object({
  filePath: Type.String({
    description: "Repository-relative or absolute path to the modified file, e.g. 'src/auth/session.ts'",
  }),
  summary: Type.String({
    description: "Concise 1-line description of the single logical change made to this file",
  }),
  diffHunk: Type.Optional(
    Type.String({
      description: "Optional specific diff hunk or +/- snippet; omit to auto-capture from git diff",
    }),
  ),
  lineRange: Type.Optional(
    Type.String({
      description: "Optional line range label such as 'L24-L35'",
    }),
  ),
  agentName: Type.Optional(
    Type.String({
      description: "Optional agent tag (defaults to 'pi' or active subagent name)",
    }),
  ),
});

export const RecordChangeNoteParams = Type.Object({
  action: Type.Optional(
    StringEnum(["add", "list", "remove", "clear"] as const, {
      description: "Operation to perform (defaults to 'add')",
    }),
  ),
  filePath: Type.Optional(
    Type.String({
      description: "Target file path (for single 'add', or optional filter for 'list'/'clear')",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "Concise 1-line summary of the logical change (for single 'add')",
    }),
  ),
  diffHunk: Type.Optional(
    Type.String({
      description: "Optional diff hunk or +/- snippet (omit on 'add' to auto-capture live git diff)",
    }),
  ),
  lineRange: Type.Optional(
    Type.String({
      description: "Optional explicit line range such as 'L24-L35'",
    }),
  ),
  agentName: Type.Optional(
    Type.String({
      description: "Optional agent name override (e.g. 'pi', 'refactor-subagent')",
    }),
  ),
  notes: Type.Optional(
    Type.Array(NoteEntrySchema, {
      description: "Batch multiple discrete per-file change notes in a single 'add' call",
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: "Note ID to delete when action is 'remove'",
    }),
  ),
  pruneClean: Type.Optional(
    Type.Boolean({
      description: "When action is 'clear', remove only notes whose files have no uncommitted git changes",
    }),
  ),
});

export type RecordChangeNoteInput = Static<typeof RecordChangeNoteParams>;

interface NoteToolDetails {
  action: "add" | "list" | "remove" | "clear";
  recordedCount?: number;
  files?: string[];
  totalNotes?: number;
}

function detectAgentName(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.PI_SUBAGENT_NAME) return process.env.PI_SUBAGENT_NAME;
  if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
  if (process.env.HERDR_AGENT) return process.env.HERDR_AGENT;
  return "pi";
}

function resolveTrackedGitTarget(rawPath: string, baseCwd: string): { repoRoot: string; filePath: string } | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  const absCandidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseCwd, rawPath);
  const startDir = path.dirname(absCandidate);

  try {
    const { repoRoot } = resolveGitPaths(startDir);
    const rel = resolveRepoRelativePath(absCandidate, baseCwd, repoRoot);
    if (!rel || rel.startsWith(".git/") || rel === ".git") return null;

    // Skip git-ignored files
    try {
      execFileSync("git", ["check-ignore", "-q", "--", rel], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
      // Exit code 0 => file IS ignored
      return null;
    } catch {
      // Exit code 1 => file is NOT ignored
    }

    return { repoRoot, filePath: rel };
  } catch {
    return null;
  }
}

function isInsideGitRepo(cwd: string): boolean {
  try {
    resolveGitPaths(cwd);
    return true;
  } catch {
    return false;
  }
}

export default function herdrGitNotesExtension(pi: ExtensionAPI) {
  const unnotedEdits = new Map<string, { repoRoot: string; filePath: string }>();
  let remindedThisRun = false;

  const markNoted = (repoRoot: string, filePath: string) => {
    unnotedEdits.delete(`${repoRoot.toLowerCase()}\0${filePath}`);
  };

  pi.registerTool({
    name: "record_change_note",
    label: "Record Change Note",
    description:
      "Append, list, remove, or clear structured per-file AgentChangeNote entries in <git-dir>/herdr-agent-notes.json for the Herdr Git Changes & Notes workspace pane.",
    promptSnippet:
      "Record concise 1-line per-file change notes (with auto-captured git diff hunks) for Herdr's Git Changes pane",
    promptGuidelines: [
      "After modifying or creating repository files with `edit` or `write`, call `record_change_note` with a concise 1-line `summary` per logical file change (use `notes: [...]` to batch multiple files).",
    ],
    parameters: RecordChangeNoteParams,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { action: params.action ?? "add" } satisfies NoteToolDetails,
        };
      }

      const action = params.action ?? "add";
      const cwd = ctx.cwd;

      if (action === "list") {
        const res = await listAgentNotes({ cwd, filePath: params.filePath ?? "" });
        const lines =
          res.notes.length === 0
            ? ["No agent change notes recorded."]
            : res.notes.map(
                (n: any) =>
                  `${n.id}  ${n.filePath}${n.lineRange ? ` (${n.lineRange})` : ""}  [${n.agentName ?? "agent"}] ${n.summary}`,
              );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            action: "list",
            totalNotes: res.notes.length,
          } satisfies NoteToolDetails,
        };
      }

      if (action === "remove") {
        if (!params.id) {
          throw new Error("`id` is required when action is 'remove'.");
        }
        const res = await removeAgentNote({ cwd, id: params.id });
        return {
          content: [{ type: "text", text: `Removed ${res.removed} note(s) (${res.remaining} remaining).` }],
          details: {
            action: "remove",
            totalNotes: res.remaining,
          } satisfies NoteToolDetails,
        };
      }

      if (action === "clear") {
        const res = await clearAgentNotes({
          cwd,
          filePath: params.filePath ?? "",
          pruneClean: Boolean(params.pruneClean),
        });
        return {
          content: [{ type: "text", text: `Cleared ${res.removed} note(s) (${res.remaining} remaining).` }],
          details: {
            action: "clear",
            totalNotes: res.remaining,
          } satisfies NoteToolDetails,
        };
      }

      // action === "add"
      const entries =
        Array.isArray(params.notes) && params.notes.length > 0
          ? params.notes
          : params.filePath && params.summary
            ? [
                {
                  filePath: params.filePath,
                  summary: params.summary,
                  diffHunk: params.diffHunk,
                  lineRange: params.lineRange,
                  agentName: params.agentName,
                },
              ]
            : [];

      if (entries.length === 0) {
        throw new Error("Provide `filePath` and `summary` (or a non-empty `notes` array) when recording change notes.");
      }

      const recordedFiles: string[] = [];
      let totalNotes = 0;

      for (const item of entries) {
        const targetDir = path.isAbsolute(item.filePath)
          ? path.dirname(item.filePath)
          : path.dirname(path.resolve(cwd, item.filePath));
        let effectiveCwd = cwd;
        try {
          resolveGitPaths(targetDir);
          effectiveCwd = targetDir;
        } catch {
          effectiveCwd = cwd;
        }

        const saved = await addAgentNote({
          cwd: effectiveCwd,
          filePath: item.filePath,
          summary: item.summary,
          agentName: detectAgentName(item.agentName ?? params.agentName),
          diffHunk: item.diffHunk,
          lineRange: item.lineRange,
          autoHunk: !item.diffHunk,
        });
        markNoted(saved.repoRoot, saved.note.filePath);
        recordedFiles.push(saved.note.filePath);
        totalNotes = saved.total;
      }

      return {
        content: [
          {
            type: "text",
            text: `Recorded ${recordedFiles.length} change note(s): ${recordedFiles.join(", ")} (${totalNotes} total in repo).`,
          },
        ],
        details: {
          action: "add",
          recordedCount: recordedFiles.length,
          files: recordedFiles,
          totalNotes,
        } satisfies NoteToolDetails,
      };
    },

    renderCall(args, theme) {
      const action = args.action ?? "add";
      if (action === "add") {
        const count = Array.isArray(args.notes) && args.notes.length > 0 ? args.notes.length : 1;
        const label =
          count > 1
            ? `${count} files`
            : args.filePath || (Array.isArray(args.notes) && args.notes[0]?.filePath) || "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("record_change_note "))}${theme.fg("accent", label)}`,
          0,
          0,
        );
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("record_change_note "))}${theme.fg("muted", action)}`,
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

  // Reset per-run tracking when an agent run begins
  pi.on("agent_start", async () => {
    unnotedEdits.clear();
    remindedThisRun = false;
  });

  // Add contextual guideline only when operating in a Git repository
  pi.on("before_agent_start", async (event, ctx) => {
    if (isInsideGitRepo(ctx.cwd)) {
      event.systemPromptOptions.sections.herdr_git_notes =
        "Record discrete 1-line per-file summaries via `record_change_note` (or `tools.record_change_note` inside `codemode`) whenever you edit or create repository files so the Herdr Git Changes & Notes pane stays up to date.";
    } else {
      delete event.systemPromptOptions.sections.herdr_git_notes;
    }
  });

  // Track modified repository files across direct and nested (codemode) edit/write calls
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      const rawPath = (event.input as { path?: unknown } | undefined)?.path;
      if (typeof rawPath === "string") {
        const target = resolveTrackedGitTarget(rawPath, ctx.cwd);
        if (target) {
          unnotedEdits.set(`${target.repoRoot.toLowerCase()}\0${target.filePath}`, target);
        }
      }
    }
  });

  // If the agent modified repository files in this run and forgot to record notes, nudge once before settling
  pi.on("agent_before_settle", async (event) => {
    if (remindedThisRun || unnotedEdits.size === 0) return;
    remindedThisRun = true;
    const files = [...unnotedEdits.values()].map((t) => t.filePath);
    unnotedEdits.clear();

    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "herdr-git-notes-reminder",
          content: `You modified repository file(s) without recording Herdr change notes: ${files.join(", ")}. Call \`record_change_note\` (use \`notes: [...]\` to batch) with a concise 1-line summary per file, then conclude briefly.`,
          display: false,
        },
      ],
      continue: true,
    };
  });

  // User slash command: /git-notes [list|prune|clear]
  pi.registerCommand("git-notes", {
    description: "Inspect, prune, or clear Herdr agent change notes in the current Git repository",
    handler: async (args, ctx) => {
      const sub = (args || "list").trim().toLowerCase();
      try {
        if (sub === "prune") {
          const res = await clearAgentNotes({ cwd: ctx.cwd, pruneClean: true });
          ctx.ui.notify(`Pruned ${res.removed} clean note(s) (${res.remaining} remaining).`, "info");
          return;
        }
        if (sub === "clear") {
          const res = await clearAgentNotes({ cwd: ctx.cwd });
          ctx.ui.notify(`Cleared ${res.removed} note(s).`, "info");
          return;
        }
        const res = await listAgentNotes({ cwd: ctx.cwd });
        if (res.notes.length === 0) {
          ctx.ui.notify("No agent change notes recorded in this repository.", "info");
        } else {
          const preview = res.notes
            .slice(0, 6)
            .map((n: any) => `• ${n.filePath}: ${n.summary}`)
            .join("\n");
          const suffix = res.notes.length > 6 ? `\n…and ${res.notes.length - 6} more` : "";
          ctx.ui.notify(`Agent Change Notes (${res.notes.length}):\n${preview}${suffix}`, "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Git notes error: ${err?.message ?? err}`, "error");
      }
    },
  });
}

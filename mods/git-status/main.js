import { View, div, svg } from "gpui-kit";
import {
  h_flex,
  v_flex,
  InputState,
  Input,
  TextareaState,
  Textarea,
  Scrollbar,
  ScrollHandle,
} from "gpui-base";
import { randomUUID } from "crypto";
import {
  agents,
  checking,
  closeOverlay,
  exec,
  focused,
  nextCommand,
  notify,
  openOverlay,
  panes,
  props,
  readTextFile,
  run,
  setShared,
  settings,
  shared,
  spaces,
  theme,
  watchFolder,
  writeTextFile,
} from "herdr";
import {
  GIT_READ_ARGS,
  MOD_NAME,
  NOTES_FILENAME,
  SHARED_BUMP_KEY,
  appendNoteToDocument,
  buildFullFileDiffLines,
  buildUntrackedDiffLines,
  clearNotesInDocument,
  computeFooterCounts,
  countLines,
  extractNoteDiffInfo,
  filterFiles,
  formatRelativeTime,
  groupNotesByFile,
  joinPosixPath,
  locationKey,
  mergeStatusAndStats,
  normalizeRepoPath,
  parseDiffLines,
  parseNotesDocument,
  parseNumstatZ,
  parsePorcelainStatusZ,
  planPaneToggle,
  removeNoteFromDocument,
  resolvePalette,
  resolveWorkspaceLocation,
  sliceUnifiedHunks,
  stageAllCommandArgs,
  stageCommandArgs,
  withAlpha,
} from "./model.js";

function icon(name, size = 13) {
  return svg(`mods/${MOD_NAME}/${name}.svg`).size(size).flex_none();
}

function monoFontFamily() {
  const s = settings() ?? {};
  return String(s.font || s.font_family || "JetBrains Mono");
}

function detectActiveAgentName(spaceId) {
  const list = agents() ?? [];
  const inSpace = spaceId ? list.filter((a) => a.space === spaceId) : list;
  const preferred = inSpace.find((a) => a.focused) ?? inSpace[0] ?? list[0] ?? null;
  if (!preferred) return "pi";
  return preferred.app || preferred.program?.key || preferred.program?.name || "pi";
}

async function saveNotesFile(notesPath, on, mutator) {
  if (!notesPath) throw new Error("Git directory is not available.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readTextFile(notesPath, { on }).catch(() => null);
    const result = mutator(existing ?? "");
    if (!on) {
      try {
        await writeTextFile(notesPath, result.text, existing);
        return result;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    } else {
      // Remote space fallback via POSIX sh / PowerShell stdin write
      const b64 = btoa(unescape(encodeURIComponent(result.text)));
      const remoteWrite = await exec(
        "sh",
        ["-c", `printf %s "$1" | base64 -d > "$2"`, "sh", b64, notesPath],
        { on },
      ).catch(() => ({ code: 1 }));
      if (remoteWrite.code !== 0) {
        const ps = await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `[IO.File]::WriteAllBytes($args[1], [Convert]::FromBase64String($args[0]))`,
            b64,
            notesPath,
          ],
          { on },
        );
        if (ps.code !== 0) throw new Error(ps.stderr || "Could not write remote notes file.");
      }
      return result;
    }
  }
  throw new Error("Concurrent update conflict writing agent notes.");
}

export default class GitStatusView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.copyProps = p;
    this.overlayId = p.overlay ?? null;
    this.role = this.overlayId ? (p.role === "add-note" ? "add-note" : "runner") : "pane";

    if (this.role === "runner") {
      if (!checking() && this.overlayId) {
        const owner = this.overlayId;
        const direction = p.direction || "right";
        cx.spawn(async () => {
          const action = planPaneToggle({
            spaces: spaces(),
            panes: panes(),
            focused: focused(),
            modName: MOD_NAME,
            direction,
          });
          run(action.command, action.args);
          closeOverlay(owner);
        });
      }
      return;
    }

    if (this.role === "add-note") {
      this.initAddNoteDialog(p, cx);
      return;
    }

    this.initPane(p, cx);
  }

  // ===========================================================================
  // ADD DISCRETE AGENT NOTE DIALOG (`role === "add-note"`)
  // ===========================================================================
  initAddNoteDialog(p, cx) {
    this.handle = cx.focus_handle();
    this.dialogFiles = Array.isArray(p.files) ? p.files : [];
    const initialFile = p.initialPath || this.dialogFiles[0]?.path || "";
    this.noteFile = initialFile;
    this.noteDesc = "";
    this.noteAgent = p.defaultAgent || "pi";
    this.noteLines = "";
    this.noteDiff = "";
    this.dialogError = "";
    this.savingNote = false;
    this.prefillingDiff = false;
    this.focusedField = "desc";

    this.fileInput = InputState.new({
      value: this.noteFile,
      placeholder: "e.g. src/auth/session.ts",
    });
    this.fileInput.on("change", (_e, cx) => {
      this.noteFile = this.fileInput.value();
      this.dialogError = "";
      cx.notify();
    });
    this.fileInput.on("focus", (_e, cx) => {
      this.focusedField = "file";
      cx.notify();
    });

    this.descInput = InputState.new({
      value: "",
      placeholder: "e.g. Added exponential backoff jitter in pollBatch",
    });
    this.descInput.on("change", (_e, cx) => {
      this.noteDesc = this.descInput.value();
      this.dialogError = "";
      cx.notify();
    });
    this.descInput.on("focus", (_e, cx) => {
      this.focusedField = "desc";
      cx.notify();
    });
    this.descInput.on("submit", (_e, cx) => this.submitNewNote(cx));

    this.agentInput = InputState.new({
      value: this.noteAgent,
      placeholder: "pi",
    });
    this.agentInput.on("change", (_e, cx) => {
      this.noteAgent = this.agentInput.value();
      cx.notify();
    });
    this.agentInput.on("focus", (_e, cx) => {
      this.focusedField = "agent";
      cx.notify();
    });

    this.linesInput = InputState.new({
      value: "",
      placeholder: "L24-L35",
    });
    this.linesInput.on("change", (_e, cx) => {
      this.noteLines = this.linesInput.value();
      cx.notify();
    });
    this.linesInput.on("focus", (_e, cx) => {
      this.focusedField = "lines";
      cx.notify();
    });

    this.diffTextarea = TextareaState.new({
      value: "",
      rows: 4,
      placeholder: "+ const backoff = calculateJitter();\n- const backoff = 1000;",
    });
    this.diffTextarea.set_soft_wrap(false);
    this.diffTextarea.on("change", (_e, cx) => {
      this.noteDiff = this.diffTextarea.value();
      cx.notify();
    });
    this.diffTextarea.on("focus", (_e, cx) => {
      this.focusedField = "diff";
      cx.notify();
    });

    if (!checking()) {
      this.descInput.focus();
      cx.timer.after(120, () => this.descInput.focus());
    }
  }

  selectDialogFile(filePath, cx) {
    this.noteFile = filePath;
    this.fileInput.set_value(filePath);
    this.dialogError = "";
    cx.notify();
  }

  prefillDialogDiff(cx) {
    const p = this.copyProps ?? {};
    const root = p.root;
    const on = p.on ?? null;
    const targetPath = normalizeRepoPath(this.noteFile, root || "");
    if (!root || !targetPath || this.prefillingDiff) return;

    this.prefillingDiff = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const fileEntry = this.dialogFiles.find((f) => f.path === targetPath);
        let snippet = "";
        if (fileEntry?.fresh) {
          const text = await readTextFile(joinPosixPath(root, targetPath), { on }).catch(() => null);
          snippet = buildUntrackedDiffLines(text, 25).join("\n");
        } else {
          for (const extra of [[], ["--cached"]]) {
            const res = await exec(
              "git",
              [...GIT_READ_ARGS, "diff", ...extra, "--no-ext-diff", "--no-textconv", "--no-color", "-U1", "--", targetPath],
              { cwd: root, on },
            );
            if (res.code === 0) {
              const hunks = sliceUnifiedHunks(res.stdout);
              if (hunks.length) {
                snippet = hunks.slice(0, 30).join("\n");
                break;
              }
            }
          }
        }
        if (snippet) {
          this.noteDiff = snippet;
          this.diffTextarea.set_value(snippet);
          const info = extractNoteDiffInfo({ diffHunk: snippet, lineRange: this.noteLines });
          if (!this.noteLines && info.lineRange) {
            this.noteLines = info.lineRange;
            this.linesInput.set_value(info.lineRange);
          }
        } else {
          this.dialogError = "No textual diff found for that file.";
        }
      } catch (err) {
        this.dialogError = String(err?.message ?? err);
      } finally {
        this.prefillingDiff = false;
        cx.notify();
      }
    });
  }

  submitNewNote(cx) {
    if (this.savingNote) return;
    const p = this.copyProps ?? {};
    const notesPath = p.notesPath;
    const root = p.root || "";
    const on = p.on ?? null;
    const filePath = normalizeRepoPath(this.noteFile, root);
    const summary = this.noteDesc.trim();
    const agentName = this.noteAgent.trim() || "pi";
    const lineRange = this.noteLines.trim();
    const diffHunk = this.noteDiff.trimEnd();

    if (!filePath) {
      this.dialogError = "Select or enter a repo-relative target file.";
      cx.notify();
      return;
    }
    if (!summary) {
      this.dialogError = "Enter a concise 1-line description of the change.";
      cx.notify();
      return;
    }
    if (!notesPath) {
      this.dialogError = "Active workspace has no Git repository.";
      cx.notify();
      return;
    }

    this.savingNote = true;
    this.dialogError = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const saved = await saveNotesFile(notesPath, on, (currentText) =>
          appendNoteToDocument(
            currentText,
            {
              filePath,
              summary,
              agentName,
              lineRange,
              diffHunk,
            },
            {
              nowIso: new Date().toISOString(),
              createId: () => `n-${randomUUID().slice(0, 8)}`,
            },
          ),
        );
        setShared(SHARED_BUMP_KEY, {
          at: Date.now(),
          expandPath: saved.note.filePath,
        });
        if (this.overlayId) closeOverlay(this.overlayId);
      } catch (err) {
        this.dialogError = String(err?.message ?? err);
        this.savingNote = false;
        cx.notify();
      }
    });
  }

  renderAddNoteDialog() {
    const p = resolvePalette(theme());
    const mono = monoFontFamily();
    const stop = (_e, cx) => cx.stop_propagation();
    const label = (text) => div().pb(4).font_family(mono).text_size(11).text_color(p.subtext).child(text);

    return v_flex()
      .id("add-note-dialog")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .bg(p.mantle)
      .text_color(p.text)
      .text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          cx.stop_propagation();
          closeOverlay(this.overlayId);
        }
      })
      // Header
      .child(
        h_flex()
          .h(38)
          .px(14)
          .items_center()
          .justify_between()
          .bg(withAlpha(p.surface0, "66"))
          .border_b(1)
          .border_color(p.border)
          .font_family(mono)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(icon("sparkles", 14).text_color(p.mauve))
              .child(div().font_semibold().text_size(12).child("Add Discrete Agent Note")),
          )
          .child(
            div()
              .id("add-note-close")
              .size(24)
              .flex()
              .items_center()
              .justify_center()
              .rounded(5)
              .text_color(p.dim)
              .cursor_pointer()
              .hover((s) => s.bg(p.hover).text_color(p.text))
              .on_mouse_down("left", stop)
              .on_click(() => {
                if (this.overlayId) closeOverlay(this.overlayId);
              })
              .child(icon("x", 13)),
          ),
      )
      // Body
      .child(
        v_flex()
          .p(14)
          .gap(10)
          // Target File
          .child(
            v_flex()
              .gap(4)
              .child(label("Target File"))
              .child(
                div()
                  .id("note-file-box")
                  .h(30)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.focusedField === "file" ? p.mauve : p.input)
                  .font_family(mono)
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.fileInput).h_full().text_size(11.5).text_color(p.text)),
              )
              .when(this.dialogFiles.length > 0, (el) =>
                el.child(
                  h_flex()
                    .id("note-file-chips")
                    .w_full()
                    .gap(4)
                    .pt(2)
                    .overflow_x_scrollbar()
                    .children(
                      this.dialogFiles.slice(0, 12).map((f, idx) => {
                        const active = normalizeRepoPath(this.noteFile) === f.path;
                        return h_flex()
                          .id(`chip-${idx}`)
                          .h(20)
                          .px(6)
                          .rounded(4)
                          .flex_none()
                          .items_center()
                          .font_family(mono)
                          .text_size(10)
                          .cursor_pointer()
                          .border_1()
                          .border_color(active ? p.mauve : p.border)
                          .bg(active ? withAlpha(p.mauve, "28") : p.base)
                          .text_color(active ? p.mauve : p.subtext)
                          .hover((s) => s.border_color(p.mauve).text_color(p.text))
                          .on_mouse_down("left", stop)
                          .on_click((_e, cx) => this.selectDialogFile(f.path, cx))
                          .child(f.name || f.path);
                      }),
                    ),
                ),
              ),
          )
          // Summary
          .child(
            v_flex()
              .child(label("Single-Line Change Description"))
              .child(
                div()
                  .id("note-desc-box")
                  .h(30)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.focusedField === "desc" ? p.mauve : p.input)
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.descInput).h_full().text_size(12).text_color(p.text)),
              ),
          )
          // Agent Tag + Line Range
          .child(
            h_flex()
              .gap(8)
              .font_family(mono)
              .child(
                v_flex()
                  .flex_1()
                  .child(label("Agent Tag"))
                  .child(
                    div()
                      .id("note-agent-box")
                      .h(28)
                      .px(8)
                      .flex()
                      .items_center()
                      .rounded(5)
                      .bg(p.surface0)
                      .border_1()
                      .border_color(this.focusedField === "agent" ? p.mauve : p.input)
                      .on_mouse_down("left", stop)
                      .child(Input.new(this.agentInput).h_full().text_size(11.5).text_color(p.text)),
                  ),
              )
              .child(
                v_flex()
                  .flex_1()
                  .child(label("Line Range"))
                  .child(
                    div()
                      .id("note-lines-box")
                      .h(28)
                      .px(8)
                      .flex()
                      .items_center()
                      .rounded(5)
                      .bg(p.surface0)
                      .border_1()
                      .border_color(this.focusedField === "lines" ? p.mauve : p.input)
                      .on_mouse_down("left", stop)
                      .child(Input.new(this.linesInput).h_full().text_size(11.5).text_color(p.text)),
                  ),
              ),
          )
          // Optional Diff Hunk
          .child(
            v_flex()
              .child(
                h_flex()
                  .pb(4)
                  .items_center()
                  .justify_between()
                  .child(
                    div()
                      .font_family(mono)
                      .text_size(11)
                      .text_color(p.subtext)
                      .child("Optional Code Snippet Diff (shown on note click)"),
                  )
                  .child(
                    h_flex()
                      .id("prefill-diff-btn")
                      .h(20)
                      .px(6)
                      .gap(4)
                      .items_center()
                      .rounded(4)
                      .border_1()
                      .border_color(p.border)
                      .bg(p.base)
                      .font_family(mono)
                      .text_size(10)
                      .text_color(p.mauve)
                      .cursor_pointer()
                      .hover((s) => s.border_color(p.mauve).bg(p.hover))
                      .on_mouse_down("left", stop)
                      .on_click((_e, cx) => this.prefillDialogDiff(cx))
                      .child(icon("code", 10))
                      .child(this.prefillingDiff ? "Loading…" : "Prefill Diff"),
                  ),
              )
              .child(
                div()
                  .id("note-diff-box")
                  .h(82)
                  .p(6)
                  .rounded(5)
                  .bg(p.crust)
                  .border_1()
                  .border_color(this.focusedField === "diff" ? p.mauve : p.input)
                  .font_family(mono)
                  .on_mouse_down("left", stop)
                  .child(Textarea.new(this.diffTextarea).size_full().text_size(11).text_color(p.text)),
              ),
          )
          .when(Boolean(this.dialogError), (el) =>
            el.child(div().text_size(11).text_color(p.red).child(this.dialogError)),
          )
          // Footer buttons
          .child(
            h_flex()
              .pt(6)
              .gap(8)
              .justify_end()
              .border_t(1)
              .border_color(p.border)
              .child(
                h_flex()
                  .id("note-cancel-btn")
                  .h(28)
                  .px(12)
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(p.border)
                  .text_color(p.subtext)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.hover).text_color(p.text))
                  .on_mouse_down("left", stop)
                  .on_click(() => {
                    if (this.overlayId) closeOverlay(this.overlayId);
                  })
                  .child("Cancel"),
              )
              .child(
                h_flex()
                  .id("note-save-btn")
                  .h(28)
                  .px(12)
                  .items_center()
                  .rounded(5)
                  .bg(p.mauve)
                  .text_color(p.mauveFg)
                  .font_semibold()
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.9))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.submitNewNote(cx))
                  .child(this.savingNote ? "Saving…" : "Save Note"),
              ),
          ),
      );
  }

  // ===========================================================================
  // STANDARD WORKSPACE PANE (`role === "pane"`)
  // ===========================================================================
  initPane(p, cx) {
    this.handle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    this.lastCwdBySpace = new Map();
    this.contextKey = "";
    this.root = null;
    this.gitDir = null;
    this.notesPath = null;
    this.on = null;
    this.branch = null;
    this.hasHead = true;

    this.files = [];
    this.limited = false;
    this.notes = [];
    this.notesByFile = new Map();

    this.filter = "ALL"; // "ALL" | "STAGED" | "UNSTAGED"
    this.query = "";
    this.searchFocused = false;

    this.expandedFiles = new Set();
    this.autoExpandedRepo = "";
    this.expandedNotes = new Set();
    this.expandedFullDiffs = new Set();
    this.fullDiffCache = new Map(); // path -> { loading, rows, error }
    this.selectedIndex = 0;

    this.loading = false;
    this.mutating = false;
    this.pendingRefresh = false;
    this.error = null;
    this.actionError = null;
    this.watches = [];
    this.watchedKey = "";
    this.lastSeenBump = shared(SHARED_BUMP_KEY)?.at ?? null;

    this.searchInput = InputState.new({
      value: "",
      placeholder: "Filter file or note...",
    });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.selectedIndex = 0;
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });

    if (checking()) return;

    cx.spawn(async (cx) => {
      for (;;) {
        const raw = await nextCommand();
        const cmd = String(raw || "").split(".").pop();
        if (cmd === "focus") {
          this.handle.focus();
          cx.notify();
        } else if (cmd === "refresh") {
          this.refresh(cx, true);
        } else if (cmd === "add-note") {
          this.openAddNoteModal();
        } else if (cmd === "stage-all") {
          this.toggleStageAll(cx);
        } else if (cmd === "expand-all") {
          const visible = filterFiles(this.files, this.notesByFile, {
            filter: this.filter,
            query: this.query,
          });
          this.toggleExpandAll(visible, cx);
        } else if (cmd === "filter-notes") {
          this.filter = this.filter === "NOTES" ? "ALL" : "NOTES";
          this.selectedIndex = 0;
          cx.notify();
        } else if (cmd === "escape" && this.searchFocused) {
          this.searchFocused = false;
          this.handle.focus();
          cx.notify();
        }
      }
    });

    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  async close() {
    this.stopWatches();
  }

  stopWatches() {
    for (const w of this.watches ?? []) {
      try {
        w.cancel();
      } catch {
        // Ignore already-settled watch handles
      }
    }
    this.watches = [];
    this.watchedKey = "";
  }

  startWatches(root, gitDir, on, cx) {
    if (on || !root) {
      this.stopWatches();
      return;
    }
    const nextKey = `${root}\0${gitDir || ""}`;
    if (this.watchedKey === nextKey) return;
    this.stopWatches();
    this.watchedKey = nextKey;

    const dirs = [root];
    if (gitDir) {
      const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const normGit = gitDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (normGit !== normRoot && !normGit.startsWith(`${normRoot}/`)) {
        dirs.push(gitDir);
      }
    }

    for (const dir of dirs) {
      cx.spawn(async (cx) => {
        try {
          while (this.watchedKey === nextKey) {
            const w = watchFolder(dir);
            this.watches.push(w);
            const changed = await w;
            this.watches = this.watches.filter((item) => item !== w);
            if (!changed.length || this.watchedKey !== nextKey) break;
            await cx.sleep(100);
            if (this.watchedKey === nextKey) this.refresh(cx);
          }
        } catch {
          if (this.watchedKey === nextKey) this.watchedKey = "";
        }
      });
    }
  }

  currentLocation() {
    return resolveWorkspaceLocation({
      spaces: spaces(),
      panes: panes(),
      focused: focused(),
      props: this.copyProps,
      lastCwdBySpace: this.lastCwdBySpace,
    });
  }

  refresh(cx, manual = false) {
    if (checking()) return;
    if (this.loading || this.mutating) {
      this.pendingRefresh = true;
      return;
    }

    const loc = this.currentLocation();
    const ctxKey = locationKey(loc);
    if (ctxKey !== this.contextKey) {
      this.contextKey = ctxKey;
      this.root = null;
      this.gitDir = null;
      this.notesPath = null;
      this.files = [];
      this.notes = [];
      this.notesByFile = new Map();
      this.fullDiffCache.clear();
      this.expandedFullDiffs.clear();
      this.error = null;
      this.actionError = null;
      this.selectedIndex = 0;
      this.stopWatches();
    }

    if (manual) {
      this.actionError = null;
      this.fullDiffCache.clear();
    }

    if (!loc.cwd) {
      this.branch = null;
      return;
    }

    this.loading = true;
    this.on = loc.on;
    if (manual) cx.notify();

    cx.spawn(async (cx) => {
      try {
        const [topRes, gitDirRes] = await Promise.all([
          exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.on }),
          exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: loc.cwd, on: loc.on }),
        ]);

        if (locationKey(this.currentLocation()) !== ctxKey) return;

        if (topRes.code !== 0 || gitDirRes.code !== 0) {
          this.root = null;
          this.gitDir = null;
          this.notesPath = null;
          this.branch = null;
          this.files = [];
          this.notes = [];
          this.notesByFile = new Map();
          this.error = "Not a Git repository";
          this.stopWatches();
          return;
        }

        const root = topRes.stdout.trim();
        const gitDir = gitDirRes.stdout.trim();
        const notesPath = joinPosixPath(gitDir, NOTES_FILENAME);
        const gitRead = (args) => exec("git", [...GIT_READ_ARGS, ...args], { cwd: root, on: loc.on });

        const [statusRes, headRes, branchRes, stagedStatRes, unstagedStatRes, notesRaw] =
          await Promise.all([
            gitRead(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
            gitRead(["rev-parse", "--verify", "HEAD"]),
            gitRead([" symbolic-ref".trim(), "--short", "-q", "HEAD"]),
            gitRead(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
            gitRead(["diff", "--numstat", "-z", "--no-renames"]),
            readTextFile(notesPath, { on: loc.on }).catch(() => null),
          ]);

        if (locationKey(this.currentLocation()) !== ctxKey) return;
        if (statusRes.code !== 0) throw new Error(statusRes.stderr || "git status failed");

        const parsedStatus = parsePorcelainStatusZ(statusRes.stdout, 1000);
        const stagedStats = stagedStatRes.code === 0 ? parseNumstatZ(stagedStatRes.stdout) : {};
        const unstagedStats = unstagedStatRes.code === 0 ? parseNumstatZ(unstagedStatRes.stdout) : {};

        // Count lines for untracked files (bounded to first 40 untracked files for snappy refreshes)
        const untrackedLineCounts = {};
        const freshEntries = parsedStatus.entries.filter((e) => e.fresh).slice(0, 40);
        if (freshEntries.length > 0) {
          await Promise.all(
            freshEntries.map(async (entry) => {
              const text = await readTextFile(joinPosixPath(root, entry.path), { on: loc.on }).catch(() => null);
              if (text !== null && !text.includes("\0")) {
                untrackedLineCounts[entry.path] = countLines(text);
              }
            }),
          );
        }

        if (locationKey(this.currentLocation()) !== ctxKey) return;

        const files = mergeStatusAndStats(
          parsedStatus.entries,
          stagedStats,
          unstagedStats,
          untrackedLineCounts,
        );
        const notes = parseNotesDocument(notesRaw ?? "");
        const notesByFile = groupNotesByFile(notes);

        this.root = root;
        this.gitDir = gitDir;
        this.notesPath = notesPath;
        this.hasHead = headRes.code === 0;
        this.branch = branchRes.code === 0 ? branchRes.stdout.trim() : loc.branch || (this.hasHead ? "detached" : "main");
        this.files = files;
        this.limited = parsedStatus.limited;
        this.notes = notes;
        this.notesByFile = notesByFile;
        this.error = null;

        // Auto-expand files that carry agent notes on first load of this repository
        if (this.autoExpandedRepo !== root) {
          this.autoExpandedRepo = root;
          for (const f of files) {
            if ((notesByFile.get(f.path) ?? []).length > 0) {
              this.expandedFiles.add(f.path);
            }
          }
        }

        // Refresh any currently expanded full-file diffs in place
        const openDiffPaths = [...this.expandedFullDiffs].filter((p) => files.some((f) => f.path === p));
        this.fullDiffCache.clear();
        await Promise.all(openDiffPaths.map((path) => this.loadFullDiff(path, ctxKey)));

        this.startWatches(root, gitDir, loc.on, cx);
      } catch (err) {
        if (locationKey(this.currentLocation()) === ctxKey) {
          this.error = String(err?.message ?? err);
        }
      } finally {
        this.loading = false;
        cx.notify();
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh(cx);
        }
      }
    });
  }

  async loadFullDiff(filePath, expectedCtx = this.contextKey) {
    const file = this.files.find((f) => f.path === filePath);
    if (!file || !this.root) return;
    const root = this.root;
    const on = this.on;
    this.fullDiffCache.set(filePath, { loading: true, rows: [], error: "" });

    try {
      let lines;
      if (file.fresh) {
        const text = await readTextFile(joinPosixPath(root, filePath), { on }).catch(() => null);
        lines = buildUntrackedDiffLines(text, 400);
      } else {
        const [stagedRes, unstagedRes] = await Promise.all([
          file.hasStaged
            ? exec(
                "git",
                [...GIT_READ_ARGS, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", filePath],
                { cwd: root, on },
              )
            : Promise.resolve({ code: 0, stdout: "" }),
          file.hasUnstaged
            ? exec(
                "git",
                [...GIT_READ_ARGS, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", filePath],
                { cwd: root, on },
              )
            : Promise.resolve({ code: 0, stdout: "" }),
        ]);

        let untrackedText = null;
        if (!this.hasHead && file.status === "A" && !stagedRes.stdout && !unstagedRes.stdout) {
          untrackedText = await readTextFile(joinPosixPath(root, filePath), { on }).catch(() => null);
        }

        lines = buildFullFileDiffLines({
          fresh: file.fresh,
          hasHead: this.hasHead,
          status: file.status,
          binary: file.binary,
          stagedOut: stagedRes.code === 0 ? stagedRes.stdout : "",
          unstagedOut: unstagedRes.code === 0 ? unstagedRes.stdout : "",
          untrackedText,
          maxLines: 400,
        });
      }

      if (this.contextKey === expectedCtx) {
        this.fullDiffCache.set(filePath, {
          loading: false,
          rows: parseDiffLines(lines),
          error: "",
        });
      }
    } catch (err) {
      if (this.contextKey === expectedCtx) {
        this.fullDiffCache.set(filePath, {
          loading: false,
          rows: [],
          error: String(err?.message ?? err),
        });
      }
    }
  }

  toggleFileExpand(filePath, cx) {
    if (this.expandedFiles.has(filePath)) {
      this.expandedFiles.delete(filePath);
    } else {
      this.expandedFiles.add(filePath);
    }
    cx.notify();
  }

  toggleExpandAll(visibleFiles, cx) {
    const anyExpanded = visibleFiles.some((f) => this.expandedFiles.has(f.path));
    if (anyExpanded) {
      for (const f of visibleFiles) this.expandedFiles.delete(f.path);
    } else {
      for (const f of visibleFiles) this.expandedFiles.add(f.path);
    }
    cx.notify();
  }

  toggleNoteExpand(noteId, cx) {
    if (this.expandedNotes.has(noteId)) {
      this.expandedNotes.delete(noteId);
    } else {
      this.expandedNotes.add(noteId);
    }
    cx.notify();
  }

  toggleFullDiff(filePath, cx) {
    if (this.expandedFullDiffs.has(filePath)) {
      this.expandedFullDiffs.delete(filePath);
      cx.notify();
      return;
    }
    this.expandedFullDiffs.add(filePath);
    const ctxKey = this.contextKey;
    cx.notify();
    if (!this.fullDiffCache.has(filePath)) {
      cx.spawn(async (cx) => {
        await this.loadFullDiff(filePath, ctxKey);
        cx.notify();
      });
    }
  }

  toggleStageFile(file, cx) {
    if (!this.root || this.mutating) return;
    const args = stageCommandArgs(file, this.hasHead);
    if (!args) return;
    const root = this.root;
    const on = this.on;
    this.mutating = true;
    this.actionError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", args, { cwd: root, on });
        if (res.code !== 0) {
          throw new Error((res.stderr || res.stdout || "git stage toggle failed").trim());
        }
      } catch (err) {
        this.actionError = String(err?.message ?? err);
      } finally {
        this.mutating = false;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  toggleStageAll(cx) {
    if (!this.root || !this.files.length || this.mutating) return;
    const args = stageAllCommandArgs(this.files, this.hasHead);
    if (!args) return;
    const root = this.root;
    const on = this.on;
    this.mutating = true;
    this.actionError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", args, { cwd: root, on });
        if (res.code !== 0) {
          throw new Error((res.stderr || res.stdout || "git stage all failed").trim());
        }
      } catch (err) {
        this.actionError = String(err?.message ?? err);
      } finally {
        this.mutating = false;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  openAddNoteModal(initialPath = "") {
    if (!this.root || !this.notesPath) {
      notify({
        title: "Git Changes & Notes",
        body: "Open a Git repository in the active space first.",
        level: "warning",
      });
      return;
    }
    const loc = this.currentLocation();
    openOverlay({
      mod: MOD_NAME,
      kind: "dialog",
      width: 470,
      height: 455,
      props: {
        role: "add-note",
        root: this.root,
        gitDir: this.gitDir,
        notesPath: this.notesPath,
        on: this.on,
        files: this.files.map((f) => ({ path: f.path, name: f.name, fresh: f.fresh })),
        initialPath: initialPath || this.files[this.selectedIndex]?.path || this.files[0]?.path || "",
        defaultAgent: detectActiveAgentName(loc.spaceId),
      },
    });
  }

  deleteNote(noteId, cx) {
    if (!this.notesPath) return;
    const notesPath = this.notesPath;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        await saveNotesFile(notesPath, on, (currentText) => removeNoteFromDocument(currentText, noteId));
        this.expandedNotes.delete(noteId);
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  pruneCleanNotes(cx) {
    if (!this.notesPath) return;
    const notesPath = this.notesPath;
    const on = this.on;
    const keepPaths = new Set(this.files.map((f) => f.path));
    cx.spawn(async (cx) => {
      try {
        await saveNotesFile(notesPath, on, (currentText) => clearNotesInDocument(currentText, { keepPaths }));
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  handlePaneKeyDown(e, visibleFiles, cx) {
    if (this.searchFocused) {
      if (e.key === "escape") {
        this.searchFocused = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }

    if (e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) return;

    if (e.key === "/") {
      this.searchInput.focus();
      cx.stop_propagation();
      cx.notify();
      return;
    }

    if (e.key === "r") {
      this.refresh(cx, true);
      cx.stop_propagation();
      return;
    }

    if (e.key === "n") {
      const current = visibleFiles[this.selectedIndex];
      this.openAddNoteModal(current?.path || "");
      cx.stop_propagation();
      return;
    }

    if (!visibleFiles.length) return;
    const maxIdx = visibleFiles.length - 1;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIdx));
    const current = visibleFiles[this.selectedIndex];

    if (e.key === "down" || e.key === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % visibleFiles.length;
      this.listScroll.scroll_to_item(this.selectedIndex);
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "up" || e.key === "k") {
      this.selectedIndex = (this.selectedIndex + visibleFiles.length - 1) % visibleFiles.length;
      this.listScroll.scroll_to_item(this.selectedIndex);
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "enter" || e.key === "right" || e.key === "l") {
      this.toggleFileExpand(current.path, cx);
      cx.stop_propagation();
    } else if (e.key === "left" || e.key === "h") {
      if (this.expandedFiles.has(current.path)) {
        this.expandedFiles.delete(current.path);
        cx.stop_propagation();
        cx.notify();
      }
    } else if (e.key === "s" || e.key === " ") {
      this.toggleStageFile(current, cx);
      cx.stop_propagation();
    } else if (e.key === "d") {
      this.expandedFiles.add(current.path);
      this.toggleFullDiff(current.path, cx);
      cx.stop_propagation();
    }
  }

  statusBadgeColors(status, p) {
    switch (status) {
      case "A":
        return { fg: p.green, bg: withAlpha(p.green, "24"), border: withAlpha(p.green, "4d") };
      case "D":
      case "U":
        return { fg: p.red, bg: withAlpha(p.red, "24"), border: withAlpha(p.red, "4d") };
      case "R":
        return { fg: p.blue, bg: withAlpha(p.blue, "24"), border: withAlpha(p.blue, "4d") };
      default:
        return { fg: p.yellow, bg: withAlpha(p.yellow, "24"), border: withAlpha(p.yellow, "4d") };
    }
  }

  renderDiffLineRow(row, p, showLineNumbers = false) {
    if (row.kind === "section") {
      return div()
        .w_full()
        .px(6)
        .py(2)
        .bg(withAlpha(p.surface0, "99"))
        .text_color(p.mauve)
        .font_semibold()
        .child(row.text);
    }
    if (row.kind === "@") {
      return div()
        .w_full()
        .px(6)
        .py(1)
        .bg(withAlpha(p.surface0, "70"))
        .text_color(p.dim)
        .child(row.text);
    }
    const isAdd = row.kind === "+";
    const isDel = row.kind === "-";
    return h_flex()
      .w_full()
      .px(6)
      .py(1)
      .gap(8)
      .rounded(2)
      .when(isAdd, (el) => el.bg(withAlpha(p.green, "1c")).text_color(p.green))
      .when(isDel, (el) => el.bg(withAlpha(p.red, "1c")).text_color(p.red))
      .when(!isAdd && !isDel, (el) => el.text_color(p.subtext))
      .when(showLineNumbers, (el) =>
        el.child(
          div()
            .w(28)
            .flex_none()
            .text_right()
            .text_color(p.dim)
            .child(row.lineNumber !== null && row.lineNumber !== undefined ? String(row.lineNumber) : ""),
        ),
      )
      .child(div().whitespace_nowrap().child(row.text || " "));
  }

  renderNoteCard(note, p, mono, nowMs) {
    const isExpanded = this.expandedNotes.has(note.id);
    const diffInfo = extractNoteDiffInfo(note);
    const relTime = formatRelativeTime(note.timestamp, nowMs);
    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .id(`note-${note.id}`)
      .w_full()
      .p(6)
      .rounded(5)
      .border_1()
      .border_color(isExpanded ? withAlpha(p.mauve, "88") : p.border)
      .bg(isExpanded ? p.surface0 : withAlpha(p.surface0, "4d"))
      .when(diffInfo.hasDiff, (el) => el.cursor_pointer())
      .hover((s) => s.border_color(isExpanded ? p.mauve : p.input))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (diffInfo.hasDiff) this.toggleNoteExpand(note.id, cx);
      })
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .items_start()
          .justify_between()
          // Left: bullet + concise 1-line summary
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_start()
              .child(div().flex_none().font_bold().text_size(11).text_color(p.mauve).child("•"))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .text_size(11.5)
                  .font_medium()
                  .text_color(p.text)
                  .child(note.summary),
              ),
          )
          // Right: code indicator, line range, agent tag, relative timestamp, delete ×
          .child(
            h_flex()
              .flex_none()
              .gap(5)
              .items_center()
              .font_family(mono)
              .text_size(10)
              .text_color(p.dim)
              .when(diffInfo.hasDiff, (el) =>
                el.child(icon("code", 11).text_color(isExpanded ? p.mauve : p.dim)),
              )
              .when(Boolean(diffInfo.lineRange), (el) =>
                el.child(
                  div()
                    .px(4)
                    .rounded(3)
                    .bg(p.crust)
                    .text_size(9.5)
                    .text_color(p.subtext)
                    .child(diffInfo.lineRange),
                ),
              )
              .when(Boolean(note.agentName), (el) =>
                el.child(div().font_semibold().text_color(p.mauve).child(note.agentName)),
              )
              .when(Boolean(relTime), (el) =>
                el
                  .child(div().text_color(p.border).child("•"))
                  .child(div().child(relTime)),
              )
              .child(
                div()
                  .id(`del-note-${note.id}`)
                  .size(16)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .text_color(p.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.hover).text_color(p.red))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.deleteNote(note.id, cx);
                  })
                  .child(icon("x", 10)),
              ),
          ),
      )
      // Inline Code Diff (only rendered when note is clicked/expanded)
      .when(isExpanded && diffInfo.hasDiff, (el) => {
        const parsedRows = parseDiffLines(diffInfo.lines);
        return el.child(
          v_flex()
            .mt(6)
            .p(6)
            .rounded(4)
            .bg(p.crust)
            .border_1()
            .border_color(p.border)
            .font_family(mono)
            .text_size(10.5)
            .child(
              h_flex()
                .pb(4)
                .mb(4)
                .items_center()
                .justify_between()
                .border_b(1)
                .border_color(p.border)
                .text_size(9.5)
                .text_color(p.dim)
                .child(div().child(diffInfo.lineRange ? `Diff hunk (${diffInfo.lineRange})` : "Diff hunk"))
                .child(div().text_color(p.mauve).child("Click to collapse")),
            )
            .child(
              div()
                .id(`note-diff-scroll-${note.id}`)
                .w_full()
                .overflow_x_scrollbar()
                .child(v_flex().w_full().children(parsedRows.map((r) => this.renderDiffLineRow(r, p, false)))),
            ),
        );
      });
  }

  renderExpandedFileBody(file, fileNotes, p, mono, nowMs) {
    const fullDiffOpen = this.expandedFullDiffs.has(file.path);
    const fullDiffEntry = this.fullDiffCache.get(file.path);
    const stop = (_e, cx) => cx.stop_propagation();

    return h_flex()
      .w_full()
      .pl(12)
      .pr(2)
      .py(3)
      .gap(8)
      // Crisp 1px vertical tree guide line
      .child(div().w(1).flex_none().bg(p.border))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          // Discrete Agent Notes list or Manual edit fallback
          .when(fileNotes.length === 0, (el) =>
            el.child(
              h_flex()
                .py(2)
                .px(4)
                .items_center()
                .justify_between()
                .child(
                  div()
                    .italic()
                    .text_size(10.5)
                    .text_color(p.dim)
                    .child("Manual edit — no discrete agent notes."),
                )
                .child(
                  h_flex()
                    .id(`add-inline-note-${file.path}`)
                    .h(18)
                    .px(6)
                    .gap(3)
                    .items_center()
                    .rounded(4)
                    .font_family(mono)
                    .text_size(9.5)
                    .text_color(p.mauve)
                    .cursor_pointer()
                    .hover((s) => s.bg(withAlpha(p.mauve, "20")))
                    .on_mouse_down("left", stop)
                    .on_click((_e, _cx) => {
                      this.openAddNoteModal(file.path);
                    })
                    .child(icon("plus", 9))
                    .child("Note"),
                ),
            ),
          )
          .when(fileNotes.length > 0, (el) =>
            el.children(fileNotes.map((note) => this.renderNoteCard(note, p, mono, nowMs))),
          )
          // Collapsible Full Git Diff toggle + add note quick button
          .child(
            v_flex()
              .w_full()
              .rounded(5)
              .border_1()
              .border_color(fullDiffOpen ? p.input : p.border)
              .bg(withAlpha(p.crust, "90"))
              .child(
                h_flex()
                  .id(`full-diff-toggle-${file.path}`)
                  .h(24)
                  .px(6)
                  .items_center()
                  .justify_between()
                  .font_family(mono)
                  .text_size(10)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.hover))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.toggleFullDiff(file.path, cx);
                  })
                  .child(
                    h_flex()
                      .gap(5)
                      .items_center()
                      .text_color(fullDiffOpen ? p.text : p.subtext)
                      .child(icon(fullDiffOpen ? "chevron-down" : "chevron-right", 11).text_color(p.dim))
                      .child(icon("code", 11).text_color(p.teal))
                      .child(div().font_medium().child("Full Git Diff"))
                      .when(file.partiallyStaged, (el) =>
                        el.child(div().text_color(p.yellow).child("(staged + unstaged)")),
                      ),
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .when(fileNotes.length > 0, (el) =>
                        el.child(
                          h_flex()
                            .id(`add-more-note-${file.path}`)
                            .h(18)
                            .px(5)
                            .gap(3)
                            .items_center()
                            .rounded(3)
                            .text_color(p.mauve)
                            .hover((s) => s.bg(withAlpha(p.mauve, "24")))
                            .on_mouse_down("left", stop)
                            .on_click((_e, cx) => {
                              cx.stop_propagation();
                              this.openAddNoteModal(file.path);
                            })
                            .child(icon("plus", 9))
                            .child("Note"),
                        ),
                      )
                      .child(
                        div()
                          .text_color(p.dim)
                          .child(fullDiffOpen ? "Hide" : "Show"),
                      ),
                  ),
              )
              .when(fullDiffOpen, (el) =>
                el.child(
                  v_flex()
                    .p(6)
                    .border_t(1)
                    .border_color(p.border)
                    .bg(p.crust)
                    .font_family(mono)
                    .text_size(10.5)
                    .when(!fullDiffEntry || fullDiffEntry.loading, (d) =>
                      d.child(div().py(4).text_color(p.dim).child("Loading git diff…")),
                    )
                    .when(Boolean(fullDiffEntry?.error), (d) =>
                      d.child(div().py(4).text_color(p.red).child(fullDiffEntry.error)),
                    )
                    .when(Boolean(fullDiffEntry && !fullDiffEntry.loading && !fullDiffEntry.error), (d) =>
                      d.child(
                        div()
                          .id(`full-diff-x-${file.path}`)
                          .w_full()
                          .overflow_x_scrollbar()
                          .child(
                            v_flex()
                              .w_full()
                              .children(
                                (fullDiffEntry?.rows ?? []).map((r) =>
                                  this.renderDiffLineRow(r, p, true),
                                ),
                              ),
                          ),
                      ),
                    ),
                ),
              ),
          ),
      );
  }

  renderFileGroup(file, index, p, mono, nowMs) {
    const isExpanded = this.expandedFiles.has(file.path);
    const isSelected = index === this.selectedIndex;
    const badge = this.statusBadgeColors(file.status, p);
    const fileNotes = this.notesByFile.get(file.path) ?? [];
    const stop = (_e, cx) => cx.stop_propagation();

    const checkIcon = file.staged
      ? "check-square"
      : file.partiallyStaged
        ? "minus-square"
        : "square";
    const checkColor = file.staged
      ? p.green
      : file.partiallyStaged
        ? p.yellow
        : p.dim;

    return v_flex()
      .id(`fg-${file.path}`)
      .w_full()
      .child(
        h_flex()
          .id(`fr-${file.path}`)
          .h(28)
          .px(6)
          .gap(6)
          .rounded(5)
          .items_center()
          .justify_between()
          .cursor_pointer()
          .when(isExpanded, (el) => el.bg(withAlpha(p.surface0, "99")).text_color(p.text))
          .when(!isExpanded && isSelected, (el) => el.bg(withAlpha(p.surface0, "55")))
          .hover((s) => s.bg(p.hover).text_color(p.text))
          .on_click((_e, cx) => {
            this.selectedIndex = index;
            this.toggleFileExpand(file.path, cx);
          })
          // Left: Chevron, Stage Checkbox, Status Badge, Monospace Dir + Filename
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(
                icon(isExpanded ? "chevron-down" : "chevron-right", 12).text_color(
                  isExpanded ? p.mauve : p.dim,
                ),
              )
              .child(
                div()
                  .id(`chk-${file.path}`)
                  .size(18)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(4)
                  .text_color(checkColor)
                  .hover((s) => s.bg(p.surface0).text_color(file.staged ? p.subtext : p.green))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.toggleStageFile(file, cx);
                  })
                  .child(icon(checkIcon, 13)),
              )
              .child(
                div()
                  .px(4)
                  .py(1)
                  .flex_none()
                  .rounded(3)
                  .border_1()
                  .border_color(badge.border)
                  .bg(badge.bg)
                  .font_family(mono)
                  .font_bold()
                  .text_size(9.5)
                  .text_color(badge.fg)
                  .child(file.status),
              )
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .font_family(mono)
                  .text_size(11.5)
                  .when(Boolean(file.dir), (el) =>
                    el.child(div().min_w(0).truncate().text_color(p.dim).child(file.dir)),
                  )
                  .child(div().flex_none().font_semibold().text_color(p.text).child(file.name)),
              ),
          )
          // Right: +add/-del stats + Mauve Sparkles Note Count Pill
          .child(
            h_flex()
              .flex_none()
              .gap(6)
              .items_center()
              .font_family(mono)
              .text_size(10)
              .child(
                h_flex()
                  .gap(2)
                  .items_center()
                  .child(div().text_color(p.green).child(`+${file.additions}`))
                  .child(div().text_color(p.dim).child("/"))
                  .child(div().text_color(p.red).child(`-${file.deletions}`)),
              )
              .when(fileNotes.length > 0, (el) =>
                el.child(
                  h_flex()
                    .px(6)
                    .h(17)
                    .gap(3)
                    .items_center()
                    .rounded_full()
                    .border_1()
                    .border_color(withAlpha(p.mauve, "55"))
                    .bg(withAlpha(p.mauve, "24"))
                    .text_color(p.mauve)
                    .font_semibold()
                    .child(icon("sparkles", 9))
                    .child(String(fileNotes.length)),
                ),
              ),
          ),
      )
      .when(isExpanded, (el) =>
        el.child(this.renderExpandedFileBody(file, fileNotes, p, mono, nowMs)),
      );
  }

  renderPane(cx) {
    if (!checking()) {
      const loc = this.currentLocation();
      if (locationKey(loc) !== this.contextKey) {
        this.refresh(cx);
      }
      const bump = shared(SHARED_BUMP_KEY);
      if (bump?.at && bump.at !== this.lastSeenBump) {
        this.lastSeenBump = bump.at;
        if (bump.expandPath) this.expandedFiles.add(bump.expandPath);
        this.refresh(cx);
      }
    }

    const p = resolvePalette(theme());
    const mono = monoFontFamily();
    const stop = (_e, cx) => cx.stop_propagation();
    const nowMs = Date.now();

    const visibleFiles = filterFiles(this.files, this.notesByFile, {
      filter: this.filter,
      query: this.query,
    });
    const footer = computeFooterCounts(this.files, this.notesByFile);
    const orphanNotesCount = Math.max(0, this.notes.length - footer.notes);
    const allStaged = this.files.length > 0 && this.files.every((f) => f.staged);

    const headerIconBtn = (id, svgName, activeColor, action, spinning = false) =>
      div()
        .id(id)
        .size(24)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(activeColor || p.subtext)
        .cursor_pointer()
        .hover((s) => s.bg(p.hover).text_color(p.text))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(spinning ? icon(svgName, 13).spin(900) : icon(svgName, 13));

    const filterPill = (key, label) => {
      const active = this.filter === key;
      return div()
        .id(`flt-${key}`)
        .px(6)
        .py(2)
        .rounded(4)
        .cursor_pointer()
        .when(active, (el) => el.bg(p.selected).text_color(p.text).font_bold())
        .when(!active, (el) => el.text_color(p.dim).hover((s) => s.text_color(p.text)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          this.filter = key;
          this.selectedIndex = 0;
          cx.notify();
        })
        .child(label);
    };

    return v_flex()
      .id("git-status-pane")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(p.mantle)
      .text_color(p.text)
      .text_size(12)
      .on_key_down((e, cx) => this.handlePaneKeyDown(e, visibleFiles, cx))
      // 1. PANE TOOLBAR / HEADER
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .justify_between()
          .bg(withAlpha(p.surface0, "66"))
          .border_b(1)
          .border_color(p.border)
          .font_family(mono)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(icon("git-compare-arrows", 14).text_color(p.mauve))
              .child(
                div()
                  .truncate()
                  .font_bold()
                  .text_size(11.5)
                  .text_color(p.text)
                  .child("Git Changes & Notes"),
              )
              .child(
                div()
                  .px(6)
                  .py(1)
                  .flex_none()
                  .rounded_full()
                  .bg(p.surface0)
                  .border_1()
                  .border_color(p.border)
                  .text_size(10)
                  .font_semibold()
                  .text_color(p.mauve)
                  .child(String(visibleFiles.length)),
              )
              .when(Boolean(this.branch), (el) =>
                el.child(
                  h_flex()
                    .px(5)
                    .py(1)
                    .gap(3)
                    .flex_none()
                    .items_center()
                    .rounded(4)
                    .bg(withAlpha(p.teal, "1f"))
                    .border_1()
                    .border_color(withAlpha(p.teal, "44"))
                    .text_size(9.5)
                    .text_color(p.teal)
                    .child(icon("git-branch", 10))
                    .child(div().max_w(96).truncate().child(this.branch)),
                ),
              ),
          )
          // Quick Actions: + Note, Expand/Collapse All, Stage All, Refresh
          .child(
            h_flex()
              .flex_none()
              .gap(3)
              .items_center()
              .child(
                h_flex()
                  .id("hdr-add-note")
                  .h(23)
                  .px(7)
                  .gap(4)
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(withAlpha(p.mauve, "66"))
                  .bg(withAlpha(p.mauve, "24"))
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(p.mauve)
                  .cursor_pointer()
                  .hover((s) => s.bg(withAlpha(p.mauve, "38")))
                  .on_mouse_down("left", stop)
                  .on_click(() => this.openAddNoteModal())
                  .child(icon("plus", 11))
                  .child("Note"),
              )
              .child(
                headerIconBtn("hdr-expand-all", "chevrons-up-down", null, (_e, cx) =>
                  this.toggleExpandAll(visibleFiles, cx),
                ),
              )
              .child(
                headerIconBtn(
                  "hdr-stage-all",
                  "check-check",
                  allStaged ? p.green : null,
                  (_e, cx) => this.toggleStageAll(cx),
                ),
              )
              .child(
                headerIconBtn(
                  "hdr-refresh",
                  "refresh",
                  this.loading ? p.mauve : null,
                  (_e, cx) => this.refresh(cx, true),
                  this.loading,
                ),
              ),
          ),
      )
      // 2. FILTER & SEARCH BAR (ULTRA COMPACT)
      .child(
        h_flex()
          .flex_none()
          .px(8)
          .py(6)
          .gap(6)
          .items_center()
          .bg(p.mantle)
          .border_b(1)
          .border_color(p.border)
          .child(
            h_flex()
              .id("search-box")
              .flex_1()
              .min_w(0)
              .h(25)
              .px(7)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(p.surface0)
              .border_1()
              .border_color(this.searchFocused ? p.mauve : p.border)
              .font_family(mono)
              .cursor_text()
              .on_mouse_down("left", stop)
              .child(icon("search", 11).text_color(p.dim))
              .child(Input.new(this.searchInput).flex_1().h_full().text_size(11).text_color(p.text))
              .when(Boolean(this.query), (el) =>
                el.child(
                  div()
                    .id("search-clear")
                    .size(16)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(3)
                    .text_color(p.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(p.text))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      this.query = "";
                      this.searchInput.set_value("");
                      cx.notify();
                    })
                    .child(icon("x", 10)),
                ),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .p(2)
              .gap(1)
              .items_center()
              .rounded(5)
              .bg(withAlpha(p.surface0, "99"))
              .border_1()
              .border_color(p.border)
              .font_family(mono)
              .text_size(10)
              .child(filterPill("ALL", "All"))
              .child(filterPill("STAGED", "Staged"))
              .child(filterPill("UNSTAGED", "Unstaged"))
              .child(filterPill("NOTES", "Notes")),
          ),
      )
      // Optional action error banner
      .when(Boolean(this.actionError), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(10)
            .py(4)
            .items_center()
            .justify_between()
            .bg(withAlpha(p.red, "20"))
            .border_b(1)
            .border_color(withAlpha(p.red, "4d"))
            .font_family(mono)
            .text_size(10.5)
            .text_color(p.red)
            .child(div().flex_1().truncate().child(this.actionError))
            .child(
              div()
                .id("dismiss-err")
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.actionError = null;
                  cx.notify();
                })
                .child(icon("x", 11)),
            ),
        ),
      )
      // 3. SCROLLABLE COMPACT FILE TREE + NESTED AGENT NOTES + INLINE DIFFS
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .bg(p.base)
          .child(
            v_flex()
              .id("git-status-list")
              .track_scroll(this.listScroll)
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .gap(2)
              .children(
                visibleFiles.map((file, idx) => this.renderFileGroup(file, idx, p, mono, nowMs)),
              )
              .when(visibleFiles.length === 0, (el) =>
                el.child(
                  v_flex()
                    .w_full()
                    .py(24)
                    .px(12)
                    .gap(6)
                    .items_center()
                    .justify_center()
                    .font_family(mono)
                    .text_size(11)
                    .text_color(p.dim)
                    .child(
                      this.error
                        ? this.error
                        : this.loading && !this.root
                          ? "Loading repository status…"
                          : !this.root
                            ? "No active Git workspace."
                            : this.files.length > 0
                              ? "No matching changes found."
                              : "Working tree clean — no uncommitted changes.",
                    )
                    .when(orphanNotesCount > 0, (sub) =>
                      sub.child(
                        h_flex()
                          .id("prune-clean-notes")
                          .mt(4)
                          .h(22)
                          .px(8)
                          .gap(5)
                          .items_center()
                          .rounded(4)
                          .border_1()
                          .border_color(p.border)
                          .bg(p.mantle)
                          .text_size(10)
                          .text_color(p.mauve)
                          .cursor_pointer()
                          .hover((s) => s.border_color(p.mauve))
                          .on_click((_e, cx) => this.pruneCleanNotes(cx))
                          .child(`Clear ${orphanNotesCount} committed note(s)`),
                      ),
                    ),
                ),
              )
              .when(this.limited, (el) =>
                el.child(
                  div()
                    .px(8)
                    .py(4)
                    .font_family(mono)
                    .text_size(10)
                    .text_color(p.dim)
                    .child("Showing first 1,000 changed files."),
                ),
              ),
          )
          .child(Scrollbar.vertical("git-status-list").absolute().inset_0()),
      )
      // 4. PANE FOOTER STATUS BAR
      .child(
        h_flex()
          .h(24)
          .flex_none()
          .px(10)
          .items_center()
          .justify_between()
          .bg(p.crust)
          .border_t(1)
          .border_color(p.border)
          .font_family(mono)
          .text_size(10)
          .text_color(p.dim)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .gap(3)
                  .child("Staged:")
                  .child(div().font_bold().text_color(p.green).child(String(footer.staged))),
              )
              .child(div().child("•"))
              .child(
                h_flex()
                  .gap(3)
                  .child("Unstaged:")
                  .child(div().font_bold().text_color(p.yellow).child(String(footer.unstaged))),
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .when(orphanNotesCount > 0 && visibleFiles.length > 0, (el) =>
                el.child(
                  div()
                    .id("footer-prune")
                    .text_color(p.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(p.mauve))
                    .on_click((_e, cx) => this.pruneCleanNotes(cx))
                    .child(`Prune ${orphanNotesCount} clean`),
                ),
              )
              .child(
                h_flex()
                  .gap(3)
                  .child("Notes:")
                  .child(div().font_bold().text_color(p.mauve).child(String(footer.notes))),
              ),
          ),
      );
  }

  render(cx) {
    if (this.role === "runner") return div();
    if (this.role === "add-note") return this.renderAddNoteDialog();
    return this.renderPane(cx);
  }
}

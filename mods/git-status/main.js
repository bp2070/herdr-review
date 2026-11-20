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
  hc,
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
  REVIEW_FILENAME,
  SHARED_BUMP_KEY,
  UNATTRIBUTED_TOPIC_ID,
  addCommentToDocument,
  buildFullFileDiffLines,
  buildGitCommitCommands,
  buildTopicGroups,
  buildUntrackedDiffLines,
  computeFooterCounts,
  countLines,
  deleteThreadFromDocument,
  deriveCommitSuggestion,
  deriveOverviewInfo,
  emptyReviewDocument,
  extractDiffHunkInfo,
  filterFilesForReview,
  formatRelativeTime,
  formatReviewDispatchPrompt,
  joinPosixPath,
  locationKey,
  mergeStatusAndStats,
  normalizeRepoPath,
  parseDiffLines,
  parseNumstatZ,
  parsePorcelainStatusZ,
  parseReviewDocument,
  planPaneToggle,
  promoteDraftThreadsToOpen,
  pruneCleanStateInDocument,
  removeTopicFromDocument,
  resolvePalette,
  resolveWorkspaceLocation,
  setThreadStatusInDocument,
  sliceUnifiedHunks,
  stageAllCommandArgs,
  stageCommandArgs,
  stagePathsCommandArgs,
  upsertTopicsInDocument,
  withAlpha,
} from "./model.js";

function icon(name, size = 13) {
  return svg(`mods/${MOD_NAME}/${name}.svg`).size(size).flex_none();
}

function monoFontFamily() {
  const s = settings() ?? {};
  return String(s.font || s.font_family || "JetBrains Mono");
}

function spaceAgents(spaceId) {
  const all = agents() ?? [];
  const inSpace = spaceId ? all.filter((a) => a.space === spaceId) : all;
  return inSpace.length > 0 ? inSpace : all;
}

async function mutateReviewFile(reviewPath, on, mutator) {
  if (!reviewPath) throw new Error("Git directory is not available.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readTextFile(reviewPath, { on }).catch(() => null);
    const result = mutator(existing ?? "");
    if (!on) {
      try {
        await writeTextFile(reviewPath, result.text, existing);
        return result;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    } else {
      const b64 = btoa(unescape(encodeURIComponent(result.text)));
      const remoteWrite = await exec(
        "sh",
        ["-c", `printf %s "$1" | base64 -d > "$2"`, "sh", b64, reviewPath],
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
            reviewPath,
          ],
          { on },
        );
        if (ps.code !== 0) throw new Error(ps.stderr || "Could not write remote review file.");
      }
      return result;
    }
  }
  throw new Error("Concurrent update conflict writing herdr-review.json.");
}

export default class GitReviewView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.copyProps = p;
    this.overlayId = p.overlay ?? null;
    this.role = this.overlayId
      ? p.role === "add-topic"
        ? "add-topic"
        : p.role === "commit"
          ? "commit"
          : "runner"
      : "pane";

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

    if (this.role === "add-topic") {
      this.initAddTopicDialog(p, cx);
      return;
    }

    if (this.role === "commit") {
      this.initCommitDialog(p, cx);
      return;
    }

    this.initPane(p, cx);
  }

  // ===========================================================================
  // ADD CHANGE TOPIC DIALOG (`role === "add-topic"`)
  // ===========================================================================
  initAddTopicDialog(p, cx) {
    this.handle = cx.focus_handle();
    this.dialogFiles = Array.isArray(p.files) ? p.files : [];
    const initialSelected = p.initialPaths?.length
      ? p.initialPaths
      : this.dialogFiles[0]?.path
        ? [this.dialogFiles[0].path]
        : [];

    this.selectedTopicPaths = new Set(initialSelected);
    this.topicTitle = "";
    this.topicRationale = "";
    this.topicAgent = p.defaultAgent || "pi";
    this.topicCommitSubject = p.suggestedSubject || "";
    this.dialogError = "";
    this.savingTopic = false;
    this.focusedField = "title";

    this.titleInput = InputState.new({
      value: "",
      placeholder: "e.g. Thread tenantId through session validation & routes",
    });
    this.titleInput.on("change", (_e, cx) => {
      this.topicTitle = this.titleInput.value();
      this.dialogError = "";
      cx.notify();
    });
    this.titleInput.on("focus", (_e, cx) => {
      this.focusedField = "title";
      cx.notify();
    });
    this.titleInput.on("submit", (_e, cx) => this.submitTopicDialog(cx));

    this.rationaleArea = TextareaState.new({
      value: "",
      rows: 2,
      placeholder: "Optional rationale: why these changes belong together or key trade-offs...",
    });
    this.rationaleArea.on("change", (_e, cx) => {
      this.topicRationale = this.rationaleArea.value();
      cx.notify();
    });
    this.rationaleArea.on("focus", (_e, cx) => {
      this.focusedField = "rationale";
      cx.notify();
    });

    this.commitSuggestInput = InputState.new({
      value: this.topicCommitSubject,
      placeholder: "Optional suggested commit message subject",
    });
    this.commitSuggestInput.on("change", (_e, cx) => {
      this.topicCommitSubject = this.commitSuggestInput.value();
      cx.notify();
    });
    this.commitSuggestInput.on("focus", (_e, cx) => {
      this.focusedField = "commit";
      cx.notify();
    });

    if (!checking()) {
      this.titleInput.focus();
      cx.timer.after(120, () => this.titleInput.focus());
    }
  }

  toggleDialogPath(filePath, cx) {
    if (this.selectedTopicPaths.has(filePath)) {
      this.selectedTopicPaths.delete(filePath);
    } else {
      this.selectedTopicPaths.add(filePath);
    }
    this.dialogError = "";
    cx.notify();
  }

  submitTopicDialog(cx) {
    if (this.savingTopic) return;
    const p = this.copyProps ?? {};
    const reviewPath = p.reviewPath;
    const root = p.root || "";
    const on = p.on ?? null;
    const title = this.topicTitle.trim();
    const paths = [...this.selectedTopicPaths].map((fp) => normalizeRepoPath(fp, root)).filter(Boolean);

    if (!title) {
      this.dialogError = "Enter a 1-line summary headline for this topic.";
      cx.notify();
      return;
    }
    if (paths.length === 0) {
      this.dialogError = "Select at least one changed file for this topic.";
      cx.notify();
      return;
    }
    if (!reviewPath) {
      this.dialogError = "No active Git repository.";
      cx.notify();
      return;
    }

    this.savingTopic = true;
    this.dialogError = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const filesWithHunks = await Promise.all(
          paths.map(async (fp) => {
            const entry = this.dialogFiles.find((f) => f.path === fp);
            let diffHunk = "";
            if (root) {
              if (entry?.fresh) {
                const text = await readTextFile(joinPosixPath(root, fp), { on }).catch(() => null);
                diffHunk = buildUntrackedDiffLines(text, 25).join("\n");
              } else {
                for (const extra of [[], ["--cached"]]) {
                  const res = await exec(
                    "git",
                    [...GIT_READ_ARGS, "diff", ...extra, "--no-ext-diff", "--no-textconv", "--no-color", "-U2", "--", fp],
                    { cwd: root, on },
                  );
                  if (res.code === 0) {
                    const hunks = sliceUnifiedHunks(res.stdout);
                    if (hunks.length) {
                      diffHunk = hunks.slice(0, 35).join("\n");
                      break;
                    }
                  }
                }
              }
            }
            return { filePath: fp, ...(diffHunk ? { diffHunk } : {}) };
          }),
        );

        const suggestedCommit = this.topicCommitSubject.trim()
          ? { subject: this.topicCommitSubject.trim(), agentName: this.topicAgent }
          : undefined;

        const saved = await mutateReviewFile(reviewPath, on, (seed) =>
          upsertTopicsInDocument(seed, {
            topics: [
              {
                title,
                rationale: this.topicRationale.trim(),
                agentName: this.topicAgent,
                files: filesWithHunks,
              },
            ],
            suggestedCommit,
            nowIso: new Date().toISOString(),
            createId: () => `tpc-${randomUUID().slice(0, 8)}`,
          }),
        );

        setShared(SHARED_BUMP_KEY, {
          at: Date.now(),
          expandTopicId: saved.upserted[0]?.id,
        });
        if (this.overlayId) closeOverlay(this.overlayId);
      } catch (err) {
        this.dialogError = String(err?.message ?? err);
        this.savingTopic = false;
        cx.notify();
      }
    });
  }

  renderAddTopicDialog() {
    const p = resolvePalette(theme());
    const mono = monoFontFamily();
    const stop = (_e, cx) => cx.stop_propagation();
    const label = (text) => div().pb(4).font_family(mono).text_size(11).text_color(p.subtext).child(text);

    return v_flex()
      .id("add-topic-dialog")
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
              .child(icon("layers", 14).text_color(p.mauve))
              .child(div().font_semibold().text_size(12).child("Create Change Topic")),
          )
          .child(
            div()
              .id("add-topic-close")
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
      .child(
        v_flex()
          .p(14)
          .gap(10)
          .child(
            v_flex()
              .child(label("Topic Summary Headline"))
              .child(
                div()
                  .id("topic-title-box")
                  .h(30)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.focusedField === "title" ? p.mauve : p.input)
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.titleInput).h_full().text_size(12).text_color(p.text)),
              ),
          )
          .child(
            v_flex()
              .child(label(`Files in this Topic (${this.selectedTopicPaths.size} selected)`))
              .child(
                v_flex()
                  .id("topic-files-pick")
                  .max_h(132)
                  .p(4)
                  .gap(2)
                  .rounded(5)
                  .bg(p.base)
                  .border_1()
                  .border_color(p.border)
                  .overflow_y_scrollbar()
                  .children(
                    this.dialogFiles.map((f, idx) => {
                      const checked = this.selectedTopicPaths.has(f.path);
                      return h_flex()
                        .id(`tf-pick-${idx}`)
                        .h(24)
                        .px(6)
                        .gap(6)
                        .rounded(4)
                        .items_center()
                        .font_family(mono)
                        .text_size(11)
                        .cursor_pointer()
                        .when(checked, (el) => el.bg(withAlpha(p.mauve, "20")).text_color(p.text))
                        .when(!checked, (el) => el.text_color(p.subtext))
                        .hover((s) => s.bg(p.hover))
                        .on_mouse_down("left", stop)
                        .on_click((_e, cx) => this.toggleDialogPath(f.path, cx))
                        .child(
                          icon(checked ? "check-square" : "square", 12).text_color(
                            checked ? p.mauve : p.dim,
                          ),
                        )
                        .child(div().flex_1().truncate().child(f.path));
                    }),
                  )
                  .when(this.dialogFiles.length === 0, (el) =>
                    el.child(div().p(6).text_color(p.dim).child("No uncommitted files in workspace.")),
                  ),
              ),
          )
          .child(
            v_flex()
              .child(label("Optional Rationale"))
              .child(
                div()
                  .id("topic-rationale-box")
                  .h(52)
                  .p(6)
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.focusedField === "rationale" ? p.mauve : p.input)
                  .on_mouse_down("left", stop)
                  .child(Textarea.new(this.rationaleArea).size_full().text_size(11.5).text_color(p.text)),
              ),
          )
          .child(
            v_flex()
              .child(label("Suggested Commit Subject"))
              .child(
                div()
                  .id("topic-commit-box")
                  .h(28)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.focusedField === "commit" ? p.mauve : p.input)
                  .font_family(mono)
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.commitSuggestInput).h_full().text_size(11.5).text_color(p.text)),
              ),
          )
          .when(Boolean(this.dialogError), (el) =>
            el.child(div().text_size(11).text_color(p.red).child(this.dialogError)),
          )
          .child(
            h_flex()
              .pt(6)
              .gap(8)
              .justify_end()
              .border_t(1)
              .border_color(p.border)
              .child(
                h_flex()
                  .id("topic-cancel-btn")
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
                  .id("topic-save-btn")
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
                  .on_click((_e, cx) => this.submitTopicDialog(cx))
                  .child(this.savingTopic ? "Saving…" : "Save Topic"),
              ),
          ),
      );
  }

  // ===========================================================================
  // COMMIT DIALOG (`role === "commit"`)
  // ===========================================================================
  initCommitDialog(p, cx) {
    this.handle = cx.focus_handle();
    this.dlgFiles = Array.isArray(p.files) ? p.files : [];
    this.dlgTopics = Array.isArray(p.topics) ? p.topics : [];
    this.dlgSuggestedCommit = p.suggestedCommit || null;
    this.dlgUnresolvedCount = Number(p.unresolvedTotal) || 0;
    this.dlgBranch = p.branch || "";

    const stagedCount = this.dlgFiles.filter((f) => f.hasStaged).length;
    this.dlgStageAll = stagedCount === 0;
    this.dlgUserEdited = false;
    this.dlgCommitting = false;
    this.dlgError = "";
    this.dlgFocusedField = "subject";

    const initial = this.computeDialogSuggestion();
    this.dlgSubject = initial.subject;
    this.dlgBody = initial.body;

    this.dlgSubjectInput = InputState.new({
      value: this.dlgSubject,
      placeholder: "Commit message subject...",
    });
    this.dlgSubjectInput.on("change", (_e, cx) => {
      this.dlgSubject = this.dlgSubjectInput.value();
      this.dlgUserEdited = true;
      this.dlgError = "";
      cx.notify();
    });
    this.dlgSubjectInput.on("focus", (_e, cx) => {
      this.dlgFocusedField = "subject";
      cx.notify();
    });
    this.dlgSubjectInput.on("submit", (_e, cx) => this.submitCommitDialog(cx));

    this.dlgBodyArea = TextareaState.new({
      value: this.dlgBody,
      rows: 5,
      placeholder: "Optional multi-line commit body...",
    });
    this.dlgBodyArea.on("change", (_e, cx) => {
      this.dlgBody = this.dlgBodyArea.value();
      this.dlgUserEdited = true;
      cx.notify();
    });
    this.dlgBodyArea.on("focus", (_e, cx) => {
      this.dlgFocusedField = "body";
      cx.notify();
    });

    if (!checking()) {
      this.dlgSubjectInput.focus();
      cx.timer.after(120, () => this.dlgSubjectInput.focus());
    }
  }

  computeDialogSuggestion() {
    const scopedFiles = this.dlgStageAll
      ? this.dlgFiles.map((f) => ({ ...f, hasStaged: false }))
      : this.dlgFiles;
    return deriveCommitSuggestion({
      files: scopedFiles,
      topics: this.dlgTopics,
      suggestedCommit: this.dlgSuggestedCommit,
    });
  }

  resetDialogSuggested(cx) {
    this.dlgUserEdited = false;
    const derived = this.computeDialogSuggestion();
    this.dlgSubject = derived.subject;
    this.dlgBody = derived.body;
    this.dlgSubjectInput.set_value(this.dlgSubject);
    this.dlgBodyArea.set_value(this.dlgBody);
    cx.notify();
  }

  setDialogScope(stageAll, cx) {
    this.dlgStageAll = stageAll;
    if (!this.dlgUserEdited) {
      const derived = this.computeDialogSuggestion();
      this.dlgSubject = derived.subject;
      this.dlgBody = derived.body;
      this.dlgSubjectInput.set_value(this.dlgSubject);
      this.dlgBodyArea.set_value(this.dlgBody);
    }
    cx.notify();
  }

  submitCommitDialog(cx) {
    const subject = this.dlgSubject.trim();
    const p = this.copyProps ?? {};
    const root = p.root;
    const on = p.on ?? null;
    const reviewPath = p.reviewPath;

    if (!subject) {
      this.dlgError = "Enter a commit subject.";
      cx.notify();
      return;
    }
    if (!root || !this.dlgFiles.length || this.dlgCommitting) return;

    const commands = buildGitCommitCommands({
      subject,
      body: this.dlgBody,
      hasStagedFiles: !this.dlgStageAll,
    });
    if (!commands.length) return;

    this.dlgCommitting = true;
    this.dlgError = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        for (const args of commands) {
          const res = await exec("git", args, { cwd: root, on });
          if (res.code !== 0) {
            throw new Error((res.stderr || res.stdout || "git commit failed").trim());
          }
        }

        if (reviewPath) {
          const postStatus = await exec(
            "git",
            [...GIT_READ_ARGS, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            { cwd: root, on },
          );
          const remainingPaths =
            postStatus.code === 0
              ? new Set(parsePorcelainStatusZ(postStatus.stdout, 10000).entries.map((e) => e.path))
              : new Set();
          await mutateReviewFile(reviewPath, on, (seed) =>
            pruneCleanStateInDocument(seed, remainingPaths, { dropResolvedThreads: true }),
          ).catch(() => {});
        }

        notify({
          title: "Committed Changes",
          body: subject,
          level: "success",
        });
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        if (this.overlayId) closeOverlay(this.overlayId);
      } catch (err) {
        this.dlgError = String(err?.message ?? err);
        this.dlgCommitting = false;
        cx.notify();
      }
    });
  }

  renderCommitDialog() {
    const p = resolvePalette(theme());
    const mono = monoFontFamily();
    const stop = (_e, cx) => cx.stop_propagation();
    const stagedCount = this.dlgFiles.filter((f) => f.hasStaged).length;
    const totalCount = this.dlgFiles.length;
    const canSubmit = Boolean(this.dlgSubject.trim() && totalCount > 0 && !this.dlgCommitting);
    const execLabel = this.dlgCommitting
      ? "Committing…"
      : !this.dlgStageAll
        ? `Commit Staged (${stagedCount})`
        : `Stage & Commit (${totalCount})`;

    return v_flex()
      .id("commit-dialog")
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
              .child(icon("git-commit", 14).text_color(p.mauve))
              .child(div().font_semibold().text_size(12).child("Commit Changes"))
              .when(Boolean(this.dlgBranch), (el) =>
                el.child(
                  h_flex()
                    .px(5)
                    .py(1)
                    .gap(3)
                    .items_center()
                    .rounded(4)
                    .bg(withAlpha(p.teal, "1f"))
                    .border_1()
                    .border_color(withAlpha(p.teal, "44"))
                    .text_size(9.5)
                    .text_color(p.teal)
                    .child(icon("git-branch", 10))
                    .child(this.dlgBranch),
                ),
              ),
          )
          .child(
            div()
              .id("commit-dlg-close")
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
      .child(
        v_flex()
          .p(14)
          .gap(10)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .gap(8)
              .font_family(mono)
              .text_size(10)
              .child(
                stagedCount > 0 && stagedCount < totalCount
                  ? h_flex()
                      .p(2)
                      .gap(2)
                      .items_center()
                      .rounded(5)
                      .bg(p.surface0)
                      .border_1()
                      .border_color(p.border)
                      .child(
                        div()
                          .id("scope-staged-btn")
                          .px(7)
                          .py(2)
                          .rounded(4)
                          .cursor_pointer()
                          .when(!this.dlgStageAll, (el) =>
                            el.bg(withAlpha(p.green, "28")).text_color(p.green).font_bold(),
                          )
                          .when(this.dlgStageAll, (el) => el.text_color(p.subtext))
                          .on_mouse_down("left", stop)
                          .on_click((_e, cx) => this.setDialogScope(false, cx))
                          .child(`Staged only (${stagedCount})`),
                      )
                      .child(
                        div()
                          .id("scope-all-btn")
                          .px(7)
                          .py(2)
                          .rounded(4)
                          .cursor_pointer()
                          .when(this.dlgStageAll, (el) => el.bg(p.selected).text_color(p.text).font_bold())
                          .when(!this.dlgStageAll, (el) => el.text_color(p.subtext))
                          .on_mouse_down("left", stop)
                          .on_click((_e, cx) => this.setDialogScope(true, cx))
                          .child(`All files (${totalCount})`),
                      )
                  : div()
                      .text_color(stagedCount > 0 ? p.green : p.subtext)
                      .child(
                        stagedCount > 0
                          ? `Committing ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`
                          : `Will stage and commit all ${totalCount} changed file${totalCount === 1 ? "" : "s"}`,
                      ),
              )
              .when(this.dlgUnresolvedCount > 0, (el) =>
                el.child(
                  h_flex()
                    .px(6)
                    .py(2)
                    .gap(4)
                    .items_center()
                    .rounded(4)
                    .bg(withAlpha(p.yellow, "22"))
                    .border_1()
                    .border_color(withAlpha(p.yellow, "55"))
                    .text_color(p.yellow)
                    .child(icon("alert-triangle", 10))
                    .child(
                      `${this.dlgUnresolvedCount} unresolved comment${this.dlgUnresolvedCount === 1 ? "" : "s"}`,
                    ),
                ),
              ),
          )
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .font_family(mono)
                  .text_size(11)
                  .child(div().text_color(p.subtext).child("Commit Subject"))
                  .when(this.dlgUserEdited, (el) =>
                    el.child(
                      div()
                        .id("dlg-reset-suggested")
                        .text_size(10)
                        .text_color(p.mauve)
                        .cursor_pointer()
                        .hover((s) => s.text_color(p.text))
                        .on_mouse_down("left", stop)
                        .on_click((_e, cx) => this.resetDialogSuggested(cx))
                        .child("↺ Reset to Suggested"),
                    ),
                  ),
              )
              .child(
                div()
                  .id("dlg-commit-subject")
                  .h(32)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(p.surface0)
                  .border_1()
                  .border_color(this.dlgFocusedField === "subject" ? p.mauve : p.input)
                  .font_family(mono)
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.dlgSubjectInput).h_full().text_size(12).text_color(p.text)),
              ),
          )
          .child(
            v_flex()
              .gap(4)
              .child(
                div()
                  .font_family(mono)
                  .text_size(11)
                  .text_color(p.subtext)
                  .child("Optional Commit Body"),
              )
              .child(
                div()
                  .id("dlg-commit-body")
                  .h(104)
                  .p(7)
                  .rounded(5)
                  .bg(p.crust)
                  .border_1()
                  .border_color(this.dlgFocusedField === "body" ? p.mauve : p.input)
                  .font_family(mono)
                  .on_mouse_down("left", stop)
                  .child(Textarea.new(this.dlgBodyArea).size_full().text_size(11).text_color(p.text)),
              ),
          )
          .when(Boolean(this.dlgError), (el) =>
            el.child(div().font_family(mono).text_size(11).text_color(p.red).child(this.dlgError)),
          )
          .child(
            h_flex()
              .pt(8)
              .gap(8)
              .justify_end()
              .border_t(1)
              .border_color(p.border)
              .child(
                h_flex()
                  .id("dlg-commit-cancel")
                  .h(30)
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
                  .id("dlg-commit-submit")
                  .h(30)
                  .px(14)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(canSubmit ? (!this.dlgStageAll ? p.green : p.mauve) : p.surface0)
                  .text_color(canSubmit ? p.crust : p.dim)
                  .font_family(mono)
                  .text_size(11)
                  .font_semibold()
                  .when(canSubmit, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.submitCommitDialog(cx))
                  .child(icon("git-commit", 12))
                  .child(execLabel),
              ),
          ),
      );
  }

  // ===========================================================================
  // STANDARD WORKSPACE REVIEW PANE (`role === "pane"`)
  // ===========================================================================
  initPane(_p, cx) {
    this.handle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    this.lastCwdBySpace = new Map();

    this.contextKey = "";
    this.root = null;
    this.gitDir = null;
    this.reviewPath = null;
    this.on = null;
    this.branch = null;
    this.hasHead = true;

    this.files = [];
    this.limited = false;
    this.reviewDoc = emptyReviewDocument();

    this.viewMode = "TOPIC"; // "TOPIC" | "FILE"
    this.filter = "ALL"; // "ALL" | "STAGED" | "UNSTAGED" | "OPEN"
    this.query = "";
    this.searchFocused = false;

    this.expandedTopics = new Set();
    this.expandedItemDiffs = new Set(); // key: `${topicId}::${filePath}` or `file::${filePath}`
    this.forceFullDiffKeys = new Set(); // keys toggled from topic hunk -> full git diff
    this.fullDiffCache = new Map(); // filePath -> { loading, rows, error }
    this.autoExpandedRepo = "";

    // Inline comment / reply composer state
    this.composerTarget = null;
    this.composerText = "";
    this.composerFocused = false;
    this.showResolvedThreads = false;

    // Agent selector for Submit Review
    this.selectedAgentAddress = null;
    this.submittingReview = false;
    this.copiedFeedbackUntil = 0;

    // Top overall summary card state
    this.overviewExpanded = true;

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
      placeholder: "Filter topic, file, comment...",
    });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
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

    this.commentInput = InputState.new({
      value: "",
      placeholder: "Add review comment (Enter saves draft, Esc cancels)...",
    });
    this.commentInput.on("change", (_e, cx) => {
      this.composerText = this.commentInput.value();
      cx.notify();
    });
    this.commentInput.on("focus", (_e, cx) => {
      this.composerFocused = true;
      cx.notify();
    });
    this.commentInput.on("blur", (_e, cx) => {
      this.composerFocused = false;
      cx.notify();
    });
    this.commentInput.on("submit", (_e, cx) => this.saveInlineComment(cx));

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
        } else if (cmd === "add-topic") {
          this.openAddTopicModal();
        } else if (cmd === "commit") {
          this.openCommitModal();
        } else if (cmd === "submit-review") {
          this.submitReviewToAgent(cx);
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
        // Ignore settled watch handles
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
            await cx.sleep(110);
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
      this.reviewPath = null;
      this.files = [];
      this.reviewDoc = emptyReviewDocument();
      this.fullDiffCache.clear();
      this.expandedTopics.clear();
      this.expandedItemDiffs.clear();
      this.composerTarget = null;
      this.error = null;
      this.actionError = null;
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
          this.reviewPath = null;
          this.branch = null;
          this.files = [];
          this.reviewDoc = emptyReviewDocument();
          this.error = "Not a Git repository";
          this.stopWatches();
          return;
        }

        const root = topRes.stdout.trim();
        const gitDir = gitDirRes.stdout.trim();
        const reviewPath = joinPosixPath(gitDir, REVIEW_FILENAME);
        const gitRead = (args) => exec("git", [...GIT_READ_ARGS, ...args], { cwd: root, on: loc.on });

        const [statusRes, headRes, branchRes, stagedStatRes, unstagedStatRes, reviewRaw] =
          await Promise.all([
            gitRead(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
            gitRead(["rev-parse", "--verify", "HEAD"]),
            gitRead(["symbolic-ref", "--short", "-q", "HEAD"]),
            gitRead(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
            gitRead(["diff", "--numstat", "-z", "--no-renames"]),
            readTextFile(reviewPath, { on: loc.on }).catch(() => null),
          ]);

        if (locationKey(this.currentLocation()) !== ctxKey) return;
        if (statusRes.code !== 0) throw new Error(statusRes.stderr || "git status failed");

        const parsedStatus = parsePorcelainStatusZ(statusRes.stdout, 1000);
        const stagedStats = stagedStatRes.code === 0 ? parseNumstatZ(stagedStatRes.stdout) : {};
        const unstagedStats = unstagedStatRes.code === 0 ? parseNumstatZ(unstagedStatRes.stdout) : {};

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
        const reviewDoc = parseReviewDocument(reviewRaw ?? "");

        this.root = root;
        this.gitDir = gitDir;
        this.reviewPath = reviewPath;
        this.hasHead = headRes.code === 0;
        this.branch =
          branchRes.code === 0 ? branchRes.stdout.trim() : loc.branch || (this.hasHead ? "detached" : "main");
        this.files = files;
        this.limited = parsedStatus.limited;
        this.reviewDoc = reviewDoc;
        this.error = null;

        if (this.autoExpandedRepo !== root) {
          this.autoExpandedRepo = root;
          for (const t of reviewDoc.topics.slice(0, 5)) {
            this.expandedTopics.add(t.id);
          }
          if (reviewDoc.topics.length === 0 && files.length > 0) {
            this.expandedTopics.add(UNATTRIBUTED_TOPIC_ID);
          }
        }

        const neededPaths = new Set();
        for (const key of this.expandedItemDiffs) {
          const idx = key.indexOf("::");
          if (idx >= 0) {
            const fp = key.slice(idx + 2);
            if (files.some((f) => f.path === fp)) neededPaths.add(fp);
          }
        }
        this.fullDiffCache.clear();
        await Promise.all([...neededPaths].map((fp) => this.loadFullDiff(fp, ctxKey)));

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

  // ===========================================================================
  // STAGING, TOPIC ACTIONS, COMMENTS, REVIEW DISPATCH, & COMMIT MODAL
  // ===========================================================================

  toggleTopicExpand(topicId, cx) {
    if (this.expandedTopics.has(topicId)) this.expandedTopics.delete(topicId);
    else this.expandedTopics.add(topicId);
    cx.notify();
  }

  toggleItemDiff(diffKey, filePath, needsLiveDiff, cx) {
    if (this.expandedItemDiffs.has(diffKey)) {
      this.expandedItemDiffs.delete(diffKey);
      cx.notify();
      return;
    }
    this.expandedItemDiffs.add(diffKey);
    const ctxKey = this.contextKey;
    cx.notify();
    if (needsLiveDiff && !this.fullDiffCache.has(filePath)) {
      cx.spawn(async (cx) => {
        await this.loadFullDiff(filePath, ctxKey);
        cx.notify();
      });
    }
  }

  toggleForceFullDiff(diffKey, filePath, cx) {
    if (this.forceFullDiffKeys.has(diffKey)) {
      this.forceFullDiffKeys.delete(diffKey);
      cx.notify();
      return;
    }
    this.forceFullDiffKeys.add(diffKey);
    const ctxKey = this.contextKey;
    cx.notify();
    if (!this.fullDiffCache.has(filePath)) {
      cx.spawn(async (cx) => {
        await this.loadFullDiff(filePath, ctxKey);
        cx.notify();
      });
    }
  }

  toggleExpandAll(groups, visibleFiles, cx) {
    if (this.viewMode === "TOPIC") {
      const anyOpen = groups.some((g) => this.expandedTopics.has(g.id));
      if (anyOpen) this.expandedTopics.clear();
      else for (const g of groups) this.expandedTopics.add(g.id);
    } else {
      const anyOpen = visibleFiles.some((f) => this.expandedItemDiffs.has(`file::${f.path}`));
      if (anyOpen) {
        for (const f of visibleFiles) this.expandedItemDiffs.delete(`file::${f.path}`);
      } else {
        const ctxKey = this.contextKey;
        for (const f of visibleFiles) {
          this.expandedItemDiffs.add(`file::${f.path}`);
          if (!this.fullDiffCache.has(f.path)) {
            cx.spawn(async (cx) => {
              await this.loadFullDiff(f.path, ctxKey);
              cx.notify();
            });
          }
        }
      }
    }
    cx.notify();
  }

  runGitStageMutation(args, cx) {
    if (!this.root || !args || this.mutating) return;
    const root = this.root;
    const on = this.on;
    this.mutating = true;
    this.actionError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("git", args, { cwd: root, on });
        if (res.code !== 0) {
          throw new Error((res.stderr || res.stdout || "git stage failed").trim());
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

  toggleStageFile(file, cx) {
    this.runGitStageMutation(stageCommandArgs(file, this.hasHead), cx);
  }

  toggleStageTopic(group, cx) {
    const shouldStage = !group.staged;
    this.runGitStageMutation(stagePathsCommandArgs(group.gitFiles, shouldStage, this.hasHead), cx);
  }

  toggleStageAll(cx) {
    this.runGitStageMutation(stageAllCommandArgs(this.files, this.hasHead), cx);
  }

  openAddTopicModal(initialPaths = []) {
    if (!this.root || !this.reviewPath) {
      notify({
        title: "Git Review",
        body: "Open a Git repository in the active space first.",
        level: "warning",
      });
      return;
    }
    const loc = this.currentLocation();
    const candidateAgents = spaceAgents(loc.spaceId);
    const activeAgent = candidateAgents.find((a) => a.focused) ?? candidateAgents[0];

    openOverlay({
      mod: MOD_NAME,
      kind: "dialog",
      width: 480,
      height: 465,
      props: {
        role: "add-topic",
        root: this.root,
        reviewPath: this.reviewPath,
        on: this.on,
        files: this.files.map((f) => ({ path: f.path, name: f.name, fresh: f.fresh })),
        initialPaths,
        defaultAgent: activeAgent?.app || activeAgent?.program?.key || "pi",
        suggestedSubject: this.reviewDoc.suggestedCommit?.subject || "",
      },
    });
  }

  openCommitModal() {
    if (!this.root || !this.files.length) {
      notify({
        title: "Git Review",
        body: this.root ? "No uncommitted changes to commit." : "Open a Git repository first.",
        level: "info",
      });
      return;
    }
    const counts = computeFooterCounts(
      this.files,
      this.reviewDoc.topics,
      this.reviewDoc.threads,
    );
    openOverlay({
      mod: MOD_NAME,
      kind: "dialog",
      width: 510,
      height: 405,
      props: {
        role: "commit",
        root: this.root,
        on: this.on,
        branch: this.branch,
        reviewPath: this.reviewPath,
        files: this.files.map((f) => ({
          path: f.path,
          name: f.name,
          hasStaged: f.hasStaged,
          hasUnstaged: f.hasUnstaged,
        })),
        topics: this.reviewDoc.topics,
        suggestedCommit: this.reviewDoc.suggestedCommit,
        unresolvedTotal: counts.unresolvedTotal,
      },
    });
  }

  deleteTopic(topicId, cx) {
    if (!this.reviewPath || topicId === UNATTRIBUTED_TOPIC_ID) return;
    const reviewPath = this.reviewPath;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        await mutateReviewFile(reviewPath, on, (seed) => removeTopicFromDocument(seed, topicId));
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  openComposer(target, cx) {
    if (this.composerTarget?.key === target.key) {
      this.composerTarget = null;
      this.composerText = "";
      this.commentInput.set_value("");
      cx.notify();
      return;
    }
    this.composerTarget = target;
    this.composerText = "";
    this.commentInput.set_value("");
    this.commentInput.focus();
    cx.notify();
  }

  closeComposer(cx) {
    this.composerTarget = null;
    this.composerText = "";
    this.commentInput.set_value("");
    this.handle.focus();
    cx.notify();
  }

  saveInlineComment(cx) {
    const target = this.composerTarget;
    const body = this.composerText.trim();
    if (!target || !body || !this.reviewPath) return;

    const reviewPath = this.reviewPath;
    const on = this.on;

    this.composerTarget = null;
    this.composerText = "";
    this.commentInput.set_value("");
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await mutateReviewFile(reviewPath, on, (seed) =>
          addCommentToDocument(
            seed,
            {
              threadId: target.threadId || "",
              topicId: target.topicId && target.topicId !== UNATTRIBUTED_TOPIC_ID ? target.topicId : "",
              filePath: target.filePath || "",
              lineNumber: target.lineNumber ?? null,
              lineRange: target.lineRange || "",
              codeExcerpt: target.codeExcerpt || "",
              author: "you",
              role: "user",
              body,
              status: "draft",
            },
            {
              nowIso: new Date().toISOString(),
              createId: () => `t-${randomUUID().slice(0, 8)}`,
            },
          ),
        );
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  setThreadStatus(threadId, status, cx) {
    if (!this.reviewPath) return;
    const reviewPath = this.reviewPath;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        await mutateReviewFile(reviewPath, on, (seed) =>
          setThreadStatusInDocument(seed, threadId, status, new Date().toISOString()),
        );
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  deleteThread(threadId, cx) {
    if (!this.reviewPath) return;
    const reviewPath = this.reviewPath;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        await mutateReviewFile(reviewPath, on, (seed) => deleteThreadFromDocument(seed, threadId));
        setShared(SHARED_BUMP_KEY, { at: Date.now() });
        this.refresh(cx);
      } catch (err) {
        this.actionError = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  resolvedTargetAgent(spaceId) {
    const candidates = spaceAgents(spaceId);
    if (!candidates.length) return null;
    if (this.selectedAgentAddress) {
      const exact = candidates.find((a) => a.address === this.selectedAgentAddress);
      if (exact) return exact;
    }
    return candidates.find((a) => a.focused) ?? candidates[0];
  }

  cycleTargetAgent(spaceId, cx) {
    const candidates = spaceAgents(spaceId);
    if (candidates.length <= 1) return;
    const current = this.resolvedTargetAgent(spaceId);
    const idx = candidates.findIndex((a) => a.address === current?.address);
    const next = candidates[(idx + 1) % candidates.length];
    this.selectedAgentAddress = next.address;
    cx.notify();
  }

  copyReviewPrompt(cx) {
    const prompt = formatReviewDispatchPrompt(this.reviewDoc.threads, this.reviewDoc.topics);
    if (!prompt) return;
    cx.write_to_clipboard(prompt);
    this.copiedFeedbackUntil = Date.now() + 2000;
    notify({
      title: "Review Copied",
      body: "Copied structured review comments to clipboard.",
      level: "info",
    });
    cx.notify();
  }

  submitReviewToAgent(cx) {
    if (this.submittingReview || !this.reviewPath) return;
    const reviewPath = this.reviewPath;
    const on = this.on;
    const loc = this.currentLocation();
    const targetAgent = this.resolvedTargetAgent(loc.spaceId);

    this.submittingReview = true;
    this.actionError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const promoted = await mutateReviewFile(reviewPath, on, (seed) =>
          promoteDraftThreadsToOpen(seed, new Date().toISOString()),
        );
        const prompt = formatReviewDispatchPrompt(promoted.doc.threads, promoted.doc.topics);
        if (!prompt) {
          this.actionError = "No draft or open review comments to submit.";
          return;
        }

        if (!targetAgent) {
          cx.write_to_clipboard(prompt);
          notify({
            title: "No Active Agent in Space",
            body: "Promoted comments to Open and copied the review prompt to clipboard.",
            level: "warning",
          });
          return;
        }

        const sendRes = await hc(["send", "--json", targetAgent.address, prompt]);
        if (sendRes.code !== 0) {
          cx.write_to_clipboard(prompt);
          notify({
            title: "Agent Busy / Blocked — Copied Review",
            body: `Could not type directly into ${targetAgent.address}; copied review prompt to clipboard instead.`,
            level: "warning",
          });
        } else {
          const agentLabel = targetAgent.app || targetAgent.program?.name || targetAgent.address;
          notify({
            title: `Sent Review to ${agentLabel}`,
            body: `Dispatched ${promoted.openThreads.length} review comment(s) to ${targetAgent.address}.`,
            level: "success",
          });
        }

        setShared(SHARED_BUMP_KEY, { at: Date.now() });
      } catch (err) {
        this.actionError = String(err?.message ?? err);
      } finally {
        this.submittingReview = false;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  // ===========================================================================
  // RENDERING HELPERS: OVERVIEW, THREADS, COMPOSER, DIFFS, TOPICS, & DISPATCH
  // ===========================================================================

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

  threadStatusStyle(status, p) {
    switch (status) {
      case "draft":
        return { label: "Draft", fg: p.yellow, bg: withAlpha(p.yellow, "22"), border: withAlpha(p.yellow, "55") };
      case "open":
        return { label: "Open", fg: p.blue, bg: withAlpha(p.blue, "22"), border: withAlpha(p.blue, "55") };
      case "addressed":
        return { label: "Addressed", fg: p.teal, bg: withAlpha(p.teal, "22"), border: withAlpha(p.teal, "55") };
      default:
        return { label: "Resolved", fg: p.dim, bg: withAlpha(p.surface0, "44"), border: p.border };
    }
  }

  renderOverviewCard(counts, p, mono, nowMs) {
    const info = deriveOverviewInfo({
      files: this.files,
      topics: this.reviewDoc.topics,
      overview: this.reviewDoc.overview,
    });
    if (!info) return null;

    const relTime = info.updatedAt ? formatRelativeTime(info.updatedAt, nowMs) : "";

    return v_flex()
      .flex_none()
      .px(8)
      .py(6)
      .gap(4)
      .bg(withAlpha(p.surface0, "4d"))
      .border_b(1)
      .border_color(p.border)
      .child(
        h_flex()
          .id("overview-toggle")
          .items_center()
          .justify_between()
          .gap(6)
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.overviewExpanded = !this.overviewExpanded;
            cx.notify();
          })
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .font_family(mono)
              .text_size(10)
              .child(
                icon(this.overviewExpanded ? "chevron-down" : "chevron-right", 11).text_color(p.dim),
              )
              .child(icon("sparkles", 11).text_color(p.mauve))
              .child(div().font_bold().text_color(p.text).child("Overall Summary"))
              .child(div().text_color(p.dim).child("•"))
              .child(div().text_color(p.subtext).child(`${this.files.length}f`))
              .when(counts.topics > 0, (el) =>
                el.child(
                  div()
                    .text_color(p.subtext)
                    .child(`· ${counts.topics} topic${counts.topics === 1 ? "" : "s"}`),
                ),
              )
              .child(
                h_flex()
                  .gap(1)
                  .child(div().text_color(p.green).child(`+${info.additions}`))
                  .child(div().text_color(p.dim).child("/"))
                  .child(div().text_color(p.red).child(`-${info.deletions}`)),
              ),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .font_family(mono)
              .text_size(9.5)
              .text_color(p.dim)
              .when(Boolean(info.agentName), (el) =>
                el.child(div().text_color(p.mauve).font_semibold().child(info.agentName)),
              )
              .when(Boolean(relTime), (el) =>
                el.child(div().child("•")).child(div().child(relTime)),
              ),
          ),
      )
      .when(this.overviewExpanded, (el) =>
        el.child(
          div()
            .id("overview-body")
            .max_h(88)
            .pl(16)
            .pr(4)
            .overflow_y_scrollbar()
            .text_size(11.5)
            .text_color(info.synthesized ? p.subtext : p.text)
            .child(info.text),
        ),
      );
  }

  renderInlineComposer(keyPrefix, p, mono) {
    const target = this.composerTarget;
    if (!target || target.key !== keyPrefix) return null;
    const stop = (_e, cx) => cx.stop_propagation();
    const canSave = Boolean(this.composerText.trim());

    return v_flex()
      .id(`composer-${keyPrefix}`)
      .w_full()
      .mt(4)
      .mb(4)
      .p(6)
      .gap(6)
      .rounded(5)
      .bg(p.mantle)
      .border_1()
      .border_color(p.mauve)
      .on_mouse_down("left", stop)
      .on_click(stop)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .font_family(mono)
          .text_size(9.5)
          .text_color(p.mauve)
          .child(
            div().child(
              target.threadId
                ? "Reply to thread (queues as Draft)"
                : target.lineRange
                  ? `Comment on ${target.filePath || ""} (${target.lineRange})`
                  : target.filePath
                    ? `Comment on ${target.filePath}`
                    : "Comment on Topic",
            ),
          )
          .child(
            div()
              .id(`comp-cancel-x-${keyPrefix}`)
              .text_color(p.dim)
              .cursor_pointer()
              .hover((s) => s.text_color(p.text))
              .on_click((_e, cx) => this.closeComposer(cx))
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .id(`comp-input-${keyPrefix}`)
              .flex_1()
              .min_w(0)
              .h(26)
              .px(7)
              .flex()
              .items_center()
              .rounded(4)
              .bg(p.surface0)
              .border_1()
              .border_color(this.composerFocused ? p.mauve : p.input)
              .child(Input.new(this.commentInput).h_full().text_size(11.5).text_color(p.text)),
          )
          .child(
            h_flex()
              .id(`comp-save-${keyPrefix}`)
              .h(26)
              .px(8)
              .items_center()
              .rounded(4)
              .bg(canSave ? p.mauve : p.surface0)
              .text_color(canSave ? p.mauveFg : p.dim)
              .font_family(mono)
              .text_size(10.5)
              .font_semibold()
              .when(canSave, (el) => el.cursor_pointer())
              .on_click((_e, cx) => this.saveInlineComment(cx))
              .child("Add Draft"),
          ),
      );
  }

  renderThreadCard(thread, scopePrefix, p, mono, nowMs) {
    if (thread.status === "resolved" && !this.showResolvedThreads) return null;
    const st = this.threadStatusStyle(thread.status, p);
    const replyKey = `reply::${scopePrefix}::${thread.id}`;
    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .id(`thr-${scopePrefix}-${thread.id}`)
      .w_full()
      .mt(3)
      .p(6)
      .gap(4)
      .rounded(5)
      .bg(p.mantle)
      .border_1()
      .border_color(st.border)
      .on_click(stop)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .font_family(mono)
          .text_size(9.5)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(icon("message-square", 10).text_color(st.fg))
              .child(
                div()
                  .px(4)
                  .py(0.5)
                  .rounded(3)
                  .bg(st.bg)
                  .border_1()
                  .border_color(st.border)
                  .font_bold()
                  .text_color(st.fg)
                  .child(st.label),
              )
              .when(Boolean(thread.lineRange), (el) =>
                el.child(div().text_color(p.subtext).child(thread.lineRange)),
              )
              .child(div().text_color(p.dim).child(formatRelativeTime(thread.updatedAt, nowMs))),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .id(`thr-reply-${scopePrefix}-${thread.id}`)
                  .px(4)
                  .py(1)
                  .gap(3)
                  .items_center()
                  .rounded(3)
                  .text_color(p.mauve)
                  .cursor_pointer()
                  .hover((s) => s.bg(withAlpha(p.mauve, "20")))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) =>
                    this.openComposer(
                      {
                        key: replyKey,
                        threadId: thread.id,
                        topicId: thread.topicId || "",
                        filePath: thread.filePath || "",
                        lineRange: thread.lineRange || "",
                      },
                      cx,
                    ),
                  )
                  .child(icon("corner-down-right", 9))
                  .child("Reply"),
              )
              .when(thread.status !== "resolved", (el) =>
                el.child(
                  h_flex()
                    .id(`thr-resolve-${scopePrefix}-${thread.id}`)
                    .px(4)
                    .py(1)
                    .gap(3)
                    .items_center()
                    .rounded(3)
                    .text_color(p.green)
                    .cursor_pointer()
                    .hover((s) => s.bg(withAlpha(p.green, "20")))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => this.setThreadStatus(thread.id, "resolved", cx))
                    .child(icon("check", 9))
                    .child("Resolve"),
                ),
              )
              .child(
                div()
                  .id(`thr-del-${scopePrefix}-${thread.id}`)
                  .size(15)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .text_color(p.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.hover).text_color(p.red))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.deleteThread(thread.id, cx))
                  .child(icon("x", 9)),
              ),
          ),
      )
      .children(
        thread.messages.map((m) =>
          h_flex()
            .w_full()
            .gap(5)
            .items_start()
            .text_size(11)
            .child(
              div()
                .flex_none()
                .font_family(mono)
                .text_size(10)
                .font_semibold()
                .text_color(m.role === "agent" ? p.teal : p.mauve)
                .child(`${m.role === "agent" ? m.author : "you"}:`),
            )
            .child(div().flex_1().min_w(0).text_color(p.text).child(m.body)),
        ),
      )
      .when(this.composerTarget?.key === replyKey, (el) =>
        el.child(this.renderInlineComposer(replyKey, p, mono)),
      );
  }

  renderInteractiveDiffBlock({ diffKey, topicId, filePath, rows, threads, p, mono, nowMs }) {
    const stop = (_e, cx) => cx.stop_propagation();
    const threadsByLine = new Map();
    for (const t of threads) {
      if (t.lineNumber) {
        const list = threadsByLine.get(t.lineNumber) ?? [];
        list.push(t);
        threadsByLine.set(t.lineNumber, list);
      }
    }

    return div()
      .id(`diff-x-${diffKey}`)
      .w_full()
      .overflow_x_scrollbar()
      .child(
        v_flex()
          .w_full()
          .font_family(mono)
          .text_size(10.5)
          .children(
            rows.map((row, idx) => {
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
              const lineNum = row.lineNumber;
              const lineKey = `line::${diffKey}::${idx}`;
              const lineRange = lineNum ? `L${lineNum}` : "";
              const lineThreads = lineNum && !isDel ? threadsByLine.get(lineNum) ?? [] : [];

              return v_flex()
                .w_full()
                .child(
                  h_flex()
                    .id(`dr-${diffKey}-${idx}`)
                    .w_full()
                    .px(4)
                    .py(1)
                    .gap(6)
                    .items_center()
                    .rounded(2)
                    .cursor_pointer()
                    .when(isAdd, (el) => el.bg(withAlpha(p.green, "1c")).text_color(p.green))
                    .when(isDel, (el) => el.bg(withAlpha(p.red, "1c")).text_color(p.red))
                    .when(!isAdd && !isDel, (el) => el.text_color(p.subtext))
                    .hover((s) => s.bg(withAlpha(p.mauve, "22")))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      this.openComposer(
                        {
                          key: lineKey,
                          topicId,
                          filePath,
                          lineNumber: lineNum,
                          lineRange,
                          codeExcerpt: row.text,
                        },
                        cx,
                      );
                    })
                    .child(
                      div()
                        .w(14)
                        .flex_none()
                        .text_center()
                        .text_size(9.5)
                        .text_color(p.mauve)
                        .child("+"),
                    )
                    .child(
                      div()
                        .w(28)
                        .flex_none()
                        .text_right()
                        .text_color(p.dim)
                        .child(lineNum !== null && lineNum !== undefined ? String(lineNum) : ""),
                    )
                    .child(div().whitespace_nowrap().child(row.text || " ")),
                )
                .children(
                  lineThreads
                    .map((t) => this.renderThreadCard(t, `${diffKey}-L${idx}`, p, mono, nowMs))
                    .filter(Boolean),
                )
                .when(this.composerTarget?.key === lineKey, (el) =>
                  el.child(this.renderInlineComposer(lineKey, p, mono)),
                );
            }),
          ),
      );
  }

  renderFileItemRow({ topicId, item, p, mono, nowMs }) {
    const file = item.gitFile;
    const diffKey = `${topicId}::${file.path}`;
    const isDiffOpen = this.expandedItemDiffs.has(diffKey);
    const forceFull = this.forceFullDiffKeys.has(diffKey);
    const hunkInfo = extractDiffHunkInfo(item);
    const needsLiveDiff = !hunkInfo.hasDiff || forceFull;
    const fullDiffEntry = this.fullDiffCache.get(file.path);
    const badge = this.statusBadgeColors(file.status, p);
    const fileCommentKey = `file-cmt::${diffKey}`;
    const stop = (_e, cx) => cx.stop_propagation();

    const fileLevelThreads = item.threads.filter((t) => !t.lineNumber || !isDiffOpen);
    const activeFileThreads = item.threads.filter((t) => t.status !== "resolved");

    const checkIcon = file.staged ? "check-square" : file.partiallyStaged ? "minus-square" : "square";
    const checkColor = file.staged ? p.green : file.partiallyStaged ? p.yellow : p.dim;

    return v_flex()
      .id(`fitem-${diffKey}`)
      .w_full()
      .rounded(5)
      .border_1()
      .border_color(isDiffOpen ? p.input : p.border)
      .bg(withAlpha(p.surface0, isDiffOpen ? "66" : "33"))
      .child(
        h_flex()
          .id(`fitem-hdr-${diffKey}`)
          .h(26)
          .px(6)
          .gap(5)
          .items_center()
          .justify_between()
          .cursor_pointer()
          .hover((s) => s.bg(p.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.toggleItemDiff(diffKey, file.path, needsLiveDiff, cx);
          })
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .items_center()
              .child(icon(isDiffOpen ? "chevron-down" : "chevron-right", 11).text_color(p.dim))
              .child(
                div()
                  .id(`fchk-${diffKey}`)
                  .size(16)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .text_color(checkColor)
                  .hover((s) => s.bg(p.surface0).text_color(p.green))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.toggleStageFile(file, cx);
                  })
                  .child(icon(checkIcon, 12)),
              )
              .child(
                div()
                  .px(4)
                  .py(0.5)
                  .flex_none()
                  .rounded(3)
                  .border_1()
                  .border_color(badge.border)
                  .bg(badge.bg)
                  .font_family(mono)
                  .font_bold()
                  .text_size(9)
                  .text_color(badge.fg)
                  .child(file.status),
              )
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .font_family(mono)
                  .text_size(11)
                  .when(Boolean(file.dir), (el) =>
                    el.child(div().min_w(0).truncate().text_color(p.dim).child(file.dir)),
                  )
                  .child(div().flex_none().font_semibold().text_color(p.text).child(file.name)),
              )
              .when(Boolean(hunkInfo.lineRange), (el) =>
                el.child(
                  div()
                    .px(4)
                    .rounded(3)
                    .bg(p.crust)
                    .font_family(mono)
                    .text_size(9)
                    .text_color(p.subtext)
                    .child(hunkInfo.lineRange),
                ),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(5)
              .items_center()
              .font_family(mono)
              .text_size(9.5)
              .when(activeFileThreads.length > 0, (el) =>
                el.child(
                  h_flex()
                    .px(4)
                    .gap(2)
                    .items_center()
                    .rounded(3)
                    .bg(withAlpha(p.yellow, "22"))
                    .text_color(p.yellow)
                    .child(icon("message-square", 9))
                    .child(String(activeFileThreads.length)),
                ),
              )
              .child(
                h_flex()
                  .gap(1)
                  .child(div().text_color(p.green).child(`+${file.additions}`))
                  .child(div().text_color(p.dim).child("/"))
                  .child(div().text_color(p.red).child(`-${file.deletions}`)),
              )
              .child(
                div()
                  .id(`fcmt-btn-${diffKey}`)
                  .size(18)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .text_color(p.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.surface0).text_color(p.mauve))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.openComposer(
                      {
                        key: fileCommentKey,
                        topicId,
                        filePath: file.path,
                        lineRange: hunkInfo.lineRange || "",
                      },
                      cx,
                    );
                  })
                  .child(icon("message-square", 10)),
              ),
          ),
      )
      .when(Boolean(item.summary), (el) =>
        el.child(
          div()
            .px(8)
            .pb(4)
            .text_size(10.5)
            .text_color(p.subtext)
            .child(`↳ ${item.summary}`),
        ),
      )
      .when(this.composerTarget?.key === fileCommentKey, (el) =>
        el.child(div().px(6).child(this.renderInlineComposer(fileCommentKey, p, mono))),
      )
      .when(fileLevelThreads.length > 0, (el) =>
        el.child(
          v_flex()
            .px(6)
            .pb(4)
            .children(
              fileLevelThreads
                .map((t) => this.renderThreadCard(t, `fl-${diffKey}`, p, mono, nowMs))
                .filter(Boolean),
            ),
        ),
      )
      .when(isDiffOpen, (el) => {
        const rows = !needsLiveDiff ? parseDiffLines(hunkInfo.lines) : fullDiffEntry?.rows ?? [];
        return el.child(
          v_flex()
            .p(5)
            .border_t(1)
            .border_color(p.border)
            .bg(p.crust)
            .child(
              h_flex()
                .pb(3)
                .mb(3)
                .items_center()
                .justify_between()
                .border_b(1)
                .border_color(p.border)
                .font_family(mono)
                .text_size(9.5)
                .text_color(p.dim)
                .child(
                  div().child(
                    !needsLiveDiff
                      ? `Topic diff hunk${hunkInfo.lineRange ? ` (${hunkInfo.lineRange})` : ""} · click any line to comment`
                      : "Full Git diff · click any line to comment",
                  ),
                )
                .when(hunkInfo.hasDiff, (hdr) =>
                  hdr.child(
                    div()
                      .id(`toggle-full-${diffKey}`)
                      .text_color(p.teal)
                      .cursor_pointer()
                      .hover((s) => s.text_color(p.mauve))
                      .on_mouse_down("left", stop)
                      .on_click((_e, cx) => this.toggleForceFullDiff(diffKey, file.path, cx))
                      .child(forceFull ? "Show Topic Hunk" : "Show Full File Diff"),
                  ),
                ),
            )
            .when(needsLiveDiff && (!fullDiffEntry || fullDiffEntry.loading), (d) =>
              d.child(div().py(4).font_family(mono).text_size(10).text_color(p.dim).child("Loading git diff…")),
            )
            .when(needsLiveDiff && Boolean(fullDiffEntry?.error), (d) =>
              d.child(div().py(4).font_family(mono).text_size(10).text_color(p.red).child(fullDiffEntry.error)),
            )
            .when(!needsLiveDiff || (fullDiffEntry && !fullDiffEntry.loading && !fullDiffEntry.error), (d) =>
              d.child(
                this.renderInteractiveDiffBlock({
                  diffKey,
                  topicId,
                  filePath: file.path,
                  rows,
                  threads: item.threads,
                  p,
                  mono,
                  nowMs,
                }),
              ),
            ),
        );
      });
  }

  renderTopicGroupCard(group, topicIndex, p, mono, nowMs) {
    const isExpanded = this.expandedTopics.has(group.id);
    const stop = (_e, cx) => cx.stop_propagation();
    const topicCommentKey = `topic-cmt::${group.id}`;

    const checkIcon = group.staged
      ? "check-square"
      : group.partiallyStaged
        ? "minus-square"
        : "square";
    const checkColor = group.staged ? p.green : group.partiallyStaged ? p.yellow : p.dim;

    return v_flex()
      .id(`topic-card-${group.id}`)
      .w_full()
      .rounded(6)
      .border_1()
      .border_color(
        isExpanded
          ? group.isUnattributed
            ? p.input
            : withAlpha(p.mauve, "77")
          : p.border,
      )
      .bg(isExpanded ? withAlpha(p.mantle, "ee") : withAlpha(p.mantle, "88"))
      .child(
        h_flex()
          .id(`topic-hdr-${group.id}`)
          .min_h(30)
          .px(7)
          .py(4)
          .gap(6)
          .items_center()
          .justify_between()
          .cursor_pointer()
          .hover((s) => s.bg(p.hover))
          .on_click((_e, cx) => this.toggleTopicExpand(group.id, cx))
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
                  .id(`tchk-${group.id}`)
                  .size(18)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(4)
                  .text_color(checkColor)
                  .hover((s) => s.bg(p.surface0).text_color(p.green))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.toggleStageTopic(group, cx);
                  })
                  .child(icon(checkIcon, 13)),
              )
              .child(
                div()
                  .px(5)
                  .py(1)
                  .flex_none()
                  .rounded(3)
                  .border_1()
                  .border_color(group.isUnattributed ? p.border : withAlpha(p.mauve, "55"))
                  .bg(group.isUnattributed ? p.surface0 : withAlpha(p.mauve, "22"))
                  .font_family(mono)
                  .font_semibold()
                  .text_size(9.5)
                  .text_color(group.isUnattributed ? p.dim : p.mauve)
                  .child(group.isUnattributed ? "Unattributed" : `Topic ${topicIndex + 1}`),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .font_semibold()
                  .text_size(11.5)
                  .text_color(group.isUnattributed ? p.subtext : p.text)
                  .child(group.title),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(6)
              .items_center()
              .font_family(mono)
              .text_size(10)
              .when(group.activeThreadCount > 0, (el) =>
                el.child(
                  h_flex()
                    .px(5)
                    .h(17)
                    .gap(3)
                    .items_center()
                    .rounded_full()
                    .bg(withAlpha(p.yellow, "24"))
                    .border_1()
                    .border_color(withAlpha(p.yellow, "55"))
                    .text_color(p.yellow)
                    .font_semibold()
                    .child(icon("message-square", 9))
                    .child(String(group.activeThreadCount)),
                ),
              )
              .child(
                div()
                  .px(4)
                  .rounded(3)
                  .bg(p.surface0)
                  .text_color(p.subtext)
                  .child(`${group.items.length}f`),
              )
              .child(
                h_flex()
                  .gap(1)
                  .child(div().text_color(p.green).child(`+${group.additions}`))
                  .child(div().text_color(p.dim).child("/"))
                  .child(div().text_color(p.red).child(`-${group.deletions}`)),
              )
              .child(
                div()
                  .id(`tcmt-btn-${group.id}`)
                  .size(18)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .text_color(p.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.surface0).text_color(p.mauve))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.expandedTopics.add(group.id);
                    this.openComposer({ key: topicCommentKey, topicId: group.id }, cx);
                  })
                  .child(icon("message-square", 10)),
              )
              .when(!group.isUnattributed, (el) =>
                el.child(
                  div()
                    .id(`tdel-btn-${group.id}`)
                    .size(18)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(3)
                    .text_color(p.dim)
                    .cursor_pointer()
                    .hover((s) => s.bg(p.surface0).text_color(p.red))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.deleteTopic(group.id, cx);
                    })
                    .child(icon("x", 10)),
                ),
              ),
          ),
      )
      .when(isExpanded, (el) =>
        el.child(
          h_flex()
            .w_full()
            .pl(12)
            .pr(6)
            .pb(6)
            .pt(2)
            .gap(8)
            .child(div().w(1).flex_none().bg(p.border))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(5)
                .when(Boolean(group.rationale || group.agentName), (r) =>
                  r.child(
                    h_flex()
                      .w_full()
                      .items_start()
                      .justify_between()
                      .gap(8)
                      .px(2)
                      .when(Boolean(group.rationale), (rt) =>
                        rt.child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .text_size(11)
                            .text_color(p.subtext)
                            .child(group.rationale),
                        ),
                      )
                      .when(Boolean(group.agentName), (ag) =>
                        ag.child(
                          h_flex()
                            .flex_none()
                            .gap(4)
                            .font_family(mono)
                            .text_size(9.5)
                            .text_color(p.dim)
                            .child(div().text_color(p.mauve).font_semibold().child(group.agentName))
                            .when(Boolean(formatRelativeTime(group.timestamp, nowMs)), (tm) =>
                              tm
                                .child(div().child("•"))
                                .child(div().child(formatRelativeTime(group.timestamp, nowMs))),
                            ),
                        ),
                      ),
                  ),
                )
                .when(group.isUnattributed && group.items.length > 0, (u) =>
                  u.child(
                    h_flex()
                      .px(2)
                      .child(
                        h_flex()
                          .id("group-unattributed-btn")
                          .h(20)
                          .px(7)
                          .gap(4)
                          .items_center()
                          .rounded(4)
                          .border_1()
                          .border_color(withAlpha(p.mauve, "55"))
                          .bg(withAlpha(p.mauve, "1f"))
                          .font_family(mono)
                          .text_size(9.5)
                          .text_color(p.mauve)
                          .cursor_pointer()
                          .hover((s) => s.bg(withAlpha(p.mauve, "33")))
                          .on_mouse_down("left", stop)
                          .on_click(() =>
                            this.openAddTopicModal(group.items.map((it) => it.filePath)),
                          )
                          .child(icon("plus", 9))
                          .child("Group into Topic"),
                      ),
                  ),
                )
                .when(this.composerTarget?.key === topicCommentKey, (c) =>
                  c.child(this.renderInlineComposer(topicCommentKey, p, mono)),
                )
                .children(
                  group.topicThreads
                    .map((t) => this.renderThreadCard(t, `tp-${group.id}`, p, mono, nowMs))
                    .filter(Boolean),
                )
                .children(
                  group.items.map((item) =>
                    this.renderFileItemRow({ topicId: group.id, item, p, mono, nowMs }),
                  ),
                ),
            ),
        ),
      );
  }

  renderByFileRow(file, p, mono, nowMs) {
    const fileTopics = this.reviewDoc.topics.filter((t) =>
      t.files.some((tf) => tf.filePath === file.path),
    );
    const fileThreads = this.reviewDoc.threads.filter((t) => t.filePath === file.path);
    const summaryText = fileTopics.map((t) => t.title).join(" · ");

    return this.renderFileItemRow({
      topicId: "file",
      item: {
        filePath: file.path,
        gitFile: file,
        summary: summaryText,
        lineRange: "",
        diffHunk: "",
        threads: fileThreads,
      },
      p,
      mono,
      nowMs,
    });
  }

  renderReviewDispatchBar(counts, spaceId, p, mono) {
    const hasReviewActivity = counts.draft > 0 || counts.open > 0 || counts.addressed > 0;
    if (!hasReviewActivity) return null;

    const stop = (_e, cx) => cx.stop_propagation();
    const candidates = spaceAgents(spaceId);
    const targetAgent = this.resolvedTargetAgent(spaceId);
    const agentLabel = targetAgent
      ? `${targetAgent.app || targetAgent.program?.name || "agent"} (${targetAgent.address})`
      : "clipboard";
    const submitCount = counts.draft + counts.open;
    const copiedRecently = Date.now() < this.copiedFeedbackUntil;

    const statusChips = [];
    if (counts.draft > 0) statusChips.push(`${counts.draft} draft`);
    if (counts.open > 0) statusChips.push(`${counts.open} open`);
    if (counts.addressed > 0) statusChips.push(`${counts.addressed} addressed`);

    return h_flex()
      .flex_none()
      .px(8)
      .py(6)
      .gap(6)
      .items_center()
      .justify_between()
      .bg(withAlpha(p.surface0, "88"))
      .border_t(1)
      .border_color(p.border)
      .font_family(mono)
      .text_size(10)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(icon("message-square", 12).text_color(counts.addressed > 0 ? p.teal : p.yellow))
          .child(div().truncate().text_color(p.text).child(statusChips.join(" • ")))
          .when(candidates.length > 1, (el) =>
            el.child(
              div()
                .id("cycle-agent-btn")
                .px(5)
                .py(1)
                .rounded(3)
                .border_1()
                .border_color(p.border)
                .bg(p.mantle)
                .text_color(p.mauve)
                .cursor_pointer()
                .hover((s) => s.border_color(p.mauve))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => this.cycleTargetAgent(spaceId, cx))
                .child(`→ ${agentLabel}`),
            ),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(5)
          .items_center()
          .when(submitCount > 0, (el) =>
            el
              .child(
                h_flex()
                  .id("copy-review-btn")
                  .h(24)
                  .px(7)
                  .gap(4)
                  .items_center()
                  .rounded(5)
                  .bg(p.mantle)
                  .border_1()
                  .border_color(p.border)
                  .text_color(copiedRecently ? p.green : p.subtext)
                  .cursor_pointer()
                  .hover((s) => s.bg(p.hover).text_color(p.text))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.copyReviewPrompt(cx))
                  .child(icon("copy", 10))
                  .child(copiedRecently ? "Copied" : "Copy"),
              )
              .child(
                h_flex()
                  .id("submit-review-btn")
                  .h(24)
                  .px(8)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(p.mauve)
                  .text_color(p.mauveFg)
                  .font_semibold()
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.9))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.submitReviewToAgent(cx))
                  .child(icon("send", 10))
                  .child(
                    this.submittingReview
                      ? "Sending…"
                      : `Submit Review → ${targetAgent?.app || "agent"} (${submitCount})`,
                  ),
              ),
          ),
      );
  }

  renderPane(cx) {
    const loc = this.currentLocation();
    if (!checking()) {
      if (locationKey(loc) !== this.contextKey) {
        this.refresh(cx);
      }
      const bump = shared(SHARED_BUMP_KEY);
      if (bump?.at && bump.at !== this.lastSeenBump) {
        this.lastSeenBump = bump.at;
        if (bump.expandTopicId) this.expandedTopics.add(bump.expandTopicId);
        this.refresh(cx);
      }
    }

    const p = resolvePalette(theme());
    const mono = monoFontFamily();
    const stop = (_e, cx) => cx.stop_propagation();
    const nowMs = Date.now();

    const topicGroups = buildTopicGroups(
      this.files,
      this.reviewDoc.topics,
      this.reviewDoc.threads,
      { filter: this.filter, query: this.query },
    );
    const visibleFiles = filterFilesForReview(
      this.files,
      this.reviewDoc.topics,
      this.reviewDoc.threads,
      { filter: this.filter, query: this.query },
    );
    const counts = computeFooterCounts(
      this.files,
      this.reviewDoc.topics,
      this.reviewDoc.threads,
    );
    const allStaged = this.files.length > 0 && this.files.every((f) => f.staged);
    const hasDirtyFiles = this.files.length > 0;
    const hasStaged = counts.staged > 0;

    const headerIconBtn = (id, svgName, activeColor, action, spinning = false) =>
      div()
        .id(id)
        .size(23)
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
        .child(spinning ? icon(svgName, 12).spin(900) : icon(svgName, 12));

    const modePill = (mode, label, svgName) => {
      const active = this.viewMode === mode;
      return h_flex()
        .id(`mode-${mode}`)
        .h(20)
        .px(6)
        .gap(4)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .when(active, (el) => el.bg(p.selected).text_color(p.mauve).font_bold())
        .when(!active, (el) => el.text_color(p.dim).hover((s) => s.text_color(p.text)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          this.viewMode = mode;
          cx.notify();
        })
        .child(icon(svgName, 10))
        .child(label);
    };

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
          cx.notify();
        })
        .child(label);
    };

    const overviewCard = this.renderOverviewCard(counts, p, mono, nowMs);
    const dispatchBar = this.renderReviewDispatchBar(counts, loc.spaceId, p, mono);

    return v_flex()
      .id("git-review-pane")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(p.mantle)
      .text_color(p.text)
      .text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.composerTarget) {
            this.closeComposer(cx);
            cx.stop_propagation();
          } else if (this.searchFocused) {
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
          }
          return;
        }
        if (
          !this.searchFocused &&
          !this.composerFocused &&
          !e.modifiers?.control &&
          !e.modifiers?.alt &&
          !e.modifiers?.platform &&
          e.key === "c" &&
          hasDirtyFiles
        ) {
          this.openCommitModal();
          cx.stop_propagation();
        }
      })
      // 1. PANE HEADER: [Topics | Files] Toggle + Branch + Quick Actions
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(8)
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
                h_flex()
                  .p(1.5)
                  .gap(1)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .bg(p.mantle)
                  .border_1()
                  .border_color(p.border)
                  .text_size(10)
                  .child(modePill("TOPIC", "Topics", "layers"))
                  .child(modePill("FILE", "Files", "file-text")),
              )
              .when(Boolean(this.branch), (el) =>
                el.child(
                  h_flex()
                    .px(5)
                    .py(1)
                    .gap(3)
                    .min_w(0)
                    .items_center()
                    .rounded(4)
                    .bg(withAlpha(p.teal, "1f"))
                    .border_1()
                    .border_color(withAlpha(p.teal, "44"))
                    .text_size(9.5)
                    .text_color(p.teal)
                    .child(icon("git-branch", 10))
                    .child(div().max_w(88).truncate().child(this.branch)),
                ),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(3)
              .items_center()
              .child(
                h_flex()
                  .id("hdr-add-topic")
                  .h(22)
                  .px(6)
                  .gap(3)
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(withAlpha(p.mauve, "66"))
                  .bg(withAlpha(p.mauve, "24"))
                  .text_size(10)
                  .font_semibold()
                  .text_color(p.mauve)
                  .cursor_pointer()
                  .hover((s) => s.bg(withAlpha(p.mauve, "38")))
                  .on_mouse_down("left", stop)
                  .on_click(() => this.openAddTopicModal())
                  .child(icon("plus", 10))
                  .child("Topic"),
              )
              .child(
                h_flex()
                  .id("hdr-open-commit")
                  .h(22)
                  .px(7)
                  .gap(4)
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(
                    !hasDirtyFiles
                      ? p.border
                      : hasStaged
                        ? withAlpha(p.green, "66")
                        : p.input,
                  )
                  .bg(
                    !hasDirtyFiles
                      ? p.surface0
                      : hasStaged
                        ? withAlpha(p.green, "24")
                        : p.surface0,
                  )
                  .text_size(10)
                  .font_semibold()
                  .text_color(!hasDirtyFiles ? p.dim : hasStaged ? p.green : p.text)
                  .when(hasDirtyFiles, (el) =>
                    el.cursor_pointer().hover((s) => s.bg(hasStaged ? withAlpha(p.green, "38") : p.hover)),
                  )
                  .on_mouse_down("left", stop)
                  .on_click(() => {
                    if (hasDirtyFiles) this.openCommitModal();
                  })
                  .child(icon("git-commit", 11))
                  .child(hasStaged ? `Commit (${counts.staged})` : "Commit…")
                  .when(counts.unresolvedTotal > 0 && hasDirtyFiles, (el) =>
                    el.child(icon("alert-triangle", 9).text_color(p.yellow)),
                  ),
              )
              .child(
                headerIconBtn("hdr-expand-all", "chevrons-up-down", null, (_e, cx) =>
                  this.toggleExpandAll(topicGroups, visibleFiles, cx),
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
      // 1b. OVERALL SUMMARY CARD AT TOP
      .when(Boolean(overviewCard), (el) => el.child(overviewCard))
      // 2. FILTER & SEARCH BAR
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
              .h(24)
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
                    .size(15)
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
                    .child(icon("x", 9)),
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
              .child(
                filterPill(
                  "OPEN",
                  `Open${counts.draft + counts.open + counts.addressed > 0 ? ` (${counts.draft + counts.open + counts.addressed})` : ""}`,
                ),
              ),
          ),
      )
      // Action Error Banner
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
      // 3. SCROLLABLE INLINE TOPIC ACCORDION / BY-FILE LIST
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .bg(p.base)
          .child(
            v_flex()
              .id("git-review-list")
              .track_scroll(this.listScroll)
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .gap(5)
              .when(this.viewMode === "TOPIC", (el) =>
                el.children(
                  topicGroups.map((group, idx) =>
                    this.renderTopicGroupCard(group, idx, p, mono, nowMs),
                  ),
                ),
              )
              .when(this.viewMode === "FILE", (el) =>
                el.children(visibleFiles.map((f) => this.renderByFileRow(f, p, mono, nowMs))),
              )
              .when(
                (this.viewMode === "TOPIC" && topicGroups.length === 0) ||
                  (this.viewMode === "FILE" && visibleFiles.length === 0),
                (el) =>
                  el.child(
                    v_flex()
                      .w_full()
                      .py(28)
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
                            ? "Loading repository review state…"
                            : !this.root
                              ? "No active Git workspace."
                              : this.files.length > 0
                                ? "No changes match the active filter."
                                : "Working tree clean — ready for next task.",
                      ),
                  ),
              ),
          )
          .child(Scrollbar.vertical("git-review-list").absolute().inset_0()),
      )
      // 4. STICKY REVIEW DISPATCH BAR (when draft/open/addressed threads exist)
      .when(Boolean(dispatchBar), (el) => el.child(dispatchBar))
      // 5. COMPACT STATUS FOOTER
      .child(
        h_flex()
          .h(22)
          .flex_none()
          .px(10)
          .items_center()
          .justify_between()
          .bg(p.crust)
          .border_t(1)
          .border_color(p.border)
          .font_family(mono)
          .text_size(9.5)
          .text_color(p.dim)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .gap(3)
                  .child("Staged:")
                  .child(div().font_bold().text_color(p.green).child(String(counts.staged))),
              )
              .child(div().child("•"))
              .child(
                h_flex()
                  .gap(3)
                  .child("Unstaged:")
                  .child(div().font_bold().text_color(p.yellow).child(String(counts.unstaged))),
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .when(counts.resolved > 0, (el) =>
                el.child(
                  div()
                    .id("toggle-resolved-btn")
                    .text_color(this.showResolvedThreads ? p.teal : p.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(p.text))
                    .on_click((_e, cx) => {
                      this.showResolvedThreads = !this.showResolvedThreads;
                      cx.notify();
                    })
                    .child(this.showResolvedThreads ? "Hide resolved" : `${counts.resolved} resolved`),
                ),
              )
              .child(
                h_flex()
                  .gap(3)
                  .child("Topics:")
                  .child(div().font_bold().text_color(p.mauve).child(String(counts.topics))),
              ),
          ),
      );
  }

  render(cx) {
    if (this.role === "runner") return div();
    if (this.role === "add-topic") return this.renderAddTopicDialog();
    if (this.role === "commit") return this.renderCommitDialog();
    return this.renderPane(cx);
  }
}

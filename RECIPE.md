# Git Review

A movable Herdr workspace pane (`mods/git-status`) for reviewing uncommitted changes with a top **Summary**, logical multi-file **Change Topics**, back-and-forth inline review threads with live coding agents, and an on-demand **Commit Changes** dialog.

## What you see

Top to bottom inside a 1px-bordered Catppuccin Mocha / theme-aware pane:

1. **Header (36px)**: mauve compare-arrows icon, **`Topics | Files`** mode switch, teal git-branch badge, mauve **`+ Topic`** button, **`Commit…`** dialog launcher (showing staged count when staged > 0 and an amber warning icon when unresolved comments exist), expand/collapse-all, stage/unstage-all, and spinning refresh.
2. **Summary Card**: collapsible top card showing sparkles icon, total file/topic/diff stats, agent timestamp, and a concise high-level summary of the entire changeset (synthesizing from active topics if not explicitly set).
3. **Search & Filter Bar (36px)**: monospace search input (`Filter topic, file, comment...`) and 4-way filter pills (`All`, `Staged`, `Unstaged`, `Open`).
4. **Inline Topic Accordion**:
   - **Topic Card**: expand chevron, topic-level stage checkbox (green check / yellow minus / dim square), `Topic N` badge (or `Unattributed` for unclaimed edits), bold headline, active comment badge, file count (`3f`), `+add/-del`, topic comment button, and delete `×`.
   - **Expanded Topic**: indented behind a 1px guide line with optional rationale + agent timestamp, per-file rows (click to expand topic diff hunk or toggle **Show Full File Diff**), and clickable diff lines (`+`) that open an inline **Add Draft** comment box and render `Draft` / `Open` / `Addressed` / `Resolved` conversation threads.
5. **Sticky Review Dispatch Bar** *(when active comments exist)*: thread counts, agent picker (`→ pi (t9t)`), **`Copy`** fallback, and **`Submit Review → pi (N)`**.
6. **Status Footer (22px)**: `Staged: N • Unstaged: M`, resolved-thread toggle, and `Topics: K`.
7. **Commit Changes Dialog (`role: "commit"`)**: opened via **`Commit…`** or `c`, with `Staged only` / `All files` scope toggle, non-blocking unresolved-comment warning badge, pre-filled subject + body inputs, `↺ Reset to Suggested`, and **`Commit Staged (N)`** / **`Stage & Commit (M)`**.

## How it behaves

- `Alt+Shift+G` (`mod.open:git-status`) toggles the split pane in the active tab.
- Every dirty file in `git status` not claimed by a topic appears automatically in **Unattributed / Manual Changes**.
- Clicking any diff line queues a `Draft` comment; clicking **Submit Review** promotes drafts to `Open` and sends a structured prompt via `hc send` to the space's agent terminal (falling back to clipboard if busy/absent).
- Committing runs `git commit` on staged changes (or `git add -A && git commit` when nothing is staged) and prunes clean topics, resolved threads, and overview.

## Built from

- `mods/git-status/mod.json`, `mods/git-status/main.js`, `mods/git-status/model.js`, and vector icons in `mods/git-status/*.svg`.
- `extensions/herdr-git-notes/index.ts`, `src/notes-store.js`, and `bin/herdr-git-note.mjs` persisting `<git-dir>/herdr-review.json`.

## Watch out

- Prepend `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` to read-only `git` calls so `watchFolder` never loops.
- Resolve workspace `cwd` from sibling terminal panes in the active tab when the mod pane itself holds focus.
- Handle unborn `HEAD` repositories with `git rm --cached -r` when unstaging.
- Never allow `buildTopicGroups` to omit unclaimed `git status` files.

## Done when

- `npm run validate` and `herdr-app check ~/.config/herdr-app/mods/git-status` pass with zero errors in `herdr-app status`.
- Overall summary, multi-file topics, unattributed edits, inline line comments, `Submit Review`, and the `Commit…` dialog work end-to-end without dirtying `git status`.

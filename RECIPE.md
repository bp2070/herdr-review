# Git Changes & Agent Notes

A standard, movable Herdr workspace pane (`mods/git-status`) that shows uncommitted Git changes, staged/unstaged/untracked diffs, and discrete per-file coding-agent change notes in the active space.

## What you see

Top to bottom inside a crisp 1px-bordered Catppuccin Mocha / theme-aware pane:

1. **Toolbar (36px)** on subtle raised surface (`surface0` at 40% alpha): mauve compare-arrows glyph, **Git Changes & Notes** title, changed-file count pill, teal git-branch badge, mauve **+ Note** button, expand/collapse-all button, stage/unstage-all button, and spinning refresh button.
2. **Filter & Search Bar (37px)**: compact monospace search input (`Filter file or note...`) on the left and a 4-way segmented pill toggle (`All`, `Staged`, `Unstaged`, `Notes`) on the right.
3. **Scrollable File & Agent Note Tree**:
   - **File Row (28px)**: expand chevron, interactive stage checkbox (green check when staged, yellow minus when partially staged, dim square when unstaged), colored status badge (`M` yellow, `A` green, `D`/`U` red, `R` blue), dim directory prefix + bold filename, `+add/-del` line counts, and a mauve sparkles note-count pill (`✦ N`).
   - **Expanded File Body**: indented behind a 1px vertical tree guide line:
     - Discrete **Agent Note Cards** showing a mauve bullet, 1-line summary, `<>` code indicator, line-range badge (`L24-L31`), agent tag (`pi`), relative timestamp (`2m ago`), and `×` delete control. Clicking a note with a `diffHunk` expands an inset syntax-colored diff block. Files without notes show *Manual edit — no discrete agent notes.* with a `+ Note` button.
     - Collapsible **Full Git Diff** bar that loads and renders staged + unstaged unified diff hunks (or untracked file previews) with line numbers.
4. **Footer Status Bar (24px)** on `canvas` (`#11111b`): `Staged: N • Unstaged: M` on the left and `Notes: K` (plus a one-click `Prune clean` link when committed notes remain) on the right.

## How it behaves

- `Alt+Shift+G` (`mod.open:git-status`) splits `git-status` to the right of the active tab's focused pane, or closes the pane if one is already open in the active tab.
- As a native tab pane, Herdr's top-center drag grip moves or docks it on any split edge, `pane.zoom` zooms it, and `pane.go` focuses it for keyboard navigation (`j`/`k`, `Enter`, `s`, `d`, `n`, `/`, `r`).
- Clicking **+ Note** opens a 470×455 dialog with changed-file quick-pick chips, single-line summary, agent tag, line range, **Prefill Diff** button, and monospace diff textarea.
- Notes are stored in `<git-dir>/herdr-agent-notes.json` via atomic compare-and-swap writes so `git status` stays clean and linked worktrees keep isolated notes.

## Built from

- `mods/git-status/mod.json`: `{"place":"none","title":"Git Changes & Notes","focusable":true,"overlay":{"kind":"popup","frame":"none","width":1,"height":1}}`.
- `mods/git-status/main.js` & `mods/git-status/model.js`: uses `herdr`'s `spaces`, `panes`, `focused`, `agents`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `openOverlay`, `closeOverlay`, `run`, `shared`, `setShared`, `nextCommand`, `checking`, `theme`, and `settings`.
- `bin/herdr-git-note.mjs` & `src/notes-store.js`: Node CLI for agents to append/list/remove/clear notes in `<git-dir>/herdr-agent-notes.json`.

## Watch out

- Always pass `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` to read-only `git` invocations; otherwise `git status` touches `.git/index` and re-triggers `watchFolder` in an infinite loop.
- When a user clicks inside a mod pane, `focused().cwd` and the mod pane's `PaneInfo.cwd` are `null`. Resolve the workspace folder from sibling terminal panes in the active tab/space before falling back to `space.folder`.
- Unstaging files on a repository with no commits yet (`HEAD` unborn) cannot use `git reset HEAD`; fall back to `git rm --cached -r -- <path>`.
- Guard `init()` async side effects with `if (checking()) return;` after initializing `InputState` / `TextareaState` / `ScrollHandle` handles so `herdr-app check` renders cleanly without spawning processes.

## Done when

- `npm run validate` passes all unit, CLI/worktree, and key-contract tests plus `herdr-app check mods/git-status`.
- `herdr-app check ~/.config/herdr-app/mods/git-status` passes and `herdr-app status` reports `"errors": []`.
- Pressing `Alt+Shift+G` splits and closes the `git-status` pane cleanly in the active tab.
- Appending a note via `bin/herdr-git-note.mjs add` or the **+ Note** modal updates `<git-dir>/herdr-agent-notes.json`, leaves `git status` clean, and auto-refreshes the pane.

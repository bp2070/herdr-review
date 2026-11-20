# AGENTS.md

## Project

This repository packages **Herdr Git Review** (`git-status`): a movable native GPUI workspace pane and companion Pi package for pre-commit code review—grouping changes into logical multi-file **Change Slices**, hosting inline back-and-forth **Review Threads** dispatched to live agents via `hc send`, and committing with agent-suggested commit messages.

Installed into Herdr & Pi via:
- Directory junction: `~/.config/herdr-app/mods/git-status -> <repository>/mods/git-status`
- Global toggle shortcut in `~/.config/herdr-app/keys.json`: `"alt-shift-g": "mod.open:git-status"`
- Pi package registration in `~/.pi/agent/settings.json`: `pi install <repository>`

## Repository layout

- `mods/git-status/main.js` — Native GPUI workspace review pane (collapsible top **Overall Summary**, Inline Slice Accordion + By-File view, interactive line/file/slice comment composer, `hc send` + clipboard review dispatch, **Commit Changes** modal dialog, and **Create Logical Change Slice** modal).
- `mods/git-status/model.js` — Pure Git status/numstat/diff parsers, v2 `ReviewDocument` (`ChangeSlice`, `ReviewThread`, `SuggestedCommit`) + v1 migration, `Unattributed` trust-bucket builder, commit derivation, and Catppuccin Mocha palette helpers. Keep free of GPUI, Herdr, and Node imports.
- `mods/git-status/mod.json` — Mod registration (`place: "none"`, `focusable: true`, popup toggle runner).
- `mods/git-status/*.svg` — Self-contained vector icons tinted by GPUI.
- `extensions/herdr-git-notes/index.ts` — Pi extension registering `record_change_slices`, `review_threads`, `/git-review`, and an `agent_before_settle` coverage guard.
- `src/notes-store.js` — Atomic Node/worktree-aware store reading and writing `<git-dir>/herdr-review.json` (with seamless v1 `herdr-agent-notes.json` migration).
- `bin/herdr-git-note.mjs` — CLI for recording slices, replying to review threads, listing, and pruning state.
- `test/model.test.js`, `test/notes-cli.test.js`, `test/keys.test.js` — Node `node:test` suite.
- `RECIPE.md` — Standalone Herdr build recipe.

## Commands

```sh
npm test          # Run unit, CLI/worktree integration, and package-contract tests
npm run check     # Run herdr-app check mods/git-status
npm run validate  # Run npm test && npm run check
```

## Guardrails

- Read `~/.config/herdr-app/AGENTS.md` before editing Herdr integration code.
- Preserve the **Review Trust Invariant** in `buildSliceGroups`: every dirty file in `git status` not claimed by an active `ChangeSlice` must appear in the synthetic `Unattributed / Manual Changes` group so zero modified lines can ever hide.
- Always prepend `GIT_READ_ARGS` (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) on read-only `git` calls so `watchFolder` never loops on `.git/index`.
- Preserve sibling terminal `cwd` resolution in `resolveWorkspaceLocation` when the `git-status` mod pane itself holds focus.
- Run `npm run validate` and `herdr-app check ~/.config/herdr-app/mods/git-status` after every change.

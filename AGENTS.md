# AGENTS.md

## Project

This repository packages **Herdr Review** (`herdr-review` / `mods/review`): a movable native GPUI workspace pane and companion Pi package for pre-commit code review—featuring a collapsible top **Summary**, grouping changes into logical multi-file **Change Topics**, hosting inline back-and-forth **Review Threads** dispatched to live agents via `hc send`, and committing through an on-demand **Commit Changes** dialog.

Installed into Herdr & Pi via:
- Directory junction: `~/.config/herdr-app/mods/review -> <repository>/mods/review`
- Global toggle shortcut in `~/.config/herdr-app/keys.json`: `"alt-shift-g": "mod.open:review"`
- Pi package registration in `~/.pi/agent/settings.json`: `pi install <repository>`

## Repository layout

- `mods/review/main.js` — Native GPUI workspace review pane (collapsible top **Summary**, Inline Topic Accordion + By-File view, interactive line/file/topic comment composer, `hc send` + clipboard review dispatch, **Commit Changes** modal dialog, and **Create Change Topic** modal).
- `mods/review/model.js` — Pure Git status/numstat/diff parsers, `ReviewDocument` (`Overview`, `ChangeTopic`, `ReviewThread`, `SuggestedCommit`), `Unattributed` trust-bucket builder, commit derivation, and Catppuccin Mocha palette helpers. Keep free of GPUI, Herdr, and Node imports.
- `mods/review/mod.json` — Mod registration (`place: "none"`, `focusable: true`, popup toggle runner).
- `mods/review/*.svg` — Self-contained vector icons tinted by GPUI.
- `extensions/herdr-review/index.ts` — Pi extension registering `record_change_topics`, `review_threads`, `/git-review`, and an `agent_before_settle` coverage guard.
- `src/review-store.js` — Atomic Node/worktree-aware store reading and writing `<git-dir>/herdr-review.json`.
- `bin/herdr-review.mjs` — CLI for recording topics, replying to review threads, listing, and pruning state.
- `test/model.test.js`, `test/review-cli.test.js`, `test/keys.test.js` — Node `node:test` suite.
- `RECIPE.md` — Standalone Herdr build recipe.

## Commands

```sh
npm test          # Run unit, CLI/worktree integration, and package-contract tests
npm run check     # Run herdr-app check mods/review
npm run validate  # Run npm test && npm run check
```

## Guardrails

- Read `~/.config/herdr-app/AGENTS.md` before editing Herdr integration code.
- Preserve the **Review Trust Invariant** in `buildTopicGroups`: every dirty file in `git status` not claimed by an active `ChangeTopic` must appear in the synthetic `Unattributed / Manual Changes` group so zero modified lines can ever hide.
- Always prepend `GIT_READ_ARGS` (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) on read-only `git` calls so `watchFolder` never loops on `.git/index`.
- Preserve sibling terminal `cwd` resolution in `resolveWorkspaceLocation` when the `review` mod pane itself holds focus.
- Run `npm run validate` and `herdr-app check ~/.config/herdr-app/mods/review` after every change.

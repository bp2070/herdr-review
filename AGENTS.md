# AGENTS.md

## Project

This repository packages the **Herdr Git Status & Agent Notes** mod (`git-status`): a native GPUI workspace pane for inspecting Git working-tree changes (`git status --porcelain=v1`, staged/unstaged/untracked diffs, and per-file staging) alongside discrete per-file `AgentChangeNote` entries in the active Herdr space.

Installed into Herdr via:
- Directory junction: `~/.config/herdr-app/mods/git-status -> <repository>/mods/git-status`
- Global toggle shortcut in `~/.config/herdr-app/keys.json`: `"alt-shift-g": "mod.open:git-status"`

## Repository layout

- `mods/git-status/main.js` — Herdr/GPUI workspace pane, toggle runner (`mod.open:git-status`), and **Add Discrete Agent Note** modal dialog.
- `mods/git-status/model.js` — Pure Git porcelain/numstat/diff parsers, `AgentChangeNote` store helpers, workspace CWD resolution, filtering, and Catppuccin Mocha palette helpers. Keep free of GPUI, Herdr, and Node imports.
- `mods/git-status/mod.json` — Mod registration (`place: "none"`, `focusable: true`, popup toggle runner spec).
- `mods/git-status/*.svg` — Self-contained vector icons tinted by GPUI.
- `src/notes-store.js` — Atomic Node/worktree-aware file store reading and writing `<git-dir>/herdr-agent-notes.json`.
- `bin/herdr-git-note.mjs` — CLI for coding agents (`pi`, `claude`, `codex`, subagents) to append, list, remove, and prune discrete file change notes.
- `keys.json` — Default shortcut mapping (`alt-shift-g`).
- `test/model.test.js`, `test/notes-cli.test.js`, `test/keys.test.js` — Node `node:test` suite.
- `RECIPE.md` — Standalone Herdr build recipe.

## Commands

```sh
npm test          # Run unit, CLI/worktree integration, and key-contract tests
npm run check     # Run herdr-app check mods/git-status
npm run validate  # Run npm test && npm run check
```

## Guardrails

- Read `~/.config/herdr-app/AGENTS.md` before editing Herdr integration code.
- Keep deterministic parsing and state logic in `mods/git-status/model.js` and add unit tests in `test/model.test.js`.
- Always prepend `GIT_READ_ARGS` (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) on read-only `git` calls so `watchFolder` never loops on `.git/index`.
- Preserve sibling terminal `cwd` resolution in `resolveWorkspaceLocation` when the `git-status` mod pane itself holds focus.
- Run `npm run validate` and `herdr-app check ~/.config/herdr-app/mods/git-status` after every change.

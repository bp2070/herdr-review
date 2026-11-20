# Herdr Git Changes & Agent Notes (`git-status`)

A movable, splittable native GPUI workspace pane for **Herdr** that pairs live Git status and diffs with structured, discrete per-file **Agent Change Notes** (`AgentChangeNote`) in the active space.

## Features

- **Standard Workspace Pane**: Splits beside terminals (`pane.split`), opens as a full tab (`tab.new`), swaps/docks on any edge via Herdr's native top-center drag grip, resizes, zooms (`pane.zoom`), and persists in the tab's layout tree.
- **One-Key Toggle (`Alt+Shift+G`)**: Pressing `Alt+Shift+G` (or running `herdr-app do mod.open --name git-status`) splits `git-status` to the right of the active pane, or closes it if already open in the active tab.
- **Live Git Status & Diffs**:
  - Runs read-only `git status --porcelain=v1 -z` and `git diff` (staged + unstaged + untracked previews) without touching `.git/index` locks.
  - Auto-refreshes via `watchFolder` (both worktree root and `<git-dir>` for linked worktrees) plus manual refresh.
  - Supports per-file stage/unstage checkboxes and header **Stage All / Unstage All** (including unborn `HEAD` repositories).
  - Collapsible **Full Git Diff** inside any expanded file showing syntax-colored hunks and line numbers.
- **Discrete Per-File Agent Notes (`<git-dir>/herdr-agent-notes.json`)**:
  - Stored inside `git rev-parse --git-dir` so notes are isolated per worktree, never dirty `git status`, and trigger live refreshes.
  - Clicking an expanded file's note reveals its optional inline `diffHunk` snippet.
  - Includes both an in-pane **+ Note** modal dialog (with one-click live diff prefill) and a zero-dependency CLI (`bin/herdr-git-note.mjs`) for coding agents.

## Opening & Moving the Pane

```sh
# Toggle split pane in the active tab (default shortcut: Alt+Shift+G)
herdr-app do mod.open --name git-status

# Or split/dock explicitly in any direction ("right" or "down") or as a standalone tab
herdr-app do pane.split --direction right --mod git-status
herdr-app do pane.split --direction down --mod git-status
herdr-app do tab.new --name "Git Changes" --mod git-status
```

Once open in a tab, drag Herdr's top-center pane grip to dock it left, right, top, or bottom, or use `Alt+Shift+H/J/K/L` (`pane.swap`) and `Ctrl+Shift+Z` (`pane.zoom`).

### Pane Keyboard Shortcuts (when focused via click or `Alt+H/J/K/L`)

- `j` / `↓`, `k` / `↑` — Move through changed files
- `Enter` / `l` / `→`, `h` / `←` — Expand or collapse file notes
- `s` / `Space` — Stage or unstage selected file
- `d` — Toggle live **Full Git Diff** on selected file
- `n` — Open **Add Discrete Agent Note** dialog for selected file
- `/` — Focus file/note filter input (`Esc` returns focus to list)
- `r` — Refresh Git status & notes

## Agent Notes Schema & CLI

Each note in `<git-dir>/herdr-agent-notes.json` follows:

```ts
interface AgentChangeNote {
  id: string;
  filePath: string;       // Repo-relative POSIX path, e.g. "src/auth/session.ts"
  summary: string;        // Concise 1-line description of the single logical change
  agentName?: string;     // e.g. "pi", "claude", "refactor-subagent"
  timestamp: string;      // ISO-8601 timestamp
  diffHunk?: string;      // Optional unified diff hunk or +/- snippet tied to this change
  lineRange?: string;     // Optional explicit line range, e.g. "L24-L35"
}
```

### Recording Notes from Coding Agents

```sh
# Append a note and automatically capture the current git diff hunk for that file
node C:/Users/bryan.petzinger/workspace/herdr-git-status/bin/herdr-git-note.mjs add \
  --file src/auth/session.ts \
  --summary "Added sliding session expiry guard before token refresh" \
  --agent pi \
  --auto-hunk

# Append a note with an explicit diff hunk from stdin
git diff -U1 -- src/auth/session.ts | node C:/Users/bryan.petzinger/workspace/herdr-git-status/bin/herdr-git-note.mjs add \
  --file src/auth/session.ts \
  --summary " tightened cookie SameSite attribute" \
  --agent refactor-subagent \
  --hunk -

# List, remove, or prune notes for already-committed files
node C:/Users/bryan.petzinger/workspace/herdr-git-status/bin/herdr-git-note.mjs list
node C:/Users/bryan.petzinger/workspace/herdr-git-status/bin/herdr-git-note.mjs clear --prune-clean
```

## Installation & Validation

```powershell
New-Item -ItemType Junction \
  -Path "$HOME\.config\herdr-app\mods\git-status" \
  -Target "C:\Users\bryan.petzinger\workspace\herdr-git-status\mods\git-status"

npm run validate
herdr-app check ~/.config/herdr-app/mods/git-status
```

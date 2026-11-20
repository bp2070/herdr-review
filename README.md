# Herdr Git Review (`git-status`)

A movable, splittable native GPUI workspace pane and Pi package for **pre-commit code review** in Herdr:
- **Summary + Logical Change Topics**: Displays a collapsible **Summary** card at the top, followed by multi-file **Change Topics** grouped by intent (with an automatic **Unattributed / Manual Changes** bucket guaranteeing 100% of `git status` is always visible).
- **Interactive Review Comments (`hc send` + Clipboard)**: Click any diff line, file, or topic to queue **Draft** review comments, then click **`Submit Review → pi (N)`** to dispatch them straight into the space's live agent terminal (with multi-turn `Draft → Open → Addressed → Resolved` threads).
- **On-Demand Commit Dialog**: Clicking **`Commit…`** (or pressing `c` when the pane is focused) opens a dedicated **Commit Changes** dialog pre-filled with `suggestedCommit` (`subject` + `body`), an interactive `Staged only` vs `All files` scope switch, and a non-blocking warning badge if unresolved comments exist.

## Opening & Moving the Pane

```sh
# Toggle split pane in the active tab (default shortcut: Alt+Shift+G)
herdr-app do mod.open --name git-status

# Or split/dock explicitly in any direction ("right" or "down") or as a standalone tab
herdr-app do pane.split --direction right --mod git-status
herdr-app do pane.split --direction down --mod git-status
herdr-app do tab.new --name "Git Review" --mod git-status
```

Switch between **`Topics`** (grouped by logical intent) and **`Files`** (classic file list) in the top-left toggle. Filter by **`All | Staged | Unstaged | Open`**.

## Pi Package Integration (`pi-package`)

Installing this repository into Pi registers:
- **`record_change_topics`**: Records a high-level `overview`, groups modified repository files into logical `topics` with auto-captured `git diff -U2` hunks, and sets `suggestedCommit: { subject, body? }`.
- **`review_threads`**: Lists open review threads or posts agent replies (`status: "addressed"`).
- **`agent_before_settle` coverage guard**: Ensures modified repository files are grouped into topics with an up-to-date `overview` and `suggestedCommit` before the turn settles.
- **`/git-review [list|prune|clear]`** slash command.

```sh
# Local live development (run /reload in active Pi sessions)
pi install C:/Users/bryan.petzinger/workspace/herdr-git-status

# From GitHub or npm once published
pi install git:github.com/<owner>/herdr-git-status
pi install npm:herdr-git-status
```

## CLI Usage (`bin/herdr-git-note.mjs`)

State is persisted per checkout/worktree in `<git-dir>/herdr-review.json` so `git status` stays clean:

```sh
# Upsert a multi-file logical topic + overview + suggested commit message
node bin/herdr-git-note.mjs topic \
  --title "Thread tenantId through session validation & routes" \
  --overview "Propagates tenantId across auth validation and API route handlers." \
  --files "src/auth/session.ts,src/api/routes.ts" \
  --rationale "Isolate downstream outbox queries per tenant" \
  --commit "feat(auth): thread tenantId through session and routes" \
  --agent pi

# Reply to an open review thread
node bin/herdr-git-note.mjs reply --thread t-1234abcd --body "Made tenantId required and updated callers" --agent pi

# Inspect or prune committed topics & resolved threads
node bin/herdr-git-note.mjs list
node bin/herdr-git-note.mjs clear --prune-clean
```

## Validation

```sh
npm run validate
herdr-app check ~/.config/herdr-app/mods/git-status
```

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendNoteToDocument,
  buildFullFileDiffLines,
  clearNotesInDocument,
  computeFooterCounts,
  extractNoteDiffInfo,
  filterFiles,
  formatRelativeTime,
  groupNotesByFile,
  mergeStatusAndStats,
  normalizeRepoPath,
  parseDiffLines,
  parseNotesDocument,
  parseNumstatZ,
  parsePorcelainStatusZ,
  planPaneToggle,
  removeNoteFromDocument,
  resolveWorkspaceLocation,
  stageAllCommandArgs,
  stageCommandArgs,
  withAlpha,
} from "../mods/git-status/model.js";

test("normalizeRepoPath handles Windows separators, repo roots, and leading ./", () => {
  assert.equal(
    normalizeRepoPath("C:\\Users\\dev\\repo\\src\\auth\\session.ts", "C:/Users/dev/repo"),
    "src/auth/session.ts",
  );
  assert.equal(normalizeRepoPath("./src/outbox/poller.ts"), "src/outbox/poller.ts");
  assert.equal(normalizeRepoPath("README.md"), "README.md");
});

test("resolveWorkspaceLocation preserves sibling terminal cwd when git-status mod pane is focused", () => {
  const lastCwdBySpace = new Map();
  const spaces = [
    {
      id: "sp1",
      active: true,
      folder: "",
      machine: null,
      branch: "main",
      tabs: [{ id: "tb1", active: true }],
    },
  ];
  const panes = [
    { pane: "p-term", tab: "tb1", terminal: "t1", cwd: "C:/repo/service-outbox", branch: "feat/outbox" },
    { pane: "p-mod", tab: "tb1", terminal: null, mod: "git-status", cwd: null, branch: null },
  ];

  // Focus on the mod pane itself (terminal: null, cwd: null)
  const loc = resolveWorkspaceLocation({
    spaces,
    panes,
    focused: { space: "sp1", tab: "tb1", pane: "p-mod", terminal: null, cwd: null },
    lastCwdBySpace,
  });

  assert.equal(loc.cwd, "C:/repo/service-outbox");
  assert.equal(loc.branch, "feat/outbox");
  assert.equal(loc.on, null);
});

test("planPaneToggle splits right when absent and closes pane when present", () => {
  const spaces = [{ id: "sp1", active: true, tabs: [{ id: "tb1", active: true }] }];
  const openAction = planPaneToggle({
    spaces,
    panes: [{ pane: "p1", tab: "tb1", terminal: "t1" }],
    focused: { space: "sp1", tab: "tb1", pane: "p1" },
  });
  assert.deepEqual(openAction, {
    command: "pane.split",
    args: { direction: "right", pane: "p1", mod: "git-status" },
  });

  const closeAction = planPaneToggle({
    spaces,
    panes: [
      { pane: "p1", tab: "tb1", terminal: "t1" },
      { pane: "p2", tab: "tb1", terminal: null, mod: "git-status" },
    ],
    focused: { space: "sp1", tab: "tb1", pane: "p2" },
  });
  assert.deepEqual(closeAction, {
    command: "pane.close",
    args: { pane: "p2" },
  });
});

test("parsePorcelainStatusZ and mergeStatusAndStats handle M, MM, A, ??, D, R, U", () => {
  const raw = [
    " M src/outbox/poller.ts",
    "M  src/db/schema/permissions.ts",
    "MM src/auth/session.ts",
    "?? src/components/EditableCell.tsx",
    " D README.md",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "UU src/conflict.ts",
    "",
  ].join("\0");

  const parsed = parsePorcelainStatusZ(raw);
  assert.equal(parsed.entries.length, 7);

  const stagedStats = parseNumstatZ(
    ["28\t5\tsrc/db/schema/permissions.ts", "4\t1\tsrc/auth/session.ts", ""].join("\0"),
  );
  const unstagedStats = parseNumstatZ(
    ["14\t3\tsrc/outbox/poller.ts", "2\t0\tsrc/auth/session.ts", "0\t12\tREADME.md", ""].join("\0"),
  );

  const files = mergeStatusAndStats(parsed.entries, stagedStats, unstagedStats, {
    "src/components/EditableCell.tsx": 45,
  });

  const poller = files.find((f) => f.path === "src/outbox/poller.ts");
  assert.equal(poller.status, "M");
  assert.equal(poller.staged, false);
  assert.equal(poller.hasUnstaged, true);
  assert.equal(poller.additions, 14);
  assert.equal(poller.deletions, 3);

  const perms = files.find((f) => f.path === "src/db/schema/permissions.ts");
  assert.equal(perms.staged, true);
  assert.equal(perms.hasStaged, true);
  assert.equal(perms.hasUnstaged, false);

  const both = files.find((f) => f.path === "src/auth/session.ts");
  assert.equal(both.partiallyStaged, true);
  assert.equal(both.additions, 6);
  assert.equal(both.deletions, 1);

  const untracked = files.find((f) => f.path === "src/components/EditableCell.tsx");
  assert.equal(untracked.status, "A");
  assert.equal(untracked.additions, 45);

  const renamed = files.find((f) => f.path === "src/new-name.ts");
  assert.equal(renamed.status, "R");
  assert.equal(renamed.origPath, "src/old-name.ts");

  const conflict = files.find((f) => f.path === "src/conflict.ts");
  assert.equal(conflict.status, "U");
  assert.equal(conflict.conflict, true);
});

test("stageCommandArgs and stageAllCommandArgs support both normal and unborn HEAD", () => {
  assert.deepEqual(stageCommandArgs({ path: "a.ts", staged: false }, true), ["add", "-A", "--", "a.ts"]);
  assert.deepEqual(stageCommandArgs({ path: "a.ts", staged: true }, true), ["reset", "HEAD", "--", "a.ts"]);
  assert.deepEqual(stageCommandArgs({ path: "a.ts", staged: true }, false), ["rm", "--cached", "-r", "--", "a.ts"]);

  assert.deepEqual(stageAllCommandArgs([{ staged: true }, { staged: false }], true), ["add", "-A"]);
  assert.deepEqual(stageAllCommandArgs([{ staged: true }], false), ["rm", "--cached", "-r", "."]);
});

test("AgentChangeNote document CRUD, diff extraction, filtering, and footer counts", () => {
  const step1 = appendNoteToDocument(
    "",
    {
      filePath: "src\\outbox\\poller.ts",
      summary: "Added transactional outbox retry jitter calculation in pollBatch",
      agentName: "pi",
      diffHunk: "@@ -24,1 +24,2 @@\n-const backoff = 200;\n+const backoff = calcJitter();\n+await sleep(backoff);",
    },
    { nowIso: "2026-11-20T15:00:00.000Z", createId: () => "n-101" },
  );

  const step2 = appendNoteToDocument(
    step1.text,
    {
      filePath: "README.md",
      summary: "Removed deprecated setup instructions",
      agentName: "refactor-subagent",
      diffHunk: "L1-L12",
    },
    { nowIso: "2026-11-20T15:02:00.000Z", createId: () => "n-102" },
  );

  const notes = parseNotesDocument(step2.text);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].id, "n-102");
  assert.equal(notes[1].filePath, "src/outbox/poller.ts");

  const hunkInfo = extractNoteDiffInfo(notes[1]);
  assert.equal(hunkInfo.hasDiff, true);
  assert.equal(hunkInfo.lineRange, "L24-L25");

  const rangeOnlyInfo = extractNoteDiffInfo(notes[0]);
  assert.equal(rangeOnlyInfo.hasDiff, false);
  assert.equal(rangeOnlyInfo.lineRange, "L1-L12");

  const byFile = groupNotesByFile(notes);
  const files = [
    { path: "src/outbox/poller.ts", hasStaged: false, hasUnstaged: true },
    { path: "README.md", hasStaged: true, hasUnstaged: false },
  ];

  assert.equal(filterFiles(files, byFile, { filter: "STAGED" }).length, 1);
  assert.equal(filterFiles(files, byFile, { filter: "UNSTAGED" }).length, 1);
  assert.equal(filterFiles(files, byFile, { filter: "NOTES" }).length, 2);
  assert.equal(
    filterFiles(
      [...files, { path: "src/manual.ts", hasStaged: false, hasUnstaged: true }],
      byFile,
      { filter: "NOTES" },
    ).length,
    2,
  );
  assert.equal(filterFiles(files, byFile, { filter: "ALL", query: "jitter" }).length, 1);
  assert.equal(filterFiles(files, byFile, { filter: "ALL", query: "refactor-subagent" }).length, 1);

  assert.deepEqual(computeFooterCounts(files, byFile), { staged: 1, unstaged: 1, notes: 2 });

  const removed = removeNoteFromDocument(step2.text, "n-101");
  assert.equal(removed.removed, 1);
  assert.equal(removed.notes.length, 1);

  const cleared = clearNotesInDocument(step2.text, { keepPaths: new Set(["src/outbox/poller.ts"]) });
  assert.equal(cleared.notes.length, 1);
  assert.equal(cleared.notes[0].id, "n-101");
});

test("buildFullFileDiffLines and parseDiffLines handle staged + unstaged sections and line numbers", () => {
  const lines = buildFullFileDiffLines({
    stagedOut: "diff --git a/a.js b/a.js\n@@ -1,2 +1,2 @@\n-old\n+staged\n ctx\n",
    unstagedOut: "diff --git a/a.js b/a.js\n@@ -10,1 +10,2 @@\n ctx2\n+unstaged\n",
  });
  const rows = parseDiffLines(lines);
  assert.equal(rows[0].kind, "section");
  assert.equal(rows[1].kind, "@");
  assert.equal(rows[2].kind, "-");
  assert.equal(rows[2].lineNumber, 1);
  assert.equal(rows[3].kind, "+");
  assert.equal(rows[3].lineNumber, 1);
});

test("formatRelativeTime and withAlpha produce clean output", () => {
  const base = Date.parse("2026-11-20T12:10:00.000Z");
  assert.equal(formatRelativeTime("2026-11-20T12:09:40.000Z", base), "Just now");
  assert.equal(formatRelativeTime("2026-11-20T12:05:00.000Z", base), "5m ago");
  assert.equal(withAlpha("#cba6f7", "24"), "#cba6f724");
  assert.equal(withAlpha("#cba6f7ff", "1a"), "#cba6f71a");
});

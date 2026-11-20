import assert from "node:assert/strict";
import test from "node:test";
import {
  UNATTRIBUTED_SLICE_ID,
  addCommentToDocument,
  buildFullFileDiffLines,
  buildGitCommitCommands,
  buildSliceGroups,
  countActiveReviewThreads,
  deriveCommitSuggestion,
  deriveOverviewInfo,
  extractNoteDiffInfo,
  filterFilesForReview,
  formatRelativeTime,
  formatReviewDispatchPrompt,
  mergeStatusAndStats,
  normalizeRepoPath,
  parseDiffLines,
  parseNumstatZ,
  parsePorcelainStatusZ,
  parseReviewDocument,
  planPaneToggle,
  promoteDraftThreadsToOpen,
  pruneCleanStateInDocument,
  resolveWorkspaceLocation,
  setThreadStatusInDocument,
  stageAllCommandArgs,
  stageCommandArgs,
  stagePathsCommandArgs,
  upsertSlicesInDocument,
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

test("parsePorcelainStatusZ, mergeStatusAndStats, and slice staging commands handle all statuses", () => {
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

  assert.deepEqual(stageCommandArgs({ path: "a.ts", staged: false }, true), ["add", "-A", "--", "a.ts"]);
  assert.deepEqual(stageCommandArgs({ path: "a.ts", staged: true }, false), ["rm", "--cached", "-r", "--", "a.ts"]);
  assert.deepEqual(
    stagePathsCommandArgs([{ path: "a.ts" }, { path: "b.ts", origPath: "old-b.ts" }], true, true),
    ["add", "-A", "--", "a.ts", "old-b.ts", "b.ts"],
  );
  assert.deepEqual(stageAllCommandArgs(files, true), ["add", "-A"]);
});

test("v1 notes migrate seamlessly into v2 ChangeSlices", () => {
  const legacyJson = JSON.stringify({
    version: 1,
    notes: [
      {
        id: "n-1",
        filePath: "src/auth/session.ts",
        summary: "Added sliding session expiry guard",
        agentName: "pi",
        timestamp: "2026-11-20T15:00:00.000Z",
        lineRange: "L18-L24",
      },
    ],
  });
  const doc = parseReviewDocument("", legacyJson);
  assert.equal(doc.version, 2);
  assert.equal(doc.slices.length, 1);
  assert.equal(doc.slices[0].title, "Added sliding session expiry guard");
  assert.equal(doc.slices[0].files[0].filePath, "src/auth/session.ts");
  assert.equal(doc.slices[0].files[0].lineRange, "L18-L24");
});

test("buildSliceGroups groups multi-file slices and guarantees Unattributed bucket for manual edits", () => {
  const upserted = upsertSlicesInDocument("", {
    overview: "Threads tenantId across auth session validation and API route handlers.",
    slices: [
      {
        id: "s-auth",
        title: "Thread tenantId into session validation and routes",
        rationale: "Required so downstream outbox queries isolate per tenant.",
        agentName: "pi",
        order: 1,
        files: [
          { filePath: "src/auth/session.ts", lineRange: "L18-L32" },
          { filePath: "src/api/routes.ts", lineRange: "L44-L49" },
        ],
      },
    ],
    suggestedCommit: {
      subject: "feat(auth): thread tenantId through session and routes",
      body: "- Propagate tenantId parameter\n- Enforce non-empty tenantId",
    },
    nowIso: "2026-11-20T16:00:00.000Z",
  });

  const gitFiles = [
    {
      path: "src/auth/session.ts",
      dir: "src/auth/",
      name: "session.ts",
      status: "M",
      staged: true,
      hasStaged: true,
      hasUnstaged: false,
      additions: 14,
      deletions: 2,
    },
    {
      path: "src/api/routes.ts",
      dir: "src/api/",
      name: "routes.ts",
      status: "M",
      staged: false,
      hasStaged: false,
      hasUnstaged: true,
      additions: 10,
      deletions: 2,
    },
    {
      path: "README.md",
      dir: "",
      name: "README.md",
      status: "M",
      staged: false,
      hasStaged: false,
      hasUnstaged: true,
      additions: 3,
      deletions: 0,
    },
  ];

  const groups = buildSliceGroups(gitFiles, upserted.doc.slices, upserted.doc.threads);
  assert.equal(groups.length, 2);

  const authGroup = groups[0];
  assert.equal(authGroup.id, "s-auth");
  assert.equal(authGroup.items.length, 2);
  assert.equal(authGroup.additions, 24);
  assert.equal(authGroup.deletions, 4);
  assert.equal(authGroup.partiallyStaged, true);

  const unattrib = groups[1];
  assert.equal(unattrib.id, UNATTRIBUTED_SLICE_ID);
  assert.equal(unattrib.isUnattributed, true);
  assert.equal(unattrib.items.length, 1);
  assert.equal(unattrib.items[0].filePath, "README.md");

  assert.equal(filterFilesForReview(gitFiles, upserted.doc.slices, [], { query: "tenantId" }).length, 2);

  const overviewInfo = deriveOverviewInfo({
    files: gitFiles,
    slices: upserted.doc.slices,
    overview: upserted.doc.overview,
  });
  assert.equal(overviewInfo.synthesized, false);
  assert.match(overviewInfo.text, /Threads tenantId across auth/);
  assert.equal(overviewInfo.additions, 27);

  const synthOverview = deriveOverviewInfo({
    files: gitFiles,
    slices: upserted.doc.slices,
    overview: null,
  });
  assert.equal(synthOverview.synthesized, true);
  assert.match(synthOverview.text, /Thread tenantId into session/);
});

test("ReviewThread back-and-forth lifecycle, dispatch prompt, and post-commit pruning", () => {
  // 1. Reviewer adds a draft comment on line 24
  const step1 = addCommentToDocument(
    "",
    {
      sliceId: "s-auth",
      filePath: "src/auth/session.ts",
      lineNumber: 24,
      lineRange: "L24",
      codeExcerpt: "+ export function validate(token: string, tenantId?: string)",
      author: "you",
      role: "user",
      body: "Make tenantId required instead of optional here.",
    },
    { nowIso: "2026-11-20T16:10:00.000Z", createId: () => "t-100" },
  );
  assert.equal(step1.thread.status, "draft");

  // 2. Submit Review promotes draft -> open and builds dispatch prompt
  const step2 = promoteDraftThreadsToOpen(step1.text, "2026-11-20T16:11:00.000Z");
  assert.equal(step2.promotedCount, 1);
  assert.equal(step2.openThreads[0].status, "open");

  const prompt = formatReviewDispatchPrompt(step2.doc.threads, [
    { id: "s-auth", title: "Thread tenantId into session" },
  ]);
  assert.match(prompt, /Thread `t-100`/);
  assert.match(prompt, /src\/auth\/session\.ts/);
  assert.match(prompt, /Make tenantId required/);

  // 3. Agent replies and marks thread addressed
  const step3 = addCommentToDocument(
    step2.text,
    {
      threadId: "t-100",
      author: "pi",
      role: "agent",
      body: "Updated tenantId to required string and fixed callers.",
      status: "addressed",
    },
    { nowIso: "2026-11-20T16:12:00.000Z" },
  );
  assert.equal(step3.thread.status, "addressed");
  assert.equal(step3.thread.messages.length, 2);
  assert.equal(countActiveReviewThreads(step3.doc.threads).unresolvedTotal, 0);
  assert.equal(countActiveReviewThreads(step3.doc.threads).addressed, 1);

  // 4. Reviewer resolves thread, then commits -> prune removes resolved thread
  const step4 = setThreadStatusInDocument(step3.text, "t-100", "resolved", "2026-11-20T16:13:00.000Z");
  const pruned = pruneCleanStateInDocument(step4.text, new Set());
  assert.equal(pruned.doc.threads.length, 0);
});

test("deriveCommitSuggestion scopes to staged slice when partial staging is active and builds git commit args", () => {
  const slices = [
    { id: "s1", title: "feat(auth): thread tenantId", rationale: "Isolate tenants.", files: [{ filePath: "a.ts" }] },
    { id: "s2", title: "fix(outbox): add retry jitter", rationale: "Avoid herd.", files: [{ filePath: "b.ts" }] },
  ];
  const suggestedCommit = { subject: "feat: tenant isolation and outbox retry jitter", body: "- auth\n- outbox" };

  // When nothing is staged, uses overall suggestedCommit
  const full = deriveCommitSuggestion({
    files: [
      { path: "a.ts", hasStaged: false },
      { path: "b.ts", hasStaged: false },
    ],
    slices,
    suggestedCommit,
  });
  assert.equal(full.subject, "feat: tenant isolation and outbox retry jitter");

  // When only a.ts (Slice 1) is staged, scopes suggestion to Slice 1!
  const scoped = deriveCommitSuggestion({
    files: [
      { path: "a.ts", hasStaged: true },
      { path: "b.ts", hasStaged: false },
    ],
    slices,
    suggestedCommit,
  });
  assert.equal(scoped.subject, "feat(auth): thread tenantId");

  assert.deepEqual(buildGitCommitCommands({ subject: "feat: test", body: "- one", hasStagedFiles: true }), [
    ["commit", "-m", "feat: test", "-m", "- one"],
  ]);
  assert.deepEqual(buildGitCommitCommands({ subject: "feat: all", hasStagedFiles: false }), [
    ["add", "-A"],
    ["commit", "-m", "feat: all"],
  ]);
});

test("extractNoteDiffInfo, buildFullFileDiffLines, parseDiffLines, formatRelativeTime, withAlpha", () => {
  const info = extractNoteDiffInfo({ diffHunk: "@@ -24,1 +24,2 @@\n-old\n+new1\n+new2" });
  assert.equal(info.lineRange, "L24-L25");
  assert.equal(info.hasDiff, true);

  const lines = buildFullFileDiffLines({
    stagedOut: "diff --git a/a.js b/a.js\n@@ -1,2 +1,2 @@\n-old\n+staged\n ctx\n",
    unstagedOut: "diff --git a/a.js b/a.js\n@@ -10,1 +10,2 @@\n ctx2\n+unstaged\n",
  });
  const rows = parseDiffLines(lines);
  assert.equal(rows[0].kind, "section");
  assert.equal(rows[2].lineNumber, 1);

  const base = Date.parse("2026-11-20T12:10:00.000Z");
  assert.equal(formatRelativeTime("2026-11-20T12:09:40.000Z", base), "Just now");
  assert.equal(withAlpha("#cba6f7ff", "1a"), "#cba6f71a");
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("mod.json, keys.json, and package.json follow Herdr and Pi package contracts", async () => {
  const modJson = JSON.parse(await fs.readFile(path.join(repoDir, "mods", "git-status", "mod.json"), "utf8"));
  assert.equal(modJson.place, "none");
  assert.equal(modJson.focusable, true);
  assert.equal(modJson.title, "Git Changes & Notes");
  assert.equal(modJson.overlay?.kind, "popup");

  const keysJson = JSON.parse(await fs.readFile(path.join(repoDir, "keys.json"), "utf8"));
  assert.equal(keysJson.global?.["alt-shift-g"], "mod.open:git-status");

  const pkgJson = JSON.parse(await fs.readFile(path.join(repoDir, "package.json"), "utf8"));
  assert.ok(pkgJson.keywords?.includes("pi-package"));
  assert.deepEqual(pkgJson.pi?.extensions, ["./extensions/herdr-git-notes/index.ts"]);
  assert.equal(pkgJson.dependencies, undefined);

  const extSource = await fs.readFile(
    path.join(repoDir, "extensions", "herdr-git-notes", "index.ts"),
    "utf8",
  );
  assert.ok(extSource.includes('name: "record_change_note"'));
  assert.ok(extSource.includes('registerCommand("git-notes"'));
});

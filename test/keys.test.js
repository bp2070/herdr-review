import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("mod.json and keys.json follow Herdr workspace pane and toggle shortcut contracts", async () => {
  const modJson = JSON.parse(await fs.readFile(path.join(repoDir, "mods", "git-status", "mod.json"), "utf8"));
  assert.equal(modJson.place, "none");
  assert.equal(modJson.focusable, true);
  assert.equal(modJson.title, "Git Changes & Notes");
  assert.equal(modJson.overlay?.kind, "popup");

  const keysJson = JSON.parse(await fs.readFile(path.join(repoDir, "keys.json"), "utf8"));
  assert.equal(keysJson.global?.["alt-shift-g"], "mod.open:git-status");
});

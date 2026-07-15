import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const INSTALL = resolve(PLUGIN_ROOT, "scripts/install.sh");

test("the installer deploys every v3 runtime module", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-v3-install-"));
  const result = spawnSync("bash", [INSTALL], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  const bin = join(home, ".claude", "bin");
  for (const path of [
    "codex-review.mjs",
    "supervisor.mjs",
    "job-worker.mjs",
    "lib/app-server-client.mjs",
    "lib/job-scheduler.mjs",
    "lib/job-state.mjs",
    "lib/job-store.mjs",
    "lib/runtime-ipc.mjs",
    "lib/project-scope.mjs",
  ]) {
    assert.equal(existsSync(join(bin, path)), true, `missing installed file: ${path}`);
  }
});

test("the SessionEnd hook describes durable-job preservation", () => {
  const hooks = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"));
  const description = hooks.hooks.SessionEnd[0].hooks[0].description;

  assert.match(description, /durable/i);
  assert.doesNotMatch(description, /cancel session-owned workers/i);
});

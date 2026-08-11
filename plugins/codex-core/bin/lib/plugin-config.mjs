import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

// Persistent plugin config, shared with codex-code-review's `defaultTone`.
// One flat JSON object at ~/.claude/codex-review.config.json; every writer
// preserves keys it does not own (see /codex-code-review:tone and
// /codex-core:transport, which both edit this same file).

export const VALID_TRANSPORTS = ["ask", "orca", "app-server"];
export const DEFAULT_TRANSPORT = "ask";

export function configPath() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return resolve(home, ".claude", "codex-review.config.json");
}

export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or malformed config is not an error — callers fall back to defaults.
    return {};
  }
}

// Merge `patch` into the existing config, preserving unrelated keys (e.g. defaultTone).
export function writeConfig(patch) {
  const path = configPath();
  const current = readConfig();
  const next = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function isValidTransport(value) {
  return VALID_TRANSPORTS.includes(value);
}

// Resolution order (highest wins):
//   --transport flag  >  env CODEX_REVIEW_TRANSPORT  >  config.transport  >  "ask"
// An unrecognized value at any layer is ignored in favor of the next source,
// so a typo can never silently disable the App Server fallback.
export function resolveTransportPreference({ flag = null } = {}) {
  const candidates = [flag, process.env.CODEX_REVIEW_TRANSPORT, readConfig().transport];
  for (const candidate of candidates) {
    if (candidate && isValidTransport(candidate)) return candidate;
  }
  return DEFAULT_TRANSPORT;
}

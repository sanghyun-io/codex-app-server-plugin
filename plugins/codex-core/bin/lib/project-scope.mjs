import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

function canonical(path) {
  const absolute = resolve(path);
  let value;
  try {
    value = realpathSync.native(absolute);
  } catch {
    value = absolute;
  }
  if (value.length > 1 && value.endsWith(sep)) {
    value = value.slice(0, -1);
  }
  return value;
}

export function resolveProjectRoot(cwd) {
  const start = canonical(cwd);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return canonical(root);
  } catch {
    return start;
  }
}

export function sameProject(a, b) {
  const left = canonical(a);
  const right = canonical(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

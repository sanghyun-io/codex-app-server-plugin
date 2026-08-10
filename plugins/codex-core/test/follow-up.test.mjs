import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { planFollowUp } from "../bin/lib/follow-up.mjs";

const ROOT = process.cwd();

function job(overrides) {
  return { sessionId: "s", projectRoot: ROOT, ...overrides };
}

test("resumes the persisted thread even when the newest turn was cancelled", () => {
  // newest-first: a cancelled follow-up on top, the completed round-1 below.
  const sessionJobs = [
    job({ status: "cancelled", threadId: "thr-1", model: "gpt-5.6-sol", effort: "max" }),
    job({ status: "completed", threadId: "thr-1", model: "gpt-5.6-sol", effort: "max" }),
  ];
  const plan = planFollowUp(sessionJobs, { sessionId: "s", projectRoot: ROOT });
  assert.equal(plan.error, undefined);
  assert.equal(plan.threadId, "thr-1");
  assert.equal(plan.model, "gpt-5.6-sol");
  assert.equal(plan.effort, "max");
});

test("resumes after the newest turn failed", () => {
  const sessionJobs = [
    job({ status: "failed", threadId: "thr-2", model: "m", effort: "high" }),
    job({ status: "completed", threadId: "thr-2", model: "m", effort: "high" }),
  ];
  const plan = planFollowUp(sessionJobs, { sessionId: "s", projectRoot: ROOT });
  assert.equal(plan.threadId, "thr-2");
});

test("refuses follow-up when no turn has completed yet", () => {
  const sessionJobs = [job({ status: "cancelled", threadId: "thr-3" })];
  const plan = planFollowUp(sessionJobs, { sessionId: "s", projectRoot: ROOT });
  assert.equal(plan.error?.code, "THREAD_NOT_READY");
});

test("refuses follow-up for an empty session", () => {
  const plan = planFollowUp([], { sessionId: "s", projectRoot: ROOT });
  assert.equal(plan.error?.code, "THREAD_NOT_READY");
});

test("rejects a follow-up from a different project", () => {
  const sessionJobs = [job({ status: "completed", threadId: "thr-4" })];
  const plan = planFollowUp(sessionJobs, {
    sessionId: "s",
    projectRoot: resolve(ROOT, "..", "some-other-project-that-does-not-exist"),
  });
  assert.equal(plan.error?.code, "PROJECT_MISMATCH");
});

test("an explicit model/effort override is preserved over the inherited values", () => {
  const sessionJobs = [job({ status: "completed", threadId: "thr-5", model: "old", effort: "high" })];
  const plan = planFollowUp(sessionJobs, {
    sessionId: "s",
    projectRoot: ROOT,
    modelExplicit: true,
    model: "new",
    effortExplicit: true,
    effort: "ultra",
  });
  assert.equal(plan.model, "new");
  assert.equal(plan.effort, "ultra");
});

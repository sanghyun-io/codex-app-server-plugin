import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canTransition,
  reduceJob,
} from "../bin/lib/job-state.mjs";
import {
  appendEvent,
  appendOutput,
  createAttempt,
  createJob,
  publishResult,
  readEvents,
  recoverJobs,
} from "../bin/lib/job-store.mjs";

function tempRuntime() {
  return mkdtempSync(join(tmpdir(), "codex-v3-job-store-"));
}

function request(overrides = {}) {
  return {
    command: "start",
    prompt: "Review this change.",
    model: "gpt-5.6-terra",
    projectRoot: "C:\\repo",
    ownerSessionId: "claude-a",
    ...overrides,
  };
}

test("terminal job states cannot transition", () => {
  assert.equal(canTransition("completed", "recovering"), false);
  assert.equal(canTransition("cancelled", "running"), false);
  assert.equal(canTransition("failed", "starting"), false);
});

test("the reducer ignores events from stale attempt generations", () => {
  const state = reduceJob(
    { schemaVersion: 3, jobId: "job-1", ...request() },
    [{ type: "queued", seq: 1 }],
    [
      { type: "starting", generation: 1, seq: 1 },
      { type: "recovering", generation: 1, seq: 2 },
      { type: "starting", generation: 2, seq: 1 },
      { type: "running", generation: 2, seq: 2, threadId: "thread-2" },
      { type: "completed", generation: 1, seq: 3 },
    ],
    false,
  );

  assert.equal(state.status, "running");
  assert.equal(state.generation, 2);
  assert.equal(state.threadId, "thread-2");
});

test("a durable dispatch reserves the job before the worker writes its first event", () => {
  const state = reduceJob(
    { schemaVersion: 3, jobId: "job-dispatched", ...request() },
    [
      { type: "queued", seq: 1 },
      { type: "dispatched", generation: 1, pid: 4242, nonce: "worker-1", seq: 2 },
    ],
    [],
    false,
  );

  assert.equal(state.status, "starting");
  assert.equal(state.generation, 1);
  assert.equal(state.pid, 4242);
  assert.equal(state.nonce, "worker-1");
});

test("a newer durable dispatch wins over stale attempt completion", () => {
  const state = reduceJob(
    { schemaVersion: 3, jobId: "job-redispatched", ...request() },
    [
      { type: "queued", seq: 1 },
      { type: "dispatched", generation: 1, pid: 1111, nonce: "worker-1", seq: 2 },
      { type: "dispatched", generation: 2, pid: 2222, nonce: "worker-2", seq: 3 },
    ],
    [
      { type: "starting", generation: 1, seq: 1 },
      { type: "running", generation: 1, seq: 2 },
      { type: "completed", generation: 1, seq: 3 },
    ],
    false,
  );

  assert.equal(state.status, "starting");
  assert.equal(state.generation, 2);
  assert.equal(state.pid, 2222);
  assert.equal(state.nonce, "worker-2");
});

test("an immutable result is completion evidence when the terminal event is lost", () => {
  const state = reduceJob(
    { schemaVersion: 3, jobId: "job-2", ...request() },
    [{ type: "queued", seq: 1 }],
    [{ type: "running", generation: 1, seq: 1 }],
    true,
  );

  assert.equal(state.status, "completed");
});

test("readEvents ignores only an incomplete final JSONL record", () => {
  const dir = tempRuntime();
  const path = join(dir, "events.jsonl");
  writeFileSync(path, '{"type":"queued","seq":1}\n{"type":"running"', "utf8");

  assert.deepEqual(readEvents(path), [{ type: "queued", seq: 1 }]);
});

test("createJob persists an immutable v3 request before returning", () => {
  const runtime = tempRuntime();
  const job = createJob(runtime, request(), { jobId: "job-fixed" });
  const stored = JSON.parse(readFileSync(job.requestPath, "utf8"));

  assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.jobId, "job-fixed");
  assert.equal(stored.prompt, "Review this change.");
  assert.deepEqual(readEvents(job.supervisorEventsPath).map(event => event.type), ["queued"]);
});

test("attempt output is append-only and publishes an immutable result", () => {
  const runtime = tempRuntime();
  const job = createJob(runtime, request(), { jobId: "job-output" });
  const attempt = createAttempt(job.jobDir, 1);
  appendOutput(attempt.outputPath, "hello ");
  appendOutput(attempt.outputPath, "world");

  const resultPath = publishResult(job.jobDir, attempt.outputPath);

  assert.equal(readFileSync(resultPath, "utf8"), "hello world");
  assert.equal(existsSync(attempt.outputPath), false);
});

test("recoverJobs rebuilds queued and completed jobs", () => {
  const runtime = tempRuntime();
  const queued = createJob(runtime, request(), { jobId: "job-queued" });
  const completed = createJob(runtime, request(), { jobId: "job-completed" });
  const attempt = createAttempt(completed.jobDir, 1);
  appendEvent(attempt.eventsPath, { type: "running", generation: 1 });
  appendOutput(attempt.outputPath, "done");
  publishResult(completed.jobDir, attempt.outputPath);

  const states = recoverJobs(runtime);

  assert.deepEqual(states.map(state => [state.jobId, state.status]), [
    ["job-completed", "completed"],
    ["job-queued", "queued"],
  ]);
  assert.equal(queued.jobId, "job-queued");
});

test("recoverJobs quarantines one corrupt job without hiding healthy jobs", () => {
  const runtime = tempRuntime();
  createJob(runtime, request(), { jobId: "job-healthy" });
  const corruptDir = join(runtime, "jobs", "job-corrupt");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "request.json"), '{"schemaVersion":3', "utf8");

  const states = recoverJobs(runtime);
  const healthy = states.find(state => state.jobId === "job-healthy");
  const corrupt = states.find(state => state.jobId === "job-corrupt");

  assert.equal(healthy.status, "queued");
  assert.equal(corrupt.status, "failed");
  assert.equal(corrupt.corrupt, true);
  assert.match(corrupt.error, /request\.json|JSON|Unexpected/i);
});

test("a durable cancel marker prevents a queued job from being redispatched", () => {
  const runtime = tempRuntime();
  const job = createJob(runtime, request(), { jobId: "job-cancel-window" });
  writeFileSync(join(job.jobDir, "cancel.requested"), "cancel\n", "utf8");

  const recovered = recoverJobs(runtime).find(state => state.jobId === job.jobId);

  assert.equal(recovered.status, "cancelled");
  assert.equal(recovered.cancelRequested, true);
});

test("best-effort events isolate ancillary write failures", async () => {
  const { appendEventBestEffort } = await import("../bin/lib/job-store.mjs");
  const errors = [];
  const written = appendEventBestEffort("ignored", { type: "checkpoint" }, {
    append: () => { throw Object.assign(new Error("temporarily locked"), { code: "EPERM" }); },
    onError: error => errors.push(error),
  });

  assert.equal(written, false);
  assert.equal(errors[0].code, "EPERM");
});

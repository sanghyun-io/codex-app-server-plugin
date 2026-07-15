import assert from "node:assert/strict";
import { test } from "node:test";

import { JobScheduler } from "../bin/lib/job-scheduler.mjs";

function job(jobId, threadId = null, ownerSessionId = "claude-a") {
  return { jobId, threadId, ownerSessionId, status: "queued" };
}

test("the scheduler runs three jobs and keeps overflow in FIFO order", () => {
  const started = [];
  const scheduler = new JobScheduler({ concurrency: 3, spawnJob: value => started.push(value.jobId) });

  scheduler.enqueue(job("job-1"));
  scheduler.enqueue(job("job-2"));
  scheduler.enqueue(job("job-3"));
  scheduler.enqueue(job("job-4"));

  assert.deepEqual(started, ["job-1", "job-2", "job-3"]);
  assert.deepEqual(scheduler.snapshot().queued.map(value => value.jobId), ["job-4"]);

  scheduler.complete("job-1", "completed");
  assert.deepEqual(started, ["job-1", "job-2", "job-3", "job-4"]);
});

test("jobs from different Claude sessions share the global capacity", () => {
  const started = [];
  const scheduler = new JobScheduler({ concurrency: 2, spawnJob: value => started.push(value.jobId) });

  scheduler.enqueue(job("job-a", null, "claude-a"));
  scheduler.enqueue(job("job-b", null, "claude-b"));

  assert.deepEqual(started, ["job-a", "job-b"]);
});

test("only one job for a Codex thread runs at a time", () => {
  const started = [];
  const scheduler = new JobScheduler({ concurrency: 3, spawnJob: value => started.push(value.jobId) });

  scheduler.enqueue(job("first", "thread-1"));
  scheduler.enqueue(job("follow-up", "thread-1"));
  scheduler.enqueue(job("unrelated", "thread-2"));

  assert.deepEqual(started, ["first", "unrelated"]);
  scheduler.complete("first", "completed");
  assert.deepEqual(started, ["first", "unrelated", "follow-up"]);
});

test("cancelling a queued job prevents it from being dispatched", () => {
  const started = [];
  const scheduler = new JobScheduler({ concurrency: 1, spawnJob: value => started.push(value.jobId) });
  scheduler.enqueue(job("running"));
  scheduler.enqueue(job("cancelled"));

  assert.equal(scheduler.cancel("cancelled"), "queued");
  scheduler.complete("running", "completed");

  assert.deepEqual(started, ["running"]);
  assert.deepEqual(
    scheduler.snapshot().terminal.find(value => value.jobId === "cancelled"),
    { ...job("cancelled"), status: "cancelled" },
  );
});

test("recovered running jobs reserve capacity and thread ownership", () => {
  const started = [];
  const scheduler = new JobScheduler({ concurrency: 2, spawnJob: value => started.push(value.jobId) });
  scheduler.restore([
    { ...job("recovered", "thread-1"), status: "running" },
    job("same-thread", "thread-1"),
    job("other-thread", "thread-2"),
    job("overflow", "thread-3"),
  ]);

  assert.deepEqual(started, ["other-thread"]);
  assert.deepEqual(scheduler.snapshot().queued.map(value => value.jobId), ["same-thread", "overflow"]);

  scheduler.complete("recovered", "completed");
  assert.deepEqual(started, ["other-thread", "same-thread"]);
});

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

import { reduceJob } from "./job-state.mjs";

const RETRYABLE_PUBLISH_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const PUBLISH_RETRY_DELAYS_MS = [10, 25, 50, 100];

function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function flushFile(path) {
  // Windows may reject fsync on a read-only handle with EPERM.
  const fd = openSync(path, "a");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeImmutableJson(path, value) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readEvents(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      const isFinalRecord = index === lines.length - 1;
      if (isFinalRecord) break;
      throw new Error(`Corrupt journal record ${index + 1} in ${path}: ${error.message}`);
    }
  }
  return events;
}

export function appendEvent(path, event) {
  mkdirSync(join(path, ".."), { recursive: true });
  const previous = readEvents(path);
  const record = {
    ...event,
    seq: event.seq ?? ((previous.at(-1)?.seq || 0) + 1),
    at: event.at || new Date().toISOString(),
  };
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

export function createJob(runtimeDir, request, options = {}) {
  const jobId = options.jobId || `job_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const jobDir = join(runtimeDir, "jobs", jobId);
  const requestPath = join(jobDir, "request.json");
  const supervisorEventsPath = join(jobDir, "supervisor.events.jsonl");
  mkdirSync(join(jobDir, "attempts"), { recursive: true });
  writeImmutableJson(requestPath, {
    ...request,
    schemaVersion: 3,
    jobId,
    createdAt: request.createdAt || new Date().toISOString(),
  });
  appendEvent(supervisorEventsPath, { type: "queued" });
  return { jobId, jobDir, requestPath, supervisorEventsPath };
}

export function createAttempt(jobDir, generation) {
  if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
  const attemptDir = join(jobDir, "attempts", String(generation).padStart(4, "0"));
  mkdirSync(attemptDir, { recursive: true });
  return {
    generation,
    attemptDir,
    eventsPath: join(attemptDir, "events.jsonl"),
    outputPath: join(attemptDir, "output.part"),
  };
}

export function appendOutput(path, delta) {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, delta, "utf8");
}

export function publishResult(jobDir, outputPath) {
  const resultPath = join(jobDir, "result.txt");
  if (existsSync(resultPath)) return resultPath;
  flushFile(outputPath);
  let lastError = null;
  for (let attempt = 0; attempt <= PUBLISH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      renameSync(outputPath, resultPath);
      return resultPath;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_PUBLISH_CODES.has(error?.code) || attempt === PUBLISH_RETRY_DELAYS_MS.length) break;
      sleepSync(PUBLISH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function attemptEvents(jobDir) {
  const attemptsDir = join(jobDir, "attempts");
  if (!existsSync(attemptsDir)) return [];
  return readdirSync(attemptsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => readEvents(join(attemptsDir, entry.name, "events.jsonl")));
}

export function recoverJobs(runtimeDir) {
  const jobsDir = join(runtimeDir, "jobs");
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const jobDir = join(jobsDir, entry.name);
      const requestPath = join(jobDir, "request.json");
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      const supervisorEventsPath = join(jobDir, "supervisor.events.jsonl");
      return {
        ...reduceJob(
          request,
          readEvents(supervisorEventsPath),
          attemptEvents(jobDir),
          existsSync(join(jobDir, "result.txt")),
        ),
        jobDir,
        requestPath,
        supervisorEventsPath,
      };
    });
}

export function jobPaths(runtimeDir, jobId) {
  if (basename(jobId) !== jobId || !/^job_[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("Invalid job id");
  const jobDir = join(runtimeDir, "jobs", jobId);
  return {
    jobDir,
    requestPath: join(jobDir, "request.json"),
    supervisorEventsPath: join(jobDir, "supervisor.events.jsonl"),
    resultPath: join(jobDir, "result.txt"),
    cancelPath: join(jobDir, "cancel.requested"),
  };
}

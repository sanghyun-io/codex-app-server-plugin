#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { AppServerClient, AppServerError } from "./lib/app-server-client.mjs";
import {
  appendEvent,
  appendEventBestEffort,
  appendOutput,
  createAttempt,
  jobPaths,
  publishResult,
} from "./lib/job-store.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function parseArgs(argv) {
  const runtimeDir = option(argv, "--runtime");
  const jobId = option(argv, "--job");
  const generation = Number(option(argv, "--generation"));
  const nonce = option(argv, "--nonce");
  if (!runtimeDir || !jobId || !Number.isInteger(generation) || generation < 1 || !nonce) {
    throw new Error("Usage: job-worker --runtime <dir> --job <id> --generation <n> --nonce <nonce>");
  }
  return { runtimeDir: resolve(runtimeDir), jobId, generation, nonce };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const paths = jobPaths(parsed.runtimeDir, parsed.jobId);
  const request = JSON.parse(readFileSync(paths.requestPath, "utf8"));
  if (request.schemaVersion !== 3 || request.jobId !== parsed.jobId) throw new Error("Invalid immutable job request");

  const attempt = createAttempt(paths.jobDir, parsed.generation);
  if (existsSync(paths.cancelPath)) {
    appendEvent(attempt.eventsPath, { type: "cancelled", generation: parsed.generation });
    process.exit(8);
  }
  appendEvent(attempt.eventsPath, {
    type: "starting",
    generation: parsed.generation,
    pid: process.pid,
    nonce: parsed.nonce,
  });

  const client = new AppServerClient();
  let checkpointTimer = null;
  let charsReceived = 0;
  let threadId = request.threadId || null;
  let turnId = null;
  const ensureNotCancelled = () => {
    if (!existsSync(paths.cancelPath)) return;
    const error = new AppServerError(8, "Job cancelled");
    error.cancelled = true;
    throw error;
  };
  try {
    ensureNotCancelled();
    await client.spawn();
    ensureNotCancelled();
    await client.initialize();
    ensureNotCancelled();
    await client.checkAuth();
    ensureNotCancelled();
    const models = await client.listModels();
    ensureNotCancelled();
    if (models && !models.includes(request.model)) {
      throw new AppServerError(6, `Model '${request.model}' is unavailable. Available models: ${models.join(", ")}`);
    }
    if (request.command === "follow-up") {
      if (!threadId) throw new AppServerError(4, "Follow-up job has no thread id");
      await client.resumeThread(threadId);
    } else {
      const thread = await client.startThread({ model: request.model, cwd: request.projectRoot });
      threadId = thread?.thread?.id;
      if (!threadId) throw new AppServerError(6, "Thread start returned no thread id");
    }
    ensureNotCancelled();

    const result = await client.startTurn(threadId, request.prompt, {
      model: request.model,
      effort: request.effort || "high",
      cwd: request.projectRoot,
      timeoutMs: request.timeoutMs,
      cancelSignal: () => existsSync(paths.cancelPath),
      onStarted: id => {
        turnId = id;
        appendEvent(attempt.eventsPath, {
          type: "running",
          generation: parsed.generation,
          threadId,
          turnId,
        });
        checkpointTimer = setInterval(() => {
          appendEventBestEffort(attempt.eventsPath, {
            type: "checkpoint",
            generation: parsed.generation,
            threadId,
            turnId,
            charsReceived,
          }, {
            onError: error => console.error(`[job-worker] checkpoint skipped: ${error?.message || error}`),
          });
        }, 3_000);
      },
      onDelta: (delta, total) => {
        charsReceived = total;
        appendOutput(attempt.outputPath, delta);
      },
    });

    if (checkpointTimer) clearInterval(checkpointTimer);
    if (result.status === "cancelled") {
      appendEvent(attempt.eventsPath, {
        type: "cancelled",
        generation: parsed.generation,
        threadId,
        turnId: result.turnId || turnId,
        charsReceived: result.text.length,
        completedAt: new Date().toISOString(),
      });
      client.close();
      process.exit(8);
    }
    if (!existsSync(attempt.outputPath)) appendOutput(attempt.outputPath, "");
    if (request.outputPath) {
      mkdirSync(dirname(request.outputPath), { recursive: true });
      copyFileSync(attempt.outputPath, request.outputPath);
    }
    publishResult(paths.jobDir, attempt.outputPath);
    appendEvent(attempt.eventsPath, {
      type: "completed",
      generation: parsed.generation,
      threadId,
      turnId: result.turnId || turnId,
      charsReceived: result.text.length,
      completedAt: new Date().toISOString(),
    });
    client.close();
    process.exit(0);
  } catch (error) {
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (error?.cancelled || existsSync(paths.cancelPath)) {
      appendEvent(attempt.eventsPath, {
        type: "cancelled",
        generation: parsed.generation,
        threadId,
        turnId,
        charsReceived,
      });
      client.close();
      process.exit(8);
    }
    appendEvent(attempt.eventsPath, {
      type: error?.retryable ? "recoverable_failure" : "failed",
      generation: parsed.generation,
      threadId,
      turnId,
      exitCode: error?.exitCode || 6,
      error: error?.message || String(error),
    });
    client.close();
    console.error(`[job-worker] ${error?.stack || error}`);
    process.exit(error?.exitCode || 6);
  }
}

main().catch(error => {
  console.error(`[job-worker] ${error?.stack || error}`);
  process.exit(error?.exitCode || 6);
});

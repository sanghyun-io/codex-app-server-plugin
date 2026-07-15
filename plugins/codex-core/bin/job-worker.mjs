#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { AppServerClient, AppServerError } from "./lib/app-server-client.mjs";
import {
  appendEvent,
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
  try {
    await client.spawn();
    await client.initialize();
    await client.checkAuth();
    const models = await client.listModels();
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

    const result = await client.startTurn(threadId, request.prompt, {
      model: request.model,
      effort: request.effort || "high",
      cwd: request.projectRoot,
      timeoutMs: request.timeoutMs,
      onStarted: id => {
        turnId = id;
        appendEvent(attempt.eventsPath, {
          type: "running",
          generation: parsed.generation,
          threadId,
          turnId,
        });
        checkpointTimer = setInterval(() => {
          appendEvent(attempt.eventsPath, {
            type: "checkpoint",
            generation: parsed.generation,
            threadId,
            turnId,
            charsReceived,
          });
        }, 3_000);
      },
      onDelta: (delta, total) => {
        charsReceived = total;
        appendOutput(attempt.outputPath, delta);
      },
    });

    if (checkpointTimer) clearInterval(checkpointTimer);
    if (!existsSync(attempt.outputPath)) appendOutput(attempt.outputPath, "");
    const resultPath = publishResult(paths.jobDir, attempt.outputPath);
    if (request.outputPath) {
      mkdirSync(dirname(request.outputPath), { recursive: true });
      copyFileSync(resultPath, request.outputPath);
    }
    appendEvent(attempt.eventsPath, {
      type: result.status === "cancelled" ? "cancelled" : "completed",
      generation: parsed.generation,
      threadId,
      turnId: result.turnId || turnId,
      charsReceived: result.text.length,
      completedAt: new Date().toISOString(),
    });
    client.close();
    process.exit(result.status === "cancelled" ? 8 : 0);
  } catch (error) {
    if (checkpointTimer) clearInterval(checkpointTimer);
    appendEvent(attempt.eventsPath, {
      type: "failed",
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

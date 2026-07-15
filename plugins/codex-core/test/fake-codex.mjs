#!/usr/bin/env node

/**
 * Fake codex app-server for testing.
 *
 * Simulates the Codex App Server JSON-RPC 2.0 protocol over stdio.
 * Responds to: initialize, account/read, thread/start, thread/resume, turn/start.
 *
 * Environment variables:
 *   FAKE_TURN_DELAY_MS     — Delay before emitting the first delta (default: 200)
 *   FAKE_TURN_TEXT          — Response text for the turn
 *   FAKE_TURN_FAIL          — If set, turn fails with this message
 *   FAKE_AUTH_FAIL          — If set, account/read returns no account
 *   FAKE_TAG_THREAD         — If set, prefix each delta with `[<threadId>] `
 *                              so concurrent-turn tests can distinguish streams.
 *   FAKE_DELTA_INTERVAL_MS  — Delay between delta chunks (default: 20)
 *   FAKE_INTERRUPT_LOG      — JSONL capture for turn/interrupt params
 */

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const TURN_DELAY = parseInt(process.env.FAKE_TURN_DELAY_MS || "200", 10);
const TURN_TEXT = process.env.FAKE_TURN_TEXT || "Fake review output for testing.\n\n[VERDICT] - APPROVE";
const TURN_FAIL = process.env.FAKE_TURN_FAIL || "";
const TURN_START_REJECT = process.env.FAKE_TURN_START_REJECT || "";
const TURN_START_RESPONSE_DELAY_MS = parseInt(process.env.FAKE_TURN_START_RESPONSE_DELAY_MS || "0", 10);
const AUTH_FAIL = !!process.env.FAKE_AUTH_FAIL;
const TAG_THREAD = !!process.env.FAKE_TAG_THREAD;
const DELTA_INTERVAL_MS = parseInt(process.env.FAKE_DELTA_INTERVAL_MS || "20", 10);
const REQUEST_LOG = process.env.FAKE_REQUEST_LOG || "";
const INTERRUPT_LOG = process.env.FAKE_INTERRUPT_LOG || "";
const INTERRUPT_DELAY_MS = parseInt(process.env.FAKE_INTERRUPT_DELAY_MS || "0", 10);
const FOREIGN_DELTA = !!process.env.FAKE_FOREIGN_DELTA;
const EXIT_AFTER_FIRST_DELTA = !!process.env.FAKE_EXIT_AFTER_FIRST_DELTA;
const EXIT_ONCE_FILE = process.env.FAKE_EXIT_ONCE_FILE || "";
const HANG_METHOD = process.env.FAKE_HANG_METHOD || "";
const INITIALIZE_DELAY_MS = parseInt(process.env.FAKE_INITIALIZE_DELAY_MS || "0", 10);
const PID_FILE = process.env.FAKE_PID_FILE || "";
if (PID_FILE) writeFileSync(PID_FILE, `${process.pid}\n`, "utf8");
const MODELS = JSON.parse(process.env.FAKE_MODELS || JSON.stringify([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
]));
const MODEL_LIST_UNSUPPORTED = !!process.env.FAKE_MODEL_LIST_UNSUPPORTED;
const MODEL_PAGES = process.env.FAKE_MODEL_PAGES
  ? JSON.parse(process.env.FAKE_MODEL_PAGES)
  : null;

const rl = createInterface({ input: process.stdin });

let threadCounter = 0;
let turnCounter = 0;
const interruptedTurns = new Set();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function recordRequest(msg) {
  if (REQUEST_LOG) {
    appendFileSync(REQUEST_LOG, `${JSON.stringify(msg)}\n`, "utf8");
  }
}

function recordInterrupt(params) {
  if (INTERRUPT_LOG) {
    appendFileSync(INTERRUPT_LOG, `${JSON.stringify(params)}\n`, "utf8");
  }
}

function handleRequest(msg) {
  const { method, id, params } = msg;
  recordRequest(msg);
  if (method === HANG_METHOD) return;

  switch (method) {
    case "initialize":
      setTimeout(() => {
        send({ id, result: { serverInfo: { name: "fake-codex", version: "0.0.1" } } });
      }, INITIALIZE_DELAY_MS);
      break;

    case "account/read":
      if (AUTH_FAIL) {
        send({ id, result: { account: null } });
      } else {
        send({
          id,
          result: {
            account: { email: "test@example.com", type: "individual", planType: "free" },
          },
        });
      }
      break;

    case "model/list":
      if (MODEL_LIST_UNSUPPORTED) {
        send({ id, error: { code: -32601, message: "Method not found: model/list" } });
      } else {
        const pageIndex = Number(params?.cursor || 0);
        const pageModels = MODEL_PAGES ? (MODEL_PAGES[pageIndex] || []) : MODELS;
        send({
          id,
          result: {
            data: pageModels.map((model, index) => ({
              id: model,
              model,
              displayName: model,
              description: "Fake model",
              hidden: false,
              isDefault: index === 0,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "High" },
              ],
            })),
            nextCursor: MODEL_PAGES && pageIndex + 1 < MODEL_PAGES.length
              ? String(pageIndex + 1)
              : null,
          },
        });
      }
      break;

    case "thread/start": {
      const threadId = `fake-thread-${++threadCounter}`;
      send({ id, result: { thread: { id: threadId } } });
      break;
    }

    case "thread/resume":
      send({ id, result: { thread: { id: params.threadId } } });
      break;

    case "turn/start": {
      if (TURN_START_REJECT) {
        let error;
        try { error = JSON.parse(TURN_START_REJECT); }
        catch { error = { message: TURN_START_REJECT }; }
        send({ id, error });
        break;
      }

      // Simulate turn processing with configurable delay
      const threadId = params.threadId;
      const turnId = `fake-turn-${++turnCounter}`;

      setTimeout(() => {
        send({
          id,
          result: { turn: { id: turnId, status: "inProgress", items: [], error: null } },
        });
      }, TURN_START_RESPONSE_DELAY_MS);

      setTimeout(() => {
        if (interruptedTurns.has(turnId)) return;
        if (TURN_FAIL) {
          send({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "failed", items: [], error: { message: TURN_FAIL } },
            },
          });
          return;
        }

        // Optionally tag each delta with its threadId so concurrent-turn
        // tests can detect if deltas from one thread leak into another.
        const tagged = TAG_THREAD ? `[${threadId}] ${TURN_TEXT}` : TURN_TEXT;
        const chunks = tagged.match(/.{1,50}/g) || [tagged];

        if (FOREIGN_DELTA) {
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: "foreign-thread",
              turnId: "foreign-turn",
              itemId: "foreign-item",
              delta: "FOREIGN_NOTIFICATION",
            },
          });
        }

        let delay = 0;
        let sentDeltas = 0;
        for (const chunk of chunks) {
          setTimeout(() => {
            if (interruptedTurns.has(turnId)) return;
            send({
              method: "item/agentMessage/delta",
              params: { threadId, turnId, itemId: `item-${turnId}`, delta: chunk },
            });
            sentDeltas += 1;
            const shouldExitOnce = EXIT_ONCE_FILE && !existsSync(EXIT_ONCE_FILE);
            if (sentDeltas === 1 && (EXIT_AFTER_FIRST_DELTA || shouldExitOnce)) {
              if (shouldExitOnce) writeFileSync(EXIT_ONCE_FILE, "exited\n", "utf8");
              setTimeout(() => process.exit(42), 10);
            }
          }, delay);
          delay += DELTA_INTERVAL_MS;
        }

        // Send completion after all deltas
        setTimeout(() => {
          if (interruptedTurns.has(turnId)) return;
          send({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "completed", items: [], error: null },
            },
          });
        }, delay + 50);
      }, TURN_DELAY);

      break;
    }

    case "turn/interrupt":
      interruptedTurns.add(params.turnId);
      recordInterrupt(params);
      setTimeout(() => {
        send({ id, result: {} });
        send({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "interrupted", items: [], error: null },
          },
        });
      }, INTERRUPT_DELAY_MS);
      break;

    default:
      send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    // Skip notifications (no id)
    if (msg.id != null) {
      handleRequest(msg);
    }
  } catch {
    // ignore non-JSON
  }
});

// Keep process alive
process.stdin.resume();

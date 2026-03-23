#!/usr/bin/env node

/**
 * Fake codex app-server for testing.
 *
 * Simulates the Codex App Server JSON-RPC 2.0 protocol over stdio.
 * Responds to: initialize, account/read, thread/start, thread/resume, turn/start.
 *
 * Environment variables:
 *   FAKE_TURN_DELAY_MS   — Delay before completing the turn (default: 200)
 *   FAKE_TURN_TEXT        — Response text for the turn (default: "Fake review output")
 *   FAKE_TURN_FAIL        — If set, turn fails with this message
 *   FAKE_AUTH_FAIL         — If set, account/read returns no account
 */

import { createInterface } from "node:readline";

const TURN_DELAY = parseInt(process.env.FAKE_TURN_DELAY_MS || "200", 10);
const TURN_TEXT = process.env.FAKE_TURN_TEXT || "Fake review output for testing.\n\n[VERDICT] - APPROVE";
const TURN_FAIL = process.env.FAKE_TURN_FAIL || "";
const AUTH_FAIL = !!process.env.FAKE_AUTH_FAIL;

const rl = createInterface({ input: process.stdin });

let threadCounter = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleRequest(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case "initialize":
      send({ id, result: { serverInfo: { name: "fake-codex", version: "0.0.1" } } });
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

    case "thread/start": {
      const threadId = `fake-thread-${++threadCounter}`;
      send({ id, result: { thread: { id: threadId } } });
      break;
    }

    case "thread/resume":
      send({ id, result: { thread: { id: params.threadId } } });
      break;

    case "turn/start": {
      // Simulate turn processing with configurable delay
      const threadId = params.threadId;

      setTimeout(() => {
        if (TURN_FAIL) {
          send({ method: "turn/completed", params: { turn: { status: "failed", error: { message: TURN_FAIL } } } });
          return;
        }

        // Send deltas in chunks
        const chunks = TURN_TEXT.match(/.{1,50}/g) || [TURN_TEXT];
        let delay = 0;
        for (const chunk of chunks) {
          setTimeout(() => {
            send({ method: "item/agentMessage/delta", params: { delta: chunk } });
          }, delay);
          delay += 20;
        }

        // Send completion after all deltas
        setTimeout(() => {
          send({ method: "turn/completed", params: { turn: { status: "completed" } } });
        }, delay + 50);
      }, TURN_DELAY);

      break;
    }

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

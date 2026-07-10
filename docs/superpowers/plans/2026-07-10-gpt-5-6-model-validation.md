# GPT-5.6 Model Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Codex review sessions use the assigned GPT-5.6 model, validate that model against the authenticated account before creating a thread, and return actionable supported-model alternatives without automatic fallback.

**Architecture:** Keep model resolution and App Server interaction in `codex-review.mjs`. Add a lower-priority internal workflow default, account-aware `model/list` validation, and one effective model passed to both thread and turn. Extend the fake App Server to capture real JSON-RPC requests so direct, broker, environment, follow-up, and failure behavior are verified at the protocol boundary.

**Tech Stack:** Node.js ESM, Node built-in test runner, JSON-RPC over stdio/TCP, Claude Code plugin manifests and Markdown rules/skills.

## Global Constraints

- New regular sessions use `gpt-5.6-terra`; `red-review` uses `gpt-5.6-sol`; `delegate --read-only` uses `gpt-5.6-luna`.
- `--model` overrides `CODEX_REVIEW_MODEL`, which overrides internal `--default-model`, which overrides wrapper `DEFAULT_MODEL`.
- No new session defaults or falls back to `gpt-5.5`; existing session state may preserve `gpt-5.5` for follow-up consistency.
- A successful `model/list` response that excludes the requested model causes exit 6 before thread creation.
- No model aliasing or automatic fallback is allowed.
- If `model/list` is unsupported or transiently fails, warn and preserve the legacy request path.
- Keep the implementation dependency-free and portable across the existing Windows and POSIX Node test environments.
- Release versions become `codex-core` 2.4.0, `codex-code-review` 2.3.0, and marketplace metadata 2.4.0.

---

### Task 1: Capture JSON-RPC model payloads and prove the regression

**Files:**
- Modify: `plugins/codex-core/test/fake-codex.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: existing `CODEX_BINARY` fake-server injection and `cli(args, opts)` test helper.
- Produces: `FAKE_REQUEST_LOG`, `FAKE_MODELS`, and `FAKE_MODEL_LIST_UNSUPPORTED` fake-server controls; `readRequests(path)` test helper.

- [ ] **Step 1: Extend the fake App Server test harness**

Add `appendFileSync` and these exact environment-backed controls:

```js
const REQUEST_LOG = process.env.FAKE_REQUEST_LOG || "";
const MODELS = JSON.parse(process.env.FAKE_MODELS || JSON.stringify([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
]));
const MODEL_LIST_UNSUPPORTED = !!process.env.FAKE_MODEL_LIST_UNSUPPORTED;

function recordRequest(msg) {
  if (REQUEST_LOG) appendFileSync(REQUEST_LOG, `${JSON.stringify(msg)}\n`, "utf8");
}
```

Call `recordRequest(msg)` before the request switch. Add `model/list` handling:

```js
case "model/list":
  if (MODEL_LIST_UNSUPPORTED) {
    send({ id, error: { code: -32601, message: "Method not found: model/list" } });
  } else {
    send({
      id,
      result: {
        data: MODELS.map((model, index) => ({
          id: model,
          model,
          displayName: model,
          description: "Fake model",
          hidden: false,
          isDefault: index === 0,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
        })),
        nextCursor: null,
      },
    });
  }
  break;
```

- [ ] **Step 2: Add request-log options to the test helper**

Extend `cli()` environment creation with:

```js
...(opts.requestLog ? { FAKE_REQUEST_LOG: opts.requestLog } : {}),
...(opts.models ? { FAKE_MODELS: JSON.stringify(opts.models) } : {}),
...(opts.modelListUnsupported ? { FAKE_MODEL_LIST_UNSUPPORTED: "1" } : {}),
...(opts.envModel ? { CODEX_REVIEW_MODEL: opts.envModel } : {}),
```

Add:

```js
function readRequests(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
```

- [ ] **Step 3: Write failing direct-mode model consistency tests**

Add a `model payload consistency` suite that creates a unique request log for each case and asserts:

```js
const requests = readRequests(requestLog);
const threadStart = requests.find(request => request.method === "thread/start");
const turnStart = requests.find(request => request.method === "turn/start");
assert.equal(threadStart.params.model, expectedModel);
assert.equal(turnStart.params.model, expectedModel);
```

Cover these exact cases:

```js
[
  { name: "wrapper default", args: [], opts: {}, expected: "gpt-5.6-terra" },
  { name: "explicit model", args: ["--model", "gpt-5.6-sol"], opts: {}, expected: "gpt-5.6-sol" },
  { name: "environment model", args: [], opts: { envModel: "gpt-5.6-luna" }, expected: "gpt-5.6-luna" },
  { name: "workflow default", args: ["--default-model", "gpt-5.6-sol"], opts: {}, expected: "gpt-5.6-sol" },
  {
    name: "environment beats workflow default",
    args: ["--default-model", "gpt-5.6-sol"],
    opts: { envModel: "gpt-5.6-luna" },
    expected: "gpt-5.6-luna",
  },
]
```

- [ ] **Step 4: Run the focused suite and verify RED**

Run:

```powershell
node --test --test-name-pattern="model payload consistency" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because the current wrapper sends `gpt-5.5` and does not parse `--default-model`.

- [ ] **Step 5: Commit the test harness and failing regression tests**

```powershell
git add plugins/codex-core/test/fake-codex.mjs plugins/codex-core/test/codex-review.test.mjs
git commit -m "test(core): capture App Server model payloads"
```

### Task 2: Implement GPT-5.6 resolution and account-aware fail-fast validation

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: fake `model/list`, request logs, existing `CodexError`, `AppServerClient`, `BrokerClient`, and session state.
- Produces: parsed `defaultModel`, `listModels()` on both clients, `validateModelAvailability(client, model)`, and exact effective-model propagation.

- [ ] **Step 1: Add failing validation and follow-up tests**

Add tests that assert:

```js
assert.equal(result.exit, 6);
assert.match(result.stderr, /not available/i);
assert.match(result.stderr, /gpt-5\.6-sol/);
assert.match(result.stderr, /gpt-5\.6-terra/);
assert.equal(readRequests(requestLog).some(r => r.method === "thread/start"), false);
assert.equal(readRequests(requestLog).some(r => r.method === "turn/start"), false);
```

The unsupported request must use `--model unavailable-model` with a fake catalog containing the three GPT-5.6 models. Add another test where `FAKE_MODEL_LIST_UNSUPPORTED=1` and a supported fake turn completes, proving compatibility fallback. Extend the existing follow-up test to assert the captured follow-up `turn/start.params.model` remains the originally persisted model, including a manually persisted `gpt-5.5` case.

- [ ] **Step 2: Run validation tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="model availability|model reuse" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because `model/list` is not requested and unsupported models reach `thread/start`.

- [ ] **Step 3: Implement model resolution**

Change:

```js
const DEFAULT_MODEL = "gpt-5.6-terra";
```

Parse `--default-model` into `defaultModel`. Resolve new-session models with:

```js
const resolvedModel = model
  || process.env.CODEX_REVIEW_MODEL
  || defaultModel
  || DEFAULT_MODEL;
```

Return both `modelExplicit: model !== null` and `defaultModel`. In `spawnWorker`, forward `--default-model` only when present. Keep follow-up resolution as explicit `--model`, otherwise persisted `state.model`, otherwise the new-session resolved model.

- [ ] **Step 4: Implement model listing and normalization**

Add the same method to both client classes:

```js
async listModels() {
  return await this.request("model/list", { includeHidden: true });
}
```

Add helpers with these contracts:

```js
function normalizeModelCatalog(result) {
  const entries = Array.isArray(result?.data) ? result.data : [];
  const accepted = new Set();
  const visible = [];
  for (const entry of entries) {
    for (const value of [entry?.id, entry?.model]) {
      if (typeof value === "string" && value.trim()) accepted.add(value.trim());
    }
    const display = entry?.model || entry?.id;
    if (!entry?.hidden && typeof display === "string" && !visible.includes(display)) visible.push(display);
  }
  return { accepted, visible };
}

async function validateModelAvailability(client, model) {
  try {
    const catalog = normalizeModelCatalog(await client.listModels());
    if (catalog.accepted.size > 0 && !catalog.accepted.has(model)) {
      throw new CodexError(6, [
        `Model "${model}" is not available for the current Codex account.`,
        `Available models: ${catalog.visible.join(", ") || "none reported"}`,
        "No fallback was performed. Choose a supported model with --model or CODEX_REVIEW_MODEL.",
      ].join("\n"));
    }
    return catalog.visible;
  } catch (err) {
    if (err instanceof CodexError) throw err;
    log(`Warning: could not validate model availability (${err.message || JSON.stringify(err)}); continuing without preflight validation.`);
    return [];
  }
}
```

Call validation after authentication and after computing the effective model, but before `thread/start` or `thread/resume`. Log `Starting turn (model: ${effectiveModel})` immediately before `startTurn`.

- [ ] **Step 5: Run focused and full tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="model payload consistency|model availability|model reuse" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: all focused tests pass, then all integration tests pass.

- [ ] **Step 6: Commit GPT-5.6 resolution and preflight validation**

```powershell
git add plugins/codex-core/bin/codex-review.mjs plugins/codex-core/test/codex-review.test.mjs
git commit -m "feat(core): validate GPT-5.6 models before turns"
```

### Task 3: Normalize unsupported-account errors with alternatives

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/test/fake-codex.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: effective model and visible model names returned by `validateModelAvailability`.
- Produces: `extractAppServerErrorMessage(value)` and `enrichUnsupportedModelError(error, model, availableModels)`.

- [ ] **Step 1: Write a failing nested-error test**

Let `FAKE_TURN_FAIL` contain this exact JSON string:

```json
{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}}
```

Assert exit 6 and stderr contains the requested model, `not supported`, `No fallback was performed`, and at least `gpt-5.6-terra` from the successful catalog lookup.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="unsupported ChatGPT model" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because the current error path returns the raw nested payload without alternatives.

- [ ] **Step 3: Implement recursive message extraction and enrichment**

Add:

```js
function extractAppServerErrorMessage(value) {
  if (typeof value === "string") {
    try { return extractAppServerErrorMessage(JSON.parse(value)); } catch { return value; }
  }
  if (!value || typeof value !== "object") return String(value || "Unknown App Server error");
  return extractAppServerErrorMessage(value.error || value.message || value.detail || JSON.stringify(value));
}

function enrichUnsupportedModelError(error, model, availableModels) {
  const message = extractAppServerErrorMessage(error?.message || error);
  if (!/not supported|unsupported model|model.+not available/i.test(message)) return error;
  const alternatives = availableModels.length ? availableModels.join(", ") : "query model/list for this account";
  return new CodexError(error?.exitCode || 6, [
    `Model "${model}" was rejected by the authenticated Codex account: ${message}`,
    `Available models: ${alternatives}`,
    "No fallback was performed. Choose a supported model with --model or CODEX_REVIEW_MODEL.",
  ].join("\n"));
}
```

Use `extractAppServerErrorMessage` in both direct and broker failed-turn handlers. Wrap `client.startTurn(...)` in `workerMain` and rethrow `enrichUnsupportedModelError(err, effectiveModel, availableModels)`.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="unsupported ChatGPT model" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: both commands pass.

- [ ] **Step 5: Commit actionable error reporting**

```powershell
git add plugins/codex-core/bin/codex-review.mjs plugins/codex-core/test/fake-codex.mjs plugins/codex-core/test/codex-review.test.mjs
git commit -m "fix(core): explain unsupported ChatGPT models"
```

### Task 4: Apply workflow defaults, documentation, and release versions

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/codex-core/.claude-plugin/plugin.json`
- Modify: `plugins/codex-code-review/.claude-plugin/plugin.json`
- Modify: `plugins/codex-core/rules/codex-delegate.md`
- Modify: `plugins/codex-core/rules/codex-delegation.md`
- Modify: `plugins/codex-core/rules/codex-session-ops.md`
- Modify: `plugins/codex-core/rules/review-protocol.md`
- Modify: `plugins/codex-core/skills/delegate/SKILL.md`
- Modify: `plugins/codex-core/skills/setup/SKILL.md`
- Modify: `plugins/codex-core/scripts/install.sh`
- Modify: `plugins/codex-code-review/rules/codex-code-review.md`
- Modify: `plugins/codex-code-review/rules/codex-red-review.md`
- Modify: `plugins/codex-code-review/skills/code-review/SKILL.md`
- Modify: `plugins/codex-code-review/skills/red-review/SKILL.md`
- Modify: `README.md`
- Modify: `README.ko.md`

**Interfaces:**
- Consumes: wrapper `--default-model`, `--model`, and `CODEX_REVIEW_MODEL` precedence.
- Produces: Sol/Terra/Luna workflow commands, accurate user documentation, and marketplace-visible release versions.

- [ ] **Step 1: Apply exact workflow defaults**

Update red-review start instructions to append:

```text
--default-model "gpt-5.6-sol"
```

when invoking `codex-review start`; a user `--model` remains a separate higher-priority argument. Update `delegate --read-only` instructions to append:

```text
--default-model "gpt-5.6-luna"
```

Regular delegate and code-review rely on wrapper `gpt-5.6-terra`. Update report templates so code-review examples say Terra and red-review examples say Sol, while instructing the workflow to replace the label with the actual session model.

- [ ] **Step 2: Update user-facing model documentation**

Document the exact table:

```text
red-review              gpt-5.6-sol
code-review             gpt-5.6-terra
delegate                gpt-5.6-terra
delegate --read-only    gpt-5.6-luna
```

Document precedence as `--model` > `CODEX_REVIEW_MODEL` > workflow default > `gpt-5.6-terra`. State that unsupported models fail before thread creation with available alternatives and no fallback. Preserve historical `gpt-5.5` only where explaining existing-session compatibility; remove it from current-default claims and setup output.

- [ ] **Step 3: Bump plugin and marketplace versions**

Apply these exact values:

```json
// .claude-plugin/marketplace.json
"metadata": { "version": "2.4.0" }
"codex-core": { "version": "2.4.0" }
"codex-code-review": { "version": "2.3.0" }

// plugins/codex-core/.claude-plugin/plugin.json
"version": "2.4.0"

// plugins/codex-code-review/.claude-plugin/plugin.json
"version": "2.3.0"
```

Keep the README update guidance that `/plugin` refreshes the cache and `/codex-core:setup` safely synchronizes the wrapper and rules during an active Claude Code session.

- [ ] **Step 4: Verify documentation and manifest consistency**

Run:

```powershell
rg -n 'gpt-5\.5.*(default|기본)|default.*gpt-5\.5|기본.*gpt-5\.5' README.md README.ko.md plugins
rg -n 'gpt-5\.6-(sol|terra|luna)|2\.4\.0|2\.3\.0' .claude-plugin plugins README.md README.ko.md
node -e "for (const p of ['.claude-plugin/marketplace.json','plugins/codex-core/.claude-plugin/plugin.json','plugins/codex-code-review/.claude-plugin/plugin.json']) JSON.parse(require('node:fs').readFileSync(p,'utf8')); console.log('manifest JSON OK')"
git diff --check
```

Expected: no current-default claim names `gpt-5.5`; all three GPT-5.6 models and all release versions appear in the intended files; JSON parsing and diff checks succeed.

- [ ] **Step 5: Run the full integration suite**

```powershell
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit workflow defaults and release versions**

```powershell
git add .claude-plugin plugins README.md README.ko.md
git commit -m "feat: release GPT-5.6 workflow defaults"
```

# Codex Model Validation and Turn Consistency Design

## Context

`codex-review.mjs` accepts a model from `--model`, then
`CODEX_REVIEW_MODEL`, then `DEFAULT_MODEL`. It sends that resolved value to
both `thread/start` and `turn/start`, including through the broker. The current
test suite only verifies the model saved in session state; it does not verify
the JSON-RPC payload received by the App Server.

A reported `red-review` failure created a thread while logging `gpt-5.5`, but
the upstream turn attempted `gpt-5.3-codex`, which the ChatGPT-authenticated
account rejected with HTTP 400. The current source and Codex 0.144.1 could not
reproduce that mismatch: a broker-backed `gpt-5.5` probe completed
successfully. The missing payload assertions and weak unsupported-model error
handling nevertheless leave this behavior unprotected.

The App Server protocol exposes `model/list`. Its results describe the models
available to the currently authenticated account. `gpt-5.3-codex` and
`gpt-5.3-codex-spark` are distinct models and must not be treated as aliases.

## Goals

- Send one resolved model consistently to `thread/start` and `turn/start` in
  direct and broker-backed execution.
- Verify `--model`, `CODEX_REVIEW_MODEL`, the default model, and persisted
  follow-up models at the JSON-RPC boundary.
- Fail before thread creation when `model/list` proves that the requested
  model is unavailable to the authenticated account.
- Explain unsupported-model failures with the requested model and usable
  alternatives.
- Preserve compatibility with App Server versions that do not implement
  `model/list`.

## Non-goals

- Do not silently select a different model.
- Do not rewrite `gpt-5.3-codex` to `gpt-5.3-codex-spark` or introduce any
  other model aliases.
- Do not maintain a hard-coded global model allowlist.
- Do not change the default model from `gpt-5.5` in this fix.
- Do not redesign broker serialization or authentication.

## Design

### Model resolution

Argument resolution remains:

1. `--model <name>`
2. `CODEX_REVIEW_MODEL`
3. `DEFAULT_MODEL` (`gpt-5.5`)

For a new session, this resolved value becomes `effectiveModel`. For a
follow-up, an explicit `--model` wins; otherwise the model stored in the
session state becomes `effectiveModel`. The same non-empty string is passed to
both thread and turn operations.

### Account-aware validation

Both `AppServerClient` and `BrokerClient` will expose the same `listModels()`
operation backed by `model/list` with `includeHidden: true`. A shared helper
will normalize each returned entry by accepting both its `id` and `model`
fields as exact valid names.

Before `thread/start` for a new session, and before `thread/resume` for a
follow-up, the worker validates `effectiveModel` against this account-specific
set. If the set is available and does not contain the exact requested name,
the worker exits with code 6 without sending `thread/start`, `thread/resume`,
or `turn/start`.

The error identifies the unavailable model and prints a concise list of
non-hidden available model names. It suggests selecting one with `--model` or
`CODEX_REVIEW_MODEL`. It never substitutes a model automatically.

If `model/list` is unavailable because the App Server returns method-not-found
or an equivalent protocol compatibility error, validation logs a warning and
the request continues. Other model-list failures are reported as warnings and
also defer to the existing runtime request so a transient catalog lookup does
not make an otherwise valid model unusable.

### Turn consistency and diagnostics

The worker will log the exact model immediately before `turn/start`. The
high-level clients continue to include `model` in both `thread/start` and
`turn/start`; tests will make this contract explicit.

Unsupported-model responses from either `turn/start` request rejection or a
failed-turn notification will be normalized. Nested App Server/HTTP error
payloads will be inspected for their human-readable message. When the message
indicates that a model is unsupported for a ChatGPT account, the final error
will state:

- the requested effective model;
- that the authenticated account rejected it;
- that no fallback was performed; and
- how to choose a model returned by `model/list`.

The process retains exit code 6 because this remains a request/configuration
failure under the wrapper's existing exit-code contract.

## Test strategy

The fake App Server will gain support for `model/list` and an optional JSONL
request-capture file. Tests will inspect actual received request objects rather
than infer behavior from session state.

Regression coverage will include:

- default `gpt-5.5` reaches both `thread/start` and `turn/start`;
- explicit `--model` reaches both requests in direct mode;
- explicit `--model` reaches both requests through the broker;
- `CODEX_REVIEW_MODEL` reaches both requests;
- follow-up without an override reuses the persisted model in `turn/start`;
- a model absent from `model/list` exits 6 before thread or turn creation;
- an unsupported ChatGPT-account error is converted into actionable output;
- lack of `model/list` support preserves the legacy execution path.

Existing foreground, background, authentication, cancellation, and broker
serialization tests must remain green.

## Files affected

- `plugins/codex-core/bin/codex-review.mjs`: model listing, validation,
  consistent effective-model handling, logging, and error normalization.
- `plugins/codex-core/test/fake-codex.mjs`: model catalog simulation and
  JSON-RPC request capture.
- `plugins/codex-core/test/codex-review.test.mjs`: direct, environment,
  broker, follow-up, validation, and error-message regression tests.
- User-facing model documentation only if implementation changes the existing
  command behavior beyond the rules described above.

## Acceptance criteria

- No `thread/start` or `turn/start` occurs for a requested model that an
  available `model/list` response excludes.
- Every successful start sends the same resolved model to thread and turn.
- `--model`, `CODEX_REVIEW_MODEL`, and follow-up state are observable in the
  captured `turn/start` payload.
- Unsupported ChatGPT-account errors name the rejected model and provide
  supported alternatives without automatic fallback.
- All existing and new tests pass on Windows and remain portable to POSIX
  environments supported by the current Node test suite.

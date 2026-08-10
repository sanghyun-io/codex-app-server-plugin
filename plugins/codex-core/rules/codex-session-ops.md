---
rule_type: workflow
applies_to:
  - "Codex session listing, cancellation, result retrieval"
  - "/sessions, /halt, /readout commands"
triggers:
  - event: "codex_session_ops"
    description: "사용자가 Codex 세션 조회/중단/결과 조회를 요청할 때"
---

# Codex Session Operations

실행 중인 Codex 세션을 관찰/중단/결과 조회하는 공통 프로토콜.
code-review, delegate, red-review 등 모든 스킬이 제출한 v3 durable job을 대상으로 한다.

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: `/sessions`, `/halt`, `/readout` 스킬이 호출되면 아래 절차를 따른다.

### 세션 현황 조회 (sessions)

| Order | Action |
|:-----:|--------|
| 1 | `codex-review list --review-dir {REVIEW_DIR}` 실행 |
| 2 | 반환된 `jobs` 배열에서 최신 상태와 output 경로 파싱 |
| 3 | Prefix별로 그룹화하여 표 출력 (`cr_` / `dg_` / `rr_`) |
| 4 | 2분 이상 실행 중인 세션은 시각적으로 강조 |

### 세션 중단 (halt)

| Order | Action |
|:-----:|--------|
| 1 | sessions 절차로 실행 중(`queued`부터 `reconnecting`까지의 비종료 상태) 세션 수집 |
| 2 | 복수 세션이면 **AskUserQuestion**으로 중단 대상 선택 |
| 3 | `codex-review cancel --session {SID} --review-dir {REVIEW_DIR}` 실행 |
| 4 | 부분 출력 파일이 있으면 경로 안내 |

### 결과 조회 (readout)

| Order | Action |
|:-----:|--------|
| 1 | sessions 절차로 완료된(`completed` / `cancelled` / `timeout_partial`) 세션 수집 |
| 2 | 복수 세션이면 **AskUserQuestion**으로 대상 선택 |
| 3 | 해당 세션의 최신 `_output.txt`를 Read로 읽고 표시 |
| 4 | v3 세션은 `codex-review status`/`list`(런타임 저널)에서 `threadId`·턴 수·모델을 추출해 표시한다. (`_state.json`은 레거시 foreground 경로에서만 생성되어 v3 기본 경로엔 없다) |

> **참고**: 여기서 말하는 `threadId`는 Codex App Server가 관리하는 내부 thread ID이며,
> 사용자가 직접 interactive `codex` CLI로 이어 쓸 수 있는 session UUID와는 다르다.
> 후속 turn이 필요하면 같은 스킬(`/codex-code-review:code-review` 또는 `/codex-core:delegate` 등)을 다시 호출하여
> `codex-review follow-up` 경로로 진행해야 한다.

---

## 상태 포맷

### `codex-review status` JSON

```json
{
  "schemaVersion": 3,
  "status": "running",
  "createdAt": "2026-04-10T10:23:45.123Z",
  "updatedAt": "2026-04-10T10:24:30.123Z",
  "lastActivityAt": "2026-04-10T10:24:30.123Z",
  "idleMs": 2100,
  "elapsedMs": 45000,
  "projectRoot": "/repo",
  "threadId": "thr_abc123",
  "turnId": "turn_abc123",
  "charsReceived": 3200,
  "pid": 12345,
  "pidAlive": true
}
```

**status 값**: `queued` / `starting` / `running` / `recovering` / `completed` / `cancelled` / `failed`

> `status`/`list`는 **Bash 포그라운드로만 조회**한다 (Monitor·`run_in_background` 금지 — review-protocol.md의 "상태 조회 메커니즘" 참조). 실행 중 세션의 생존은 `pidAlive`와 `idleMs`(워커가 ~3초마다 checkpoint)로 판단하며, turn 지속시간 제한은 없다. `status: "streaming"`, `startedAt`, `promptChars`, `firstOutputAt`/`firstOutputMs`, `lastEventAt`, `warnings`, `reconnectCount`/`reconnectAttemptCount`는 레거시 foreground/broker 경로에서만 나오며 v3 기본 경로에는 없다.

### Thread 메타데이터

```json
{
  "threadId": "thr_abc123...",
  "model": "gpt-5.6-terra",
  "projectRoot": "/repo",
  "turnCount": 3,
  "lastTurnAt": "2026-04-10T10:25:12.456Z"
}
```

---

## Prefix별 의미

| Prefix | 스킬 | 라운드/Turn 네이밍 |
|:------:|------|:-----------------:|
| `cr_` | code-review | `r{N}` (라운드) |
| `rr_` | red-review | `r{N}` (라운드) |
| `dg_` | delegate | `t{N}` (Turn) |

---

## 세션 현황 표 형식 (sessions)

```
## Running Sessions (N)

| Session | Skill | Model | Elapsed | Chars | Status |
|---------|-------|-------|--------:|------:|--------|
| cr_123456_78 | code-review | gpt-5.6-terra | 45s | 3,200 | running |
| dg_123457_89 | delegate | gpt-5.6-terra | 2m 12s | 8,500 | running ⚠️ |

## Completed Sessions (N)

| Session | Skill | Model | Turns | Last Updated | Status |
|---------|-------|-------|:-----:|--------------|--------|
| cr_123400_12 | code-review | gpt-5.6-terra | 3 | 2026-04-10 09:45 | completed |
| dg_123410_34 | delegate | gpt-5.6-terra | 5 | 2026-04-10 10:15 | cancelled |
```

> **⚠️ 강조**: 2분 이상 실행 중인 세션.

---

## Halt 안내 메시지

취소 성공 후:

```
✅ Session {SID} cancelled.

Partial output (if any): {HOME}/.claude/tmp/{prefix}_{SID}_{last}_output.txt

The thread stays resumable — invoke the same skill again and it will follow up on the
existing thread instead of starting fresh. The runtime resumes the last completed
turn's thread even though this turn was cancelled (no context is lost).
```

---

## Readout 안내 메시지

결과 표시 후:

```
## Session {SID} Result

**Skill**: {skill}
**Model**: {model}
**Turns**: {turn_count}
**Thread ID**: `{threadId}` (internal App Server thread)
**Status**: {status}

---

{output content}
```

---

## 금지 사항

- ❌ 여러 세션을 무차별 중단 (반드시 사용자 선택)
- ❌ `codex-review close` 호출 (readout은 Thread를 유지해야 resume 가능)
- ❌ prefix 무시하고 단일 포맷으로 출력 (skill별 구분 필수)

---

## Linked Skills

<!-- @linked-skills -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/sessions` | 세션 현황 조회 요청 시 | auto | 실행 중/완료 세션 목록 |
| `/halt` | 세션 중단 요청 시 | auto | 실행 중 세션 취소 |
| `/readout` | 완료 세션 결과 조회 요청 시 | auto | Output + thread_id 표시 |

<!-- @/linked-skills -->

---

*Related*: `review-protocol.md`, `codex-delegation.md`
*Last modified*: 2026-04-10

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
code-review, delegate, red-review 등 모든 스킬이 사용하는 세션 파일(`{REVIEW_DIR}/{prefix}_{SID}_*`)을 대상으로 한다.

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: `/sessions`, `/halt`, `/readout` 스킬이 호출되면 아래 절차를 따른다.

### 세션 현황 조회 (sessions)

| Order | Action |
|:-----:|--------|
| 1 | `{REVIEW_DIR}` 디렉토리의 `*_progress.json` + `*_state.json` 파일을 Glob으로 수집 |
| 2 | 각 세션 파일을 Read로 읽어 상태 파싱 |
| 3 | Prefix별로 그룹화하여 표 출력 (`cr_` / `dg_` / `rr_`) |
| 4 | 2분 이상 실행 중인 세션은 시각적으로 강조 |

### 세션 중단 (halt)

| Order | Action |
|:-----:|--------|
| 1 | sessions 절차로 실행 중(`running`) 세션 수집 |
| 2 | 복수 세션이면 **AskUserQuestion**으로 중단 대상 선택 |
| 3 | `codex-review cancel --session {SID} --review-dir {REVIEW_DIR}` 실행 |
| 4 | 부분 출력 파일이 있으면 경로 안내 |

### 결과 조회 (readout)

| Order | Action |
|:-----:|--------|
| 1 | sessions 절차로 완료된(`completed` / `cancelled` / `timeout_partial`) 세션 수집 |
| 2 | 복수 세션이면 **AskUserQuestion**으로 대상 선택 |
| 3 | 해당 세션의 최신 `_output.txt`를 Read로 읽고 표시 |
| 4 | `_state.json`에서 `threadId` 추출하여 "외부 Codex CLI로 이어 쓰기" 안내 |

---

## 파일 포맷

### progress.json (워커가 3초 간격으로 기록)

```json
{
  "status": "running",
  "startedAt": "2026-04-10T10:23:45.123Z",
  "elapsedMs": 45000,
  "charsReceived": 3200,
  "pid": 12345,
  "pidAlive": true
}
```

**status 값**: `initializing` / `queued` / `running` / `completed` / `timeout_partial` / `cancelled` / `crashed` / `failed`

### state.json (Thread 메타데이터)

```json
{
  "threadId": "thr_abc123...",
  "model": "gpt-5.4",
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
| cr_123456_78 | code-review | gpt-5.4 | 45s | 3,200 | running |
| dg_123457_89 | delegate | gpt-5.4 | 2m 12s | 8,500 | running ⚠️ |

## Completed Sessions (N)

| Session | Skill | Model | Turns | Last Updated | Status |
|---------|-------|-------|:-----:|--------------|--------|
| cr_123400_12 | code-review | gpt-5.4 | 3 | 2026-04-10 09:45 | completed |
| dg_123410_34 | delegate | gpt-5.4 | 5 | 2026-04-10 10:15 | cancelled |
```

> **⚠️ 강조**: 2분 이상 실행 중인 세션.

---

## Halt 안내 메시지

취소 성공 후:

```
✅ Session {SID} cancelled.

Partial output (if any): {HOME}/.claude/tmp/{prefix}_{SID}_{last}_output.txt

To resume later, use the thread_id from {prefix}_{SID}_state.json with codex CLI directly.
```

---

## Readout 안내 메시지

결과 표시 후:

```
## Session {SID} Result

**Skill**: {skill}
**Model**: {model}
**Turns**: {turn_count}
**Thread ID**: `{threadId}`
**Status**: {status}

---

{output content}

---

### Resume Externally

To continue this Codex thread from the `codex` CLI:
```bash
codex resume --thread {threadId}
```
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

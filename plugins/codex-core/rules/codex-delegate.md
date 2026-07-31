---
rule_type: workflow
applies_to:
  - "Delegating coding tasks to Codex"
  - "/delegate command"
triggers:
  - event: "codex_delegate"
    description: "사용자가 Codex에게 작업 위임을 요청하거나 /delegate 실행 시"
---

# Codex Delegation Protocol (A+ Pattern)

Codex에게 자율적 작업을 위임하되, 실제 파일 변경은 Claude가 수행하는 협업 워크플로.
모든 모델 호출은 `review-protocol.md`의 실행 규칙을 따른다 (`codex-review` CLI wrapper → App Server).

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: 사용자가 Codex에게 작업을 위임하면 아래 워크플로를 반드시 수행한다.

### 작업 위임 시작 시 (codex_delegate)

| Order | Action |
|:-----:|--------|
| 0 | 세션 초기화 (review-protocol.md의 세션 ID/디렉토리 규칙 준수, prefix = `dg_`) |
| 1 | 작업 범위 + 컨텍스트 수집 (관련 파일, 에러 로그, 재현 스텝) |
| 2 | Turn 1 실행: 초기 프롬프트 전송 (Codex가 최초 변경안 제시) |
| 3 | Codex 응답 검토 → Edit/Write로 변경사항 적용 → 검증 |
| 4 | Turn N 반복: follow-up으로 "적용 결과 + 다음 지시 요청" (A+ 루프) |
| 5 | 완료 판정 후 Thread close + 최종 리포트 |

---

## A+ 패턴 핵심 원칙

| 역할 | 책임 |
|------|------|
| **Codex (두뇌)** | 분석, 근거 추론, 구체적 변경안 제시 (unified diff / JSON / 파일별 수정 지시) |
| **Claude (손)** | 제안 적용 (Edit/Write), 검증 실행 (lint/test/빌드), 결과 요약 후 다음 Turn 프롬프트 구성 |

### 금지 사항

- ❌ Codex에게 "직접 파일을 수정하라"고 지시 (App Server는 read-only)
- ❌ Claude가 Codex 제안을 사용자에게 그대로 전달 (반드시 Claude가 직접 적용)
- ❌ 매 Turn fresh start (Thread 재사용 필수)
- ❌ 전체 컨텍스트 재전송 (follow-up에는 증분만)
- ❌ Codex 판단 없이 Claude가 독자적으로 설계 변경 (Codex가 두뇌 역할 유지)

---

## 작업 범위 결정

### 자동 수집

사용자 요청에서 추출한 키워드 + 아래 소스를 참고하여 컨텍스트를 구성한다:

| 소스 | 추출 방법 |
|------|-----------|
| 사용자 발화 | 파일 경로, 함수명, 에러 메시지, "이런 식으로" 의도 |
| Git 상태 | `git status`, 최근 커밋 (`git log --oneline -10`) |
| 현재 브랜치 diff | `git diff` (필요 시 특정 파일만) |
| 관련 파일 | Grep/Glob로 언급된 심볼 위치 확인 |

### Read-only 모드

사용자가 `--read-only` 플래그를 쓰거나 발화가 순수 질의(예: "왜 X가 Y인지 설명해줘")이면:
- Codex에게 "파일 변경 제안 없이 답변만 반환하라" 지시
- Claude는 적용 단계를 건너뛰고 답변을 사용자에게 표시

### 모델 오버라이드 처리

`$ARGUMENTS`를 파싱하여 `--model <X>` 인자를 확인한다:

| 상황 | 처리 |
|------|------|
| `--model <X>` 명시 | Turn 1 `codex-review start` 호출에 `--model "<X>"` 인자 추가 |
| 미명시 + 일반 위임 | 인자 생략 (CLI가 `CODEX_REVIEW_MODEL` 환경변수 또는 기본값 `gpt-5.6-terra` 사용) |
| 미명시 + `--read-only` | `--default-model "gpt-5.6-luna"` 추가 (`CODEX_REVIEW_MODEL`이 있으면 환경변수가 우선) |

> **follow-up 자동 처리**: `start`에서 지정한 모델은 `dg_{SID}_state.json`에 저장되어
> 후속 `follow-up` 호출에서 자동 재사용된다. follow-up에 `--model`을 다시 명시할 필요는 없다.

### 추론 effort 오버라이드 처리

`$ARGUMENTS`에서 `--effort <level>`을 확인한다. 허용되는 자연어 라우팅 값은
`low`, `medium`, `high`, `xhigh`, `max`, `ultra`이며, 지정된 값은 Turn 1
`codex-review start` 호출에 `--effort "<level>"`로 추가한다. 미지정 시 wrapper
기본값 `high`를 사용한다.

`start`에서 선택한 effort는 세션 상태에 저장되므로 follow-up에 다시 적지 않아도
유지된다. follow-up에 `--effort`를 명시하면 해당 turn부터 새 값으로 변경된다.

---

## Turn 1: 초기 프롬프트

### Step 1: 프롬프트 전달 + codex-review start 실행

`--stdin` heredoc으로 프롬프트를 전달한다 (Write 도구 불필요).
세션 이름은 `dg_{SID}`:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" start --stdin "{HOME_LITERAL}/.claude/tmp/dg_{SID}_t1_prompt.txt" "{HOME_LITERAL}/.claude/tmp/dg_{SID}_t1_output.txt" --session "dg_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp" <<'PROMPT_EOF'
{치환 완료된 프롬프트 전문}
PROMPT_EOF
echo "EXIT_CODE: $?"
```

`$ARGUMENTS`에 `--read-only`가 있으면 위 명령에 `--default-model "gpt-5.6-luna"`를 추가한다. `$ARGUMENTS`에 `--model <X>`도 있으면 `--model "<X>"`를 함께 추가하며 사용자 지정 모델이 내부 기본값보다 우선한다. `$ARGUMENTS`에 `--effort <level>`이 있으면 `--effort "<level>"`도 추가한다 (예: `--review-dir "..." --default-model "gpt-5.6-luna" --model "gpt-5.6-sol" --effort "max" <<'PROMPT_EOF'`).

### Step 2: 폴링

review-protocol.md의 **PHASE 1 Step 2**와 동일 (status → 30초 간격, 묻지 않고 계속 대기, 2분마다 진행 안내, 30분 하드 타임아웃까지).

### Step 3: 결과 수집 및 해석

`dg_{SID}_t1_output.txt` 읽기. Codex 응답은 다음 중 한 형식으로 온다:

| 응답 유형 | 처리 |
|-----------|------|
| **unified diff** | `dg_{SID}_t1_patch.diff`에 저장 후 Edit 도구로 파일별 반영 |
| **JSON 변경안** | `{file, line_start, line_end, replacement}` 배열 → Edit로 순차 적용 |
| **전체 파일** | Write 도구로 파일 덮어쓰기 |
| **질문 되묻기** | AskUserQuestion으로 사용자에게 전달 → 답변 수신 후 Turn 2로 진행 |
| **"완료"/"변경 없음"** | 사용자에게 결과 요약 후 Thread close |

---

## Turn 2+: Follow-up 루프

### Step 1: 적용 결과 수집

이전 Turn에서 Claude가 적용한 내용을 요약한다:

| 항목 | 내용 |
|------|------|
| Applied Changes | 파일 경로 + 실제 반영된 diff |
| Verification | lint/test/빌드 결과 (성공/실패) |
| Observations | 예상과 다른 결과, 에러, 추가로 발견한 문제 |
| Blockers | Codex 판단이 필요한 불확실한 부분 |

### Step 2: 프롬프트 전달 + codex-review follow-up 실행

`--stdin` heredoc으로 follow-up 프롬프트를 전달한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" follow-up --stdin "{HOME_LITERAL}/.claude/tmp/dg_{SID}_t{N}_prompt.txt" "{HOME_LITERAL}/.claude/tmp/dg_{SID}_t{N}_output.txt" --session "dg_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp" <<'PROMPT_EOF'
{치환 완료된 follow-up 프롬프트 전문}
PROMPT_EOF
echo "EXIT_CODE: $?"
```

> **⛔ 금지**: 이전 Turn의 프롬프트/컨텍스트 재전송. Thread가 기억하고 있다.

### Step 3: 폴링 + 결과 처리

Turn 1과 동일. Codex 응답을 해석하여 다음 행동을 결정한다.

### 루프 지속 조건

| 상황 | 행동 |
|------|------|
| Codex가 새 변경안 제시 | Claude가 적용 → Turn N+1 |
| Codex가 "완료" 판정 | Step: 최종 리포트 → close |
| 사용자가 중단 요청 | `cancel` → 부분 결과 표시 → close |
| 동일 제안 2회 이상 반복 (Codex가 막힘) | AskUserQuestion으로 사용자 개입 요청 |
| Turn 수 ≥ 10 | AskUserQuestion으로 계속/종료 확인 (경고: 드물게 발생) |

세션은 최초 `start`의 canonical 프로젝트 루트에 고정한다. 다른 프로젝트에서 같은 SID로 follow-up하지 않으며, `reconnecting` 상태에서는 새 turn을 시작하지 않고 기존 `threadId`/`turnId` 복구를 기다린다.

---

## Delegate Prompt Template (Turn 1)

```
You are Codex working on an engineering task. Claude will apply your changes to files; do not attempt to write files yourself — respond with specific, actionable change proposals.

## Your Role

- You are the **brain**: analyze, reason about root causes, design the fix.
- Claude is the **hands**: applies your proposals with Edit/Write tools, runs tests, reports results.

## Response Format

For each change, respond with ONE of these formats (pick the clearest per change):

### Format A: Unified Diff
```diff
--- a/path/to/file.ext
+++ b/path/to/file.ext
@@ -10,5 +10,8 @@
 context
-old line
+new line
 context
```

### Format B: Structured JSON
```json
[
  {
    "file": "path/to/file.ext",
    "line_start": 42,
    "line_end": 45,
    "replacement": "new code block"
  }
]
```

### Format C: Full File (only when rewriting)
```
FILE: path/to/file.ext
<full file contents>
```

After all changes, add:

**Verification Plan**: commands Claude should run to verify (e.g., `npm test`, `./gradlew build`).

**Done?**: `IN_PROGRESS` (more turns needed) or `DONE` (task complete).

## Task

{TASK_DESCRIPTION}

## Context

### Current Repo State
{REPO_STATE}

### Relevant Files
{RELEVANT_FILES}

### Error / Symptoms (if any)
{ERROR_CONTEXT}

## Project Context

{PROJECT_CONTEXT}

## Mode

{MODE}  — either `write` (propose changes) or `read-only` (answer without proposing changes)
```

### 플레이스홀더

| 플레이스홀더 | 내용 |
|--------------|------|
| `{TASK_DESCRIPTION}` | 사용자가 요청한 작업 내용 |
| `{REPO_STATE}` | `git status` + `git log --oneline -5` |
| `{RELEVANT_FILES}` | 언급된 파일 경로 + 필요 시 전체/부분 내용 |
| `{ERROR_CONTEXT}` | 에러 메시지, 스택 트레이스, 재현 스텝 (있을 때만) |
| `{PROJECT_CONTEXT}` | 프로젝트 CLAUDE.md |
| `{MODE}` | `write` 또는 `read-only` |

---

## Delegate Follow-up Template

```
## Previous Turn Result

### Applied Changes
{APPLIED_CHANGES}

### Verification Output
{VERIFICATION_OUTPUT}

### Observations
{OBSERVATIONS}

### Blockers / Questions
{BLOCKERS}

## Next Step

Based on the applied changes and verification results, decide:
- Propose the next change (same response format as Turn 1)
- Ask a clarifying question (Claude will forward to the user)
- Declare `DONE` if the task is complete
```

---

## 최종 리포트 형식

```
# Delegate Task Report

## 요약
- **작업**: {task description}
- **Turn 수**: {total_turns}
- **모드**: {write / read-only}
- **최종 상태**: {DONE / CANCELLED / BLOCKED}

## 변경 내역

| Turn | 파일 | 요약 |
|------|------|------|
| 1 | path/to/file1.ext | ... |
| 2 | path/to/file2.ext | ... |

## 검증 결과

| 명령 | 결과 |
|------|------|
| `npm test` | ✅ Pass / ❌ Fail |
| `./gradlew build` | ✅ Pass / ❌ Fail |

## Codex Verdict

{마지막 Turn의 Codex 판정}
```

---

## 실행 규칙

### 모델 호출

review-protocol.md의 비동기 실행 규칙을 적용한다:
- `codex-review` CLI wrapper 사용
- 비동기 실행: `start`/`follow-up` → `status` 폴링 → 결과 수집
- Exit code 기반 에러 처리 (review-protocol.md 참조)
- 묻지 않고 계속 대기, 2분마다 진행 안내 (중단은 사용자가 직접 `/codex-core:halt`)

### 파일 네이밍 (Delegate 전용)

| 파일 | 경로 |
|------|------|
| Turn N 프롬프트 | `{REVIEW_DIR}/dg_{SID}_t{N}_prompt.txt` |
| Turn N 출력 | `{REVIEW_DIR}/dg_{SID}_t{N}_output.txt` |
| Turn N 패치 (diff) | `{REVIEW_DIR}/dg_{SID}_t{N}_patch.diff` |
| 히스토리 | `{REVIEW_DIR}/dg_{SID}_history.md` |
| Durable 상태 | `codex-review status --session dg_{SID}` |
| 런타임 journal | `~/.claude/codex-runtime/v3/jobs/` (CLI를 통해 조회) |

> Delegate는 `dg_{SID}_*` 패턴을 사용한다. Turn 번호는 `t{N}` (code review의 `r{N}`과 구분).

### 세션 ID 및 디렉토리

review-protocol.md의 세션 초기화 규칙을 그대로 따른다 (Step A: HOME 리터럴, Step B: SID 생성).

---

## Linked Skills

<!-- @linked-skills -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/delegate` | Codex에게 작업 위임 요청 시 | auto | Delegate 진입점 |

<!-- @/linked-skills -->

---

*Related*: `review-protocol.md`, `codex-delegation.md`, `codex-code-review.md`
*Last modified*: 2026-04-10

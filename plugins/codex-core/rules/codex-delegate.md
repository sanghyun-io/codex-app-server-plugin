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

### 0단계: Transport 결정 (먼저)

작업 위임을 시작하기 전에 **Codex를 어디서 실행할지** 먼저 정한다 (아래 "Transport 결정" 섹션의 절차를 따른다). 결과는 `app-server` 또는 `orca` 둘 중 하나다.

| 결정 | 이어서 따를 절차 |
|------|------------------|
| **app-server** (기본 / Orca 없음 / 명시) | 아래 "작업 위임 시작 시 — App Server 경로" 표 (A+ 루프) |
| **orca** (Orca 실행 중 + 사용자 선택) | "Orca 대화창 경로" 섹션 (A+ 루프 대신 핸드오프) |

### 작업 위임 시작 시 — App Server 경로 (codex_delegate)

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

> 위 A+ 원칙과 금지 사항은 **App Server 경로에만** 적용된다. Orca 대화창 경로(transport=orca)는 사용자가 직접 대화하므로 Claude가 A+ 적용 루프를 돌리지 않는다 (아래 "Orca 대화창 경로" 참조).

---

## Transport 결정 (App Server vs Orca 대화창)

Codex 실행 위치를 아래 순서로 정한다. 최종 후보는 `app-server` 또는 `orca` 둘 중 하나이며, **Orca가 없으면 언제나 `app-server`로 폴백**한다.

### 결정 절차

1. **기본값 읽기** — `~/.claude/codex-review.config.json`의 `transport`를 읽는다 (없으면 `ask`):
   ```bash
   node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}process.stdout.write(c.transport||"ask")'
   ```
2. **이번 호출 오버라이드** — `$ARGUMENTS`에 `--transport <orca|app-server|ask>`가 있으면 그 값이 config보다 우선 (config 파일은 건드리지 않는다).
3. **Orca 가용성 확인** (결정값이 `app-server`가 아닐 때만) — `orca status --json`의 `result.app.running`이 true인지 본다. Orca가 없거나 응답이 없으면 **묻지 않고 `app-server`로 확정**한다.
4. **값별 처리**
   - `app-server` → 아래 App Server 경로(A+ 루프)로 진행.
   - `orca` (+ Orca 실행 중) → "Orca 대화창 경로"로 진행.
   - `ask` (+ Orca 실행 중) → **최초 1회만** AskUserQuestion으로 물어보고, 답을 config에 저장하여 이후에는 다시 묻지 않는다:
     ```bash
     node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}c.transport=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' <orca|app-server>
     ```
     저장한 값의 경로로 이어서 진행한다.

> 기본값을 나중에 바꾸려면 `/codex-core:transport`. 이번 한 번만 다르게 하려면 명령에 `--transport`.

### AskUserQuestion 예시 (`ask` + Orca 실행 중, 최초 1회)

`question`/`header`/`label`/`description`에는 이모지·박스문자 등 비-ASCII 장식 문자를 넣지 않는다 (일반 한글+ASCII만).

```json
{
  "questions": [{
    "question": "Orca가 실행 중입니다. Codex를 어디서 열까요? (이 선택은 기본값으로 저장되어 다음부터는 묻지 않습니다)",
    "header": "Codex 실행 위치",
    "multiSelect": false,
    "options": [
      {"label": "Orca 대화창", "description": "Orca 터미널에 codex를 띄우고 그 창에서 직접 대화 / 이어가기"},
      {"label": "App Server (기존)", "description": "Claude가 결과를 받아 파일에 적용하는 기존 방식"}
    ]
  }]
}
```

---

## Orca 대화창 경로 (transport = orca)

Orca 터미널에 codex를 **사람이 보는 대화창**으로 열고, 첫 프롬프트를 넣은 뒤 **사용자에게 소유권을 넘긴다.** 이 경로에서 Claude는 A+ 적용 루프(결과 파싱 · Edit/Write)를 돌리지 않는다 — 화면이 곧 결과이고, 사용자가 직접 이어간다.

> **실행 파일 결정 (미리 명시 — 정상 흐름에선 `orca-cli` 스킬 로드도 `orca skills get`도 불필요):**
> 아래에서 `ORCA`는 이 실행 파일이다.
> - `ORCA_CLI_COMMAND` 환경변수가 있으면 그 값 (Orca-managed WSL 세션)
> - 그 외 Windows / Orca-managed 터미널: `orca`
> - Linux의 Orca 비-managed 셸: `orca-ide` (bare `orca`는 GNOME 스크린리더라 금지)
>
> 이 경로에 필요한 명령은 아래 절차의 `create` / `wait` / `send` / `read` (+ 이어가기의 `resume` / `close`)가 전부다. **정상 흐름에서는 이 명령들을 그대로 쓰고 전체 가이드를 fetch하지 않는다.** 명령이 `unknown command`나 알 수 없는 플래그로 실패하거나 orca가 업데이트된 정황이면 — **그때만** `orca-cli` 스킬을 로드해(`orca skills get orca-cli`) 버전에 맞는 최신 명령 표면을 확인하고 재시도한다.

### 절차

| Order | Action |
|:-----:|--------|
| 1 | `ORCA status --json` 재확인 (`result.app.running`=false면 즉시 App Server 경로로 폴백) |
| 2 | codex 실행 인자 조립 — 모델은 `--model <model>`, effort는 `-c model_reasoning_effort=<effort>`. 예: `codex --model gpt-5.6-terra -c model_reasoning_effort="high"`. `--read-only`면 모델 기본을 `gpt-5.6-luna`로 |
| 3 | 터미널 생성 — `ORCA terminal create --worktree active --title "codex: <작업 요약>" --command "<조립된 codex 명령>" --json` → 반환된 `terminal.handle` 보관 |
| 4 | TUI 준비 대기 — `ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json`. `blockedReason`이 `codex-update-prompt`면 `ORCA terminal send --terminal <handle> --text "2"`(Skip) 후 다시 wait |
| 5 | 첫 프롬프트 전송 — `ORCA terminal send --terminal <handle> --text "<작업 브리핑>" --enter --json` |
| 6 | 사용자에게 안내(한국어, 쉬운 말) — "Orca에 codex 대화창을 열었어요. 이제 그 창에서 직접 이어서 대화하시면 됩니다." + 필요 시 아래 이어가기 안내 |

### 이어가기 / 다른 worktree로 넘기기 (handoff)

- codex 세션은 종료 후에도 `~/.codex/sessions/.../rollout-*.jsonl`에 남으므로 언제든 재개할 수 있다.
- 같은/다른 worktree의 새 터미널에서 이어받기: `ORCA terminal create --worktree <selector> --command "codex resume --last" --json` (특정 세션은 `codex resume <session-id>`). update-prompt 처리는 위 4단계와 동일.

### 이 경로의 금지 사항

- ❌ Claude가 codex 화면을 스크래핑해 결과를 파일에 적용 (이 경로는 사용자 소유 — A+ 루프 금지)
- ❌ Orca가 없는데 orca 경로 강행 (반드시 App Server 폴백)
- ❌ `--dangerously-bypass-approvals-and-sandbox` 등 승인 우회를 사용자 동의 없이 추가 (codex 기본 승인 정책 유지)

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

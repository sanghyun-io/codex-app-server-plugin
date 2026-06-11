## Codex Review Execution Protocol

Codex를 이용한 리뷰 실행 시 아래 프로토콜을 반드시 따를 것.
이 문서는 `codex-code-review.md`가 공통으로 참조하는 실행 인프라(세션 관리, CLI 호출, 폴링, 결과 처리 골격)를 정의한다.

### Provider 구성

| 모델 | Provider | 호출 방식 |
|------|----------|-----------|
| gpt-5.5 (기본) | OpenAI (App Server) | `codex-review` CLI wrapper (`~/.claude/bin/codex-review.mjs`) |

#### 호출 방식

| 항목 | 설명 |
|------|------|
| 바이너리 | `node {HOME_LITERAL}/.claude/bin/codex-review.mjs` |
| 통신 프로토콜 | Codex App Server (JSON-RPC 2.0 over stdio) |
| Thread 모델 | Stateful — Thread 내에서 follow-up Turn으로 반복 리뷰 가능 |
| 인증 | ChatGPT 관리형 OAuth (`codex login`으로 사전 인증 필요) |
| Fallback | 없음 — 실패 시 즉시 PASS |
| 모델 오버라이드 | `--model <MODEL>` CLI 플래그 또는 `CODEX_REVIEW_MODEL` 환경변수 (기본값: `gpt-5.5`) |
| 타임아웃 오버라이드 | `--timeout <MS>` CLI 플래그 또는 `CODEX_REVIEW_TIMEOUT` 환경변수 (기본값: `1800000` / 30분) |
| 실행 모드 | **비동기** (백그라운드 워커) — `start`/`follow-up`은 즉시 반환, `status`로 폴링 |

> **App Server 사용 이유**:
> - Thread 영속성으로 follow-up 시 diff만 전송 → 토큰 ~52% 절감
> - 이전 리뷰 컨텍스트를 모델이 기억 → 일관된 리뷰 품질
> - stdin 파이프 + 파일 기반으로 프롬프트 전달 → 길이 제한 없음

### 세션 ID 및 파일 규칙

#### 세션 ID 생성 및 디렉토리 준비 (필수)

프로토콜 시작 시 **2단계**로 세션을 초기화한다:

**Step A: `$HOME` 리터럴 경로 확인 (Bash 도구 호출 1회)**

```bash
echo "$HOME"
```

이 결과값(예: `/c/Users/QESG`)을 `{HOME_LITERAL}`로 기억한다.

> **⛔ 왜 필요한가**: Claude Code의 Bash 도구는 **호출마다 독립된 shell 세션**을 생성한다.
> `$HOME` 환경변수가 일부 호출에서 빈 문자열로 확장되는 사례가 확인되었다.
> 따라서 첫 호출에서 리터럴 값을 확인하고, 이후 모든 Bash 호출에서 **리터럴 경로**를 사용한다.

**Step B: 세션 ID 생성 및 디렉토리 준비 (Bash 도구 호출 1회)**

`{HOME_LITERAL}`을 Step A에서 확인한 실제 경로로 치환하여 실행한다:

```bash
SID=$(date +%s)_$$ && REVIEW_DIR="{HOME_LITERAL}/.claude/tmp" && mkdir -p "$REVIEW_DIR" && echo "Review session: $SID / Dir: $REVIEW_DIR"
```

> **⛔ 필수**: 여러 세션이 동시 실행될 때 임시파일 덮어쓰기를 방지하기 위해,
> 모든 출력 파일에 `{SID}`를 반드시 포함한다.
>
> **⛔ Windows 경로 규칙**:
> - Bash/Git Bash: **`{HOME_LITERAL}/.claude/tmp/cr_{SID}_*.txt`** (리터럴 경로 사용)
> - **절대로 `/tmp/`를 사용하지 않는다** (Windows에서 Git Bash의 /tmp/ 경로가 시스템과 불일치)
> - **절대로 Bash 도구에서 `$HOME`을 직접 사용하지 않는다** (확장 실패 가능성)

#### 파일 규칙

> **⛔ 무조건**: **프롬프트와 출력 모두 파일로 저장**한다.
> 파일을 거치지 않고 프롬프트를 인라인으로 전달하거나 결과를 파일 없이 처리하는 것을 금지한다.

**파일이 필요한 이유**:
- Git Bash 파이프 경유 시 한글 인코딩 깨짐 방지
- **동시 세션 간 파일 충돌 방지**
- 프롬프트 이력 보존 (디버깅 및 재실행 용이)

> **`--stdin` 모드**: 프롬프트를 heredoc으로 CLI에 전달하면 CLI가 내부적으로 파일을 작성한다.
> Write 도구 호출이 불필요하므로 **사용자 인가 없이** 프롬프트 파일이 생성된다.

**파일 네이밍 규칙** (코드 리뷰):

| 종류 | 파일 경로 |
|------|-----------|
| Round N 프롬프트 | `{REVIEW_DIR}/cr_{SID}_r{N}_prompt.txt` |
| Round N 출력 | `{REVIEW_DIR}/cr_{SID}_r{N}_output.txt` |
| 리뷰 히스토리 | `{REVIEW_DIR}/cr_{SID}_history.md` |
| Thread 상태 | `{REVIEW_DIR}/cr_{SID}_state.json` |
| Worker 진행 상황 | `{REVIEW_DIR}/cr_{SID}_progress.json` |
| Worker PID | `{REVIEW_DIR}/cr_{SID}_pid` |
| Worker 로그 | `{REVIEW_DIR}/cr_{SID}_worker.log` |

> `{SID}`는 세션 ID, `{REVIEW_DIR}`은 `{HOME_LITERAL}/.claude/tmp`으로 치환한다 (`{HOME_LITERAL}`은 세션 초기화에서 확인한 리터럴 경로).
> 프롬프트 파일은 `--stdin` 플래그를 사용하여 CLI가 직접 작성한다 (Write 도구 불필요).

---

### Engineering Preferences

리뷰 모델에게 공유하는 엔지니어링 기준:

```
Engineering standards for this review:
- DRY: Flag repetition only when it causes real maintenance problems.
- Edge cases: Thorough coverage over speed. Handle more, not fewer.
- Engineering balance: Not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
- Explicit over clever.
- Well-tested: Focus on critical paths and edge cases.
- Report issues only if they represent real problems — "no issue" is a valid finding.
```

---

### PHASE 1: 초기 리뷰 (codex-review start)

`codex-review start` 명령으로 새 Thread를 생성하고 첫 Turn을 전송한다.
프롬프트는 아래 **Code Review Prompt Template**의 플레이스홀더를 치환하여 사용한다.

#### Step 1: 프롬프트 전달 + codex-review start 실행 (단일 Bash 호출)

`--stdin` 플래그를 사용하여 **프롬프트를 heredoc으로 전달**한다.
CLI가 내부적으로 프롬프트 파일을 작성하므로 Write 도구 호출이 필요 없다.

Code Review Prompt Template의 플레이스홀더를 치환한 완료본을 heredoc 본문으로 넣는다.
`{HOME_LITERAL}`은 세션 초기화 Step A에서 확인한 리터럴 경로로 치환한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" start --stdin "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r1_prompt.txt" "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r1_output.txt" --session "cr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp" <<'PROMPT_EOF'
{치환 완료된 프롬프트 전문}
PROMPT_EOF
echo "EXIT_CODE: $?"
```

> **핵심**:
> - `--stdin`으로 프롬프트를 stdin에서 읽어 `<prompt-file>`에 자동 저장 → **Write 도구 인가 불필요**
> - `start` 명령은 **즉시 반환** (exit 0). 실제 Codex 호출은 백그라운드 워커가 처리
> - 워커는 진행 상황을 `cr_{SID}_progress.json`에 3초 간격으로 기록
> - 결과 확인은 **Step 2 (폴링)**으로 진행
> - `--session`과 `--review-dir`는 필수 인자
> - heredoc 종료 후 `echo "EXIT_CODE: $?"`로 exit code 확인
>
> **⛔ `$HOME` 직접 사용 금지**: Bash 도구 호출마다 `$HOME`이 빈 문자열로 확장될 수 있다.
> 반드시 세션 초기화에서 확인한 `{HOME_LITERAL}` 리터럴 경로를 사용한다.

#### Step 2: 진행 상황 폴링 (status)

`start`가 exit 0을 반환하면, **30초 간격**으로 `status` 명령을 호출하여 진행 상황을 확인한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" status --session "cr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"
```

`status` 명령은 JSON을 stdout으로 출력하고, 상태에 따라 exit code를 반환한다:

| Exit Code | 상태 | 처리 |
|:---------:|------|------|
| 0 | `completed` | **Step 3으로 진행** — 출력 파일 읽기 |
| 7 | `running` / `initializing` / `queued` | **30초 후 재폴링** (아래 진행 안내 규칙 참조) |
| 5 | `timeout_partial` | 부분 출력 저장됨 — Step 3으로 진행 (출력 파일 읽기) |
| 8 | `cancelled` | 취소됨 — 부분 출력이 있으면 읽기 |
| 6 | `crashed` / `failed` | 에러 처리 섹션 참조 |
| 1-4 | 기타 에러 | 에러 처리 섹션 참조 |

**status JSON 형식**:
```json
{
  "status": "running",
  "startedAt": "2026-03-23T...",
  "elapsedMs": 45000,
  "charsReceived": 3200,
  "pid": 12345,
  "pidAlive": true
}
```

**진행 안내 규칙**: Codex 요청은 수 분이 걸릴 수 있으므로, **중간에 사용자에게 계속할지 묻지 않고 계속 대기**한다.
대신 진행 상황만 주기적으로 텍스트로 안내한다.

| 항목 | 규칙 |
|------|------|
| 폴링 간격 | **30초** (변함없음 — exit 7이면 계속 재폴링) |
| 진행 안내 주기 | **2분(120초)마다 1회**, 한 줄로 경과 시간과 수신량을 안내 |
| 안내 형식 | `Codex 진행 중 — {elapsed}초 경과, {charsReceived}자 수신` (예: `Codex 진행 중 — 240초 경과, 5,120자 수신`) |
| 종료 조건 | `status`가 exit 0(completed) 또는 exit 5(timeout_partial)를 반환할 때까지 폴링 지속 |
| 하드 타임아웃 | **30분 safety net 유지** — `status`가 exit 5(`timeout_partial`)를 반환하면 부분 출력으로 Step 3 진행 |

> **⛔ AskUserQuestion 금지**: 대기 시간이 길다는 이유만으로 사용자에게 계속/취소/PASS를 묻지 않는다.
> 사용자가 멈추고 싶으면 직접 `/codex-core:halt`(또는 `/codex-core:sessions`로 확인 후 halt)를 호출하거나 세션에 개입한다.
> 이때 partial 출력과 thread state는 보존된다.

> **안내 주기 운용**: 폴링은 30초마다 돌지만, 진행 안내 텍스트는 누적 경과가 **120초의 배수에 도달했을 때만** 1줄 출력한다
> (240초, 360초, 480초 ... 30분까지). 30초 폴링마다 매번 출력하지 않는다.

**취소 명령** (사용자가 직접 중단을 요청했을 때만):
```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" cancel --session "cr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"
```

#### Step 3: 결과 수집

status exit 0 (completed) 반환 후, Read 도구로 출력 파일 읽기:

`{HOME}/.claude/tmp/cr_{SID}_r1_output.txt`

exit code가 에러인 경우 → 에러 처리 섹션 참조.

---

### PHASE 2: Follow-up 리뷰 (codex-review follow-up)

Round 2+ 증분 리뷰 시 사용한다.
**동일 Thread를 재사용**하므로 모델이 이전 리뷰 컨텍스트를 기억한다.

#### 언제 실행하는가

- Round 1 완료 후 사용자가 이슈를 수정하고 Round 2+로 진입할 때
- Round N에서 다음 Round N+1로 진행할 때

#### Step 1: 프롬프트 전달 + codex-review follow-up 실행 (단일 Bash 호출)

PHASE 1과 동일하게 `--stdin` heredoc으로 프롬프트를 전달한다.

**Follow-up 컨텐츠 구성 규칙**:

| 항목 | 내용 | 비고 |
|------|------|------|
| `{DIFF_CONTENT}` | `git diff $PREV_COMMIT..$CURRENT_COMMIT` 증분 | 전체 diff 재전송 **금지** |
| `{REVIEW_HISTORY}` | 이전 라운드 이슈/결정 누적 | "DO NOT re-flag deferred" 지시 포함 |
| `{ROUND_NUMBER}` | 현재 라운드 번호 | |
| `{ROUND_DIRECTIVE}` | 후반 라운드 지시 (Round 3+) | Late round focus 지시 |

> **⛔ 전체 diff 재전송 금지**: follow-up에서는 증분 diff만 전송한다.
> Thread가 이전 Turn의 전체 컨텍스트를 기억하고 있으므로, 이번 라운드에서 변경된 부분만 보내면 된다.

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" follow-up --stdin "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r{N}_prompt.txt" "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r{N}_output.txt" --session "cr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp" <<'PROMPT_EOF'
{치환 완료된 follow-up 프롬프트 전문}
PROMPT_EOF
echo "EXIT_CODE: $?"
```

> **동작 원리**: `follow-up --stdin`은 stdin에서 프롬프트를 읽어 파일에 저장한 뒤,
> state 파일에서 threadId를 읽어 기존 Thread를 resume하고,
> 백그라운드 워커로 새 Turn을 생성한다. **즉시 반환** (exit 0).

#### Step 2: 진행 상황 폴링 (status)

PHASE 1 Step 2와 **동일한 폴링 패턴**을 사용한다:
- 30초 간격으로 `status` 명령 호출
- 묻지 않고 계속 대기, 2분(120초)마다 진행 상황만 1줄 안내
- 완료(exit 0) 또는 30분 하드 타임아웃(exit 5)까지 폴링 지속 → 출력 파일 읽기

#### Step 3: 결과 수집

Read 도구로 `{HOME}/.claude/tmp/cr_{SID}_r{N}_output.txt` 읽기.

exit code 4 (resume fail) 발생 시:
- Thread가 손상되었을 수 있음
- `codex-review start`로 새 Thread 생성 후 전체 diff로 재시작

---

### PHASE 3: 결과 처리 + 사용자 상호작용

PHASE 1 또는 PHASE 2가 완료된 후 Claude가 직접 결과를 종합한다.

#### Step 1: 이슈 통합

이슈를 번호를 재부여한다:
- 심각도는 가장 높은 값 채택
- 영역(Area 1-4)별로 그룹화

#### Step 2: HIGH 이슈 사용자 확인

HIGH 심각도 이슈에 대해 **AskUserQuestion**으로 사용자 결정을 받는다:

```json
{
  "questions": [{
    "question": "[#{N}] {이슈 제목}\n\n{문제 설명}\n\n추천: ({LETTER}) {추천 내용}",
    "header": "Issue #N",
    "multiSelect": false,
    "options": [
      {"label": "#N-(A) {추천 옵션}", "description": "Effort: X, Risk: X, Impact: X"},
      {"label": "#N-(B) {대안}", "description": "Effort: X, Risk: X, Impact: X"},
      {"label": "#N-Skip", "description": "이 이슈를 인지하고 현재 상태로 진행"}
    ]
  }]
}
```

> **규칙**: HIGH 이슈에는 "Do nothing" 옵션을 제공하지 않는다. "Skip"은 인지 후 진행.
> MED/LOW 이슈는 리포트에 포함하되 사용자 확인 없이 권고사항으로 기록한다.

#### Step 3: 최종 리포트

최종 리포트의 구체적 형식은 `codex-code-review.md`의 **최종 리포트 형식** 섹션을 따른다.

#### Step 4: 세션 종료 (Thread Close)

리뷰가 최종 완료된 후 (수렴 조건 만족 또는 사용자가 명시적으로 종료 요청 시) Thread를 정리한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" close --session "cr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"
```

> **주의**: close는 최종 완료 시에만 실행한다. Round N → Round N+1 반복 중에는 Thread를 유지한다.
> close 실패는 무시해도 된다 (Thread 파일은 자동 만료됨).

---

### 증분 Diff 추출

#### Diff 추출 규칙

| 라운드 | 명령 | 설명 |
|--------|------|------|
| Round 1 | `git diff $BASE_COMMIT..$CURRENT_COMMIT` | 전체 diff |
| Round N (N>=2) | `git diff $PREV_COMMIT..$CURRENT_COMMIT` | 증분 diff (이전 라운드 이후 변경분만) |

#### Commit 기록

각 라운드 시작 시:
```bash
PREV_COMMIT=$CURRENT_COMMIT          # 이전 라운드의 HEAD
CURRENT_COMMIT=$(git rev-parse HEAD)  # 현재 HEAD
```

Round 1에서는:
```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
BASE_COMMIT=$(git merge-base origin/$DEFAULT_BRANCH HEAD)
CURRENT_COMMIT=$(git rev-parse HEAD)
```

#### 빈 Diff 처리

증분 diff가 비어 있는 경우 (Round 2+):
- AskUserQuestion으로 "변경사항이 없습니다. 리뷰를 종료할까요?" 확인
- "종료" 선택 시 최종 리포트 생성
- "계속" 선택 시 사용자가 수정할 때까지 대기

#### Diff 크기 제한

diff가 30,000자를 초과하는 경우:
1. 파일 경로 목록 + 통계(`--stat`)를 먼저 전달
2. 파일별로 분할하여 순차 리뷰 (각 호출에 히스토리 포함)

---

### 리뷰 히스토리

#### 히스토리 파일

파일: `{REVIEW_DIR}/cr_{SID}_history.md`

각 라운드 완료 시 append 방식으로 업데이트한다.

#### 히스토리 형식

```markdown
## Round {N} Summary

### Issues
| # | Severity | Area | Title | Status |
|---|----------|------|-------|--------|
| 1 | HIGH | Area 1 | ... | fixed / deferred / wontfix |
| 2 | MED | Area 2 | ... | fixed |

### Deferred Issues
- #2: {한줄 요약} — 사유: {사용자 결정 사유}

### User Decisions
- #1: (A) 채택 — {설명}
- #3: Skip — {사유}
```

#### 프롬프트 삽입 규칙

Round 2+ 프롬프트의 `{REVIEW_HISTORY}` 플레이스홀더에 히스토리를 삽입한다:

1. 이전 라운드의 이슈 목록 (번호, 심각도, 한줄 요약, 해결 여부)
2. Deferred 목록 + **"DO NOT re-flag these deferred issues"** 지시
3. 전체 히스토리를 누적 (라운드 수 제한 없음)

#### 히스토리 누적 예시

```
Previous review history (DO NOT re-flag deferred issues):

Round 1: 5 issues found (3 fixed, 1 deferred, 1 wontfix)
- #1 [HIGH] Area 1: Missing input validation → FIXED
- #2 [HIGH] Area 2: SQL injection risk → FIXED
- #3 [MED] Area 3: No unit tests for edge case → FIXED
- #4 [MED] Area 1: Tight coupling → DEFERRED (user accepted)
- #5 [LOW] Area 4: Suboptimal query → WONTFIX

DO NOT re-flag: #4 (tight coupling), #5 (suboptimal query)
```

---

### Opus 교차검증 (선택사항)

#### 트리거

사용자가 명시적으로 요청한 경우에만 실행:
- `/code-review --with-opus`
- 리뷰 도중 "Opus 검증" 요청
- Codex APPROVE 후 "최종 확인" 요청

#### 실행 방법

Task tool의 `oracle` agent (Opus 모델)로 호출한다:

```
프롬프트 구성:
- Codex가 리뷰한 diff 전문
- Codex의 이슈 목록 요약
- "Codex가 놓친 이슈를 찾아라. 특히 다음에 집중:
  1. 보안 취약점 (injection, auth bypass, data leak)
  2. 동시성/레이스 컨디션
  3. 에러 핸들링 빈틈
  4. Codex가 APPROVE했지만 남아있는 아키텍처 문제"
```

#### 결과 처리

- Opus 이슈가 있으면 최종 리포트에 별도 섹션으로 추가
- Opus 이슈의 심각도가 HIGH인 경우 AskUserQuestion으로 사용자 결정

#### 실패 처리

| 상황 | 처리 |
|------|------|
| oracle agent 실패 | Codex 결과만으로 진행, 리포트에 "Opus: SKIP (사유)" 명시 |
| Opus가 이슈 0개 | "Opus 교차검증: 추가 이슈 없음" 명시 |

---

### Code Review Prompt Template

```
Review the following code changes critically as a senior engineer.

## Engineering Standards
- DRY: Flag repetition only when it causes real maintenance problems.
- Edge cases: Thorough coverage over speed. Handle more, not fewer.
- Engineering balance: Not under-engineered (fragile) nor over-engineered (unnecessary complexity).
- Explicit over clever.
- Well-tested: Focus on critical paths and edge cases.
- Report issues only if they represent real problems — "no issue" is a valid finding.

## Review Guidelines
- Report only real issues — if an area has no problems, report none.
- Prioritize by actual impact. Report every real issue you find.

## Round: {ROUND_NUMBER}

{ROUND_DIRECTIVE}

## Review History

{REVIEW_HISTORY}

## Review Areas

### Area 1: Architecture & Design
- System design and component boundaries
- Dependency graph and coupling concerns
- Data flow patterns and potential bottlenecks
- Security architecture (auth, data access, API boundaries)

### Area 2: Implementation Quality
- Code correctness and logical errors
- DRY violations — only when it causes real maintenance problems
- Error handling patterns and missing edge cases
- Technical debt introduced

### Area 3: Test Strategy
- Test coverage for changed code
- Missing edge case tests
- Untested failure modes and error paths

### Area 4: Performance & Scalability
- N+1 queries and database access patterns
- Memory-usage concerns
- Slow or high-complexity code paths

## Output Format

For EACH issue found, use this exact format:

### [#N] [HIGH/MED/LOW] [Area X] Issue title
**File**: `path/to/file.py:LINE`
**Problem**:
- **What**: What is wrong.
- **Why**: Root cause — why this is a problem.
- **Impact**: Actual harm or risk if left unaddressed.

**Options**:
- **(A) {recommended action}**: Description. Effort: X. Risk: X. Impact: X.
- **(B) {alternative}**: Description. Effort: X. Risk: X. Impact: X.
- **(C) Do nothing**: Rationale. (Only if severity != HIGH)

**Recommendation**: (A/B/C) — Reasoning mapped to engineering standards above.

---

After all issues, provide:

[VERDICT] - APPROVE / REVISE / REJECT with summary reasoning.

## Code Changes to Review:

{DIFF_CONTENT}

## Project Context:

{PROJECT_CONTEXT}
```

---

### 실행 규칙

#### codex-review Exit Code 처리

`codex-review.mjs` v2는 다음 exit code를 반환한다:

**`start` / `follow-up` 명령** (비동기 — 즉시 반환):

| Exit Code | 의미 | 처리 |
|:---------:|------|------|
| 0 | 워커 spawn 성공 | `status`로 폴링 시작 |
| 4 | Thread resume 실패 | `start`로 새 Thread 생성 후 재시도 |
| 6 | 프로세스 오류 (프롬프트 파일 없음 등) | 1회 재시도 후 PASS |

**`status` 명령** (폴링):

| Exit Code | 의미 | 처리 |
|:---------:|------|------|
| 0 | 완료 (`completed`) | 출력 파일 읽기 → PHASE 3 진행 |
| 7 | 실행 중 (`running` / `initializing` / `queued`) | 30초 후 재폴링 (묻지 않고 계속 대기, 2분마다 진행 안내) |
| 5 | 타임아웃 (`timeout_partial`, 30분 safety net) | 부분 출력 읽기 → PHASE 3 진행 |
| 8 | 취소됨 (`cancelled`) | 부분 출력이 있으면 읽기 |
| 1 | codex 바이너리 없음 | 즉시 PASS |
| 2 | 인증 실패 | 즉시 PASS — 사용자에게 `codex login` 안내 |
| 3 | Rate limit | 즉시 PASS |
| 6 | 워커 crash / 프로세스 오류 | 1회 재시도 후 PASS |

**`cancel` 명령**:

| Exit Code | 의미 | 처리 |
|:---------:|------|------|
| 0 | 취소 완료 | 부분 출력 파일이 있으면 읽기 |

#### 에러 처리 흐름 (비동기)

```
codex-review start → exit 0 (워커 시작됨)
  │
  ├─ status 폴링 루프 (30초 간격)
  │   ├─ exit 7 → 실행 중 → 묻지 않고 계속 대기 (2분마다 진행 안내, 30분 하드 타임아웃까지)
  │   ├─ exit 0 → 완료 → 출력 파일 읽기 → PHASE 3
  │   ├─ exit 5 → 타임아웃 → 부분 출력 읽기 → PHASE 3
  │   ├─ exit 8 → 취소됨 → 부분 출력 있으면 읽기
  │   ├─ exit 1 → PASS (codex 미설치)
  │   ├─ exit 2 → PASS (인증 실패)
  │   ├─ exit 3 → PASS (rate limit)
  │   └─ exit 6 → PASS (워커 crash)
  │
  ├─ 사용자 "취소" 선택 시
  │   └─ codex-review cancel → 부분 출력 사용 또는 PASS
  │
  └─ start 자체 에러 시
      ├─ exit 4 → start로 재시도 (Thread 손상)
      └─ exit 6 → 1회 재시도 → 재실패 시 PASS
```

> **PASS 의미**: 검증을 건너뛰고 다음 단계로 진행한다.
> 리포트에 "Codex: ⏭️ PASS (사유: {exit code 설명})" 형태로 기록한다.

#### 기타

- 모델이 PASS되면 종합본 심사 모델 목록에 사유와 함께 명시
- Phase 순서는 절대 건너뛰거나 병합하지 말 것
- 최종 종합본은 반드시 한국어로 작성
- HIGH 이슈는 반드시 AskUserQuestion으로 사용자 결정을 받을 것
- MED/LOW 이슈는 권고사항으로 리포트에 포함 (사용자 확인 불필요)

---

*Last modified*: 2026-04-10

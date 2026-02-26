## Plan Review Protocol (GPT-5.3 Codex)

플랜 검증 요청 시 아래 프로토콜을 반드시 따를 것.

### Provider 구성

| 모델 | Provider | 호출 방식 |
|------|----------|-----------|
| GPT-5.3 Codex | OpenAI (App Server) | `codex-review` CLI wrapper (`~/.claude/bin/codex-review.mjs`) |

#### 호출 방식

| 항목 | 설명 |
|------|------|
| 바이너리 | `node {HOME_LITERAL}/.claude/bin/codex-review.mjs` |
| 통신 프로토콜 | Codex App Server (JSON-RPC 2.0 over stdio) |
| Thread 모델 | Stateful — Thread 내에서 follow-up Turn으로 반복 리뷰 가능 |
| 인증 | ChatGPT 관리형 OAuth (`codex login`으로 사전 인증 필요) |
| Fallback | 없음 — 실패 시 즉시 PASS |

> **App Server 사용 이유**:
> - Thread 영속성으로 follow-up 시 diff만 전송 → 토큰 ~52% 절감
> - 이전 리뷰 컨텍스트를 모델이 기억 → 일관된 리뷰 품질
> - stdin 파이프 + 파일 기반으로 프롬프트 전달 → 길이 제한 없음

### 세션 ID 및 파일 규칙

#### 세션 ID 생성 및 디렉토리 준비 (필수)

프로토콜 시작 시 (Phase 0 자동 감지 이전) **2단계**로 세션을 초기화한다:

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
> - Write 도구: `{HOME}/.claude/tmp/review_{SID}_*.txt` (절대 경로, `{HOME}`은 런타임에 해석)
> - Bash/Git Bash: **`{HOME_LITERAL}/.claude/tmp/review_{SID}_*.txt`** (리터럴 경로 사용)
> - **절대로 `/tmp/`를 사용하지 않는다** (Windows에서 Write 도구와 Git Bash의 /tmp/ 경로가 불일치)
> - **절대로 Bash 도구에서 `$HOME`을 직접 사용하지 않는다** (확장 실패 가능성)

#### 파일 규칙

> **⛔ 무조건**: **프롬프트와 출력 모두 파일로 저장**한다.
> 파일을 거치지 않고 프롬프트를 인라인으로 전달하거나 결과를 파일 없이 처리하는 것을 금지한다.

**파일이 필요한 이유**:
- Git Bash 파이프 경유 시 한글 인코딩 깨짐 방지
- Bash 도구 30000자 truncation 방지
- **동시 세션 간 파일 충돌 방지**
- 프롬프트 이력 보존 (디버깅 및 재실행 용이)

**파일 네이밍 규칙**:

**Plan 검증용** (`codex-plan-validation.md`):

| Phase | 종류 | 파일 경로 |
|-------|------|-----------|
| Phase 1 | 프롬프트 입력 | `{REVIEW_DIR}/review_{SID}_p1_prompt.txt` |
| Phase 1 | 모델 출력 | `{REVIEW_DIR}/review_{SID}_p1_output.txt` |
| Phase 1.5 | follow-up 프롬프트 | `{REVIEW_DIR}/review_{SID}_fu{N}_prompt.txt` |
| Phase 1.5 | follow-up 출력 | `{REVIEW_DIR}/review_{SID}_fu{N}_output.txt` |
| Thread | 상태 파일 | `{REVIEW_DIR}/review_{SID}_state.json` |

**코드 리뷰용** (`codex-code-review.md`):

| 종류 | 파일 경로 |
|------|-----------|
| Round N 프롬프트 | `{REVIEW_DIR}/cr_{SID}_r{N}_prompt.txt` |
| Round N 출력 | `{REVIEW_DIR}/cr_{SID}_r{N}_output.txt` |
| 리뷰 히스토리 | `{REVIEW_DIR}/cr_{SID}_history.md` |
| Thread 상태 | `{REVIEW_DIR}/cr_{SID}_state.json` |

> `{SID}`는 세션 ID, `{REVIEW_DIR}`은 `{HOME_LITERAL}/.claude/tmp`으로 치환한다 (`{HOME_LITERAL}`은 세션 초기화에서 확인한 리터럴 경로).
> Write 도구 사용 시에는 `{HOME}/.claude/tmp/review_{SID}_*.txt` 형태의 절대 경로를 사용한다.

---

### PHASE 0: 리뷰 모드 자동 감지

Phase 1 실행 전, **사용자에게 묻지 않고** 아래 기준으로 자동 판단한다.

#### 자동 감지 기준

| 조건 | 결과 |
|------|------|
| 태스크 수 ≥ 5 | **BIG CHANGE** |
| 3개 이상 레이어/모듈 변경 (예: entity + service + controller + test ...) | **BIG CHANGE** |
| 신규 아키텍처 도입 또는 전체 흐름 변경 | **BIG CHANGE** |
| 그 외 (소규모 버그픽스, 단순 기능 추가 등) | **SMALL CHANGE** |

> **오버라이드**: 사용자가 프롬프트에서 "BIG CHANGE로" 또는 "SMALL CHANGE로"라고 명시한 경우 해당 값을 사용한다.

감지된 결과를 `{REVIEW_MODE}`로 Phase 1 프롬프트에 전달한다.
리뷰 시작 시 감지 결과를 한 줄로 출력한다 (예: `리뷰 모드: BIG CHANGE (태스크 7개 감지)`).

---

### Engineering Preferences

리뷰 모델에게 공유하는 엔지니어링 기준:

```
Engineering standards for this review:
- DRY: Flag repetition aggressively.
- Edge cases: Thorough coverage over speed. Handle more, not fewer.
- Engineering balance: Not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
- Explicit over clever.
- Well-tested: Rather have too many tests than too few.
```

---

### Review Prompt Template (Phase 1)

아래 프롬프트를 GPT-5.3에게 전달한다.
`{REVIEW_MODE}`, `{PLAN_CONTENT}`, `{PROJECT_CONTEXT}` 를 치환한다.

```
Review the following implementation plan critically as a senior engineer.

## Engineering Standards
- DRY: Flag repetition aggressively.
- Edge cases: Thorough coverage over speed. Handle more, not fewer.
- Engineering balance: Not under-engineered (fragile) nor over-engineered (unnecessary complexity).
- Explicit over clever.
- Well-tested: Rather have too many tests than too few.

## Review Mode: {REVIEW_MODE}
- If BIG CHANGE: Find up to 4 top issues per review area (max 16 total).
- If SMALL CHANGE: Find the single most critical issue per review area (max 4 total).

## Review Areas

### Area 1: Architecture & Design
- System design and component boundaries
- Dependency graph and coupling concerns
- Data flow patterns and potential bottlenecks
- Scaling characteristics and single points of failure
- Security architecture (auth, data access, API boundaries)

### Area 2: Implementation Quality
- Plan completeness and logical structure
- DRY violations — flag aggressively
- Error handling patterns and missing edge cases (call out explicitly)
- Technical debt hotspots
- Over-engineered or under-engineered areas

### Area 3: Test Strategy
- Test coverage gaps (unit, integration, e2e)
- Test quality and assertion strength considerations
- Missing edge case coverage — be thorough
- Untested failure modes and error paths

### Area 4: Performance & Scalability
- N+1 queries and database access patterns
- Memory-usage concerns
- Caching opportunities
- Slow or high-complexity code paths

## Output Format

For EACH issue found, use this exact format:

### [#N] [HIGH/MED/LOW] [Area X] Issue title
**Problem**: Concrete description of the issue.

**Options**:
- **(A) {recommended action}**: Description. Effort: X. Risk: X. Impact: X.
- **(B) {alternative}**: Description. Effort: X. Risk: X. Impact: X.
- **(C) Do nothing**: Rationale. (Only if severity != HIGH)

**Recommendation**: (A/B/C) — Reasoning mapped to engineering standards above.

---

After all issues, provide:

[VERDICT] - APPROVE / REVISE / REJECT with summary reasoning.

## Plan to Review:

{PLAN_CONTENT}

## Project Context:

{PROJECT_CONTEXT}
```

---

### Follow-up Review Prompt Template (Phase 1.5)

NEEDS_REVISION 후 수정된 Plan을 재검증할 때 사용한다.
동일 Thread 내에서 follow-up Turn으로 전송하므로 모델이 이전 리뷰 컨텍스트를 기억한다.

```
I've made changes to address issues from the previous review.

## Issues Addressed
{ADDRESSED_ISSUES}

## Issues NOT Addressed (user decision)
{SKIPPED_ISSUES}

## Changes Made (diff)
{PLAN_DIFF}

## Re-review Instructions
1. Verify that each addressed issue is properly fixed
2. Check if the fixes introduced new issues
3. Do NOT re-report previously skipped issues
4. Focus review on changed areas only
5. Use the same output format as the initial review
6. Provide updated [VERDICT]: APPROVE / REVISE / REJECT
```

**플레이스홀더 설명**:

| Placeholder | Source | 설명 |
|-------------|--------|------|
| `{ADDRESSED_ISSUES}` | Phase 2 사용자 결정 | 수정하기로 한 이슈 목록 (번호, 제목, 선택 옵션) |
| `{SKIPPED_ISSUES}` | Phase 2 사용자 결정 | Skip/Deferred한 이슈 목록 + 사유 |
| `{PLAN_DIFF}` | Plan 수정 전후 diff | 변경된 부분만 포함 (전체 Plan 재전송 금지) |

---

### PHASE 1: 초기 리뷰 (codex-review start)

GPT-5.3에게 플랜을 전달한다.
위 **Review Prompt Template**의 `{REVIEW_MODE}`, `{PLAN_CONTENT}`, `{PROJECT_CONTEXT}`를 치환하여 전달한다.

#### Step 1: 프롬프트 파일 생성 (필수)

**반드시** Write 도구로 프롬프트를 파일에 저장한다:

- 파일 경로: `{REVIEW_DIR}/review_{SID}_p1_prompt.txt`
  - Write 도구: `{HOME}/.claude/tmp/review_{SID}_p1_prompt.txt`
- 내용: `{REVIEW_PROMPT_P1}` (플레이스홀더 치환 완료본)

> **⛔ 필수**: 이 단계를 건너뛰고 프롬프트를 인라인으로 전달하는 것을 금지한다.

#### Step 2: codex-review start 실행

`codex-review.mjs`의 `start` 명령으로 새 Thread를 생성하고 초기 리뷰를 실행한다.
`{HOME_LITERAL}`은 세션 초기화 Step A에서 확인한 리터럴 경로로 치환한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" start "{HOME_LITERAL}/.claude/tmp/review_{SID}_p1_prompt.txt" "{HOME_LITERAL}/.claude/tmp/review_{SID}_p1_output.txt" --session "review_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"; echo "EXIT_CODE: $?"
```

> **핵심**:
> - 프롬프트 파일과 출력 파일을 **positional 인자**로 전달 (stdin/stdout 파이프 사용하지 않음)
> - wrapper가 직접 파일을 읽고 쓰므로 인코딩 문제 없음
> - `--session`과 `--review-dir`는 필수 인자
> - `; echo "EXIT_CODE: $?"`로 exit code 확인 (반드시 `;`로 분리)
>
> **⛔ `$HOME` 직접 사용 금지**: Bash 도구 호출마다 `$HOME`이 빈 문자열로 확장될 수 있다.
> 반드시 세션 초기화에서 확인한 `{HOME_LITERAL}` 리터럴 경로를 사용한다.

#### Step 3: 결과 수집

Read 도구로 `{HOME}/.claude/tmp/review_{SID}_p1_output.txt` 읽기.

exit code가 0이 아닌 경우 → 에러 처리 섹션 참조.

---

### PHASE 1.5: Follow-up 리뷰 (codex-review follow-up)

NEEDS_REVISION 후 Plan을 수정하고 재검증할 때 사용한다.
**동일 Thread를 재사용**하므로 모델이 이전 리뷰 컨텍스트를 기억한다.

#### 언제 실행하는가

- Phase 2에서 NEEDS_REVISION 판정
- 사용자가 "수정 후 재검증" 선택
- Plan 수정 완료 후

#### Step 1: Follow-up 프롬프트 파일 생성

Write 도구로 follow-up 프롬프트를 파일에 저장한다:

- 파일 경로: `{REVIEW_DIR}/review_{SID}_fu{N}_prompt.txt` (N = follow-up 회차, 1부터)
  - Write 도구: `{HOME}/.claude/tmp/review_{SID}_fu{N}_prompt.txt`
- 내용: **Follow-up Review Prompt Template**의 플레이스홀더를 치환한 완료본

**Follow-up 컨텐츠 구성 규칙**:

| 항목 | 내용 | 비고 |
|------|------|------|
| `{ADDRESSED_ISSUES}` | Phase 2에서 사용자가 (A)/(B)를 선택한 이슈 목록 | 번호 + 제목 + 선택 옵션 |
| `{SKIPPED_ISSUES}` | Skip/Deferred한 이슈 목록 | "DO NOT re-report" 지시 포함 |
| `{PLAN_DIFF}` | 수정된 Plan의 변경 부분만 | 전체 Plan 재전송 **금지** |

> **⛔ 전체 Plan 재전송 금지**: follow-up에서는 diff만 전송한다.
> Thread가 이전 Turn의 전체 Plan을 기억하고 있으므로, 변경된 부분만 보내면 된다.

#### Step 2: codex-review follow-up 실행

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" follow-up "{HOME_LITERAL}/.claude/tmp/review_{SID}_fu{N}_prompt.txt" "{HOME_LITERAL}/.claude/tmp/review_{SID}_fu{N}_output.txt" --session "review_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"; echo "EXIT_CODE: $?"
```

> **동작 원리**: `follow-up` 명령은 state 파일에서 threadId를 읽어 기존 Thread를 resume한 뒤,
> 새 Turn을 생성하여 follow-up 프롬프트를 전달한다.

#### Step 3: 결과 수집

Read 도구로 `{HOME}/.claude/tmp/review_{SID}_fu{N}_output.txt` 읽기.

exit code 4 (resume fail) 발생 시:
- Thread가 손상되었을 수 있음
- `codex-review start`로 새 Thread 생성 후 전체 Plan으로 재시작

---

### PHASE 2: 종합본 생성 + 사용자 상호작용

Phase 1 (또는 Phase 1.5) 이 완료된 후 Claude가 직접 결과를 종합한다.

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
      {"label": "#N-Skip", "description": "이 이슈를 인지하고 현재 Plan으로 진행"}
    ]
  }]
}
```

> **규칙**: HIGH 이슈에는 "Do nothing" 옵션을 제공하지 않는다. "Skip"은 인지 후 진행.
> MED/LOW 이슈는 리포트에 포함하되 사용자 확인 없이 권고사항으로 기록한다.

#### Step 3: 최종 리포트

반드시 아래 형식으로 한국어 최종 리포트를 작성한다:

```
# Plan Review Report

## 리뷰 모드
{BIG CHANGE / SMALL CHANGE}

## 심사 모델
- GPT-5.3 Codex ✅ / ⏭️ PASS (사유)

---

## 이슈 총괄

| # | 심각도 | 영역 | 이슈 | 사용자 결정 |
|---|--------|------|------|-------------|
| 1 | HIGH | Area 1 | ... | (A) 채택 |
| 2 | MED | Area 3 | ... | 권고 |
| ... | ... | ... | ... | ... |

---

## Area 1: Architecture & Design

### [#1] [HIGH] 이슈 제목
- **문제**: 구체적 설명
- **선택된 옵션**: (A) — 사용자 결정
- **적용 방법**: 구체적 수정 가이드

### [#2] ...

## Area 2: Implementation Quality
...

## Area 3: Test Strategy
...

## Area 4: Performance & Scalability
...

---

## 최종 Verdict

| 모델 | Phase 1 |
|---|---|
| GPT-5.3 | APPROVE/REVISE/REJECT |
| **종합** | **APPROVE / REVISE / REJECT** |

---

## 수정 적용 계획 (사용자 결정 기반)

| 우선순위 | # | 선택 옵션 | 적용 내용 |
|:--------:|---|-----------|-----------|
| 1 | #1 | (A) | ... |
| 2 | #2 | 권고 | ... |
```

#### Step 4: 세션 종료 (Thread Close)

리뷰가 최종 완료된 후 (PASS 또는 사용자가 "현재 상태로 진행" 선택 시) Thread를 정리한다:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" close --session "review_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp"
```

> **주의**: close는 최종 완료 시에만 실행한다. NEEDS_REVISION → follow-up 반복 중에는 Thread를 유지한다.
> close 실패는 무시해도 된다 (Thread 파일은 자동 만료됨).

---

### 증분 Diff 추출 (코드 리뷰 전용)

> 이 섹션은 `codex-code-review.md`에서만 사용한다. Plan 검증에서는 사용하지 않는다.

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

### 리뷰 히스토리 (코드 리뷰 전용)

> 이 섹션은 `codex-code-review.md`에서만 사용한다. Plan 검증에서는 사용하지 않는다.

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
3. **최대 2000자**로 제한 (초과 시 가장 오래된 라운드부터 요약 축소)

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

### Opus 교차검증 (코드 리뷰 전용, 선택사항)

> 이 섹션은 `codex-code-review.md`에서만 사용한다. Plan 검증에서는 사용하지 않는다.

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

### Code Review Prompt Template (코드 리뷰 전용)

> Plan 검증은 위의 **Review Prompt Template (Phase 1)**을 사용한다.
> 코드 리뷰는 아래 템플릿을 사용한다.

```
Review the following code changes critically as a senior engineer.

## Engineering Standards
- DRY: Flag repetition aggressively.
- Edge cases: Thorough coverage over speed. Handle more, not fewer.
- Engineering balance: Not under-engineered (fragile) nor over-engineered (unnecessary complexity).
- Explicit over clever.
- Well-tested: Rather have too many tests than too few.

## Review Mode: {REVIEW_MODE}
- If BIG CHANGE: Find up to 4 top issues per review area (max 16 total).
- If SMALL CHANGE: Find the single most critical issue per review area (max 4 total).

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
- DRY violations — flag aggressively
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
**Problem**: Concrete description of the issue.

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

`codex-review.mjs`는 다음 exit code를 반환한다:

| Exit Code | 의미 | 처리 |
|:---------:|------|------|
| 0 | 성공 | 정상 진행 — 출력 파일 읽기 |
| 1 | codex 바이너리 없음 | 즉시 PASS (검증 종료) |
| 2 | 인증 실패 | 즉시 PASS — 사용자에게 `codex login` 안내 |
| 3 | Rate limit | 즉시 PASS (검증 종료) |
| 4 | Thread resume 실패 | follow-up에서만 발생 — `start`로 새 Thread 생성 후 재시도 |
| 5 | Turn timeout (300초) | 즉시 PASS |
| 6 | 프로세스 오류 | 1회 재시도 후 PASS |

#### 에러 처리 흐름

```
codex-review 실행
  ├─ exit 0 → 출력 파일 읽기 → Phase 2 진행
  ├─ exit 1 → PASS (codex 미설치)
  ├─ exit 2 → PASS (인증 실패, "codex login 필요" 안내)
  ├─ exit 3 → PASS (rate limit)
  ├─ exit 4 → start로 재시도 (Thread 손상)
  ├─ exit 5 → PASS (timeout)
  └─ exit 6 → 1회 재시도 → 재실패 시 PASS
```

> **PASS 의미**: 검증을 건너뛰고 다음 단계로 진행한다.
> 리포트에 "GPT-5.3 Codex: ⏭️ PASS (사유: {exit code 설명})" 형태로 기록한다.

#### 기타

- 모델이 PASS되면 종합본 심사 모델 목록에 사유와 함께 명시
- Phase 순서는 절대 건너뛰거나 병합하지 말 것
- 최종 종합본은 반드시 한국어로 작성
- HIGH 이슈는 반드시 AskUserQuestion으로 사용자 결정을 받을 것
- MED/LOW 이슈는 권고사항으로 리포트에 포함 (사용자 확인 불필요)

---

*Last modified*: 2026-02-26

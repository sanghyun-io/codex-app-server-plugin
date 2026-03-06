---
rule_type: workflow
applies_to:
  - "Code review requests"
  - "/code-review command"
triggers:
  - event: "code_review"
    description: "사용자가 코드 리뷰를 명시적으로 요청하거나 /code-review 실행 시"
---

# Code Review Protocol (Codex + Opus)

코드 리뷰 전용 워크플로. Plan 검증(`codex-plan-validation.md`)과 분리된 반복 코드 리뷰 프로토콜.

모든 모델 호출은 `review-protocol.md`의 실행 규칙을 따른다 (`codex-review` CLI wrapper → App Server).

---

## Plan 검증과의 차이

| | Plan 검증 (`codex-plan-validation.md`) | 코드 리뷰 (이 문서) |
|---|---|---|
| **대상** | Plan 문서 (마크다운) | git diff (코드) |
| **반복** | 최대 3회 | 수렴까지 (제한 없음) |
| **증분 diff** | follow-up 시 diff만 전송 (Thread 컨텍스트 활용) | Round 2+부터 증분만 |
| **히스토리** | Thread가 관리 (App Server) | 있음 (이전 이슈/결정 누적) |
| **Opus 교차검증** | 없음 | 선택사항 |
| **트리거** | `plan_created` (자동 제안) | 사용자 명시적 요청 |

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: 코드 리뷰 요청 시 아래 워크플로를 반드시 수행한다.

### 코드 리뷰 시작 시 (code_review)

| Order | Action |
|:-----:|--------|
| 0 | 세션 초기화 (review-protocol.md의 세션 ID/디렉토리 규칙 준수) |
| 1 | 리뷰 대상 결정 (브랜치 diff / PR diff / 사용자 지정 범위) |
| 2 | Round 1 실행 (Full diff) |
| 3 | 사용자 이슈 확인 + 수정 |
| 4 | Round N 반복 (증분 diff) — 수렴까지 |
| 5 | (선택) Opus 교차검증 |
| 6 | 최종 리포트 |

---

## 리뷰 대상 결정

### 자동 감지

| 인자 | 동작 |
|------|------|
| (없음) | 현재 브랜치 vs default branch (`git diff $DEFAULT_BRANCH...HEAD`) |
| `PR#N` | `gh pr diff N` |
| `--base <ref>` | `git diff <ref>...HEAD` |

### Base Commit 기록

리뷰 시작 시 `BASE_COMMIT`과 `CURRENT_COMMIT`을 기록한다:

```bash
BASE_COMMIT=$(git merge-base $DEFAULT_BRANCH HEAD)
CURRENT_COMMIT=$(git rev-parse HEAD)
```

---

## Round 1: Full Diff 리뷰

### Step 1: Diff 추출

review-protocol.md의 **증분 Diff 추출** 섹션을 따른다:

```
Round 1: git diff $BASE_COMMIT..$CURRENT_COMMIT (전체)
```

### Step 2: 프롬프트 구성

review-protocol.md의 **Code Review Prompt Template**를 사용한다.

플레이스홀더 치환:
- `{REVIEW_MODE}`: Phase 0 자동 감지 (review-protocol.md 기준)
- `{DIFF_CONTENT}`: Step 1에서 추출한 diff
- `{PROJECT_CONTEXT}`: 프로젝트 CLAUDE.md
- `{REVIEW_HISTORY}`: (Round 1에서는 비어 있음)
- `{ROUND_NUMBER}`: 1
- `{ROUND_DIRECTIVE}`: (Round 1에서는 비어 있음)

### Step 3: Codex 실행

review-protocol.md의 실행 규칙 (`codex-review` CLI wrapper)을 따른다.

파일 네이밍: `cr_{SID}_r1_prompt.txt`, `cr_{SID}_r1_output.txt`

### Step 4: 결과 처리

review-protocol.md PHASE 2의 이슈 통합 + 사용자 상호작용 절차를 따른다.

- HIGH 이슈: AskUserQuestion으로 사용자 결정
- MED/LOW 이슈: 권고사항으로 리포트

사용자가 이슈를 수정하면 Round 2로 진행.

---

## Round N (N >= 2): 증분 Diff 리뷰

### Step 1: 증분 Diff 추출

```
PREV_COMMIT = (이전 라운드 시작 시 기록한 CURRENT_COMMIT)
CURRENT_COMMIT = $(git rev-parse HEAD)
git diff $PREV_COMMIT..$CURRENT_COMMIT
```

빈 diff인 경우:
- 사용자에게 "변경사항이 없습니다. 리뷰를 종료할까요?" AskUserQuestion
- "종료" 선택 시 최종 리포트 생성
- "계속" 선택 시 대기

### Step 2: 히스토리 구성

review-protocol.md의 **리뷰 히스토리** 섹션을 따른다.

`{REVIEW_HISTORY}` 플레이스홀더에 이전 라운드 요약을 삽입:
- 이전 이슈 목록 (번호, 심각도, 한줄 요약, 해결 여부)
- Deferred 목록 + "DO NOT re-flag these" 지시
- 최대 2000자

### Step 3: 후반 라운드 지시 (Round 3+)

`{ROUND_DIRECTIVE}` 플레이스홀더에 추가:

```
IMPORTANT - Late round review directive:
- Focus ONLY on: (1) verifying fixes for previous issues, (2) regression bugs introduced by fixes
- DO NOT flag LOW severity issues
- DO NOT re-flag deferred issues (listed in Review History as "deferred")
- Keep findings minimal and focused on correctness
```

### Step 4: Codex 실행

파일 네이밍: `cr_{SID}_r{N}_prompt.txt`, `cr_{SID}_r{N}_output.txt`

### Step 5: 결과 처리 + 히스토리 업데이트

1. 이슈 통합 (Round 1과 동일 절차)
2. 히스토리 파일 업데이트 (`cr_{SID}_history.md`에 append)
3. 수렴 조건 확인

---

## 수렴 조건

다음 중 하나라도 만족하면 리뷰 종료:

| 조건 | 설명 |
|------|------|
| **APPROVE** | Codex가 APPROVE verdict 반환 |
| **이슈 0** | 증분 diff에서 HIGH + MED 이슈가 0개 |
| **사용자 종료** | 사용자가 명시적으로 종료 요청 |
| **빈 diff** | 증분 diff가 비어 있고 사용자가 종료 선택 |

수렴 시 최종 리포트를 생성한다.

---

## Opus 교차검증 (선택사항)

### 트리거 조건

| 조건 | 동작 |
|------|------|
| 사용자가 `--with-opus` 플래그 사용 | 활성화 |
| 사용자가 리뷰 중 "Opus 검증" 요청 | 활성화 |
| Codex APPROVE 후 사용자가 최종 확인 요청 | 활성화 |
| 기본값 | 비활성화 |

### 실행 방법

review-protocol.md의 **Opus 교차검증** 섹션을 따른다:

1. Task tool의 `oracle` agent로 호출
2. Codex 리뷰 결과 + diff를 전달
3. "Codex가 놓친 이슈를 찾아라" 프롬프트
4. 결과를 최종 리포트에 병합

### 실패 처리

Opus 교차검증 실패 시 Codex 결과만으로 진행 (리포트에 "Opus 교차검증: SKIP (사유)" 명시).

---

## 최종 리포트 형식

```
# Code Review Report

## 리뷰 요약
- **대상**: {branch} vs {base} (또는 PR #{N})
- **라운드 수**: {total_rounds}
- **리뷰 모드**: {BIG CHANGE / SMALL CHANGE}

## 심사 모델
- GPT-5.3 Codex: {라운드별 verdict 요약}
- Opus 교차검증: ✅ / ⏭️ SKIP (사유)

---

## 이슈 총괄

| # | 심각도 | 영역 | 이슈 | 라운드 | 상태 |
|---|--------|------|------|--------|------|
| 1 | HIGH | Area 1 | ... | R1 | 수정됨 |
| 2 | MED | Area 2 | ... | R1 | Deferred |
| 3 | HIGH | Area 3 | ... | R2 | 수정됨 |

---

## 라운드별 상세

### Round 1 (Full diff)
{이슈 목록 + 사용자 결정}

### Round 2 (증분)
{이슈 목록 + 수정 검증 결과}

...

---

## 최종 Verdict

| 모델 | 최종 라운드 |
|---|---|
| GPT-5.3 Codex | APPROVE / REVISE |
| Opus (선택) | APPROVE / REVISE |
| **종합** | **APPROVE / REVISE** |
```

---

## 실행 규칙

### 모델 호출

review-protocol.md의 실행 규칙을 그대로 적용한다:
- `codex-review` CLI wrapper (`codex-review.mjs`) 사용
- Exit code 기반 에러 처리 (exit 1/2/3/5 → PASS, exit 6 → 1회 재시도 후 PASS)

### 파일 네이밍 (코드 리뷰 전용)

| 파일 | 경로 |
|------|------|
| Round N 프롬프트 | `{REVIEW_DIR}/cr_{SID}_r{N}_prompt.txt` |
| Round N 출력 | `{REVIEW_DIR}/cr_{SID}_r{N}_output.txt` |
| 히스토리 | `{REVIEW_DIR}/cr_{SID}_history.md` |
| Thread 상태 | `{REVIEW_DIR}/cr_{SID}_state.json` |

> `review_{SID}_*`는 Plan 검증 전용. 코드 리뷰는 `cr_{SID}_*` 패턴을 사용한다.

### 세션 ID 및 디렉토리

review-protocol.md의 세션 초기화 규칙을 그대로 따른다 (Step A: HOME 리터럴, Step B: SID 생성).

---

## Linked Skills

<!-- @linked-skills -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/code-review` | 사용자가 코드 리뷰 요청 시 | auto | 코드 리뷰 진입점 |

<!-- @/linked-skills -->

---

## 금지 사항

- ❌ 매 라운드 전체 diff 재전송 (Round 2+에서는 반드시 증분 diff)
- ❌ 이전 라운드 이슈/결정을 무시 (히스토리 필수 포함)
- ❌ Deferred 이슈를 다시 지적
- ❌ Plan 검증 프로토콜로 코드 리뷰 실행 (이 문서의 워크플로 사용)
- ❌ 사용자 확인 없이 Opus 교차검증 자동 실행
- ❌ 수렴 조건 미달 시 임의 종료

---

*Related*: `review-protocol.md`, `codex-plan-validation.md`, `rule-format.md`
*Last modified*: 2026-02-26

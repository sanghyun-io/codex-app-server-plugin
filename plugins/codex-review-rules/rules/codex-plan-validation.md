---
rule_type: workflow
applies_to:
  - "Plan mode - plan file creation"
  - "Plan execution start"
triggers:
  - event: "plan_created"
    description: "Plan 파일이 작성 완료된 후"
---

# Plan Validation (GPT-5.3 Codex)

Plan 작성 완료 후 Plan Review 프로토콜(`review-protocol.md`)을 활용하여 논리적/기술적 유효성을 검증하는 워크플로.

모든 모델 호출은 `review-protocol.md`의 실행 규칙을 따른다 (`codex-review` CLI wrapper → App Server).

> **참고**: 코드 리뷰(git diff 기반)는 이 문서가 아닌 `codex-code-review.md`를 사용한다.
> Plan 검증은 증분 diff, 리뷰 히스토리, Opus 교차검증을 **사용하지 않는다**.

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: Plan 파일 작성이 완료되면 아래 워크플로를 반드시 수행한다.

### Plan 작성 완료 시 (plan_created)

**기존 Pre-work 흐름에 Order 0으로 삽입:**

| Order | Condition | Action | Source |
|:-----:|-----------|--------|--------|
| 0 | Plan created | Ask: Multi-Model validation? | **이 규칙** |
| 0.1 | Issues found | Show → iterate (max 3회) | **이 규칙** |
| 1 | Plan mode active | ExitPlanMode | plan-structure.md |
| 2 | Task >= 3 | Ask: /subdivide? | plan-structure.md |
| 3 | Multi-file changes | Ask: /review? | plan-structure.md |
| 4 | Git 저장소 | 새 Worktree 생성 (default 브랜치 기반) | plan-structure.md |
| 5 | Pre-work done | Begin implementation (새 Worktree 내) | plan-structure.md |

> **주의**: Order 0은 ExitPlanMode **이전**에 실행된다 (Plan 모드 내에서 검증).

### Step 0: Validation 실행 여부 확인

Plan 작성 완료 후 **AskUserQuestion**으로 확인:

```json
{
  "questions": [{
    "question": "Plan 작성이 완료되었습니다. Multi-Model Debate로 유효성 검증을 실행할까요?",
    "header": "Validation",
    "multiSelect": false,
    "options": [
      {"label": "검증 실행", "description": "GPT-5.3 Codex 모델로 Plan의 유효성을 검증합니다"},
      {"label": "스킵", "description": "검증 없이 다음 단계로 진행합니다"}
    ]
  }]
}
```

### Step 0.1: Multi-Model Debate 실행

사용자가 "검증 실행"을 선택한 경우:

1. **컨텍스트 수집** (재읽기 금지 — 현재 컨텍스트 활용)
2. **review-protocol.md Phase 0(자동 감지) → Phase 1 실행** (`codex-review start`)
3. **Phase 2 종합본으로 Pass/Fail 판정**
4. **NEEDS_REVISION이면 Phase 1.5로 follow-up 재검증** (`codex-review follow-up`, 동일 Thread 재사용)

---

## 검증 4개 영역

review-protocol.md의 Review Prompt Template에 정의된 4개 영역을 사용한다:

| # | 영역 | 검증 내용 |
|:-:|------|-----------|
| 1 | **Architecture & Design** | 시스템 설계, 의존성, 데이터 흐름, 확장성, 보안 |
| 2 | **Implementation Quality** | 완전성, DRY, 에러 처리, 엣지케이스, 기술 부채 |
| 3 | **Test Strategy** | 테스트 커버리지, 엣지케이스, 실패 모드 |
| 4 | **Performance & Scalability** | N+1 쿼리, 메모리, 캐싱, 복잡도 |

---

## 프롬프트 구성

### 컨텍스트

review-protocol.md의 Review Prompt Template에서 아래 플레이스홀더를 치환한다:

| Placeholder | Source | Purpose |
|-------------|--------|---------|
| `{PLAN_CONTENT}` | 현재 컨텍스트 (재읽기 금지) | 검증 대상 Plan |
| `{PROJECT_CONTEXT}` | 프로젝트 CLAUDE.md + Plan에서 언급한 파일 목록 | 기술 스택, 컨벤션, 정합성 확인 |
| `{REVIEW_MODE}` | Phase 0에서 자동 감지 (태스크 수/변경 규모 기준) | BIG CHANGE / SMALL CHANGE |

### Phase 1, 1.5, 2 프롬프트

review-protocol.md의 프롬프트 템플릿을 **그대로** 사용한다.
- Phase 1: Review Prompt Template (Phase 1) — `codex-review start`로 실행
- Phase 1.5: Follow-up Review Prompt Template — `codex-review follow-up`으로 실행 (동일 Thread)
- Phase 2: 종합본 생성 + 사용자 상호작용

> **주의**: 이전에 Phase 1 프롬프트를 이 파일에서 오버라이드했으나,
> review-protocol.md에 Engineering Preferences + 4 Area + 구조화된 이슈 형식이
> 통합되었으므로 별도 오버라이드 없이 review-protocol.md를 따른다.

---

## Phase 실행

review-protocol.md의 Phase를 순서대로 실행한다:

| Phase | 내용 | 참조 | 실행 방법 |
|:-----:|------|------|-----------|
| 1 | 초기 리뷰 (GPT-5.3 Codex) | review-protocol.md PHASE 1 | `codex-review start` (새 Thread 생성) |
| 1.5 | Follow-up 재검증 (반복) | review-protocol.md PHASE 1.5 | `codex-review follow-up` (동일 Thread) |
| 2 | 종합본 생성 | review-protocol.md PHASE 2 | Claude 직접 처리 |

> **모든 Phase의 실행 규칙, 에러 처리**는 `review-protocol.md`를 따른다.
>
> **Thread 재사용**: Phase 1에서 생성한 Thread를 Phase 1.5에서 재사용한다.
> follow-up 시 수정된 Plan의 diff만 전송하여 토큰을 절감한다.
>
> **Plan 검증 전용**: 증분 diff, 리뷰 히스토리, Opus 교차검증은 Plan 검증에서 사용하지 않는다.
> 이들은 코드 리뷰 전용 기능이다 (`codex-code-review.md` 참조).

---

## Pass/Fail 판정

Phase 2 종합본의 **최종 Verdict** 기준으로 판정:

| Overall | Condition |
|---------|-----------|
| **PASS** | 종합 Verdict = **APPROVE** |
| **NEEDS_REVISION** | 종합 Verdict = **REVISE** 또는 **REJECT** |

### PASS 시

결과를 요약 표시하고 다음 단계(ExitPlanMode → Pre-work)로 진행.

### NEEDS_REVISION 시

1. Phase 2 종합본을 사용자에게 표시
2. **AskUserQuestion**으로 다음 행동 선택:

```json
{
  "questions": [{
    "question": "Multi-Model 검증에서 이슈가 발견되었습니다. 어떻게 진행할까요?",
    "header": "Validation",
    "multiSelect": false,
    "options": [
      {"label": "수정 후 재검증", "description": "이슈를 수정하고 동일 Thread에서 follow-up 재검증합니다"},
      {"label": "현재 상태로 진행", "description": "이슈를 인지하고 현재 Plan으로 계속 진행합니다"},
      {"label": "Plan 재작성", "description": "Plan을 처음부터 다시 작성합니다"}
    ]
  }]
}
```

> **"수정 후 재검증" 선택 시**: Plan을 수정한 뒤 `codex-review follow-up`으로 동일 Thread에서 재검증한다.
> 수정된 부분의 diff만 전송하며, 모델이 이전 리뷰 컨텍스트를 기억하므로 일관된 리뷰가 가능하다.

---

## Iteration 규칙

| 항목 | 값 |
|------|-----|
| 최대 반복 | 3회 (초과 시 사용자 강제 결정) |
| User escape | 모든 단계에서 "현재 상태로 진행" 선택 가능 |
| Thread 관리 | 반복 중 동일 Thread 유지, 최종 완료 시 `codex-review close`로 정리 |

### 3회 초과 시

```json
{
  "questions": [{
    "question": "검증을 3회 반복했으나 모든 이슈가 해결되지 않았습니다. 어떻게 진행할까요?",
    "header": "Max retries",
    "multiSelect": false,
    "options": [
      {"label": "현재 상태로 진행", "description": "남은 이슈를 인지하고 구현을 시작합니다"},
      {"label": "Plan 재작성", "description": "Plan을 처음부터 다시 작성합니다"}
    ]
  }]
}
```

---

## 에러 처리

> 개별 모델 호출 실패는 `review-protocol.md`의 exit code 기반 에러 처리 규칙을 따른다.
>
> - **Exit 1** (codex 없음) → 즉시 PASS
> - **Exit 2** (인증 실패) → 즉시 PASS, `codex login` 안내
> - **Exit 3** (rate limit) → 즉시 PASS
> - **Exit 4** (Thread resume 실패) → `start`로 재시도
> - **Exit 5** (timeout 300초) → 즉시 PASS
> - **Exit 6** (프로세스 오류) → 1회 재시도 후 PASS

전체 프로토콜 실행 불가 시:

```json
{
  "questions": [{
    "question": "Multi-Model 검증 중 오류가 발생했습니다: {error_description}. 어떻게 진행할까요?",
    "header": "Error",
    "multiSelect": false,
    "options": [
      {"label": "재시도", "description": "검증을 다시 시도합니다"},
      {"label": "스킵", "description": "검증 없이 다음 단계로 진행합니다"}
    ]
  }]
}
```

---

## Linked Skills

<!-- @linked-skills: Skills in this table should be automatically suggested when conditions are met -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/plan` | Plan 작성 필요 시 | auto | Plan 작성 (이 규칙은 plan_created 이후 트리거) |
| `/subdivide` | Task >= 3 AND Validation 완료 후 | confirm | Plan 세분화 (plan-structure.md와 연계) |
| `/review` | Multi-file changes AND Validation 완료 후 | confirm | Plan 리뷰 (plan-structure.md와 연계) |

<!-- @/linked-skills -->

---

## 금지 사항

- ❌ 검증 결과를 Claude가 임의로 무시하거나 스킵 결정
- ❌ 사용자 확인 없이 자동으로 검증 실행
- ❌ Plan 컨텍스트를 다시 읽기 (이미 컨텍스트에 있는 경우)
- ❌ 검증 결과를 변조하거나 요약 없이 생략
- ❌ 3회 초과 반복 시 사용자 결정 없이 진행
- ❌ review-protocol.md의 Phase 순서를 건너뛰거나 병합
- ❌ 프롬프트를 파일 없이 인라인으로 전달 (파일 경유 필수)
- ❌ follow-up 시 전체 Plan 재전송 (diff만 전송)

---

*Related*: `plan-structure.md`, `review-protocol.md`, `codex-code-review.md`, `rule-format.md`
*Last modified*: 2026-02-26

---
rule_type: workflow
applies_to:
  - "Codex에게 부탁/요청/위임"
  - "Codex에게 물어봐/확인"
  - "Codex로 리뷰/검토/수정/구현/디버깅"
  - "/delegate, /sessions, /halt, /readout, /red-review, /code-review"
triggers:
  - event: "codex_delegation"
    description: "사용자 발화에 'Codex에게 부탁/요청/물어봐/위임/확인' 또는 'Codex로 {동작}' 표현이 등장할 때"
---

# Codex Delegation Intent Router

사용자가 자연어로 Codex를 호출하면 이 규칙이 의도를 분류하여 적절한 스킬로 라우팅한다.
스킬을 사용자가 직접 호출(`/delegate` 등)하는 경우에도 각 스킬 내부에서 이 규칙을 참조할 수 있다.

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: 사용자 발화에서 "Codex" + 위임 동사가 감지되면 아래 의도 분류 표에 따라 스킬을 선택하고, 선택한 스킬의 SKILL 파일에 정의된 절차를 실행한다.

### 의도 감지 시 (codex_delegation)

| Order | Action |
|:-----:|--------|
| 1 | 발화에서 **핵심 동사**와 **대상**을 추출한다 |
| 2 | **모델명 추출** — `{모델}(으)로`, `with {model}` 등 패턴 매칭 (없으면 스킵) |
| 3 | 아래 **의도 분류 표**로 스킬을 선택한다 |
| 4 | 복수 의도로 해석될 수 있으면 **AskUserQuestion**으로 확정한다 (추측 금지) |
| 5 | 선택한 스킬을 실행한다 — 추출된 모델이 있으면 `--model <X>` 인수로 자동 부착 (스킬 내부 절차는 해당 SKILL.md 참조) |

---

## 자연어 트리거

### 위임 동사 (Codex와 결합되는 표현)

| 패턴 | 예시 발화 |
|------|-----------|
| `Codex에게 {동사}` | "Codex에게 부탁해", "Codex에게 물어봐", "Codex에게 요청해", "Codex에게 맡겨", "Codex에게 시켜" |
| `Codex로 {동작}` | "Codex로 리뷰해줘", "Codex로 확인해봐", "Codex로 고쳐봐", "Codex로 디버깅해" |
| `Codex가 {동작}` | "Codex가 검토하게 해", "Codex가 구현하게 해" |
| 영문 | "Ask Codex to ...", "Have Codex review ...", "Let Codex fix ..." |

### 비-트리거 (라우터를 실행하지 않는 케이스)

| 상황 | 처리 |
|------|------|
| "Codex CLI를 설치해줘" (설정/셋업 관련) | `/codex-core:setup` 안내, 라우터 실행 금지 |
| "Codex란 뭐야?" (설명 요청) | 일반 응답, 스킬 실행 금지 |
| "Codex 세션 상태 어때?" (이미 명시적 동사 있음) | 바로 `sessions` 스킬로 진입 (라우터 1단계 건너뜀) |

---

## 의도 분류 표

> 발화의 동사/명사에서 아래 키워드를 매칭하여 의도를 결정한다.

| 의도 | 트리거 키워드 | 라우팅 스킬 | 요약 |
|------|--------------|------------|------|
| **코드 리뷰** | 리뷰, 검토, review, 잘못된 거, 품질 확인 | `/code-review` | 반복 코드 리뷰 (기존 워크플로) |
| **공격자 관점 리뷰** | 보안, 취약점, 공격, 침투, red team, 악의적, 해킹 | `/red-review` | 보안/취약점 집중 리뷰 |
| **작업 위임 (수정/구현/디버깅)** | 고쳐, 수정, 구현, 만들어, 작성, 리팩터, 버그, 디버그, fix, implement, refactor | `/delegate` | Codex가 구체적 변경안을 제시 → Claude가 실행 (A+ 패턴) |
| **질의** | 물어봐, 확인해, 알려줘, 찾아봐, ask, explain, why | `/delegate` (read-only 모드) | 파일 쓰기 없이 질의응답만 |
| **세션 현황 조회** | 세션, 상태, 돌아가는 거, 진행 중, running, status | `/sessions` | 모든 Codex 세션 목록 |
| **세션 중단** | 중단, 취소, 멈춰, stop, cancel, kill | `/halt` | 실행 중인 세션 중단 |
| **결과 꺼내기** | 결과, 출력, 마저 보기, result, output, readout | `/readout` | 완료된 세션의 output + 메타데이터 표시 |

### 모호한 경우 AskUserQuestion 예시

동사가 없거나 복수 의도로 해석될 수 있을 때:

```json
{
  "questions": [{
    "question": "Codex에게 어떤 작업을 맡길까요?",
    "header": "Codex Intent",
    "multiSelect": false,
    "options": [
      {"label": "코드 리뷰", "description": "현재 브랜치의 변경사항을 반복 리뷰"},
      {"label": "공격자 관점 리뷰", "description": "보안/취약점 중심 리뷰"},
      {"label": "작업 위임 (수정/구현)", "description": "Codex가 변경안을 제시하면 Claude가 적용"},
      {"label": "질의", "description": "파일 변경 없이 질문에 답변만"},
      {"label": "세션 현황 보기", "description": "실행 중/완료된 Codex 세션 목록"}
    ]
  }]
}
```

---

## A+ 패턴 (Codex↔Claude 협업)

> **delegate** 및 관련 작업형 스킬은 이 패턴을 기본으로 사용한다.

### 원칙

| 역할 | 책임 |
|------|------|
| **Codex (두뇌)** | 문제 분석, 원인 파악, 구체적 변경안 제시 (unified diff 또는 JSON 형식) |
| **Claude (손)** | Codex의 제안을 실제 파일에 Edit/Write 도구로 적용, 실행 결과를 Codex에게 보고 |

### 루프 흐름

```
사용자 요청
  ↓
Claude: Codex Thread 시작 (codex-review start) + 초기 프롬프트
        "변경안은 diff/JSON으로만 답하고, 직접 파일을 수정하지 말 것"
  ↓
Codex: 변경안 1차 제안
  ↓
Claude: 제안을 검토 → Edit/Write로 적용 → 결과 요약
  ↓
Claude: codex-review follow-up으로 다음 Turn
        "방금 X를 Y로 적용했다. 결과는 Z. 다음 단계는?"
  ↓
Codex: 다음 변경안 또는 "완료" 판정
  ↓
(완료될 때까지 반복)
  ↓
Claude: codex-review close로 Thread 종료
```

### Thread 재사용 이점

- Codex가 이전 Turn 컨텍스트를 메모리에 보관 → follow-up 프롬프트는 델타만 전송
- 토큰 비용 절감 (fresh start 대비 follow-up이 훨씬 저렴)
- 반복 통신이 자연스러움 (라운드 수 제한 없음)

### 금지 사항

- ❌ Codex에게 "파일을 직접 수정하라"고 지시 (App Server는 read-only, 혼동 유발)
- ❌ Claude가 Codex 제안을 적용하지 않고 사용자에게 그대로 전달 (Claude가 손 역할)
- ❌ follow-up 없이 매 라운드 fresh start (Thread 재사용 이점 상실)
- ❌ 라운드마다 전체 컨텍스트 재전송 (follow-up은 증분만)

---

## 모델 의도 추출

발화에서 Codex 모델명을 추출하여 라우팅 시 `--model <X>` 인수로 자동 주입한다.
이 추출은 위 의도 분류와 **독립적으로** 수행된다 (리뷰/위임 등 어떤 의도든 모델 지정 가능).

### 추출 패턴

#### 한국어

| 패턴 | 예시 발화 | 추출 모델 |
|------|-----------|----------|
| `{모델}(으)로` | "gpt-5.6-sol로 리뷰해줘" | `gpt-5.6-sol` |
| `{모델} 사용해서` | "o1 사용해서 검토 부탁" | `o1` |
| `{모델} 써서` | "claude-3.5-sonnet 써서 분석" | `claude-3.5-sonnet` |
| `{모델} 모델로` | "gpt-5.6-terra 모델로 위임" | `gpt-5.6-terra` |

#### 영어

| 패턴 | 예시 발화 | 추출 모델 |
|------|-----------|----------|
| `with {model}` | "Have Codex review with gpt-5.6-sol" | `gpt-5.6-sol` |
| `using {model}` | "Ask Codex using o1" | `o1` |
| `{model} model` | "use gpt-5.6-terra model" | `gpt-5.6-terra` |

### 모델명 인식 휴리스틱

다음 prefix 중 하나로 시작하는 토큰을 모델명 후보로 간주한다:

- `gpt-*` (예: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`)
- `o1*`, `o3*`, `o4*` (예: `o1`, `o1-mini`, `o3-pro`)
- `claude-*` (예: `claude-3.5-sonnet`)
- `gemini-*`
- `chatgpt-*`

> **검증 안 함**: 추출된 모델명은 클라이언트 측에서 유효성 검증하지 않는다.
> App Server가 거부하면 첫 turn 실패 메시지로 사용자에게 보고된다.
> 새 모델 출시 시 라우터 코드 변경 없이 즉시 사용 가능하도록 의도된 설계다.

### 라우팅 결과 예시

| 발화 | 라우팅 |
|------|--------|
| "Codex에게 gpt-5.6-sol로 리뷰 부탁해" | `/code-review --model gpt-5.6-sol` |
| "Codex로 o1 써서 보안 검토" | `/red-review --model o1` |
| "Have Codex fix the bug using gpt-5.6-terra" | `/delegate "fix the bug" --model gpt-5.6-terra` |
| "gpt-5.6-luna 모델로 이 함수 왜 느린지 물어봐" | `/delegate "이 함수 왜 느린지" --read-only --model gpt-5.6-luna` |

### 모호 / 충돌 처리

| 상황 | 처리 |
|------|------|
| 모델명이 발화에 없음 | `--model` 미부착 (CLI가 `CODEX_REVIEW_MODEL` 환경변수 또는 기본값 사용) |
| 모델명 후보가 2개 이상 | AskUserQuestion으로 사용자 확인 |
| 추출된 모델이 prefix는 맞지만 형식 의심 | 일단 부착하고 App Server 거부 시 사용자에게 재질의 |
| 사용자가 슬래시 커맨드로 직접 `--model X`, 발화에서 다른 모델 언급 | 슬래시 커맨드 우선 (사용자 명시) |
| 세션 진행 중 다른 모델 언급 | **새 세션 시작** (기존 Thread는 모델 고정 — `state.json`에 저장됨) |

---

## 세션 네이밍 규약

각 스킬은 고유한 prefix를 사용하여 다른 세션과 구분한다:

| 스킬 | Prefix | 파일 패턴 예 |
|------|:------:|--------------|
| `code-review` | `cr_` | `cr_{SID}_r1_prompt.txt` |
| `red-review` | `rr_` | `rr_{SID}_r1_prompt.txt` |
| `delegate` | `dg_` | `dg_{SID}_t1_prompt.txt` |

> `t{N}`은 delegate의 Turn 번호 (code-review의 `r{N}` 라운드와 구분).

---

## Linked Skills

<!-- @linked-skills -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/code-review` | "Codex에게 리뷰 부탁" 등 리뷰 의도 감지 | auto | 반복 코드 리뷰 |
| `/red-review` | "Codex에게 보안 검토" 등 공격 관점 의도 | auto | 공격자 관점 리뷰 |
| `/delegate` | "Codex에게 고쳐/구현 부탁" 등 작업 의도 | auto | A+ 패턴 작업 위임 |
| `/sessions` | "Codex 세션 상태" 등 조회 의도 | auto | 세션 현황 표시 |
| `/halt` | "Codex 중단/취소" 등 중단 의도 | auto | 실행 중 세션 중단 |
| `/readout` | "Codex 결과 꺼내" 등 결과 조회 의도 | auto | 완료 세션 결과 표시 |

<!-- @/linked-skills -->

---

## 금지 사항

- ❌ 사용자가 명시적으로 Codex를 지목했는데 Claude가 단독 처리 (반드시 라우팅)
- ❌ 의도 모호성을 혼자 추측하여 스킬 선택 (AskUserQuestion 필수)
- ❌ 작업형 의도(고쳐/구현)를 리뷰로 해석 (동사 매칭 우선)
- ❌ `delegate`에서 Codex에게 "직접 파일을 수정하라"고 지시 (A+ 패턴 위반)

---

*Related*: `review-protocol.md`, `codex-code-review.md`, `rule-format.md`
*Last modified*: 2026-04-10

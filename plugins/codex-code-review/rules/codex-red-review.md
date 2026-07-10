---
rule_type: workflow
applies_to:
  - "Adversarial / security-focused code review"
  - "/red-review command"
triggers:
  - event: "codex_red_review"
    description: "사용자가 공격자 관점 리뷰를 명시적으로 요청하거나 /red-review 실행 시"
---

# Codex Red Review Protocol (Adversarial)

공격자 관점의 반복 코드 리뷰 워크플로. 구조와 실행 규칙은 `codex-code-review.md`와 동일하지만,
프롬프트 템플릿과 영역 구성이 **보안/취약점 중심**으로 교체된다.

---

## 🔴 Required Actions (Action Required)

> **MUST DO**: 공격자 관점 리뷰 요청 시 아래 워크플로를 반드시 수행한다.

### Red Review 시작 시 (codex_red_review)

| Order | Action |
|:-----:|--------|
| 0 | 세션 초기화 (review-protocol.md의 세션 ID/디렉토리 규칙 준수, prefix = `rr_`) |
| 1 | 리뷰 대상 결정 (브랜치 diff / PR diff / 사용자 지정 범위) |
| 2 | Round 1 실행 (Full diff + Red Review Prompt Template) |
| 3 | 사용자 이슈 확인 + 수정 |
| 4 | Round N 반복 (증분 diff) — 수렴까지 |
| 5 | (선택) Opus 교차검증 |
| 6 | 최종 리포트 |

---

## codex-code-review와의 차이점

| 항목 | code-review | red-review |
|------|-------------|------------|
| Prefix | `cr_` | `rr_` |
| 리뷰 영역 | Architecture / Implementation / Test / Performance | Input Trust / Auth & Authz / State & Concurrency / Data Exposure |
| 이슈 관점 | "올바르게 동작하는가" | "어떻게 깨뜨릴 수 있는가" |
| 심각도 해석 | HIGH = 기능적 버그 | HIGH = 악용 가능 취약점 |
| Verdict | APPROVE / REVISE / REJECT | SECURE / AT_RISK / COMPROMISED |

리뷰 대상 결정, base commit 기록, Round 전환, 수렴 조건, Opus 교차검증, 최종 리포트 골격은
**`codex-code-review.md`를 그대로 재사용**한다. 아래에서는 **다른 부분만** 정의한다.

---

## Round 1: Full Diff 공격자 리뷰

### Step 1: Diff 추출

review-protocol.md의 **증분 Diff 추출** 섹션을 따른다 (Round 1 = 전체 diff).

### Step 2: 프롬프트 구성

아래 **Red Review Prompt Template**를 사용한다.

플레이스홀더 치환:
- `{DIFF_CONTENT}`: Step 1에서 추출한 diff
- `{PROJECT_CONTEXT}`: 프로젝트 CLAUDE.md
- `{REVIEW_HISTORY}`: (Round 1에서는 비어 있음)
- `{ROUND_NUMBER}`: 1
- `{ROUND_DIRECTIVE}`: (Round 1에서는 비어 있음)
- `{TRUST_BOUNDARIES}`: 가능한 경우 "인증 토큰", "외부 API 입력", "DB 경계" 등 프로젝트의 신뢰 경계 힌트

### Step 3: Codex 실행 (비동기)

review-protocol.md의 실행 규칙을 따른다. 세션 이름은 `rr_{SID}`:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" start "{HOME_LITERAL}/.claude/tmp/rr_{SID}_r1_prompt.txt" "{HOME_LITERAL}/.claude/tmp/rr_{SID}_r1_output.txt" --session "rr_{SID}" --review-dir "{HOME_LITERAL}/.claude/tmp" --default-model "gpt-5.6-sol"; echo "EXIT_CODE: $?"
```

`gpt-5.6-sol`은 red-review의 내부 기본값이다. `$ARGUMENTS`에 `--model <X>`가 있으면 위 명령 끝에 `--model "<X>"`를 추가하며, 사용자 지정 모델이 `--default-model`보다 우선한다. `CODEX_REVIEW_MODEL`도 내부 기본값보다 우선한다.
모델 오버라이드 처리 규칙은 `codex-code-review.md`의 **모델 오버라이드 처리** 섹션을 동일하게 따른다 (start에서 지정한 모델은 `rr_{SID}_state.json`에 저장되어 follow-up에 자동 재사용됨).

폴링 패턴은 code-review와 동일 (30초 간격, 묻지 않고 계속 대기, 2분마다 진행 안내, 30분 하드 타임아웃까지).

### Step 4: 결과 처리

- `AT_RISK` / `COMPROMISED` verdict + HIGH 이슈 → AskUserQuestion으로 사용자 결정
- MED/LOW 이슈 → 권고사항으로 리포트

---

## Round N (N >= 2): 증분 공격자 리뷰

`codex-code-review.md`의 **Round N** 절차를 그대로 따르되:
- 파일 네이밍: `rr_{SID}_r{N}_*`
- 프롬프트 템플릿: 아래 Red Review Prompt Template
- 후반 라운드 지시(`{ROUND_DIRECTIVE}`)는 code-review와 동일하게 "수정 검증 + regression 집중"

---

## Red Review Prompt Template

```
You are a senior offensive security engineer. Review the following code changes as if you are looking for vulnerabilities to exploit. Assume an attacker has source access.

## Your Stance
- Assume all input is hostile until proven otherwise.
- Assume the caller is authenticated but malicious (privilege escalation, IDOR, etc.).
- Assume concurrent requests, retries, and partial failures.
- Assume the code ships to production exactly as written.

## Round: {ROUND_NUMBER}

{ROUND_DIRECTIVE}

## Review History

{REVIEW_HISTORY}

## Trust Boundaries

{TRUST_BOUNDARIES}

## Review Areas

### Area 1: Input Trust & Injection
- Untrusted input reaching SQL, shell, file paths, templates, deserializers
- Missing validation, sanitization, encoding
- Server-side request forgery, XML/JSON external entities
- Path traversal, regex DoS, integer overflow

### Area 2: Auth & Authorization
- Missing or bypassable auth checks
- Privilege escalation paths (IDOR, mass assignment, tenant leakage)
- Token/session handling: storage, transport, expiration, replay
- Broken access control on admin or internal endpoints

### Area 3: State & Concurrency
- TOCTOU and race conditions
- Inconsistent state under partial failure or retry
- Transaction boundaries that can be split by attacker-controlled timing
- Cache poisoning, lock bypass

### Area 4: Data Exposure & Exfiltration
- Sensitive data in logs, errors, responses, metrics
- PII/secret handling: at rest, in transit, in backups
- Side channels (timing, error messages, response size)
- Overly verbose error responses revealing internals

## Output Format

For EACH finding, use this exact format:

### [#N] [HIGH/MED/LOW] [Area X] Vulnerability title
**File**: `path/to/file.py:LINE`
**Attack**:
- **Vector**: How an attacker reaches this code path.
- **Exploit**: Concrete steps to exploit (input, sequence, timing).
- **Impact**: What the attacker gains (data, access, persistence).

**Mitigations**:
- **(A) {recommended fix}**: Description. Effort: X. Risk: X. Residual: X.
- **(B) {alternative}**: Description. Effort: X. Risk: X. Residual: X.
- **(C) Accept risk**: Rationale. (Only if severity != HIGH)

**Recommendation**: (A/B/C) — Reasoning with attacker capability assumptions.

---

After all findings, provide:

[VERDICT] - SECURE / AT_RISK / COMPROMISED with summary reasoning.

- **SECURE**: No exploitable paths found in this diff.
- **AT_RISK**: One or more MED/LOW findings, no HIGH.
- **COMPROMISED**: At least one HIGH finding (exploitable without unusual preconditions).

## Code Changes to Review:

{DIFF_CONTENT}

## Project Context:

{PROJECT_CONTEXT}
```

---

## 수렴 조건

| 조건 | 설명 |
|------|------|
| **SECURE** | Codex가 SECURE verdict 반환 |
| **이슈 0** | 증분 diff에서 HIGH + MED 이슈가 0개 |
| **사용자 종료** | 사용자가 명시적으로 종료 요청 |
| **빈 diff** | 증분 diff가 비어 있고 사용자가 종료 선택 |

---

## 최종 리포트 형식

code-review의 최종 리포트 형식을 기반으로 하되, verdict 줄을 다음과 같이 바꾼다:

```
| 모델 | 최종 라운드 |
|---|---|
| Codex (gpt-5.6-sol) | SECURE / AT_RISK / COMPROMISED |
| Opus (선택) | SECURE / AT_RISK / COMPROMISED |
| **종합** | **SECURE / AT_RISK / COMPROMISED** |
```

---

## 실행 규칙

review-protocol.md v2의 비동기 실행 규칙을 그대로 적용한다. 파일 네이밍만 `rr_{SID}_*` prefix로 교체.

세션의 canonical 프로젝트 루트 고정, heartbeat 재접속, 실제 upstream interrupt, progress 단계/지연 메트릭도 review-protocol.md 규칙을 그대로 따른다.

### 파일 네이밍 (Red Review 전용)

| 파일 | 경로 |
|------|------|
| Round N 프롬프트 | `{REVIEW_DIR}/rr_{SID}_r{N}_prompt.txt` |
| Round N 출력 | `{REVIEW_DIR}/rr_{SID}_r{N}_output.txt` |
| 히스토리 | `{REVIEW_DIR}/rr_{SID}_history.md` |
| Thread 상태 | `{REVIEW_DIR}/rr_{SID}_state.json` |
| Worker 진행 상황 | `{REVIEW_DIR}/rr_{SID}_progress.json` |
| Worker PID | `{REVIEW_DIR}/rr_{SID}_pid` |
| Worker 로그 | `{REVIEW_DIR}/rr_{SID}_worker.log` |

---

## Linked Skills

<!-- @linked-skills -->

| Skill | Trigger Condition | Execution Mode | Description |
|-------|-------------------|:--------------:|-------------|
| `/red-review` | 사용자가 공격자 관점 리뷰 요청 시 | auto | Red review 진입점 |

<!-- @/linked-skills -->

---

## 금지 사항

- ❌ code-review prefix(`cr_`)를 사용 (반드시 `rr_`)
- ❌ 일반 기능 버그를 HIGH로 격상 (HIGH는 악용 가능 취약점 전용)
- ❌ 영역을 code-review의 Architecture/Implementation/Test/Performance로 되돌리기

---

*Related*: `review-protocol.md`, `codex-code-review.md`, `codex-delegation.md`
*Last modified*: 2026-04-10

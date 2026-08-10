---
rule_type: workflow
applies_to:
  - "Code review requests"
  - "/code-review command"
  - "Codex에게 리뷰/검토 부탁/요청"
  - "Codex로 코드 리뷰/검토"
triggers:
  - event: "code_review"
    description: "사용자가 코드 리뷰를 명시적으로 요청하거나 /code-review 실행 시, 또는 'Codex에게 리뷰 부탁' 같은 자연어 트리거 시"
---

# Code Review Protocol (Codex + Opus)

반복 코드 리뷰 워크플로. 모든 모델 호출은 `review-protocol.md`의 실행 규칙을 따른다 (`codex-review` CLI wrapper → App Server).

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
| `--model <name>` | Codex 모델 오버라이드 (workflow default: `gpt-5.6-terra`, env: `CODEX_REVIEW_MODEL`) |
| `--effort <level>` | Codex 추론 강도 오버라이드 (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`; 기본값 `high`) |
| `--tone <level>` | 리뷰 결과 말투/난이도 (`easy`/`plain`/`normal`/`deep`; 기본값 `plain`) — 위 "말투(Tone) 단계 처리" 참조 |
| `--with-opus` | Opus 교차검증 활성화 |

### Base Commit 기록

리뷰 시작 시 `BASE_COMMIT`과 `CURRENT_COMMIT`을 기록한다:

```bash
BASE_COMMIT=$(git merge-base $DEFAULT_BRANCH HEAD)
CURRENT_COMMIT=$(git rev-parse HEAD)
```

---

## 모델 및 effort 오버라이드 처리

### $ARGUMENTS 파싱

리뷰 시작 시 `$ARGUMENTS`를 파싱하여 `--model <X>`와 `--effort <level>` 인자를 확인한다:

| 상황 | 처리 |
|------|------|
| `--model <X>` 명시 | 모든 `codex-review start` 호출에 `--model "<X>"` 인자 추가 |
| `--model` 미명시 | 인자 생략 (CLI가 `CODEX_REVIEW_MODEL` 환경변수 또는 기본값 `gpt-5.6-terra` 사용) |
| `--effort <level>` 명시 | 모든 `codex-review start` 호출에 `--effort "<level>"` 인자 추가 |
| `--effort` 미명시 | 인자 생략 (wrapper 기본값 `high`) |
| `--tone <level>` 명시 | 해당 레벨을 Layer 1(`{TONE_DIRECTIVE}`)·Layer 2(최종 보고)에 적용(세션 override). codex-review에는 전달하지 않음 |
| `--tone` 미명시 | 설정 파일 `defaultTone`(영속 기본값) 적용, 없으면 `plain` — 아래 "말투(Tone) 단계 처리" 참조 |

### CLI 명령 형식

review-protocol.md **PHASE 1 Step 2**의 `codex-review start` 명령 끝에 지정된 인수를 추가:

```bash
node "{HOME_LITERAL}/.claude/bin/codex-review.mjs" start \
  "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r1_prompt.txt" \
  "{HOME_LITERAL}/.claude/tmp/cr_{SID}_r1_output.txt" \
  --session "cr_{SID}" \
  --review-dir "{HOME_LITERAL}/.claude/tmp" \
  --model "<X>" \
  --effort "<level>"; echo "EXIT_CODE: $?"
```

> **follow-up 자동 처리**: `start`에서 지정한 모델은 `cr_{SID}_state.json`에 저장되어
> 후속 `follow-up` 호출에서 자동 재사용된다. follow-up에 `--model`을 다시 명시할 필요는 없다.
> 단, 라운드별로 다른 모델을 쓰려면 follow-up에도 `--model <X>`를 추가할 수 있다.
> `start`에서 지정한 effort도 저장되어 follow-up에서 자동 재사용된다. 라운드별로 바꾸려면
> follow-up에 `--effort <level>`을 명시한다.

### 최종 리포트에 모델 표시

`codex-review status` 또는 `cr_{SID}_state.json`에서 실제 사용된 모델을 추출하여 최종 리포트의
"심사 모델" / "최종 Verdict" 섹션의 `Codex (gpt-5.6-terra)` 표기를 실제 모델명으로 교체한다.

---

## 말투(Tone) 단계 처리

리뷰 결과의 난이도를 `--tone <level>`로 조절한다. Codex 프롬프트(Layer 1)와 Claude의 한국어 최종 보고(Layer 2) **양쪽**에 적용된다. `--tone`은 **Claude가 소비**하며 `codex-review.mjs`에는 전달하지 않는다.

**적용 레벨 결정 순서**: `--tone` 플래그(세션 override) > 세션 내 발화("쉽게 설명해줘" 등, 세션 override) > 설정 파일 `defaultTone`(영속 기본값) > 내장 기본값 `plain`.

| `--tone` | 이름 | 대상 | 규칙 |
|----------|------|------|------|
| `easy` | 쉽게 | 비개발자 | 전문 용어 배제, 일상어. 코드/파일 세부 최소화 |
| `plain` **(기본 fallback)** | 풀어서 | 일반 개발자 | 개발 용어는 쓰되 IDOR/SSRF/TOCTOU 같은 전문 약어가 처음 나올 때마다 괄호로 풀어 설명 |
| `normal` | 평범하게 | 숙련 개발자 | 전문 용어 그대로, 간결. 풀이 최소 |
| `deep` | 아주 자세히 | 전문가 | 용어 + CWE/CVE + 공격/재현/완화 전체, 최대 상세 |

> `--effort`(추론 강도)와 혼동 금지 — `--tone`은 **가독성/난이도**, `--effort`는 **추론 깊이**다.

### Layer 1 — Codex 프롬프트의 `{TONE_DIRECTIVE}`

프롬프트 템플릿의 `{TONE_DIRECTIVE}` 플레이스홀더를 아래 레벨별 문장으로 치환한다:

- **easy**: `Write every finding (What/Why/Impact) so a non-expert can follow it. Avoid jargon; if a technical term is unavoidable, define it inline in one short clause. Never use an acronym without expanding it.`
- **plain** (기본): `Write for a general developer. You may use ordinary development terms, but the FIRST time any specialized or security acronym appears (e.g. IDOR, SSRF, TOCTOU, XXE, CSRF), expand it inline in parentheses. Keep explanations concrete.`
- **normal**: `Write for an experienced engineer. Use standard technical terminology directly and keep findings concise.`
- **deep**: `Write for an expert reviewer. Use full technical depth — retain CWE/CVE identifiers, exact mechanisms, and attack/repro detail. Be precise and thorough.`

### Layer 2 — Claude 최종 보고

Claude가 한국어 최종 리포트를 쓸 때 위 레벨 규칙을 따른다 (스킬의 "Reporting to the User" 섹션이 레벨별로 분기).

### 기본값 설정 (영속)

`--tone`이 없을 때 쓰는 **영속 기본값**은 설정 파일에 저장한다:

- **파일**: `{HOME_LITERAL}/.claude/codex-review.config.json` (`~/.claude/codex-review.config.json`)
- **형식**: `{ "defaultTone": "easy" | "plain" | "normal" | "deep" }` — 파일이 없거나 값이 유효하지 않으면 `plain`
- **생성**: 플러그인 설치/업데이트 시 codex-code-review `install.sh`가 파일이 없으면 `{"defaultTone": "plain"}`으로 생성하고, **있으면 건드리지 않는다**(유저 설정 보존).
- **읽기**: 리뷰 시작 시 Claude가 이 파일을 1회 읽어 기본값을 확정한다. 세션 초기화의 HOME 확인 Bash 단계에서 함께 확인한다:
  ```bash
  cat "{HOME_LITERAL}/.claude/codex-review.config.json" 2>/dev/null || echo '{}'
  ```
- **기본값 변경**: 사용자가 파일을 직접 편집하거나, "기본 말투 easy로 바꿔줘" 같이 요청하면 Claude가 이 파일의 `defaultTone`을 생성/수정한다(다른 키는 보존). **이 파일은 유저 데이터라 플러그인 재설치/업데이트로 덮이지 않는다.**

### 세션 override / 라운드 간 유지

`--tone` 플래그와 세션 내 발화는 **그 세션에만** 적용되는 override다 — follow-up 라운드에서 유지되지만 **설정 파일(영속 기본값)은 절대 바꾸지 않는다**(Claude가 세션 컨텍스트에서만 기억). 사용자가 세션 중 새 `--tone`/발화를 주면 그 시점부터 세션 값이 바뀐다.

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
- `{DIFF_CONTENT}`: Step 1에서 추출한 diff
- `{PROJECT_CONTEXT}`: 프로젝트 CLAUDE.md
- `{REVIEW_HISTORY}`: (Round 1에서는 비어 있음)
- `{ROUND_NUMBER}`: 1
- `{ROUND_DIRECTIVE}`: (Round 1에서는 비어 있음)
- `{TONE_DIRECTIVE}`: 결정된 말투 레벨(결정 순서: `--tone` > 발화 > 설정 파일 `defaultTone` > `plain`)에 해당하는 문장 (위 "말투(Tone) 단계 처리" 참조)

### Step 3: Codex 실행 (비동기)

review-protocol.md의 실행 규칙을 따른다. v2에서는 **비동기 실행**:

1. `codex-review start` → 워커 spawn, 즉시 반환 (exit 0)
2. `codex-review status` → 30초 간격 폴링 (exit 7=실행중, 0=완료)
3. 묻지 않고 계속 대기, 2분마다 진행 안내 1줄 (turn 지속시간 무제한 — Bash 포그라운드 폴링만, pidAlive/idleMs로 생존 확인)

파일 네이밍: `cr_{SID}_r1_prompt.txt`, `cr_{SID}_r1_output.txt`

> 자세한 폴링/진행 안내 절차는 review-protocol.md **PHASE 1 Step 2** 참조.

### Step 4: 결과 처리

review-protocol.md PHASE 3의 이슈 통합 + 사용자 상호작용 절차를 따른다.

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
- 전체 히스토리 누적 (라운드 수 제한 없음)

### Step 3: 후반 라운드 지시 (Round 3+)

`{ROUND_DIRECTIVE}` 플레이스홀더에 추가:

```
IMPORTANT - Late round review directive:
- Focus ONLY on: (1) verifying fixes for previous issues, (2) regression bugs introduced by fixes
- DO NOT flag LOW severity issues
- DO NOT re-flag deferred issues (listed in Review History as "deferred")
- Keep findings minimal and focused on correctness
```

### Step 4: Codex 실행 (비동기)

Round 1과 동일한 비동기 패턴 (start → status 폴링 → 결과 수집).
단, Round 2+에서는 `follow-up` 명령을 사용하여 동일 Thread를 재사용한다.

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

## 심사 모델
- Codex (gpt-5.6-terra): {라운드별 verdict 요약}
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
| Codex (gpt-5.6-terra) | APPROVE / REVISE / REJECT |
| Opus (선택) | APPROVE / REVISE / REJECT |
| **종합** | **APPROVE / REVISE / REJECT** |
```

---

## 실행 규칙

### 모델 호출

review-protocol.md v2의 비동기 실행 규칙을 적용한다:
- `codex-review` CLI wrapper (`codex-review.mjs` v2) 사용
- **비동기 실행**: `start`/`follow-up` → `status` 폴링 → 결과 수집
- Exit code 기반 에러 처리 (review-protocol.md 참조)
- 묻지 않고 계속 대기, 2분마다 진행 안내 (중단은 사용자가 직접 `/codex-core:halt`)
- canonical 프로젝트 루트 고정, heartbeat 재접속, upstream interrupt, progress 단계/지연 메트릭은 review-protocol.md를 그대로 적용

### 파일 네이밍 (코드 리뷰 전용)

| 파일 | 경로 |
|------|------|
| Round N 프롬프트 | `{REVIEW_DIR}/cr_{SID}_r{N}_prompt.txt` |
| Round N 출력 | `{REVIEW_DIR}/cr_{SID}_r{N}_output.txt` |
| 히스토리 | `{REVIEW_DIR}/cr_{SID}_history.md` |
| Thread 상태 | `{REVIEW_DIR}/cr_{SID}_state.json` |
| Worker 진행 상황 | `{REVIEW_DIR}/cr_{SID}_progress.json` |
| Worker PID | `{REVIEW_DIR}/cr_{SID}_pid` |
| Worker 로그 | `{REVIEW_DIR}/cr_{SID}_worker.log` |

> 코드 리뷰는 `cr_{SID}_*` 패턴을 사용한다.

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
- ❌ 사용자 확인 없이 Opus 교차검증 자동 실행
- ❌ 수렴 조건 미달 시 임의 종료

---

*Related*: `review-protocol.md`, `rule-format.md`
*Last modified*: 2026-04-10

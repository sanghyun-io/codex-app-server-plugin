# codex-app-server-plugin

> 🌐 [README.md (ENG)](./README.md)

**Codex App Server**를 Claude Code에 통합하는 Claude Code 플러그인 마켓플레이스. 새 세션은 GPT-5.6 워크플로 기본값을 사용하며, 모델 오버라이드와 stateful thread + turn 간 컨텍스트 재사용을 지원합니다.

## 플러그인 구성

| 플러그인 | 제공 기능 | 필수 여부 |
|---------|----------|:--------:|
| **codex-core** | Claude Code에서 Codex를 쓰는 데 필요한 모든 것: durable supervisor, 격리 worker, hooks, 자연어 라우터, A+ 작업 위임 (`/codex-core:delegate`), 세션 운영 (`sessions`/`halt`/`readout`) | ✅ |
| **codex-code-review** | 반복 라운드 코드 리뷰 + 공격자 관점 보안 리뷰 워크플로 (`/codex-code-review:code-review`, `/codex-code-review:red-review`) | 선택 |

**codex-core**만 설치해도 "Codex에게 이 버그 고쳐달라고 해" 같은 자연어 발화가 동작합니다 — Claude가 알아서 적절한 스킬로 라우팅합니다.

**codex-code-review**는 그 위에 리뷰 전용 워크플로(라운드별 이슈 추적, deferred 이슈 히스토리, 선택적 Opus 교차검증)를 추가합니다.

## 동작 방식

```
여러 Claude Code 세션
  └─ codex-review.mjs             (호환 명령 클라이언트)
       └─ supervisor.mjs          (durable FIFO queue, 기본 동시 실행 3개)
            └─ job-worker.mjs     (활성 turn마다 격리 worker)
                 └─ codex app-server (작업별 전용 subprocess)
                      └─ gpt-5.6-*   (stateful thread, 모델 변경 가능)
```

Wrapper는 thread 라이프사이클을 세 가지 명령으로 관리합니다:
- `start` — thread 생성 + 첫 turn
- `follow-up` — thread resume + 다음 turn (증분 diff만 전송)
- `close` — 세션 상태 정리

버전 3은 **영속 Supervisor + 격리 Worker** 구조를 사용합니다. Supervisor는 여러 Claude 세션의 작업을 받아 기본 3개까지 병렬 실행하고, 같은 Codex thread의 follow-up은 직렬화합니다. 활성 turn마다 전용 `codex app-server`를 사용하므로 transport나 subprocess 장애는 해당 작업에만 영향을 줍니다. 작업과 부분 출력은 `~/.claude/codex-runtime/v3`에 journal로 남으며, Supervisor가 교체돼도 실행 중 worker는 독립적으로 계속 동작합니다. 복구 가능한 app-server 장애는 현재 turn만 제한적으로 재실행합니다. 일시적 thread-resume 오류는 버리지 않고 같은 thread로 재시도하며, follow-up은 직전 turn이 취소(예: `halt`)되거나 실패했어도 세션의 마지막 완료 thread를 재개합니다. `SessionEnd`는 v3 작업을 취소하지 않으며 명시적인 `cancel` 또는 `halt`만 작업을 중단합니다.

각 세션은 canonical Git 프로젝트 루트에 고정되며 동일한 `cwd`가 `thread/start`와 `turn/start`에 전달됩니다. 다른 프로젝트에서 follow-up하면 Codex 호출 전에 실패합니다. progress JSON에는 연결/모델 검증/thread 시작/최초 출력 대기/스트리밍 단계와 프롬프트 크기, 최초 출력 지연, 수신 글자 수, protocol ID, turn 생존 신호(`pidAlive`, `idleMs`, `lastActivityAt` — worker가 ~3초마다 checkpoint)가 기록됩니다. 기본적으로 **turn 지속시간 타임아웃이 없습니다**: 출력이 없는 긴 추론(예: ultra effort)은 시계가 아니라 생존 신호로만 판단하며, 상한이 필요하면 `--timeout`/`CODEX_REVIEW_TIMEOUT`로 opt-in합니다. 상태는 포그라운드 `status` 호출로만 폴링합니다 — durable worker가 이미 분리 실행되므로 codex-review 명령을 다른 도구로 백그라운드 처리하지 않습니다(`reconnectCount`는 레거시 broker 경로에서만 나타남). 131,072자를 초과하는 프롬프트는 자르지 않고 그대로 전달하며 지연 경고만 남깁니다.

호출별 모델과 추론 effort를 변경할 수 있습니다. 모델 우선순위는 CLI 플래그 > 환경변수 > 워크플로 기본값 > wrapper 기본값 `gpt-5.6-terra`이며, effort 기본값은 `high`입니다:

```bash
# CLI 플래그
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-5.6-sol --effort max

# 환경변수
CODEX_REVIEW_MODEL=gpt-5.6-luna node codex-review.mjs start ...
```

### 환경변수

| 변수 | 용도 | 기본값 |
|------|------|--------|
| `CODEX_REVIEW_MODEL` | 워크플로/wrapper 모델 오버라이드 | unset (wrapper 기본값: `gpt-5.6-terra`) |
| `CODEX_REVIEW_CONCURRENCY` | 동시에 실행할 수 있는 서로 다른 v3 작업 수 | `3` |
| `CODEX_REVIEW_RUNTIME_DIR` | durable v3 runtime 디렉터리 변경 | `~/.claude/codex-runtime/v3` |
| `CODEX_REVIEW_NO_BROKER` | v2 호환용으로 허용; v3는 공유 broker를 사용하지 않음 | unset |
| `CODEX_BINARY` | `codex app-server` 대신 사용할 커스텀 바이너리 경로 (테스트용) | unset |

## 사전 요구사항

- [Claude Code](https://claude.ai/code) v1.x+
- [Node.js](https://nodejs.org) v18+
- [codex CLI](https://github.com/openai/codex) — ChatGPT 계정으로 로그인 (`codex login`)

## 설치

```bash
# 1. 마켓플레이스 추가
/plugin marketplace add sanghyun-io/codex-app-server-plugin

# 2. core 설치 (자연어 + delegate + 세션 운영 제공)
/plugin install codex-core@sanghyun-io

# 3. (선택) 코드 리뷰 워크플로 설치
/plugin install codex-code-review@sanghyun-io

# 4. 검증
/codex-core:setup
```

`codex-core` install hook은 `~/.claude/CLAUDE.md`에 마커 블록을 append하여 규칙을 자동 활성화합니다. 블록은 idempotent하므로 재실행해도 안전합니다.

### 업데이트

`/plugin`으로 플러그인을 업데이트하면 **플러그인 캐시**가 갱신됩니다. 단, Claude가 실제로 읽는 규칙 파일은 `~/.claude/rules/*.md`에 있고(스킬이 캐시가 아니라 이곳에서 `@import`합니다), install hook이 업데이트 시 이곳으로 복사하므로 대부분의 경우 새 규칙이 자동으로 적용됩니다.

> 반드시 필요한 것은 아니지만, **업데이트 후 `/codex-core:setup`을 한 번 실행하면 안전합니다.** 캐시와 `~/.claude/rules/`를 비교(diff)하여 변경된 파일만 다시 복사하므로, hook이 실행되지 않았더라도 최신 규칙이 확실히 활성화됩니다.

## Plugin: codex-core

런타임 + 범용 워크플로. CLI, durable supervisor, 격리 worker, hook 스크립트, 스키마, 자연어 라우터, A+ 위임, 세션 운영을 설치합니다.

### 설치 파일

| 파일 | 위치 | 용도 |
|------|------|------|
| `codex-review.mjs` | `~/.claude/bin/` | JSON-RPC wrapper CLI |
| `supervisor.mjs` | `~/.claude/bin/` | 다중 세션 durable queue와 자동 복구 |
| `job-worker.mjs` | `~/.claude/bin/` | 작업별 격리 app-server 실행기 |
| `broker.mjs` | `~/.claude/bin/` | 실행 중인 v2 작업의 업그레이드 호환용 broker |
| `lib/project-scope.mjs` | `~/.claude/bin/lib/` | canonical 프로젝트 루트 고정 및 비교 |
| `session-lifecycle.mjs` | `~/.claude/bin/` | SessionStart/SessionEnd 핸들러 (v3 durable 작업 유지) |
| `stop-gate.mjs` | `~/.claude/bin/` | Stop hook 품질 게이트 (진행 중 리뷰 / 미커밋 변경 차단) |
| `review-output.schema.json` | `~/.claude/schemas/` | 구조화된 리뷰 출력 JSON 스키마 |
| `review-protocol.md` | `~/.claude/rules/` | 공통 호출 프로토콜 (세션 ID, 폴링, 에러 처리) |
| `codex-delegation.md` | `~/.claude/rules/` | 자연어 의도 라우터 |
| `codex-delegate.md` | `~/.claude/rules/` | A+ 작업 위임 워크플로 |
| `codex-session-ops.md` | `~/.claude/rules/` | 세션 list / cancel / readout |

### Hook 이벤트

| 이벤트 | 스크립트 | 용도 |
|-------|---------|------|
| `Setup` | `scripts/install.sh` | bin/schemas/rules를 `~/.claude/`에 복사, CLAUDE.md 마커 블록 관리 |
| `SessionStart` | `session-lifecycle.mjs start` | 워커 조정용 세션 메타데이터 export |
| `SessionEnd` | `session-lifecycle.mjs end` | v3 durable 작업은 유지하고 legacy 세션 소유 worker만 정리 |
| `Stop` | `stop-gate.mjs` | 진행 중 리뷰가 있거나 미리뷰 변경이 있으면 세션 stop 차단 |

### 스킬

| 스킬 | 호출 | 설명 |
|------|------|------|
| Setup | `/codex-core:setup` | Node, codex CLI, 인증, 설치 파일 검증 |
| Delegate | `/codex-core:delegate <task>` | A+ 작업 위임 — Codex가 제안하면 Claude가 적용 |
| Sessions | `/codex-core:sessions` | 모든 Codex 세션 목록 (실행 중 + 완료) |
| Halt | `/codex-core:halt` | 실행 중 Codex 세션 취소 |
| Readout | `/codex-core:readout` | 완료된 세션의 출력 + 메타데이터 표시 |

### 자연어 라우터

`codex-delegation.md`가 import된 상태(설치 시 자동 활성화)에서는 Claude가 Codex 관련 요청을 자연어로 라우팅합니다 — 슬래시 명령 불필요.

| 발화 예시 | 라우팅 대상 |
|----------|-----------|
| "Codex에게 이 버그 고쳐달라고 해" / "Let Codex fix the race condition" | `delegate` |
| "Codex에게 이 함수가 왜 느린지 물어봐" (read-only) | `delegate --read-only` |
| "Codex 세션 뭐 돌아가고 있어?" / "What Codex sessions are running" | `sessions` |
| "Codex 지금 거 중단해" / "Stop the Codex session" | `halt` |
| "Codex 그 결과 다시 보여줘" / "Show me that Codex output" | `readout` |
| "Codex에게 **gpt-5.6-sol로** 부탁" / "Have Codex **with gpt-5.6-sol**" | (모든 의도) `--model gpt-5.6-sol` |
| "Codex에게 **gpt-5.6-sol max 로** 부탁" / "Have Codex **with gpt-5.6-sol at max effort**" | (모든 의도) `--model gpt-5.6-sol --effort max` |
| "**o1 써서** 검토" / "Ask Codex **using o1**" | (모든 의도) `--model o1` |

의도가 모호하면 Claude는 추측 대신 `AskUserQuestion`으로 확인을 받습니다.

코드 리뷰 의도(`/codex-code-review:code-review`, `/codex-code-review:red-review`)는 `codex-code-review`가 설치되어 있을 때만 정확히 라우팅됩니다.

### 모델 및 effort 오버라이드

모든 Codex 기반 스킬은 `--model <name>`과 `--effort <level>`을 받습니다. 모델 우선순위:

1. `--model <name>` CLI 플래그 (최우선)
2. `CODEX_REVIEW_MODEL` 환경변수
3. 워크플로 기본값
4. wrapper 기본값 (`gpt-5.6-terra`)

| 워크플로 | 기본 모델 |
|----------|-----------|
| `red-review` | `gpt-5.6-sol` |
| `code-review` | `gpt-5.6-terra` |
| 일반 `delegate` | `gpt-5.6-terra` |
| `delegate --read-only` | `gpt-5.6-luna` |

Wrapper는 thread를 생성하거나 resume하기 전에 인증 계정의 `model/list`를 확인합니다. 요청 모델을 사용할 수 없으면 fallback하지 않고 종료하며 사용 가능한 모델명을 출력합니다. 기존 세션은 follow-up에서도 저장된 모델을 유지합니다.

effort 값은 `low`, `medium`, `high`, `xhigh`, `max`, `ultra`를 인식합니다. 자연어에서는 `gpt-5.6-sol max 로`, `max effort로`, `추론 강도 ultra` 같은 표현을 `--effort`로 변환합니다. 선택된 effort는 후속 turn에서도 자동 재사용되며 새 값을 명시하면 그 turn부터 변경됩니다.

`code-review`와 `red-review`는 추가로 `--tone <level>`을 받습니다 — `easy`(비개발자), `plain`(기본값), `normal`, `deep` — 리뷰 결과의 가독성/난이도를 조절합니다. `--effort`와는 구분됩니다(가독성 vs 추론 깊이): `--tone`은 Codex 리뷰 프롬프트와 Claude의 한국어 최종 보고 양쪽을 조정하며(`easy`/`plain`에서는 IDOR/SSRF 같은 약어를 인라인으로 풀어 설명), CLI로 전달되지 않고 Claude가 처리합니다. 영속 기본값은 `~/.claude/codex-review.config.json`의 `defaultTone`에 저장됩니다(없으면 `plain`). `--tone`과 세션 내 발화는 그 세션에만 적용되는 override이며 이 파일을 바꾸지 않습니다.

자연어 모델 추출 시 인식되는 prefix: `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`, `gemini-*`. 선택된 모델은 thread의 `state.json`에 저장되어 follow-up turn에서 자동 재사용됩니다.

### A+ 위임 패턴

`delegate`는 **Codex = 두뇌 / Claude = 손** 구조를 사용합니다:

1. Codex가 작업을 분석하고 구체적인 변경안(unified diff 또는 구조화된 JSON)을 반환합니다.
2. Claude가 `Edit` / `Write`로 변경안을 적용하고, 검증을 실행하고, 결과를 캡처합니다.
3. Claude가 적용 결과 요약을 담은 `follow-up` turn을 보냅니다. Codex thread는 이전 컨텍스트를 기억하므로 델타만 전송됩니다.
4. Codex가 `DONE`을 선언할 때까지 반복한 뒤, thread를 `close`합니다.

이 구조 덕분에 파일 쓰기는 Claude의 도구 권한 통제 하에 두면서도 Codex가 계획을 주도할 수 있습니다.

### 예시

```
/codex-core:delegate Fix the null pointer in UserService.login
/codex-core:delegate Refactor auth middleware to use JWT --model gpt-5.6-sol --effort max
/codex-core:delegate Why is /api/v1/users returning 500 --read-only

/codex-core:sessions            # 모든 세션 목록
/codex-core:sessions --running  # 실행 중만
/codex-core:halt                # 실행 중 세션 중에서 선택해 취소
/codex-core:halt cr_1728473812_9876
/codex-core:readout             # 완료된 세션 중에서 선택해 조회
/codex-core:readout dg_1728473812_9876
```

## Plugin: codex-code-review (선택)

codex-core 위에 올라가는 반복 + 공격자 관점 코드 리뷰 워크플로.

> **선행 조건**: `codex-core`가 먼저 설치되어 있어야 합니다.

### 설치 파일

| 파일 | 위치 | 용도 |
|------|------|------|
| `codex-code-review.md` | `~/.claude/rules/` | 반복 코드 리뷰 워크플로 |
| `codex-red-review.md` | `~/.claude/rules/` | 공격자 관점(보안) 리뷰 워크플로 |

Install hook이 `~/.claude/CLAUDE.md`에 별도 마커 블록(`<!-- @codex-code-review:begin -->`)을 추가합니다.

### 스킬

| 스킬 | 호출 | 설명 |
|------|------|------|
| Code Review | `/codex-code-review:code-review` | 반복 라운드 코드 리뷰 |
| Red Review | `/codex-code-review:red-review` | 공격자 관점, 보안 중심 리뷰 |

### Code Review

```
/codex-code-review:code-review                  # 현재 브랜치 vs default 브랜치
/codex-code-review:code-review PR#123           # 특정 PR 리뷰
/codex-code-review:code-review --base main      # 특정 base 기준 리뷰
/codex-code-review:code-review --model gpt-5.6-sol --effort max   # Codex 모델/effort 오버라이드
/codex-code-review:code-review --with-opus      # Claude Opus 교차검증 추가
```

### Red Review

```
/codex-code-review:red-review                   # 현재 브랜치 공격자 관점 리뷰
/codex-code-review:red-review PR#123            # PR 공격자 관점 리뷰
/codex-code-review:red-review --model gpt-5.6-sol --effort ultra  # Codex 모델/effort 오버라이드
/codex-code-review:red-review --with-opus       # Claude Opus 교차검증 추가
```

## Exit Code

| Code | 의미 | 동작 |
|------|------|------|
| 0 | 성공 | 정상 흐름 |
| 1 | codex 미발견 | 자동 스킵 |
| 2 | 인증 실패 | 자동 스킵 + `codex login` 안내 |
| 3 | Rate limit | 자동 스킵 |
| 4 | 재개할 완료 turn 없음 (롤아웃 미저장) | status 재폴링(일시 오류는 같은 thread로 자동 재시도); 완료 이력이 전혀 없을 때만 새 thread 시작 |
| 5 | Turn 타임아웃 (`--timeout`/`CODEX_REVIEW_TIMEOUT` 지정 시에만) | 부분 출력 저장 |
| 6 | 프로세스 에러 | 1회 재시도 후 스킵 |
| 7 | Turn 진행 중 | (status 명령 한정) |
| 8 | Turn 취소됨 | 부분 출력 저장 |

## v1.x에서 업그레이드

기존에 `codex-review-core` 또는 `codex-review-rules`를 설치한 적이 있다면, 플러그인 이름 변경, 기능 재배치, 슬래시 명령 변경, 마이그레이션 절차는 [v1_README.md](./v1_README.md)를 참고하세요.

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)

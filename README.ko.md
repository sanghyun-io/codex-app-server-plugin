# codex-app-server-plugin

> 🌐 [README.md (ENG)](./README.md)

**Codex App Server**를 Claude Code에 통합하는 Claude Code 플러그인 마켓플레이스. 새 세션은 GPT-5.6 워크플로 기본값을 사용하며, 모델 오버라이드와 stateful thread + turn 간 컨텍스트 재사용을 지원합니다.

## 플러그인 구성

| 플러그인 | 제공 기능 | 필수 여부 |
|---------|----------|:--------:|
| **codex-core** | Claude Code에서 Codex를 쓰는 데 필요한 모든 것: CLI 런타임, broker, hooks, 자연어 라우터, A+ 작업 위임 (`/codex-core:delegate`), 세션 운영 (`sessions`/`halt`/`readout`) | ✅ |
| **codex-code-review** | 반복 라운드 코드 리뷰 + 공격자 관점 보안 리뷰 워크플로 (`/codex-code-review:code-review`, `/codex-code-review:red-review`) | 선택 |

**codex-core**만 설치해도 "Codex에게 이 버그 고쳐달라고 해" 같은 자연어 발화가 동작합니다 — Claude가 알아서 적절한 스킬로 라우팅합니다.

**codex-code-review**는 그 위에 리뷰 전용 워크플로(라운드별 이슈 추적, deferred 이슈 히스토리, 선택적 Opus 교차검증)를 추가합니다.

## 동작 방식

```
Claude Code
  └─ codex-review.mjs              (JSON-RPC wrapper — codex-core가 설치)
       └─ broker.mjs (TCP, opt-out) (영속 IPC 직렬화 — auth 캐시, warm app-server)
            └─ codex app-server      (단일 subprocess, 모든 워커가 공유)
                 └─ gpt-5.6-*          (stateful thread, 모델 변경 가능)
```

Wrapper는 thread 라이프사이클을 세 가지 명령으로 관리합니다:
- `start` — thread 생성 + 첫 turn
- `follow-up` — thread resume + 다음 turn (증분 diff만 전송)
- `close` — 세션 상태 정리

기본적으로 워커는 **영속 broker**(`broker.mjs`)를 통해 연결됩니다. broker는 localhost TCP 포트에서 단일 warm `codex app-server` subprocess를 유지해, turn마다 발생하는 spawn 오버헤드(~2–3초)를 제거하고 모든 워커가 단일 auth 체크를 재사용하게 합니다. broker는 첫 사용 시 자동 시작되고, 10분 idle 후 종료되며, `SessionEnd` hook으로도 정리됩니다. `CODEX_REVIEW_NO_BROKER=1`을 설정하면 broker를 거치지 않고 `codex app-server`를 직접 spawn합니다 (테스트 용도).

호출별 모델은 변경 가능합니다 (우선순위: CLI 플래그 > 환경변수 > 워크플로 기본값 > wrapper 기본값 `gpt-5.6-terra`):

```bash
# CLI 플래그
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-5.6-sol

# 환경변수
CODEX_REVIEW_MODEL=gpt-5.6-luna node codex-review.mjs start ...
```

### 환경변수

| 변수 | 용도 | 기본값 |
|------|------|--------|
| `CODEX_REVIEW_MODEL` | 워크플로/wrapper 모델 오버라이드 | unset (wrapper 기본값: `gpt-5.6-terra`) |
| `CODEX_REVIEW_NO_BROKER` | broker 생략, `codex app-server` 직접 spawn (`1`로 설정) | unset |
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

런타임 + 범용 워크플로. CLI 바이너리, broker, hook 스크립트, 스키마, 자연어 라우터, A+ 위임, 세션 운영을 설치합니다.

### 설치 파일

| 파일 | 위치 | 용도 |
|------|------|------|
| `codex-review.mjs` | `~/.claude/bin/` | JSON-RPC wrapper CLI |
| `broker.mjs` | `~/.claude/bin/` | IPC 직렬화용 영속 TCP broker |
| `session-lifecycle.mjs` | `~/.claude/bin/` | SessionStart/SessionEnd 핸들러 (워커 + broker cleanup) |
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
| `SessionEnd` | `session-lifecycle.mjs end` | 실행 중인 워커 종료, broker 셧다운, 임시 파일 정리 |
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
| "**o1 써서** 검토" / "Ask Codex **using o1**" | (모든 의도) `--model o1` |

의도가 모호하면 Claude는 추측 대신 `AskUserQuestion`으로 확인을 받습니다.

코드 리뷰 의도(`/codex-code-review:code-review`, `/codex-code-review:red-review`)는 `codex-code-review`가 설치되어 있을 때만 정확히 라우팅됩니다.

### 모델 오버라이드

모든 Codex 기반 스킬은 `--model <name>`을 받습니다. 우선순위:

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

자연어 추출 시 인식되는 prefix: `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`, `gemini-*`. 선택된 모델은 thread의 `state.json`에 저장되어 follow-up turn에서 자동 재사용됩니다.

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
/codex-core:delegate Refactor auth middleware to use JWT --model gpt-5.6-sol
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
/codex-code-review:code-review --model gpt-5.6-sol   # Codex 모델 오버라이드
/codex-code-review:code-review --with-opus      # Claude Opus 교차검증 추가
```

### Red Review

```
/codex-code-review:red-review                   # 현재 브랜치 공격자 관점 리뷰
/codex-code-review:red-review PR#123            # PR 공격자 관점 리뷰
/codex-code-review:red-review --model o1        # Codex 모델 오버라이드
/codex-code-review:red-review --with-opus       # Claude Opus 교차검증 추가
```

## Exit Code

| Code | 의미 | 동작 |
|------|------|------|
| 0 | 성공 | 정상 흐름 |
| 1 | codex 미발견 | 자동 스킵 |
| 2 | 인증 실패 | 자동 스킵 + `codex login` 안내 |
| 3 | Rate limit | 자동 스킵 |
| 4 | Thread resume 실패 | 새 thread로 재시도 |
| 5 | Turn 타임아웃 (30분 safety net) | 부분 출력 저장 |
| 6 | 프로세스 에러 | 1회 재시도 후 스킵 |
| 7 | Turn 진행 중 | (status 명령 한정) |
| 8 | Turn 취소됨 | 부분 출력 저장 |

## v1.x에서 업그레이드

기존에 `codex-review-core` 또는 `codex-review-rules`를 설치한 적이 있다면, 플러그인 이름 변경, 기능 재배치, 슬래시 명령 변경, 마이그레이션 절차는 [v1_README.md](./v1_README.md)를 참고하세요.

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)

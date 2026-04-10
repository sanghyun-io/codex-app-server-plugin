---
name: setup
description: Setup and verify Codex App Server Plugin. Checks Node.js, codex CLI, authentication, and installed files. Run after plugin installation.
invocation:
  command: setup
  user_invocable: true
---

# Codex App Server Plugin — Setup

Guide the user through verifying the complete plugin installation step by step.

---

## Step 1: Check and Update Files

Use Bash to locate plugin cache files dynamically (version-independent):

```bash
CORE_ROOT=$(find ~/.claude/plugins/cache/sanghyun-io/codex-review-core -type d -name "bin" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
RULES_DIR=$(find ~/.claude/plugins/cache/sanghyun-io/codex-review-rules -type d -name "rules" 2>/dev/null | head -1)
echo "CORE_ROOT=$CORE_ROOT"
echo "RULES_DIR=$RULES_DIR"
```

**If Bash is unavailable** (permission denied / don't ask mode):
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `ls ~/.claude/bin/codex-review.mjs ~/.claude/rules/review-protocol.md`"
- Proceed to Step 2.

**If CORE_ROOT or RULES_DIR is empty**: Stop and report:
```
Plugin cache not found. Please reinstall:
  claude plugin install codex-review-core@sanghyun-io
  claude plugin install codex-review-rules@sanghyun-io
```

**Compare each file against cache using Bash**:

```bash
INSTALLED_BIN_DIR="$HOME/.claude/bin"
INSTALLED_SCHEMA_DIR="$HOME/.claude/schemas"
INSTALLED_RULES="$HOME/.claude/rules"

# core bin files
for name in codex-review.mjs broker.mjs; do
  src="$CORE_ROOT/bin/$name"
  dest="$INSTALLED_BIN_DIR/$name"
  [ -f "$src" ] || continue
  if [ ! -f "$dest" ]; then
    echo "MISSING: $name"
  elif diff -q "$src" "$dest" > /dev/null 2>&1; then
    echo "MATCH: $name"
  else
    echo "DIFFER: $name"
  fi
done

# lifecycle scripts
for name in session-lifecycle.mjs stop-gate.mjs; do
  src="$CORE_ROOT/scripts/$name"
  dest="$INSTALLED_BIN_DIR/$name"
  [ -f "$src" ] || continue
  if [ ! -f "$dest" ]; then
    echo "MISSING: $name"
  elif diff -q "$src" "$dest" > /dev/null 2>&1; then
    echo "MATCH: $name"
  else
    echo "DIFFER: $name"
  fi
done

# schemas
for name in review-output.schema.json; do
  src="$CORE_ROOT/schemas/$name"
  dest="$INSTALLED_SCHEMA_DIR/$name"
  [ -f "$src" ] || continue
  if [ ! -f "$dest" ]; then
    echo "MISSING: $name"
  elif diff -q "$src" "$dest" > /dev/null 2>&1; then
    echo "MATCH: $name"
  else
    echo "DIFFER: $name"
  fi
done

# rules files (all .md in the rules cache dir)
if [ -d "$RULES_DIR" ]; then
  for src in "$RULES_DIR"/*.md; do
    [ -f "$src" ] || continue
    name=$(basename "$src")
    dest="$INSTALLED_RULES/$name"
    if [ ! -f "$dest" ]; then
      echo "MISSING: $name"
    elif diff -q "$src" "$dest" > /dev/null 2>&1; then
      echo "MATCH: $name"
    else
      echo "DIFFER: $name"
    fi
  done
fi
```

**결과별 처리**:

| 상태 | 표시 | 처리 |
|------|------|------|
| MATCH | `✓ {filename} — 최신` | 넘어감 |
| MISSING | `✗ {filename} — 미설치` | 즉시 캐시에서 복사 |
| DIFFER | `⚠️ {filename} — 구버전 감지` | 아래 질문으로 처리 |

DIFFER 파일이 하나라도 있으면 **AskUserQuestion**:

```json
{
  "questions": [{
    "question": "설치된 파일 중 캐시와 다른 버전이 감지되었습니다. 업데이트할까요?\n\n{DIFFER_LIST}",
    "header": "파일 업데이트",
    "multiSelect": false,
    "options": [
      {"label": "업데이트", "description": "캐시 버전으로 덮어씁니다"},
      {"label": "건너뛰기", "description": "현재 설치된 파일을 유지합니다"}
    ]
  }]
}
```

"업데이트" 또는 MISSING 파일 복사 시 — Bash로 설치:

```bash
mkdir -p ~/.claude/bin ~/.claude/schemas ~/.claude/rules

# core bin files
cp "$CORE_ROOT/bin/codex-review.mjs" ~/.claude/bin/ && chmod +x ~/.claude/bin/codex-review.mjs
[ -f "$CORE_ROOT/bin/broker.mjs" ] && cp "$CORE_ROOT/bin/broker.mjs" ~/.claude/bin/ && chmod +x ~/.claude/bin/broker.mjs

# lifecycle scripts
for name in session-lifecycle.mjs stop-gate.mjs; do
  [ -f "$CORE_ROOT/scripts/$name" ] && cp "$CORE_ROOT/scripts/$name" ~/.claude/bin/ && chmod +x ~/.claude/bin/$name
done

# schemas
[ -f "$CORE_ROOT/schemas/review-output.schema.json" ] && cp "$CORE_ROOT/schemas/review-output.schema.json" ~/.claude/schemas/

# rules (copy every *.md from the cache)
if [ -d "$RULES_DIR" ]; then
  for src in "$RULES_DIR"/*.md; do
    [ -f "$src" ] && cp "$src" ~/.claude/rules/
  done
fi

echo "✓ Files installed/updated"
```

모든 파일이 MATCH이거나 업데이트 완료 시: "✓ Plugin files up to date" 표시 후 Step 2로 진행.

---

## Step 2: Check Node.js

Try with Bash — check version and path together:

```bash
IS_WSL=$(uname -r 2>/dev/null | grep -qi microsoft && echo "YES" || echo "NO")
NODE_PATH=$(which node 2>/dev/null || echo "NOT_FOUND")
NODE_VER=$(node --version 2>/dev/null || echo "NOT_FOUND")
echo "WSL=$IS_WSL PATH=$NODE_PATH VER=$NODE_VER"
```

**If Bash is unavailable** (permission denied / don't ask mode):
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `node --version` (v18+ required)"
- Proceed to Step 3.

**If NOT_FOUND**: Show "❌ Node.js is required (v18+). Install from https://nodejs.org" and stop.

**If WSL=YES and PATH starts with `/mnt/`**:
- Show: "❌ WSL 환경에서 Windows에 설치된 Node.js가 감지됩니다 (`{PATH}`). WSL 내부에 Linux 네이티브 Node.js를 설치해야 합니다."
- Guide:
  ```
  # nvm으로 설치 (권장)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
  source ~/.bashrc
  nvm install --lts

  # 또는 apt로 설치
  sudo apt update && sudo apt install nodejs npm
  ```
- Stop and wait.

**If found with Linux-native path**: Show "✓ Node.js {version}"

---

## Step 3: Check codex CLI

Try with Bash — check path to detect Windows vs Linux install:

```bash
CODEX_PATH=$(which codex 2>/dev/null || echo "NOT_FOUND")
CODEX_VER=$(codex --version 2>/dev/null || echo "NOT_FOUND")
echo "PATH=$CODEX_PATH VER=$CODEX_VER"
```

**If Bash is unavailable**:
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `which codex` and confirm the path does not start with `/mnt/`"
- Proceed to Step 4.

**If PATH starts with `/mnt/`** (Windows 설치본이 WSL에서 실행됨):
- Show: "❌ Windows에 설치된 codex가 감지됩니다 (`{PATH}`). WSL Linux 환경에서는 Linux 네이티브 codex가 필요합니다."
- Guide:
  ```
  npm install -g @openai/codex@latest
  ```
- Stop and wait for user to reinstall, then re-run setup.

**If NOT_FOUND**:
Ask the user using AskUserQuestion:

```json
{
  "questions": [{
    "question": "codex CLI가 설치되어 있지 않습니다. 어떻게 하시겠어요?",
    "header": "codex CLI",
    "multiSelect": false,
    "options": [
      {"label": "지금 설치 (npm install -g @openai/codex@latest)", "description": "현재 환경의 npm으로 Linux 네이티브 codex를 설치합니다"},
      {"label": "수동으로 설치하겠습니다", "description": "터미널에서 직접 설치 후 다시 실행합니다"},
      {"label": "건너뛰기", "description": "나중에 설치합니다 (플러그인 기능이 동작하지 않습니다)"}
    ]
  }]
}
```

If "지금 설치": Run `npm install -g @openai/codex@latest` then re-verify path and version.

**If found with Linux-native path**: Show "✓ codex CLI {version}"

---

## Step 4: Check Authentication

Ask the user using AskUserQuestion:

```json
{
  "questions": [{
    "question": "codex 인증 상태를 확인합니다.",
    "header": "인증",
    "multiSelect": false,
    "options": [
      {"label": "이미 로그인했습니다", "description": "다음 단계로 진행합니다"},
      {"label": "아직 로그인하지 않았습니다", "description": "codex login 방법을 안내합니다"}
    ]
  }]
}
```

**If "아직 로그인하지 않았습니다"**:
Show and stop:
```
터미널에서 다음을 실행하세요:

  BROWSER=/bin/false codex login

완료 후 /codex-review-core:setup 을 다시 실행하세요.
```

**If "이미 로그인했습니다"**: Proceed to Step 5.

---

## Step 5: Check CLAUDE.md Rules Import (read-only, no auto-edit)

> **⛔ 중요**: 이 단계는 **절대 `~/.claude/CLAUDE.md`를 수정하지 않는다**.
> CLAUDE.md는 사용자가 수시로 편집하는 파일이라 플러그인이 append/재배치하면
> 중복·위치 충돌·소유권 모호 문제가 발생한다. 확인만 하고 안내만 한다.

Use the **Read tool** to read `~/.claude/CLAUDE.md`.
Check which of the following import lines are already present:

- `@~/.claude/rules/review-protocol.md`
- `@~/.claude/rules/codex-delegation.md`
- `@~/.claude/rules/codex-code-review.md`
- `@~/.claude/rules/codex-red-review.md`
- `@~/.claude/rules/codex-delegate.md`
- `@~/.claude/rules/codex-session-ops.md`

**If `review-protocol.md` is already imported**: Show "✓ Rules imported in CLAUDE.md" plus a list of which specific rules are currently active.

**If `review-protocol.md` is NOT imported**, show this message (no AskUserQuestion, no edit):

```
⚠️ CLAUDE.md에 플러그인 rules가 import되어 있지 않습니다.

다음 내용을 직접 복사해서 ~/.claude/CLAUDE.md 에 추가해주세요.
필요한 것만 골라 추가하면 됩니다 — review-protocol은 필수, 나머지는 선택입니다.

  # 필수 (공통 프로토콜 + 자연어 라우터)
  @~/.claude/rules/review-protocol.md
  @~/.claude/rules/codex-delegation.md

  # 선택 (사용하려는 워크플로만 추가)
  @~/.claude/rules/codex-code-review.md      # 일반 코드 리뷰
  @~/.claude/rules/codex-red-review.md       # 공격자 관점 리뷰
  @~/.claude/rules/codex-delegate.md         # A+ 작업 위임
  @~/.claude/rules/codex-session-ops.md      # sessions/halt/readout
```

**If `review-protocol.md` is imported but some of the new rules are missing**, show:

```
✓ review-protocol.md imported.

ℹ️ 추가로 활성화할 수 있는 rules가 있습니다. 필요한 것만 직접 추가해주세요:

  {missing list}
```

> **금지**: Edit/Write 도구로 `~/.claude/CLAUDE.md`를 수정하지 말 것.
> 안내 출력만으로 Step 5를 끝낸다.

---

## Step 6: Setup Complete

Show the final summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Codex App Server Plugin — Setup Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

설치된 항목:
  ✓ ~/.claude/bin/codex-review.mjs
  ✓ ~/.claude/bin/broker.mjs
  ✓ ~/.claude/bin/session-lifecycle.mjs
  ✓ ~/.claude/bin/stop-gate.mjs
  ✓ ~/.claude/schemas/review-output.schema.json
  ✓ ~/.claude/rules/*.md (review-protocol, codex-delegation,
    codex-code-review, codex-red-review, codex-delegate,
    codex-session-ops)

사용 방법:
  • 코드 리뷰:      /codex-review-rules:code-review
  • 공격자 리뷰:    /codex-review-rules:red-review
  • 작업 위임:      /codex-review-rules:delegate <task>
  • 세션 목록:      /codex-review-rules:sessions
  • 세션 중단:      /codex-review-rules:halt
  • 결과 조회:      /codex-review-rules:readout
  • 설정 재확인:    /codex-review-core:setup

자연어 트리거:
  "Codex에게 리뷰 부탁해" / "Codex에게 이 버그 고쳐달라고 해"
  같은 자연어도 codex-delegation 라우터가 감지해서 적절한 스킬로
  연결됩니다. (review-protocol + codex-delegation이 CLAUDE.md에
  import되어 있어야 동작합니다.)

모델: gpt-5.4 (Stateful Thread 방식, --model 플래그로 오버라이드 가능)
브로커: 기본 활성화 (CODEX_REVIEW_NO_BROKER=1 로 비활성화 가능)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

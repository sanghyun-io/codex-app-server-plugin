---
name: setup
description: Setup and verify codex-core (and optional codex-code-review). Checks Node.js, codex CLI, authentication, and installed files. Run after plugin installation.
invocation:
  command: setup
  user_invocable: true
---

# codex-core — Setup

Guide the user through verifying the complete plugin installation step by step.

---

## Step 1: Check and Update Files

Use Bash to locate plugin cache files dynamically (version-independent):

```bash
CORE_ROOT=$(find ~/.claude/plugins/cache/sanghyun-io/codex-core -type d -name "bin" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
REVIEW_ROOT=$(find ~/.claude/plugins/cache/sanghyun-io/codex-code-review -type d -name "rules" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
echo "CORE_ROOT=$CORE_ROOT"
echo "REVIEW_ROOT=$REVIEW_ROOT  (optional — may be empty if not installed)"
```

**If Bash is unavailable** (permission denied / don't ask mode):
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `ls ~/.claude/bin/codex-review.mjs ~/.claude/rules/review-protocol.md`"
- Proceed to Step 2.

**If CORE_ROOT is empty**: Stop and report:
```
codex-core cache not found. Please reinstall:
  /plugin install codex-core@sanghyun-io
```

`REVIEW_ROOT` empty is OK — `codex-code-review` is optional.

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

# core rules (review-protocol, codex-delegation, codex-delegate, codex-session-ops)
if [ -d "$CORE_ROOT/rules" ]; then
  for src in "$CORE_ROOT/rules"/*.md; do
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

# code-review rules (only if installed)
if [ -n "$REVIEW_ROOT" ] && [ -d "$REVIEW_ROOT/rules" ]; then
  for src in "$REVIEW_ROOT/rules"/*.md; do
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

# core rules
if [ -d "$CORE_ROOT/rules" ]; then
  for src in "$CORE_ROOT/rules"/*.md; do
    [ -f "$src" ] && cp "$src" ~/.claude/rules/
  done
fi

# code-review rules (if installed)
if [ -n "$REVIEW_ROOT" ] && [ -d "$REVIEW_ROOT/rules" ]; then
  for src in "$REVIEW_ROOT/rules"/*.md; do
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

완료 후 /codex-core:setup 을 다시 실행하세요.
```

**If "이미 로그인했습니다"**: Proceed to Step 5.

---

## Step 5: Check CLAUDE.md Rules Import (read-only, no auto-edit)

> **⛔ 중요**: 이 단계는 **절대 `~/.claude/CLAUDE.md`를 수정하지 않는다**.
> CLAUDE.md는 사용자가 수시로 편집하는 파일이라 플러그인이 append/재배치하면
> 중복·위치 충돌·소유권 모호 문제가 발생한다. 확인만 하고 안내만 한다.
> (마커 블록 자동 삽입은 플러그인의 install hook이 담당. 이 스킬은 verify만.)

Use the **Read tool** to read `~/.claude/CLAUDE.md`.
Check which of the following import lines are already present:

**codex-core (필수)**:
- `@~/.claude/rules/review-protocol.md`
- `@~/.claude/rules/codex-delegation.md`
- `@~/.claude/rules/codex-delegate.md`
- `@~/.claude/rules/codex-session-ops.md`

**codex-code-review (선택)**:
- `@~/.claude/rules/codex-code-review.md`
- `@~/.claude/rules/codex-red-review.md`

**Legacy markers (v1.x 잔재)**:
- `<!-- @codex-review-rules:begin -->` ... `<!-- @codex-review-rules:end -->`

**If legacy v1.x marker block is detected**, show:
```
⚠️ Legacy 'codex-review-rules' marker block detected in CLAUDE.md.
   This is from v1.x. The codex-core install hook should remove it automatically.
   If it persists, remove the block manually (between begin/end markers).
```

**If `review-protocol.md` is already imported**: Show "✓ codex-core rules imported in CLAUDE.md" plus a list of which specific rules are currently active.

**If `review-protocol.md` is NOT imported**, show this message (no AskUserQuestion, no edit):

```
⚠️ CLAUDE.md에 codex-core rules가 import되어 있지 않습니다.
   /plugin install codex-core@sanghyun-io 의 install hook이 자동으로 처리합니다.

수동 추가가 필요한 경우:

  <!-- @codex-core:begin -->
  @~/.claude/rules/review-protocol.md
  @~/.claude/rules/codex-delegation.md
  @~/.claude/rules/codex-delegate.md
  @~/.claude/rules/codex-session-ops.md
  <!-- @codex-core:end -->

  <!-- @codex-code-review:begin -->        # codex-code-review 설치 시
  @~/.claude/rules/codex-code-review.md
  @~/.claude/rules/codex-red-review.md
  <!-- @codex-code-review:end -->
```

> **금지**: Edit/Write 도구로 `~/.claude/CLAUDE.md`를 수정하지 말 것.
> 안내 출력만으로 Step 5를 끝낸다.

---

## Step 6: Setup Complete

Show the final summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ codex-core — Setup Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

설치된 항목:
  ✓ ~/.claude/bin/codex-review.mjs
  ✓ ~/.claude/bin/broker.mjs
  ✓ ~/.claude/bin/session-lifecycle.mjs
  ✓ ~/.claude/bin/stop-gate.mjs
  ✓ ~/.claude/schemas/review-output.schema.json
  ✓ ~/.claude/rules/*.md
    (codex-core: review-protocol, codex-delegation, codex-delegate, codex-session-ops)
    (codex-code-review (선택): codex-code-review, codex-red-review)

기본 사용 (codex-core):
  • 작업 위임:      /codex-core:delegate <task>
  • 세션 목록:      /codex-core:sessions
  • 세션 중단:      /codex-core:halt
  • 결과 조회:      /codex-core:readout
  • 설정 재확인:    /codex-core:setup

추가 워크플로 (codex-code-review):
  • 코드 리뷰:      /codex-code-review:code-review
  • 공격자 리뷰:    /codex-code-review:red-review

자연어 트리거:
  "Codex에게 이 버그 고쳐달라고 해" / "Codex로 gpt-4o 써서 검토 부탁"
  같은 자연어도 codex-delegation 라우터가 감지해서 적절한 스킬로 연결됩니다.

모델: gpt-5.4 (Stateful Thread, --model 플래그 / CODEX_REVIEW_MODEL 환경변수로 오버라이드)
브로커: 기본 활성화 (CODEX_REVIEW_NO_BROKER=1 로 비활성화 가능)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

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
CORE_BIN=$(find ~/.claude/plugins/cache/sanghyun-io/codex-review-core -name "codex-review.mjs" 2>/dev/null | head -1)
RULES_DIR=$(find ~/.claude/plugins/cache/sanghyun-io/codex-review-rules -type d -name "rules" 2>/dev/null | head -1)
echo "CORE_BIN=$CORE_BIN"
echo "RULES_DIR=$RULES_DIR"
```

**If Bash is unavailable** (permission denied / don't ask mode):
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `ls ~/.claude/bin/codex-review.mjs ~/.claude/rules/review-protocol.md`"
- Proceed to Step 2.

**If CORE_BIN or RULES_DIR is empty**: Stop and report:
```
Plugin cache not found. Please reinstall:
  claude plugin install codex-review-core@sanghyun-io
  claude plugin install codex-review-rules@sanghyun-io
```

**Compare each file against cache using Bash**:

```bash
INSTALLED_BIN="$HOME/.claude/bin/codex-review.mjs"
INSTALLED_RULES="$HOME/.claude/rules"

# codex-review.mjs
if [ ! -f "$INSTALLED_BIN" ]; then
  echo "MISSING: codex-review.mjs"
elif diff -q "$CORE_BIN" "$INSTALLED_BIN" > /dev/null 2>&1; then
  echo "MATCH: codex-review.mjs"
else
  echo "DIFFER: codex-review.mjs"
fi

# rules files
for name in review-protocol.md codex-plan-validation.md codex-code-review.md; do
  dest="$INSTALLED_RULES/$name"
  if [ ! -f "$dest" ]; then
    echo "MISSING: $name"
  elif diff -q "$RULES_DIR/$name" "$dest" > /dev/null 2>&1; then
    echo "MATCH: $name"
  else
    echo "DIFFER: $name"
  fi
done
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
mkdir -p ~/.claude/bin ~/.claude/rules
cp "$CORE_BIN" ~/.claude/bin/codex-review.mjs && chmod +x ~/.claude/bin/codex-review.mjs
cp "$RULES_DIR/review-protocol.md" ~/.claude/rules/
cp "$RULES_DIR/codex-plan-validation.md" ~/.claude/rules/
cp "$RULES_DIR/codex-code-review.md" ~/.claude/rules/
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

완료 후 /codex-app-server-plugin:setup 을 다시 실행하세요.
```

**If "이미 로그인했습니다"**: Proceed to Step 5.

---

## Step 5: Check CLAUDE.md Rules Import

Use the **Read tool** to read `~/.claude/CLAUDE.md`.
Check if the content contains "review-protocol".

**If import exists**: Show "✓ Rules imported in CLAUDE.md"

**If not imported**:
Ask the user using AskUserQuestion:

```json
{
  "questions": [{
    "question": "rules 파일이 CLAUDE.md에 import되어 있지 않습니다. Plan 검증 및 코드 리뷰 자동화 기능을 사용하려면 import가 필요합니다.",
    "header": "CLAUDE.md",
    "multiSelect": false,
    "options": [
      {"label": "자동으로 추가해주세요", "description": "CLAUDE.md 끝에 import 구문 3줄을 추가합니다"},
      {"label": "직접 추가하겠습니다", "description": "추가할 내용을 보여줍니다"},
      {"label": "건너뛰기", "description": "나중에 직접 추가합니다"}
    ]
  }]
}
```

**If "자동으로 추가해주세요"**:
Append these 3 lines to `~/.claude/CLAUDE.md` using the Edit tool:
```
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-plan-validation.md
@~/.claude/rules/codex-code-review.md
```
Show: "✓ CLAUDE.md에 rules import를 추가했습니다"

**If "직접 추가하겠습니다"**:
Show the 3 lines above.

---

## Step 6: Setup Complete

Show the final summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Codex App Server Plugin — Setup Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

설치된 항목:
  ✓ ~/.claude/bin/codex-review.mjs
  ✓ ~/.claude/rules/review-protocol.md
  ✓ ~/.claude/rules/codex-plan-validation.md
  ✓ ~/.claude/rules/codex-code-review.md

사용 방법:
  • Plan 검증: Plan 작성 완료 후 Claude가 자동으로 제안합니다
  • 코드 리뷰: /codex-app-server-plugin:code-review 를 실행하세요
  • 설정 재확인: /codex-app-server-plugin:setup

모델: gpt-5.4 (Stateful Thread 방식, --model 플래그로 오버라이드 가능)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

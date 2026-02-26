---
name: codex-setup
description: Setup and verify Codex App Server Plugin. Checks Node.js, codex CLI, authentication, and installed files. Run after plugin installation.
invocation:
  command: codex-setup
  user_invocable: true
---

# Codex App Server Plugin — Setup

Guide the user through verifying the complete plugin installation step by step.

---

## Step 1: Check Installed Files

Run the following checks in parallel:

```bash
ls ~/.claude/bin/codex-review.mjs 2>/dev/null && echo "BIN_FOUND" || echo "BIN_MISSING"
```

```bash
ls ~/.claude/rules/review-protocol.md 2>/dev/null && echo "RULES_FOUND" || echo "RULES_MISSING"
```

**If BIN_MISSING or RULES_MISSING**:
- Show which files are missing
- Explain: "PostPluginInstall hook should have installed these automatically."
- Guide: "Try reinstalling the plugin:"
  ```
  claude plugin uninstall codex-app-server-plugin@sanghyun-io
  claude plugin install codex-app-server-plugin@sanghyun-io
  ```
- Stop and wait for user

**If all found**: Show "✓ Plugin files installed correctly"

---

## Step 2: Check Node.js

```bash
node --version 2>/dev/null || echo "NOT_FOUND"
```

**If NOT_FOUND**:
- Show: "❌ Node.js is required (v18+). Install from https://nodejs.org"
- Stop and wait

**If found**: Show "✓ Node.js {version}"

---

## Step 3: Check codex CLI

```bash
codex --version 2>/dev/null || echo "NOT_FOUND"
```

**If NOT_FOUND**:
Ask the user using AskUserQuestion:

```json
{
  "questions": [{
    "question": "codex CLI가 설치되어 있지 않습니다. 어떻게 하시겠어요?",
    "header": "codex CLI",
    "multiSelect": false,
    "options": [
      {"label": "지금 설치 (npm i -g @anthropic-ai/codex)", "description": "npm으로 codex CLI를 전역 설치합니다"},
      {"label": "수동으로 설치하겠습니다", "description": "터미널에서 직접 설치 후 다시 실행합니다"},
      {"label": "건너뛰기", "description": "나중에 설치합니다 (플러그인 기능이 동작하지 않습니다)"}
    ]
  }]
}
```

If "지금 설치":
- Run: `npm install -g @anthropic-ai/codex`
- Re-verify with `codex --version`
- If still fails, stop and report error

**If found**: Show "✓ codex CLI {version}"

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
      {"label": "이미 로그인했습니다", "description": "동작 확인 테스트를 실행합니다"},
      {"label": "아직 로그인하지 않았습니다", "description": "codex login 방법을 안내합니다"}
    ]
  }]
}
```

**If "아직 로그인하지 않았습니다"**:
Show the following and stop:
```
터미널에서 다음을 실행하세요:

  $ codex login

브라우저가 열리면 ChatGPT 계정으로 로그인하세요.
완료 후 /codex-app-server-plugin:setup 을 다시 실행하세요.
```

**If "이미 로그인했습니다"**: Proceed to Step 5

---

## Step 5: Verify Binary Works

Run:

```bash
node ~/.claude/bin/codex-review.mjs --help 2>&1; echo "EXIT_CODE: $?"
```

**If EXIT_CODE: 0**: Show "✓ codex-review.mjs is working correctly"

**If other exit code**:
- Show the error output
- Stop and report: "Binary check failed. Please check Node.js version (v18+ required)."

---

## Step 6: CLAUDE.md Rules Check

Run:

```bash
grep -l "review-protocol" ~/.claude/CLAUDE.md 2>/dev/null && echo "IMPORTED" || echo "NOT_IMPORTED"
```

**If NOT_IMPORTED**:
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
Append to `~/.claude/CLAUDE.md`:
```
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-plan-validation.md
@~/.claude/rules/codex-code-review.md
```
Show: "✓ CLAUDE.md에 rules import를 추가했습니다"

**If "직접 추가하겠습니다"**:
Show:
```
~/.claude/CLAUDE.md 에 다음 3줄을 추가하세요:

@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-plan-validation.md
@~/.claude/rules/codex-code-review.md
```

---

## Step 7: Setup Complete

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

모델: gpt-5.3-codex (Stateful Thread 방식)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

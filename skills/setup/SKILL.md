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

## Step 1: Check and Install Files

Use the **Read tool** (not Bash) to check file existence:
- Read `~/.claude/bin/codex-review.mjs`
- Read `~/.claude/rules/review-protocol.md`

**If both exist**: Show "✓ Plugin files installed correctly" and proceed to Step 2.

**If any file is missing**: Copy from plugin cache using Read + Write tools.

Plugin cache source paths:
- `~/.claude/plugins/cache/codex-app-server-plugin/bin/codex-review.mjs`
- `~/.claude/plugins/cache/codex-app-server-plugin/rules/review-protocol.md`
- `~/.claude/plugins/cache/codex-app-server-plugin/rules/codex-plan-validation.md`
- `~/.claude/plugins/cache/codex-app-server-plugin/rules/codex-code-review.md`

Destination paths:
- `~/.claude/bin/codex-review.mjs`
- `~/.claude/rules/review-protocol.md`
- `~/.claude/rules/codex-plan-validation.md`
- `~/.claude/rules/codex-code-review.md`

Read each source file and Write to the destination. After copying show:
"✓ Plugin files installed from cache"

If cache files also don't exist, stop and report:
"Plugin cache not found at ~/.claude/plugins/cache/codex-app-server-plugin/. Please reinstall: `claude plugin install codex-app-server-plugin@sanghyun-io`"

---

## Step 2: Check Node.js

Try with Bash:

```bash
node --version 2>/dev/null || echo "NOT_FOUND"
```

**If Bash is unavailable** (permission denied / don't ask mode):
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `node --version` (v18+ required)"
- Proceed to Step 3.

**If NOT_FOUND**: Show "❌ Node.js is required (v18+). Install from https://nodejs.org" and stop.

**If found**: Show "✓ Node.js {version}"

---

## Step 3: Check codex CLI

Try with Bash:

```bash
codex --version 2>/dev/null || echo "NOT_FOUND"
```

**If Bash is unavailable**:
- Show: "⚠️ Shell restricted — cannot verify automatically. Please run in terminal: `codex --version`"
- Proceed to Step 4.

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

If "지금 설치": Run `npm install -g @anthropic-ai/codex` then re-verify.

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

모델: gpt-5.3-codex (Stateful Thread 방식)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---
name: tone
description: Show or set the persistent default review tone (easy|plain|normal|deep) stored in ~/.claude/codex-review.config.json. Use when the user wants to view or change the default readability of code-review / red-review results.
argument-hint: "[easy | plain | normal | deep]"
invocation:
  command: tone
  user_invocable: true
---

# Review Tone (persistent default)

Show or change the **persistent default tone** used by `code-review` / `red-review`
when no `--tone` is given. It is stored in `~/.claude/codex-review.config.json`
(`defaultTone`). This changes only the default — per-session overrides still use
`--tone` on the review command, or an in-session request ("쉽게 설명해줘"), and
those never rewrite this file.

## Arguments

- `(no args)` — Show the current default tone and the available levels.
- `easy` | `plain` | `normal` | `deep` — Set the persistent default tone.

## Levels

| level | 이름 | 대상 |
|-------|------|------|
| `easy` | 쉽게 | 비개발자 — 전문 용어 배제, 일상어 |
| `plain` | 풀어서 | 일반 개발자 — IDOR/SSRF 등 약어를 괄호로 풀이 (설정 없을 때 fallback) |
| `normal` | 평범하게 | 숙련 개발자 — 전문 용어 그대로, 간결 |
| `deep` | 아주 자세히 | 전문가 — 용어 + CWE/CVE + 공격/재현/완화 전체 |

Full definitions: `~/.claude/rules/codex-code-review.md` → "말투(Tone) 단계 처리".

## Execution

$ARGUMENTS

The config file is `~/.claude/codex-review.config.json`. Use the Node one-liners
below (they resolve the home directory natively, preserve any other keys, and
always write valid JSON) instead of hand-editing the file.

### Show (no argument)

```bash
node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}console.log("defaultTone:",c.defaultTone||"plain (fallback — no config set)")'
```

Then list the four levels above so the user can pick one.

### Set (argument is one of easy|plain|normal|deep)

1. Validate the argument is exactly one of `easy` / `plain` / `normal` / `deep`.
   If not, print the valid levels and stop — do NOT write the file.
2. Write it, preserving all other keys, with (substitute `<level>`):

   ```bash
   node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}c.defaultTone=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");console.log("defaultTone =",c.defaultTone)' <level>
   ```
3. Confirm in Korean, plainly: e.g. "기본 말투를 `easy`(쉽게)로 설정했어요. 이제 `--tone` 없이 리뷰하면 이 말투로 나옵니다. 특정 리뷰에서만 다르게 하려면 그 명령에 `--tone` 을 붙이세요."

## Notes

- This affects only the persistent default; it does not change a review that is
  already running.
- `--tone` on `/codex-code-review:code-review` / `:red-review` (and in-session
  requests) override the default for that session only and never rewrite this file.
- The file is user data — plugin reinstall/update never overwrites an existing one.

## References

- `~/.claude/rules/codex-code-review.md` — tone level definitions and the
  resolution order (`--tone` > in-session utterance > `defaultTone` > `plain`).

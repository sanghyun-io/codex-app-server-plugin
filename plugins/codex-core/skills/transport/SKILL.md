---
name: transport
description: Show or set the persistent default Codex transport (ask|orca|app-server) stored in ~/.claude/codex-review.config.json. Use when the user wants to view or change whether Codex runs in an Orca terminal or via the App Server, or to reset the one-time "ask me" prompt.
argument-hint: "[ask | orca | app-server]"
invocation:
  command: transport
  user_invocable: true
---

# Codex Transport (persistent default)

Show or change the **persistent default transport** — where Codex actually runs
when no `--transport` is given. It is stored in `~/.claude/codex-review.config.json`
(`transport`). This changes only the default — a single call can still override with
`--transport` on the review/delegate command, and that never rewrites this file.

App Server is always the fallback: if Orca is not running, Codex uses the App Server
regardless of this setting.

## Arguments

- `(no args)` — Show the current default transport and what each value means.
- `ask` | `orca` | `app-server` — Set the persistent default.

## Values

| value | 동작 |
|-------|------|
| `ask` | Orca가 켜져 있으면 다음 실행 때 한 번 "Orca 터미널로 codex를 켤까요?"를 물어보고, 그 답을 이 파일에 저장한다 (이후로는 안 물어봄). Orca가 없으면 곧바로 App Server. |
| `orca` | Orca가 켜져 있으면 항상 Orca 터미널에서 codex 실행 (대화가 보이고, 이어가기/다른 worktree로 넘기기 가능). 없으면 App Server. |
| `app-server` | 항상 기존 App Server 방식 (묻지 않음). |

초기값은 `ask`입니다. 즉 처음 Orca 환경에서 codex를 쓰면 한 번 물어보고, 그 선택이 기본값이 됩니다.

## Execution

$ARGUMENTS

The config file is `~/.claude/codex-review.config.json`. Use the Node one-liners
below (they resolve the home directory natively, preserve any other keys such as
`defaultTone`, and always write valid JSON) instead of hand-editing the file.

### Show (no argument)

```bash
node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}console.log("transport:",c.transport||"ask (default — not set)")'
```

Then list the three values above so the user can pick one.

### Set (argument is one of ask|orca|app-server)

1. Validate the argument is exactly one of `ask` / `orca` / `app-server`.
   If not, print the valid values and stop — do NOT write the file.
2. Write it, preserving all other keys, with (substitute `<value>`):

   ```bash
   node -e 'const fs=require("fs"),os=require("os"),path=require("path"),p=path.join(os.homedir(),".claude","codex-review.config.json");let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}c.transport=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");console.log("transport =",c.transport)' <value>
   ```
3. Confirm in Korean, plainly. Examples:
   - `orca`: "기본 실행 방식을 `orca`로 설정했어요. 이제 Orca가 켜져 있으면 codex를 Orca 터미널에서 실행합니다. 특정 실행에서만 다르게 하려면 그 명령에 `--transport app-server`를 붙이세요."
   - `app-server`: "기본 실행 방식을 `app-server`로 설정했어요. 항상 기존 방식으로 실행하고 Orca를 쓰지 않습니다."
   - `ask`: "다음에 Orca 환경에서 codex를 쓸 때 한 번 물어보도록 초기화했어요."

## Notes

- This affects only the persistent default; it does not change a session that is
  already running.
- `--transport` on a review/delegate command (and the env var
  `CODEX_REVIEW_TRANSPORT`) override the default for that call only and never
  rewrite this file.
- Resolution order (highest wins): `--transport` > `CODEX_REVIEW_TRANSPORT` >
  `transport` in the config file > `ask`.
- The file is user data — plugin reinstall/update never overwrites an existing one.
- Orca detection uses `orca status`; when Orca is unreachable the App Server path
  runs no matter what this is set to.

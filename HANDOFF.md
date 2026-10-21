# HANDOFF — shared board for anyone working on claude-gw

**Read this before you edit anything. Sign your edits below. Keep it short and dated.**

Two agents have edited this repo at the same time. The gateway is a **single shared process**
(`127.0.0.1:8790`) and a single config/state dir, so uncoordinated edits and restarts clobber each
other. The rules are cheap; follow them.

## Rules

1. `git status` first. Uncommitted changes in a file = someone else is mid-edit there.
2. Claim a file in **CLAIMS** below before editing it. Release it when committed.
3. **Never restart the gateway without saying so here first.** A restart kills an in-flight test, an
   armed usage-limit wait, and any live chat's held request. `cla-gw stop && cla-gw start`.
4. **Never point `upstream` at a fake server without saying so here.** While it points at a fake,
   every Claude chat on the machine is answered by that fake. If `.probe/hold-config.json` exists,
   somebody's probe is live — do not touch `upstream`, and do not delete that snapshot.
5. Before and after any change: `node src/test_selection.mjs && node src/test_sticky.mjs &&
   node src/test_quota_surface.mjs` (30 checks in the last one). Commit small.
6. `.probe/` is gitignored scratch: stand-in control/log, throwaway launchers, watcher output. Safe
   to read, safe to delete (except while someone's probe is live).

## Live state (as of this commit)

- Running gateway: port 8790, pool `B,C`, A disabled, upstream real.
- Credential mode: **supported** — `ANTHROPIC_AUTH_TOKEN` is deliberately absent; the local secret
  travels in the `x-gw-secret` header, so the client authenticates to us with its saved claude.ai
  login and stays a subscription session. Managed by `cla-gw activate`, verified by `cla-gw doctor`.
  `~/.claude/settings.json` carries the env block (backup: `settings.json.claude-gw.bak`), which is
  why **Developer: Reload Window** is enough — a full VS Code quit is not required.
- Live config knobs (`%LOCALAPPDATA%\claude-gw\config.json`, hot-reloaded per request):
  - `holdMaxMs: 240000` — silent hold when the pool reopens within 4 min (proven, panel-tolerated).
  - **`holdStream: false`** — the *long* hold (commit the SSE stream + ping keepalive) is coded and
    unit-proven but **not yet client-proven**. Flip to `true` only after the panel test passes, and
    say so here.
  - `holdStreamMaxMs: 21600000` (6 h) — ceiling on any hold; beyond it the refusal passes through.
  - `secretHeader: x-gw-secret`, `swapInferenceOnly: true`.

## What is proven vs assumed

| Claim | Status |
|---|---|
| Interactive (terminal TUI) chats arm and resume themselves at the reset | **proven on real accounts**: 429 at 11:24 → served by B at 14:21:01, 61 s after the reset, nobody typing |
| Extension panel does NOT arm (it drives `claude.exe` headless → `rate_limit_event` then `result`) | **proven** on 2.1.305, both by behaviour and by the headless run against the stand-in |
| Panel tolerates a held request | **proven at ~100 s**: hold 99 s → 200, no client abort |
| Panel tolerates a *long* held request kept alive by ping frames | **UNPROVEN** — this is the next test (`probe_hold.mjs --long`) |
| Quota shim: the client is told when the **pool** reopens, not the refusing account | **proven live**: C refused with its own 16:00 window, client was handed B's 14:20 |
| Shim never lengthens a wait | proven by tests |

## Commands worth knowing

```
node src/probe_upstream.mjs start --detach        # stand-in api.anthropic.com on :8791 (zero quota)
node src/probe_upstream.mjs selftest              # prove the 429/200 shapes without a client
node src/probe_limit.mjs arm --reset-in 360       # stand-in "out of usage", heals in 6 min
node src/probe_limit.mjs launch --variant B --vscode   # throwaway window on the stand-in
node src/probe_limit.mjs launch --real            # throwaway window on the REAL gateway, new mode
node src/probe_hold.mjs selftest --window 40      # prove the silent hold path end to end
node src/probe_hold.mjs run --window 180 --long   # LONG-hold tolerance test (touches live upstream!)
node src/probe_hold.mjs restore                   # undo it, always
node src/watch_autoresume.mjs --reset <epochSec>  # record which waiting chats got served after a reset
```

## Open work

1. **Long-hold tolerance in the extension panel** — `probe_hold.mjs --long` at 180 s, then at ~15 min.
   If it survives, set `holdStream: true` live (and consider raising the ceiling to 6 h) so panel
   chats also ride out a multi-hour window. If the client errors on pings-before-first-token, say so
   here and we keep panel chats refusing fast instead.
2. Surface the countdown in the VS Code status-bar extension (`vscode/`) during a hold — the gateway
   already sends `x-gw-held: <ms>`.
3. C's token was pasted into a chat once; rotation was offered and declined for now. Re-raise if the
   account is ever shared or the machine is.

## CLAIMS

| file | who | since | status |
|---|---|---|---|
| `src/gw.mjs`, `src/config.mjs`, `src/probe_hold.mjs`, `src/test_quota_surface.mjs` | pi session (this board's author) | 18:05 | released — committed |

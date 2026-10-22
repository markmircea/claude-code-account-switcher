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
- Extension auto-updated under us: **2.1.306** is current (2.1.301/305/306 all installed). Probe the
  bundled `resources/native-binary/claude.exe` of 306 from now on.
- Credential mode: **supported** — `ANTHROPIC_AUTH_TOKEN` is deliberately absent; the local secret
  travels in the `x-gw-secret` header, so the client authenticates to us with its saved claude.ai
  login and stays a subscription session. Managed by `cla-gw activate`, verified by `cla-gw doctor`.
  `~/.claude/settings.json` carries the env block (backup: `settings.json.claude-gw.bak`), which is
  why **Developer: Reload Window** is enough — a full VS Code quit is not required.
- Live config knobs (`%LOCALAPPDATA%\claude-gw\config.json`, hot-reloaded per request):
  - **`holdStream: true` — ENABLED LIVE 19:55.** The long hold (commit the SSE stream + ping every 20 s,
    then splice the real frames in) is now proven against the extension's own 2.1.306 binary at 240 s
    and 700 s. This is the only mechanism that gets a panel chat past a limit, since the panel never
    arms Claude Code's own wait.
  - `holdMaxMs: 15000` — raised from 240000 to a **small** silent hold. Now that the ping path exists
    and is proven, a minutes-long *silent* hold is the strictly riskier way to buy the same wait.
  - `holdStreamMaxMs: 600000` (**10 min**) — **cut down from 5.5 h on 2026-10-21 21:15 after the
    overnight log.** The client abandons a held stream at **~900 s** (see the wall below). Parking a
    chat past ~10 min therefore cannot deliver the answer, and it costs the client its own arm, which
    is the only thing that survives a multi-hour window. Beyond the ceiling the real 429 passes
    through immediately, with the pool-corrected countdown, so an interactive chat arms.
  - `secretHeader: x-gw-secret`, `swapInferenceOnly: true`.

## What is proven vs assumed

| Claim | Status |
|---|---|
| Interactive (terminal TUI) chats arm and resume themselves at the reset | **proven on real accounts**: 429 at 11:24 → served by B at 14:21:01, 61 s after the reset, nobody typing |
| Extension panel does NOT arm (drives `claude.exe` headless → `rate_limit_event` then `result`) | **proven on 2.1.305 and re-proven on 2.1.306** (resident stream-json session: 429 at 19:13:50, then 7 min idle, one request total) |
| Panel tolerates a held request (silent) | **proven at ~100 s**: hold 99 s → 200, no client abort; now capped at 15 s anyway, since the ping path below is better |
| Panel tolerates a *long* held request kept alive by ping frames | **PROVEN 19:55 on 2.1.306** via `probe_long_hold.mjs`: held 236 926 ms and 695 421 ms, no abort, answer delivered on the same stream as a normal turn (`result is_error=false`) |
| A hold survives past the client's own `x-stainless-timeout: 600` | **proven at 695 s** — that timeout is time-to-first-*response*, not time-to-first-token: once the gateway has committed 200 + a ping, the client keeps waiting. Do NOT read 600 s as the hold ceiling. |
| **The wall: a hold longer than ~900 s is lost** | **MEASURED 2026-10-21 overnight** (real accounts, three live chats): five `hold-stream-abort` at **910.9–911.6 s** each, with a ping every 20 s running. The aborts are ~11 s after the hold began, so the timer is ~900 s from request start. 695 s survived; 911 s did not. Treat 900 s as hard. |
| A parked chat then resumes itself at the reset | **DISPROVEN** — the overnight log: chats held from 20:38 (B opens 00:30, ~3.8 h out) were killed at ~15 min, retried once into a real 429, and then **zero requests after midnight**. Parking past the client's wall both loses the request *and* skips the arm the client would otherwise have made. This is why `holdStreamMaxMs` is 10 min now. |
| The held panel chat still shows a limit notice | observed: the committed stream carries the refusal's (pool-corrected) quota headers, so the client emits `rate_limit_event` **and** completes the turn. Honest countdown, no dead turn. Keep an eye on it — if a future build lets that event end the turn, the hold breaks. |
| A hold survives **hours**, VS Code closed, or a laptop sleeping through the reset | **DISPROVEN for hours** (see the ~900 s wall). A closed window or sleep still kills the socket (`hold-stream-abort`); nothing gateway-side recovers those. |
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
node src/probe_long_hold.mjs --selftest          # 20s, plumbing only, no live anything
node src/probe_long_hold.mjs --window 240        # the REAL panel binary, throwaway gateway, zero quota
node src/probe_long_hold.mjs --window 700        # real scale; nothing live is touched, ~13 min
```

## Open work

1. ~~Long hold: shipped 19:55; measure the tail (a hold of hours).~~ **ANSWERED, and it is a NO** —
   the real night measured the tail for us: the client kills a held stream at ~900 s, and parking past
   that loses the chat *and* the arm. Ceiling is now 10 min. See the wall row above. Do not raise
   `holdStreamMaxMs` again without a measurement that beats 900 s.
2. Surface the countdown in the VS Code status-bar extension (`vscode/`) during a hold — the gateway
   already sends `x-gw-held: <ms>`, and a chat parked for an hour with no visible reason is exactly
   what the status bar should be explaining.
3. C's token was pasted into a chat once; rotation was offered and declined for now. Re-raise if the
   account is ever shared or the machine is.

## ANNOUNCEMENTS

- 18:40 — running the **panel/headless auto-resume question** as a free probe: stand-in upstream on
  :8791 armed `limited` (resets ~5 min out) + the extension's own bundled `claude.exe` driven
  `-p` **directly at the stand-in** (variant B env, no `ANTHROPIC_AUTH_TOKEN`). **Live gateway and
  live `upstream` are NOT touched** — this is not a hijack of other chats; only the one spawned
  process talks to :8791. No gateway restart. Watch `.probe/requests.jsonl`.
- Reason for re-testing at all: two findings while setting this up.
  1. `.probe/autoresume-watch.log`'s last line ("did NOT self-initiate") is **not** a panel failure —
     it is just that watch's `--for 1200` deadline expiring at 14:46. The watcher never recorded a
     `RESUMED` line for the 14:21:01 resume (the gateway log did: `d3beb324` 429 at 11:24 → 200 at
     14:21:01). The watcher's verdict line is misleading; read the gateway log, not that line.
  2. The extension auto-updated to **2.1.306** (2.1.301/305/306 all present). Every "proven on
     2.1.305" row above needs re-proving against 306.

- 19:25 — probe finished, stand-in stopped, **live config never touched** (`upstream` still
  `https://api.anthropic.com`, `holdStream` still `false`, no `hold-config.json`), no restart.
  Verdict below; it changes what the panel can and cannot get.

- **~14:05 — cost accounting shipped: usage is now captured per response, and `cla-gw cost` prices it.**
  Claiming `src/config.mjs` (price table + scanUsage), `src/cli.mjs` (`cost`), `vscode/extension.js` (0.2.0),
  and the delivery paths in `src/gw.mjs`. Gateway RESTARTED twice (13:5x, 14:0x) — sorry if that cut a hold.
  What it does: the response bytes the client is already receiving get scanned for the `usage` objects the
  API sends anyway (`message_start` input side incl. cache splits, last `message_delta` output), priced at
  list (`PRICE_TABLE`, per family, overridable in `config.json -> "prices"`), logged as `usage`/`costUsd`/
  `priceFamily` on the request record, summed into `status.json -> cost` (today + this run + per day + per
  account), and primed from the log tail on boot so a restart does not zero the day. `cla-gw cost
  [--days N]` prints the per-model table, by day, by account, and the rates used.
  Rules worth keeping: the tap is text-frames-only and every scan error is swallowed — a wrong number is
  acceptable, a broken stream never is. `poolReopening()` was added because `poolOpening()` answers "who is
  closest to serving" (unblocked => now), which makes a status bar say "opens <this minute>".
  **The extension is installed (local.claude-gw-status@0.2.0) but a Reload Window is needed** to pick it up:
  bar gains today's cost + the soonest reopen + a terms-wall warning, and the hover now carries emails, the
  per-account cost table and the rates. 38 checks (2 new: usage captured off a live stream; priced at the
  right family). Not covered: usage recorded before 2026-10-22 ~14:00 is simply absent from the log, so
  `cost` reports what it can see and says so.
- **12:35 — `cla-gw email <label> <addr>` added; the three live accounts now carry their addresses** (stored in
  `config.json -> accounts[].identity.email`, not committed - keep addresses out of this file). `ls`, `health`
  and the `check` terms-wall hint print them, which is the point: a setup-token cannot report its email, so
  "sign in as this account and accept the terms" was unactionable advice with three accounts in the pool.
  Duplicate addresses across two labels warn loudly (two labels, one account, no extra capacity). Noted
  separately: B and the CLI login (account A) are the same person, which is why A stays disabled.
  I did NOT touch `add.mjs` / `preflight.mjs` - yours per the 12:25 claim. If you want the address recorded
  at enrolment time, `cla-gw add X --email <addr>` is a two-line change on your side.
- **12:25 — CLAIMING `src/preflight.mjs` (new), `src/add.mjs`; live `config.json` change: D DISABLED.**
  No gateway restart (config is hot-reloaded per request). The gateway now survives a terms-walled account,
  but `cla-gw add` still enrols a credential it has never asked to do any work. `preflight.mjs` probes
  `/v1/messages/count_tokens` (inference path — same wall, same 401, same quota rejection — but generates
  nothing, so it is free) and `add` now refuses to put a terms-walled or token-rejected credential into
  rotation. `cla-gw disable D` was run: D (org fc3a5866) cannot serve until a human accepts the terms in
  claude.ai, and re-enabling is `cla-gw enable D` after that. Verified against live tokens at 12:2x:
  D -> `terms-wall`, B/C -> `limited-now` (credential good, window closed), zero quota spent.
  **Gotcha for anyone reusing this: `/v1/messages/count_tokens` does NOT see the terms wall** — same
  token, same minute: count_tokens -> 200, /v1/messages -> 400 Consumer Terms. The probe has to be a
  real completion, which is why it is `max_tokens: 1` on a one-character prompt. `cla-gw check [labels]`
  now answers "can this account actually serve" on demand (exit 1 if any cannot) — run it BEFORE adding
  an account in a panic; on 2026-10-22 the pool was not short of accounts, it was short of servable ones.
- **11:50 — consent walls are now a first-class account state; gateway RESTARTED at 11:50.** Account D (org
  fc3a5866) came back from `cla-gw add` with `400 We've updated our Consumer Terms... accept them in
  claude.ai`. Six of those in three seconds, every chat dead, because the failover loop treats any non
  429/529 as "the client's problem" and passes it through. Now: a 400 whose body matches the terms wall
  parks that account 30 min under a `terms` window (`markConsentRequired`), routes around it, pops once
  with the org id (a setup-token cannot report its email), logs `consent-required`, and shows as
  `NEEDS TERMS at claude.ai` in `cla-gw ls`. An ordinary 400 is still passed through verbatim - it is read
  to text and re-sent, since bodies are single-use, which is why the delivery path has a new branch. 36
  checks. Do not "fix" this by fail-over-retrying all 400s: that replays genuinely bad client requests
  around the pool.
- **11:35 — notify.mjs rewritten (popup is now the primary path) + gateway RESTARTED at 11:36 to load it.**
  `cla-gw notify` printed "sent via toast" while showing nothing: the WinRT toast path returns exit 0 when
  Windows silently drops an unregistered-AUMID notification, so it cannot be trusted to mean "seen". Now:
  our own tiny topmost popup (one powershell, no install, auto-close 9 s, click to dismiss, named mutex so
  five chats = one box), toast and balloon demoted to fallbacks. Also wired the reopen alert: a refusal now
  schedules `open-alert` in the log and pops "B is back (HH:MM) - type continue" at the epoch the client was
  given. Tests set `CLAUDE_GW_NO_NOTIFY=1` (test_quota_surface was missing it and would have popped boxes
  during the refusal cases). 31 checks.
- **21:15 — changed the LIVE config: `holdStreamMaxMs` 5.5 h → 600000 (10 min), and the code default
  6 h → 10 min. No gateway restart needed (config is hot-reloaded per request).** Reason: the overnight
  log, three real chats, five aborts at 910.9–911.6 s, then a real 429 on retry and **nothing after
  midnight** — the 00:30 reset passed with zero requests. A 5.5 h ceiling converted a fast honest
  refusal into a 15-minute stall followed by a lost turn. If you disagree, argue it with log lines, not
  with the 695 s probe.

## VERDICT: does the extension panel arm the wait? No. Proven on 2.1.306.

Drove the extension's **own bundled binary** (`.vscode/extensions/anthropic.claude-code-2.1.306-win32-x64/
resources/native-binary/claude.exe`) against the stand-in, in the shape the panel uses:
resident `--input-format stream-json --output-format stream-json`, real claude.ai login, no
`ANTHROPIC_AUTH_TOKEN`, stand-in armed `limited` with a 240 s window.

```
7:13:50 PM  stand-in -> 429 rate_limit_error (resets 7:17:49)
            client emits: system/init, rate_limit_event, assistant, result(is_error=true,
                          "You've hit your session limit · resets 7:16pm")
            ...then the process stayed alive 7 more minutes and sent NOTHING. One request total.
```
Also tried with `"autoContinueAtUsageLimit": true` set explicitly (single-shot `-p`): identical,
exit 1 in 2 s. So the wait/continue state machine is **not reachable from the headless/agent-sdk path
the panel drives** — this is not a setting we can turn on, it is an interactive-UI-only feature.

What the binary itself says (2.1.306, `strings` on the 295 MB exe — for the gateway's own shim rules):
- `autoContinueAtUsageLimit` IS a documented user setting
  (`claude-code-settings.schema.json:4866`): *"wait for the limit to reset and continue the task
  automatically. When off, the limit dialog offers the wait as a choice instead."*
- the arm gate: subscription auth AND `billingType !== "usage_based"` AND a quota object with
  `status === "rejected"` and a finite `resetsAt` AND `isUsingOverage !== true` AND `overageInUse !== true`
  AND a killswitch/feature flag AND the setting not explicitly off. **Our quota shim must keep
  `status: rejected` + a finite reset and must never make the state look like overage-in-use** —
  that alone can silently un-arm a terminal chat. Current shim only rewrites epochs, so we are fine.
- its own constants: `30000, 90000, 1800000, 21600000` — i.e. a **6 h ceiling** on its own wait,
  same number `holdStreamMaxMs` already uses. State machine has `sleptThroughReset`, `takeoverUuids`,
  `pendingContinuationUuid`, `episodeArmOrigin: "dialog" | "auto"` — the `"dialog"` origin is the
  interactive-only path we just watched refuse to exist headless.

**Consequence for the user's stated preference** ("I prefer an error, but it must restart itself"):
- terminal chats: already exactly that — honest limit message, self-continues at the reset
  (gateway log: `d3beb324` 429 11:24 -> 200 **14:21:01** with nobody typing).
- panel chats: an error ends the turn and nothing in the client can restart it. Error-then-self-restart
  is **not obtainable** in the panel. The two real choices are (a) keep the request open so the panel
  never sees the 429 (`holdStream`, unproven at scale, looks like "thinking"), or (b) an external
  driver that re-runs the same session at the reset (`claude -p --resume <sessionId>` — the gateway
  already logs the sessionId on every 429) and lands the answer in the same transcript. (b) is
  unverified: does the panel re-render a transcript appended by another process? Test that next.

## GOTCHA that cost real quota during this probe — read before writing another probe

`~/.claude/settings.json` has an `env` block (`ANTHROPIC_BASE_URL=http://127.0.0.1:8790`), and **the
settings `env` block overrides the process environment**. A probe that repoints at the stand-in by
setting `ANTHROPIC_BASE_URL` in the shell silently talks to the LIVE gateway instead: my first two
headless runs went to B for real (gateway log 7:12:09, 7:12:20 PM, two tiny completions) while the
stand-in log looked "quiet". The fix is a settings layer:
`--settings .probe/probe-settings.json` (env -> :8791, no secret header). Confirm the request shows up
in `.probe/requests.jsonl` with `ua=claude-cli/...` **before** trusting any probe result. The
`probe_limit.mjs launch` launchers only reach the stand-in if nothing in settings overrides them —
same trap applies to them.

- 19:40 — CLAIMING `src/probe_upstream.mjs` (log the `x-stainless-timeout` value: it is the ceiling on
  how long ANY hold can be, and we have never read it) and NEW `src/probe_long_hold.mjs`.
  **The target is the VS Code panel, not terminal Claude Code** — the harness drives the extension's own
  bundled `claude.exe` (2.1.306) resident `--input-format/--output-format stream-json`, i.e. the exact
  agent-sdk shape the panel drives. It does **NOT** repoint the live gateway: a **throwaway gateway**
  (:8795, scratch `LOCALAPPDATA=.probe/gw-scratch`, fake vault tokens, upstream = stand-in :8791) means
  every live chat on the machine — including the pi session, which itself routes through :8790 — keeps
  working untouched. Zero quota, no restart, restore on exit/watchdog.

## Open work — current (21:15, after the overnight log) Not solvable gateway-side: the client's own socket
   dies at ~900 s and the panel never arms. Options, none built yet:
   - *Tell the user when the pool is back* so one `continue` typed at 00:30 finishes the job: the
     gateway knows the exact epoch; a Windows toast / `msg` popup at reopen is ~20 lines. Cheapest win.
   - Interactive (terminal) chats **do** cross it unattended — steer long overnight runs there.
   - A gateway-side "park the turn, replay it at the reset" would need to re-inject an answer into a
     client that has already ended the turn. Not possible through this client; do not build it.
2. Surface the countdown in the VS Code status-bar extension (`vscode/`) during a hold — the gateway
   already sends `x-gw-held: <ms>`.
3. C's token was pasted into a chat once; rotation was offered and declined for now. Re-raise if the
   account is ever shared or the machine is.

## CLAIMS

| file | who | since | status |
|---|---|---|---|
| `src/gw.mjs`, `src/config.mjs`, `src/probe_hold.mjs`, `src/test_quota_surface.mjs` | pi session (this board's author) | 18:05 | released — committed |
| `src/config.mjs` (price table, scanUsage, poolReopening), `src/cli.mjs` (`cost`), `vscode/extension.js`, `src/gw.mjs` delivery paths | pi session | ~14:05 | released — committed |
| `src/config.mjs` (holdStreamMaxMs default + why), `HANDOFF.md`, live `config.json` (ceiling → 10 min) | pi session | 21:12 | released — committed |

| `HANDOFF.md` (probe write-up), `.probe/probe-settings.json` | pi session | 18:40 | released — probe over, stand-in stopped, live config untouched |
| `src/probe_upstream.mjs`, `src/probe_long_hold.mjs` | pi session | 19:40 | released — committed; harness is zero-quota and never touches live config |
| `src/preflight.mjs` (new), `src/add.mjs`, live `config.json` (D disabled) | pi session (second window) | 12:25 | released — committed; `cla-gw check` added, 36 checks green, D disabled not deleted |
| `src/vault.mjs`, `src/notify.mjs`, `src/activate.mjs`, `src/cli.mjs`, `src/add.mjs`, `vscode/` (Linux port: platform branches only, Windows paths unchanged) | Claude (linux-port session, worktree `../claude-gw-linux`) | 10-23 00:40 | CLAIMED |

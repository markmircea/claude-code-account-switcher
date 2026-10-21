# claude-gw

A localhost gateway that sits between Claude Code (CLI **and** the VS Code extension) and
`api.anthropic.com`, re-signing inference with whichever account you select. Phase 2: manual
selection, one account, no failover yet.

Design and rationale live in [`../PLAN.md`](../PLAN.md). This README is operations only.

## What it is for

Anthropic's Claude Code holds exactly **one** credential per config dir and never hot-reloads
auth, so switching accounts normally means an interactive `/login`. This gateway keeps every
account permanently available and swaps the bearer **per request**, so switching is instant and
never opens a browser.

## Run it

```powershell
node src/cli.mjs start      # detached background listener on 127.0.0.1:8790
node src/cli.mjs status
node src/cli.mjs health     # per-account quota state: utilisation, reset time, parked?
node src/cli.mjs ls
node src/cli.mjs use A      # pin an account (or: use none -> first enabled)
node src/cli.mjs disable B  # take out of rotation (credential kept) — instant, mid-session
node src/cli.mjs enable  B
node src/cli.mjs add B      # provision another account (opens a browser; see below)
node src/cli.mjs forget B --yes   # delete the LOCAL entry. NOT a revoke. Guarded by --yes
node src/cli.mjs statusline # prints the settings.json snippet for the account indicator
node src/cli.mjs stop
```

## Adding an account

`cla-gw add <label>` runs `claude setup-token` in an **isolated config dir** (your real login is
never touched), prints the browser URL, and vaults the resulting 1-year inference-only token via
DPAPI. It then tries to confirm the token belongs to a *different* account than the ones you
already have — an accidental second login as the same account adds no capacity, and that check is
what catches it. If the token is inference-only and cannot report its identity, it says so plainly
instead of guessing, and you confirm in the browser.

**Use a private browser window.** The OAuth page hands back whichever Google account the browser is
already signed into, so "logging in as account B" silently re-authenticates as A otherwise.

If the automated flow cannot drive `setup-token` non-interactively, print the manual command with
`cla-gw add <label>` (it is shown on failure) and finish with `cla-gw add <label> --paste`.

## Go live (and come back)

```powershell
node src/cli.mjs activate      # sets the vars at USER scope + starts the gateway + installs logon autostart
node src/cli.mjs doctor        # first thing to run when anything looks broken
node src/cli.mjs deactivate    # removes the vars, the startup entry, stops the gateway
node src/cli.mjs activate --legacy   # old credential model (ANTHROPIC_AUTH_TOKEN) - works, no auto-resume
```

**The credential slot is deliberately left empty.** `ANTHROPIC_AUTH_TOKEN` is what Claude Code calls a
*gateway credential*, and while it is set the client treats the session as a billed-API session and
**turns off its own "wait for the claude.ai usage limit to reset, then continue the task" feature**
(docs: *"While a gateway credential variable or apiKeyHelper is active, the subscription's usage
limits don't apply"*). So supported mode sets only:

```powershell
$env:ANTHROPIC_BASE_URL       = "http://127.0.0.1:8790"
$env:ANTHROPIC_CUSTOM_HEADERS = "x-gw-secret: <local secret>"   # our shared secret, not a credential
# ANTHROPIC_AUTH_TOKEN must be ABSENT - doctor fails if it is present
```

The client then authenticates **to us** with its saved claude.ai login (proved on 2.1.305: it sends
its own OAuth bearer with `anthropic-beta: …,oauth-2025-04-20,…`), the session stays a subscription
session, and claude-gw still re-signs `/v1/messages` with B or C. Consequences:

- Only `/v1/messages*` is re-signed. `/v1/models` and anything account-shaped keeps the client's own
  credential, because a `setup-token` is inference-only and 403s on those endpoints.
- The login must exist and be readable: `activate` refuses without it, `doctor` checks it.
- `/usage` now reports **that login's** windows, not the serving account's. The status bar and
  `cla-gw health` remain the truth.

User scope is deliberate (D-6): the VS Code extension spawns its **own bundled `claude.exe`**, so
shell-only exports would cover the terminal and miss the extension. Three consequences, all real:

- **Restart VS Code fully, and open a new terminal.** Running processes keep the old environment; this
  is the #1 "it didn't work".
- `ANTHROPIC_BASE_URL` at user scope affects **every** process you start, not just Claude Code.
- If the gateway is down, Claude Code cannot reach the API at all — hence the Startup entry, and
  `doctor` checking for it. `cla-gw activate --no-startup` opts out of autostart.

Verified live: a brand-new process with the persisted vars ran `claude -p` through the gateway and the
log recorded `B 200 lowest-pressure-skipping-restricted` — A was restricted, so B served it.

For one session without the gateway (your real login direct, nothing persistent changes):

```powershell
node src/cli.mjs run -- -p "hi"
```

**Deleting the three variables is the kill switch**; `deactivate` does it for you.

## Credentials: who owns what

| Account | Credential | Refreshed by |
|---|---|---|
| `A` (`kind: cli-credential`) | `~/.claude/.credentials.json` | **the Claude Code CLI only.** The gateway opens this read-only and never writes it |
| `B`… (`kind: vault`) | DPAPI blob in `%LOCALAPPDATA%\claude-gw\vault\` | nothing — `setup-token` values do not refresh; re-add at ~365 days |

The CLI guards that file with a lockfile + compare-and-swap write and assumes it is the sole
writer. An external process refreshing the same chain risks corrupting it and logging you out —
hence the split. Do not add a second writer.

Vault secrets are passed to PowerShell over **stdin**, never as a command-line argument (arguments
are visible to every other process). Decryption happens once and is cached; per-request subprocess
spawns would add hundreds of ms to every call. DPAPI `CurrentUser` protects the token **at rest** —
it does not protect it from a process already running as you.

## How switching works

Every `/v1/messages` response — success or error — carries the account's quota state:
`anthropic-ratelimit-unified-{5h,7d}-{utilization,status,reset}`, `retry-after`, `representative-claim`.
The gateway records it per account in `accounts_state.json`, so nothing is polled (which matters:
a vaulted `setup-token` gets `403 … user:profile` from the usage endpoint and cannot be polled at all).

- **Either window being full triggers the switch.** A 429 on the serving account parks it and replays
  the request on the next account *before a single token streams to you*, so the request that hits the
  limit is still served. Replaying is safe only there: a rejected attempt cost nothing, and once the
  first SSE token is on the wire we never retry (double-billing, duplicated text).
- **An account is usable again when its LAST rejected window clears**, not the first. A's 5h refills
  tonight; its weekly runs to Oct 16, so A is dead until Oct 16.
- **All accounts restricted → route to whoever reactivates soonest**, and pass the real 429 plus its
  countdown through rather than inventing an error.
- **Sticky: switch ONLY on a full window.** Traffic stays on the account in use (`activeAt` in
  `accounts_state.json`) however high its usage, and moves only when a 5h or weekly window blocks it.
  The new account then stays current until it is blocked in turn. Usage alone never switches because
  the prompt cache is per account: every switch resends the whole conversation uncached. A model gate
  or a headerless blip gets a one-request **detour** that leaves the current account unchanged.
- **Not all 429s are quota — there are three shapes, and telling them apart is the whole game:**
  1. **quota rejection** — a window status says `rejected`, with reset epochs / `retry-after` → park the
     account until its last rejected window clears;
  2. **model-level gate** — headers present, *nothing* rejected. Observed on B: Sonnet rejected while
     B's own headers read `7d 80% allowed_warning`, and the **same token served Haiku seconds later**.
     So the *model* is gated, not the account: it gets a 15-minute model gate and the account stays in
     the pool. Selection prefers an ungated account for that model, and never strands the request.
  3. **headerless blip** — the opaque `{"message":"Error"}`, no quota info → 60s park (`retry-after`
     honoured when present), never a week.
  Parking long on (2) or (3) once removed a healthy account from the pool for days, which then looked
  like "both accounts are exhausted". `cla-gw health` prints `MODEL-GATED (…)` per account.
- **`overage-status: rejected` is not a capacity signal.** It appears on *successful* responses too;
  it just means extra-usage purchase is off (`out_of_credits` / `org_level_disabled`). Reading it as
  "out of capacity" is one reason a live pool was misread as empty.
- **You get told:** a Windows toast on switch (throttled per account-pair), the statusline shows the
  serving account, and `cla-gw health` shows utilisation, reset times and park reason.

`cla-gw notify` fires a test notification. `cla-gw reset-state` clears quota state; the running
gateway hot-reloads the file, so no restart is needed.

## When both accounts run out: the chats resume themselves

This is Claude Code's own feature, not a rescuer script we wrote. With the credential slot empty (see
"Go live") a session that hits a usage limit shows
`Usage limit reached · continuing automatically at 3:10am · esc to cancel`, waits, and at the reset
**sends the continuation itself**. Proven end to end on 2.1.305 against a stand-in upstream: stopped at
10:06:30, resumed itself at 10:07:28 (that ~60s is its own jitter) with nobody typing. `esc` cancels
that chat's resume; a chat you interrupted before the limit stays where you left it.

What the gateway adds is making the countdown describe **the pool**, because the client has no idea a
second account exists:

- **quota shim** — a waiting client arms a timer from the reset epoch in the 429's headers and stops
  asking. If the refusing account reopens at 04:00 but its mate reopens at 03:10, we rewrite *only*
  those reset epochs and `retry-after` to the earlier time. Statuses, body, status code and error type
  stay exactly as upstream sent them, and the shim **never lengthens a wait**. Logged as `quotaShim`.
- **bounded hold** (`holdMaxMs`, default 45s) — if the pool refuses but reopens within seconds (last
  night: C filled 1:02, B 1:03), the request is held and then served instead of handing over a limit
  message that would start a wait we could have skipped. A reset further out than the ceiling fails
  fast, exactly as before; a chat is never held open for hours.
- `probe_upstream.mjs` / `probe_limit.mjs` stand in for api.anthropic.com and answer whatever
  credential arrives, so this whole flow can be rehearsed in six minutes for **zero** quota and with
  nothing live touched. Re-run it after any Claude Code update — this is the feature most likely to be
  silently regressed by an update or by someone re-adding `ANTHROPIC_AUTH_TOKEN`.

```powershell
node src/probe_upstream.mjs start --detach      # stand-in on 127.0.0.1:8791
node src/probe_limit.mjs arm --reset-in 360     # "out of usage", heals in 6 minutes
node src/probe_limit.mjs launch --variant B --vscode   # throwaway window, no quota, no live config
node src/probe_upstream.mjs selftest            # prove the 429/200 shapes without a client
node src/probe_upstream.mjs stop
```

## Quota state and routing

Every `/v1/messages` response — success or 429 — carries the account's live quota state in headers:
`anthropic-ratelimit-unified-{5h,7d}-{utilization,status,reset}`, `retry-after`, `representative-claim`,
`overage-*`, and `anthropic-organization-id`. The gateway records all of it per account in
`accounts_state.json`. Nothing is polled, which matters because **a vaulted `setup-token` cannot read
`/api/oauth/usage` at all** (`403 … does not meet scope requirement user:profile`) — headers are the
only quota signal available to it, and they are free.

A 429 parks that account until *its own* reset epoch, and traffic moves to the least-used free account
(`max(5h, 7d)`), which stays current until it is blocked in turn. If every account is parked, the gateway still forwards to whichever
frees up soonest and passes the real 429 through — it never invents an error. The org id in those
headers is also how a token with no `user:profile` scope gets identified: two accounts sharing an org
are the same account, and `cla-gw ls` says so.

## Which account is serving me?

`/usage` and the account chip bypass the base-URL override, so they always report the pinned
account. The only truthful indicator is:

- `cla-gw status` — pool, pin, per-account request counts
- `cla-gw statusline` → add the printed `statusLine` block to `~/.claude/settings.json`; it renders
  `gw→A [A,B]` for the conversation you are in (keyed on `x-claude-code-session-id`). `~` prefix
  means inferred rather than observed for that session. **I did not edit your settings.json**.
- The VS Code **Claude Code panel draws no `statusLine`** (and mods cannot draw there yet), so
  `vscode/` holds a tiny extension that puts `gw→C 29%/4% · B 78%/11%` in the window's status bar,
  with a hover table and a red `claude-gw DOWN` if the gateway stops. Rebuild and install:
  `python vscode/pack.py` then `code --install-extension vscode/claude-gw-status-0.1.0.vsix --force`.

## Tests

```powershell
node src/smoke.mjs          # 11 checks: auth, host guard, real upstream passthrough, empty rotation
node src/smoke-sse.mjs      #  7 checks: SSE streams incrementally, no content-encoding/length leaks
node src/smoke-vault.mjs    # 10 checks: DPAPI round-trip, no plaintext on disk, per-session statusline
node src/test_selection.mjs # 35 checks: the rotation rules and 429 classification, no network at all
node src/test_sticky.mjs    #  9 checks: sticky routing end to end, real gateway + fake upstream in a
                            #            throwaway data dir (free, touches nothing live, no toasts)
node src/test_replay.mjs    # 10 checks: mid-request failover against a fake upstream (free, deterministic)
node src/test_quota_surface.mjs # 22 checks: header auth, per-path re-signing, the quota shim, the
                            #            bounded hold, and "never hold a reset that is hours away"
node src/failover_test.mjs  # 11 checks: same against the REAL upstream (costs two tiny completions)
```

`smoke.mjs` sends **one** tiny request to the real upstream. If the account is at its limit that
429 is the expected result and costs nothing; otherwise it costs a handful of tokens.

## Guarantees and non-guarantees

- Loopback-only bind, peer-address check, `Host` validation, timing-safe secret compare. The local
  secret travels in `x-gw-secret` (or, in legacy mode, the bearer) and is stripped before forwarding.
- **`ANTHROPIC_AUTH_TOKEN` is a *local* secret, not an Anthropic credential.** Still: do not commit
  it, do not paste it into logs or issues.
- The gateway logs to `%LOCALAPPDATA%\claude-gw\gateway.jsonl`: paths, statuses, session ids,
  timings, byte counts. It never logs tokens, secrets, or `authorization` values.
- **`disable` is not `revoke`.** There is no server-side revoke in Claude Code; a disabled
  account's token stays valid until it expires or you revoke it at claude.ai settings.
- An empty rotation fails fast with an explicit error (`503 empty-rotation`) rather than hanging,
  because a stall would otherwise turn into the CLI's retry ladder.
- `/usage` and the account chip bypass the base-URL override, so they keep reporting the pinned
  account, not the one serving tokens. Until phase 3's statusline lands, `cla-gw status` is the
  source of truth for which account actually served a request.
- The extension bundles and auto-updates its own `claude.exe` independently of the CLI. After an
  extension update, re-run both smoke tests.

## State

- config: `%LOCALAPPDATA%\claude-gw\config.json` (hot-reloaded per request — no restart needed)
- log: `%LOCALAPPDATA%\claude-gw\gateway.jsonl`
- pid: `%LOCALAPPDATA%\claude-gw\gateway.pid`

Nothing under `~/.claude` is ever written by this program.

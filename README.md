# claude-gw

A local gateway for [Claude Code](https://code.claude.com) that serves its requests from a **pool of your
Claude accounts**. When the account in use hits its 5-hour or weekly usage limit, the next request goes to
another account, before a single token has streamed, so the chat keeps going instead of stopping at
"usage limit reached".

It works for both the Claude Code CLI and the VS Code extension, with no change to Claude Code itself: Claude
Code is pointed at `http://127.0.0.1:8790` through its documented `ANTHROPIC_BASE_URL` setting.

```
Claude Code (CLI / VS Code panel)
        │  ANTHROPIC_BASE_URL=http://127.0.0.1:8790
        ▼
   claude-gw  ── picks an account, swaps the credential on /v1/messages, reads the quota headers
        │
        ▼
 api.anthropic.com
```

- **Pure Node.js, zero dependencies.** One process, loopback only.
- **Windows** today (the credential vault, autostart and notifications use PowerShell and DPAPI).
- Every routing rule below is covered by an offline test suite (`npm test`).

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [How routing works](#how-routing-works)
- [Riding out a limit: auto-resume and the long hold](#riding-out-a-limit-auto-resume-and-the-long-hold)
- [Seeing which account is serving](#seeing-which-account-is-serving)
- [What the traffic would have cost on the API](#what-the-traffic-would-have-cost-on-the-api)
- [Configuration](#configuration)
- [Files it reads and writes](#files-it-reads-and-writes)
- [Security model](#security-model)
- [Tests](#tests)
- [Known limits](#known-limits)
- [License](#license)

## What it does

**Account pool and failover**
- Keeps any number of accounts ready and swaps the credential **per request**, so switching is instant and
  never opens a browser (Claude Code itself holds one login and needs `/login` to change it).
- Account `A` is the login Claude Code already has. More accounts are added with `cla-gw add <label>`, which
  runs `claude setup-token` in an isolated config directory and stores the token encrypted with Windows DPAPI.
- A request that gets a quota `429` is replayed on the next account **before any of the response has reached
  the client**, so the request that hits the limit is still answered. Once the first byte of a stream is sent,
  it is never retried (that would duplicate text and double-bill).
- **Sticky routing:** traffic stays on one account until a window actually blocks it. High usage alone never
  switches, because the prompt cache is per account and every switch re-sends the whole conversation uncached.

**Telling limits apart**
- Distinguishes three kinds of `429`: a full 5h/weekly window (park the account until its *last* blocked window
  clears), a limit on one model only (gate that model on that account, starting at 15 minutes, and keep the
  account), and an opaque error with no quota headers (park for 60 s, or `retry-after` up to 15 minutes).
- Detects an account that cannot serve at all, for example one that needs you to accept updated terms on
  claude.ai, parks it and tells you what to click. `cla-gw check` probes every account with a one-token request.
- Learns quota state for free from the `anthropic-ratelimit-unified-*` headers on every response. Nothing is
  polled, which matters because a `setup-token` cannot read the usage endpoint at all.
- Spots two "accounts" that are really the same one (same organisation id) and says so.

**Keeping chats alive across a limit**
- With every account blocked, it forwards the real `429` with the reset time rewritten to **the earliest
  reopening in the pool** (never later than upstream said), so Claude Code's own "continuing automatically at
  …" resumes the chat at the right moment.
- **Short hold:** if the pool reopens within seconds, the request is held and then served.
- **Long hold** for the VS Code panel, which never arms that auto-resume: the stream is opened, kept alive with
  pings, and the real answer is spliced in when an account reopens (up to 10 minutes by default).

**Visibility and control**
- `cla-gw health`: per-account utilisation, reset times, park reason, model gates.
- A Claude Code status line that names the account serving **this** conversation.
- A small VS Code extension that shows every account in the status bar, plus the API-equivalent cost.
- `/switch` inside Claude Code, or `cla-gw switch`, to pick the serving account by hand.
- Desktop popups when the gateway switches accounts, when a blocked pool reopens, and when an account needs
  terms accepted.
- `cla-gw audit routing` checks the real traffic log against the routing rules.
- `cla-gw cost` prices the traffic at API list rates per model, day and account, and reports how much of the
  traffic it could price.

## Requirements

- **Windows 10/11** with Windows PowerShell 5.1 (built in).
- **Node.js 20+**.
- **Claude Code** (CLI and/or the VS Code extension), signed in. `cla-gw add` runs
  `%USERPROFILE%\.local\bin\claude.exe` (where the native installer puts it); set `CLAUDE_BIN` if yours is
  elsewhere. `cla-gw run` uses `claude` from `PATH`.
- Python 3, only to build the VS Code status-bar extension.

## Install

```powershell
git clone https://github.com/markmircea/claude-gw.git
cd claude-gw
npm install -g .       # puts `cla-gw` on PATH (no dependencies are downloaded)
npm test               # offline suites, a few seconds, touch nothing live
```

`node src/cli.mjs <command>` works everywhere `cla-gw <command>` is shown.

## Quick start

```powershell
cla-gw start           # background listener on 127.0.0.1:8790; creates the config on first run
cla-gw add B           # enrol a second account (prints a sign-in URL; use a PRIVATE browser window)
cla-gw check           # one 1-token request per account: can each one actually serve?
cla-gw activate        # point Claude Code at the gateway (user env vars + settings.json) and autostart it
cla-gw doctor          # verify the whole chain; run this first whenever something looks wrong
```

Then **open a new terminal and fully restart VS Code**. Running processes keep their old environment, and
this is the most common reason it "didn't work".

On first start the pool contains only `A`, your existing Claude Code login. Use a private browser window for
`cla-gw add`: the sign-in page hands back whichever account the browser is already signed into, so otherwise
"adding B" silently re-enrols A. The gateway then catches the duplicate by its organisation id.

If `setup-token` cannot be driven automatically, `cla-gw add <label>` prints the manual command; finish with
`cla-gw add <label> --paste`. Record which address an account belongs to with `cla-gw email <label> <addr>`
(a setup-token cannot report its own email).

To undo everything: `cla-gw deactivate` removes the environment variables, the settings.json keys and the
autostart entry, and stops the gateway. To run one session that bypasses the gateway: `cla-gw run -- -p "hi"`.

## Commands

| Command | What it does |
|---|---|
| `start` / `stop` / `status` | Run or stop the background gateway; `status` shows the pool, the pin and per-account request counts |
| `health` | Per-account quota state from real traffic: utilisation, resets, park reason, model gates |
| `check [labels]` | Live probe: one 1-token request per account. Exit code 1 if any account cannot serve |
| `ls` | List accounts and their credential kind |
| `add <label> [--paste\|--auto]` | Enrol an account via `claude setup-token` in an isolated config dir. A one-token probe runs first: a rejected token is not added, and an account that cannot serve yet (e.g. terms not accepted) is added disabled |
| `email <label> <addr>` | Record the account's email address (shown by `ls`, `health`, the status bar) |
| `enable <label>` / `disable <label>` | Put an account in or out of rotation, instantly, without deleting it |
| `forget <label> --yes` | Delete the local entry and its vaulted token. **Not** a revoke: revoke at claude.ai if needed |
| `switch [label\|number\|next\|off]` | Pick the serving account by hand, with the state you need to choose; `off` returns to automatic |
| `use <label>\|none` | Pin an account (`none` = automatic) |
| `install-slash [name]` | Install `/switch` into `~/.claude/commands` (never overwrites a different file) |
| `activate [--no-startup\|--legacy]` | Set the user env vars and settings.json env block, start the gateway, install the logon autostart |
| `deactivate` | Undo `activate` and stop the gateway |
| `doctor` | Check env vars, settings, login, gateway and autostart; exit code 1 on any failure |
| `run -- <claude args>` | One Claude session with the gateway variables removed (your login, direct) |
| `env` / `clear-env` | Print PowerShell lines that set or clear the variables for the current shell only |
| `statusline` | Print the `statusLine` snippet for `~/.claude/settings.json` (it does not edit the file) |
| `cost [--days N]` / `prices` | API-equivalent cost per model, day and account, with coverage / the rate table behind it |
| `audit routing [--hours N]` | Judge the real traffic log against the routing rules; exit code 1 on a violation |
| `reset-state` | Clear learned quota state (the running gateway picks it up without a restart) |
| `notify` | Show a test notification |

## How routing works

Every `/v1/messages` response, success or error, carries the account's quota state in
`anthropic-ratelimit-unified-{5h,7d}-{utilization,status,reset}` and `retry-after`. The gateway records it per
account in `accounts_state.json` and routes on it:

1. **Stay on the current account** while it can serve, however high its usage.
2. **A full window moves traffic.** A quota `429` parks the account until its *last* blocked window clears
   (a 5h window that refills tonight does not help if the weekly one is full until Friday), and the request is
   replayed on the least-used open account, which then becomes current.
3. **A model gate is a detour, not a switch.** A `429` whose headers show nothing rejected means that model is
   limited on that account. The model is gated there for 15 minutes, growing to 1 hour and then 4 hours if it
   keeps refusing (any success clears it). The request goes elsewhere for that model only, and the current
   account stays current.
4. **A headerless blip parks for 60 s** (or for `retry-after`, capped at 15 minutes), never for days. Parking
   long on (3) or (4) once removed a healthy account from the pool for days.
5. **Everything blocked:** the request goes to whichever account reopens soonest, and the real `429` is passed
   through with the pool-corrected reset time. The gateway never invents an error.
6. **An empty rotation fails fast** with `503 empty-rotation` instead of hanging into the client's retry ladder.

`overage-status: rejected` on a response is **not** treated as a capacity signal: it appears on successful
responses too and only means extra-usage purchase is off.

Only `/v1/messages*` is re-signed. In the default mode every other path (model listing, account calls) keeps the
client's own credential, because a setup-token is inference-only and is refused there. In `--legacy` mode the
client sends the local secret instead of its login, so there is no client credential to keep.

## Riding out a limit: auto-resume and the long hold

**Terminal chats.** When the client's own credential slot is left empty (the default mode, see
[Security model](#security-model)), Claude Code treats the session as a subscription session. When it hits a
limit it shows `Usage limit reached · continuing automatically at …`, waits, and sends the continuation itself.
The gateway's part is making that countdown describe **the pool**: it rewrites only the reset epochs and
`retry-after` in the `429` to the earliest reopening across all accounts. Status, body and error type stay as
upstream sent them, and it never makes a wait longer.

**Short hold** (`holdMaxMs`, default 45 s): if the pool reopens within that time, the request is held and then
served, instead of starting a wait that could be skipped.

**VS Code panel: the long hold.** The panel runs Claude Code headless, and in that mode it does **not**
auto-resume after a limit. So for streaming requests, if the pool reopens within `holdStreamMaxMs` (default
10 minutes), the gateway answers `200` at once, sends an SSE `ping` every 20 s, and splices the real upstream
response into the same stream when an account opens. The turn never ends. The ceiling is 10 minutes because the
client abandons a held stream at about 900 s; past the ceiling the real `429` is passed through straight away,
so an interactive chat can still arm its own wait.

It cannot bring back a panel chat you interrupted, a window you closed, or a laptop that slept through the
reset.

## Seeing which account is serving

Claude Code's own `/usage` and account chip ignore the base-URL override, so they keep showing your login, not
the account that served the request. The gateway's views are the truthful ones:

- **`cla-gw status`** and **`cla-gw health`**.
- **Status line** (terminal): run `cla-gw statusline` and add the printed block to `~/.claude/settings.json`. It
  shows `gw→C 5h 51% 7d 87% [B,C,D]` for the conversation you are in (a `~` before the label means inferred
  rather than observed). When the whole pool is full it adds `| all full, D opens 06:00`.
- **VS Code status bar** (the panel draws no status line). Build and install the extension in `vscode/`:

  ```powershell
  python vscode/pack.py                                        # writes vscode/claude-gw-status-<version>.vsix
  code --install-extension vscode/claude-gw-status-0.3.0.vsix --force
  ```

  Then run **Developer: Reload Window**. The bar shows the whole pool:

  ```
  gw: ✓ C 51%/87% · B ?/9% · D ?/40% · ≥$76.17 api
  ```

  ✓ marks the serving account, the numbers are 5h/7d utilisation (`?` = not seen since its window reset), `⛔`
  plus a time means blocked until then, `⚠terms` means a person has to accept terms on claude.ai, `off` means
  disabled, `⏳ N held` counts chats being held for a reopening, and `claude-gw DOWN` appears in red if the
  gateway stops. The hover has a table per account (email, status,
  resets, last seen) and the cost for the past day, week, month and all time. Clicking runs `cla-gw health`.
- **`/switch`**: `cla-gw install-slash` adds a `/switch` command to Claude Code. `/switch` lists the pool,
  `/switch c` or `/switch 2` pins an account, `/switch next` moves to the next open one, `/switch off` returns
  to automatic. The switch is plain shell run before the model reads anything, and the model cannot invoke it
  on its own.

## What the traffic would have cost on the API

A subscription is flat-rate, but the gateway sees every token, so it prices them at API list rates:

```powershell
cla-gw cost --days 7    # per model, per day, per account, in tokens and dollars, with coverage
cla-gw prices           # the rate table and the date it was copied
```

- Rates are keyed by **exact model id** in a dated table (`PRICES_AS_OF` in `src/config.mjs`). A model the table
  does not know is reported as **UNPRICED**, never guessed.
- Multipliers come from the response itself: cache-write TTL (5m vs 1h), cache reads, fast mode, US-only
  inference, long-context tiers. Web searches are priced per search; web fetches are counted but not priced.
- Every total says how much of the traffic it covers (`N priced of M`). Streams cut off before their final
  usage count make the figure a floor, shown as `≥`.
- Override or add rates in `config.json` under `"prices"`.

## Configuration

`%LOCALAPPDATA%\claude-gw\config.json` is created on first start and **re-read on every request**, so edits
apply without a restart.

| Key | Default | Meaning |
|---|---|---|
| `host`, `port` | `127.0.0.1`, `8790` | Listen address (loopback only) |
| `upstream` | `https://api.anthropic.com` | Where requests go |
| `secret` | random | Local shared secret clients must send; generated on first run |
| `secretHeader` | `x-gw-secret` | Header that carries the secret |
| `swapInferenceOnly` | `true` | Re-sign only `/v1/messages*` |
| `active` | `null` | Pinned account label; `null` = automatic |
| `holdMaxMs` | `45000` | Short silent hold when the pool reopens within this many ms; `0` disables |
| `holdStream` | `true` | Long hold for streaming requests (the VS Code panel) |
| `holdStreamMaxMs` | `600000` | Long-hold ceiling; keep it under the client's ~900 s abandon point |
| `accounts` | `[A]` | `{ label, kind: "cli-credential" \| "vault", enabled, identity }` |
| `prices` | none | Per-model or per-family rate overrides for `cost` |

`CLAUDE_GW_DATA_DIR` moves the `%LOCALAPPDATA%\claude-gw` files below to another directory (the tests and
probe harnesses use it); the `~/.claude` files, environment variables and Startup entry are not affected.
`CLAUDE_GW_NO_NOTIFY=1` suppresses popups. `CLAUDE_BIN` overrides the `claude.exe` that `add` runs.

## Files it reads and writes

| Path | Purpose |
|---|---|
| `%LOCALAPPDATA%\claude-gw\config.json` | Configuration and account list |
| `%LOCALAPPDATA%\claude-gw\vault\<label>.dpapi` | Enrolled tokens, DPAPI-encrypted (CurrentUser) |
| `%LOCALAPPDATA%\claude-gw\provision\<label>\` | The isolated Claude config dir `add` runs `setup-token` in |
| `%LOCALAPPDATA%\claude-gw\accounts_state.json` | Learned quota state per account |
| `%LOCALAPPDATA%\claude-gw\status.json` | Live snapshot for the status line and the VS Code extension |
| `%LOCALAPPDATA%\claude-gw\gateway.jsonl` | Request log: paths, statuses, accounts, timings, token counts. Never tokens or secrets |
| `%LOCALAPPDATA%\claude-gw\gateway.pid` | PID of the running gateway |
| `~/.claude/.credentials.json` | Account `A`: Claude Code's own login. **Read only**, never written |
| `~/.claude.json` | Read only, to show which account Claude Code is signed in as |
| `~/.claude/settings.json` | `activate` adds three `env` keys (one-time backup `settings.json.claude-gw.bak`); `deactivate` removes them |
| `~/.claude/commands/switch.md` | Written by `install-slash` only |
| User environment variables | `CLAUDE_CODE_USE_GATEWAY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` (set by `activate`; `--legacy` sets `ANTHROPIC_AUTH_TOKEN` instead of the header); `deactivate` clears all four |
| Startup folder `claude-gw.cmd` | Starts the gateway at logon (`activate --no-startup` skips it) |

## Security model

- **Loopback only**: binds to `127.0.0.1`, checks the peer address and the `Host` header, and compares the
  local secret in constant time. The secret is stripped before anything is forwarded.
- **The credential slot is left empty on purpose.** The local secret travels in a custom header
  (`ANTHROPIC_CUSTOM_HEADERS: x-gw-secret: …`) and `ANTHROPIC_AUTH_TOKEN` stays unset. If it were set, Claude
  Code would treat the session as a metered API session and turn off its own wait-and-continue at usage limits.
  In this mode `doctor` fails if it is present. `activate --legacy` uses the old token mode anyway, without
  auto-resume.
- **Account `A`'s credential belongs to Claude Code.** The CLI refreshes `~/.claude/.credentials.json` under its
  own lock and assumes it is the only writer, so the gateway only ever reads it.
- **Enrolled tokens** are 1-year, inference-only `setup-token`s, encrypted with DPAPI for the current Windows user.
  They are passed to PowerShell over stdin (never on a command line) and decrypted once per gateway run. DPAPI
  protects them at rest, not from a process already running as you.
- `ANTHROPIC_BASE_URL` at user scope affects **every** process you start, not only Claude Code. If the gateway
  is down, Claude Code cannot reach the API at all: that is why `activate` installs the autostart, and why
  `doctor` and the red status-bar item exist. `deactivate` (or deleting the three variables) is the off switch.
- `disable` and `forget` are local. Revoke a token at claude.ai if it was ever exposed.

## Tests

```powershell
npm test
```

runs the eight offline suites. Each one uses its own port and a throwaway data directory, so they never touch a
running gateway, its config or your accounts:

| Suite | Covers |
|---|---|
| `test_selection` | Account selection and `429` classification, pure functions |
| `test_routing_rules` | The routing contract: stickiness, detours, pool-corrected resets |
| `test_sticky` | Sticky routing end to end: a real gateway against a fake upstream |
| `test_quota_surface` | Header auth, per-path re-signing, the quota shim, both holds, usage capture from a real-shaped stream |
| `test_costing` | Token capture from usage objects copied from real traffic, and per-model pricing |
| `test_statusbar` | What the VS Code bar and hover render (stubs `vscode`, calls the extension's `render()`) |
| `test_config_safety` | Config writes under live traffic: atomic saves, a corrupt file keeps the last good config, and hot reload sees every edit, even two in one file-time tick |
| `test_switch_cli` | `cla-gw switch` reaches every account and explains what a choice costs |

Others need care:

- `src/test_replay.mjs` and `src/smoke-sse.mjs` point the **running** gateway's `upstream` at a fake server for
  a few seconds. Run them only when no real chat is using the gateway.
- `src/smoke-vault.mjs` writes a test entry into the real vault directory.
- `src/smoke.mjs` and `src/failover_test.mjs` send tiny requests to the real API.

`src/probe_*.mjs` are development harnesses. `probe_upstream.mjs` is a stand-in for api.anthropic.com that can
play "out of usage, reopens in N minutes", so the whole limit/resume flow can be rehearsed against the real
Claude Code binary without spending quota. `probe_long_hold.mjs` does the same for the VS Code panel's own
`claude.exe` on a throwaway gateway. Re-run them after a Claude Code update: the client-side behaviour they rely
on is the part most likely to change.

## Known limits

- **Windows only** for now: the vault, `activate`/autostart and notifications have no Linux or macOS path yet.
- Developed and tested against Claude Code 2.1.30x. The auto-resume and long-hold behaviour depends on how the
  client handles `429`s, which can change between releases.
- `setup-token`s do not refresh. Re-add an account after about a year.
- Claude Code's `/usage` and account chip keep reporting your own login, not the serving account.
- The VS Code panel cannot be resumed by the gateway once the client has ended the turn.

## License

[Apache License 2.0](LICENSE).

claude-gw is an independent project and is not affiliated with or endorsed by Anthropic.

---
description: Switch which claude-gw pool account serves this chat — /switch (list) · /switch b · /switch 2 · /switch next · /switch off. Any account in the pool, by label or by its number in the list.
allowed-tools: Bash(cla-gw switch:*)
disable-model-invocation: true
---

!`cla-gw switch $ARGUMENTS`

The block above is the gateway's own output, produced before this message was written. Do not re-run the
command, and do not repeat any number that is not in that block.

**Every account in the pool is reachable** — by its label (case-insensitive) or by the row number the listing
shows (`/switch 2`). `/switch next` moves to the next account that is open, `/switch off` returns control to
the automatic rules. If the user asks for an account that does not appear in that listing, do not guess or
substitute another one: say which labels the listing shows and ask which they meant.

Answer in at most two lines:

1. Which account is pinned now — or that nothing was pinned (unknown label, disabled account, or every
   other account is limited and the pool reopens at a stated time).
2. If the output contains WARNING, say what it warned about in plain words, including the reopen time.

Two things that must not be got wrong:

- **This turn does not change accounts.** The pin applies to the NEXT request. The reply being written now
  is already being served by whatever account took the request, and a reply already streaming finishes on
  the account it started on.
- **The status badge is per-conversation.** It names the account that last answered THIS chat, which is not
  necessarily the account the pool would choose next; a `~` prefix in it means inferred. If the badge and
  the switch output disagree, both can be true — say so rather than picking one.

First request on a newly-pinned account rebuilds that chat's prompt cache: expect it to be slower and to
cost more tokens than the one before it.

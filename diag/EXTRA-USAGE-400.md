# Intermittent 400 "You're out of extra usage"

```
API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
```

Server-issued with a real `request_id`, typed `invalid_request_error`, marked `x-should-retry: false` — so Claude Code treats a billing condition as a fatal client error and the turn dies. The response carries none of the `anthropic-ratelimit-unified-*` family except `overage-disabled-reason`, so the server short-circuits before computing a rate-limit view. Twenty occurrences 2026-07-29 to 2026-08-06, in episodes minutes long.

Use `diag/attrib.py` to find and classify occurrences; it documents the log shapes to match on.

## Reproduction

Deterministic and client-free. Capture a failure, then replay the body with its headers:

```
node diag/capture-proxy.mjs --port 8795 --out /tmp/cc-cap
ANTHROPIC_BASE_URL=http://127.0.0.1:8795 pi --model claude-bridge/claude-opus-5
# an episode writes err-NNNN.json beside req-NNNN.json
curl -X POST 'https://api.anthropic.com/v1/messages?beta=true' \
     -H "authorization: Bearer $TOKEN" <headers from err-NNNN.json> \
     --data-binary @req-NNNN.json
```

`req_011CdnAUvhxnrxVzANbdJD7N` replays 400 every time while four sibling captures from the same account replay 200 in the same minute, interleaved — so the state does not drift under the test.

## What decides it

The system prompt, byte for byte. `req-0071` is a failing agent turn; `req-0073` is the `continue` the user typed straight after, which passed. They differ in both system prompt and messages, so swap them:

| system prompt | messages | result |
| --- | --- | --- |
| agent turn (27,584 chars, carries `<sub_agent_context>`) | 0071's | **400** |
| parent (20,150 chars) | 0073's | 200 |
| parent (20,150 chars) | 0071's | 200 |
| agent turn (27,584 chars) | 0073's | **400** |

**This is why "continue" clears it** — the next `before_agent_start` restored the parent's prompt, making it a different request. Retrying is not what helps.

A cumulative component sits underneath: with the full agent prompt the messages are irrelevant, but with a *truncated* one they decide it. It is not raw size — synthetic filler never triggers it anywhere from 11K to 181K tokens.

## Ruled out

Each by direct experiment, most after being asserted here and withdrawn:

| hypothesis | killed by |
| --- | --- |
| client authenticity / non-official access | the failing request came from the real CC binary via the Agent SDK; >100 hand-rolled `curl` requests passed |
| a retry, in any form | identical body fails 100%; unmoved by fresh session/device id, whitespace, `max_tokens`, or an appended `continue` turn |
| a banned keyword (`kimi-k3`) | a passing capture contains it 4×; stripping it from the failing body still fails; adding it to a passing body still passes |
| prefix-position cache key | prepending 49 chars changed nothing |
| token count or a size band | filler sweeps 11K→181K tokens without one failure |
| model, tools, thinking, effort, `max_tokens`, `cache_control` | removed or varied individually; failure persists |
| concurrency / simultaneity | 28 concurrent pairs, 0 failures |
| subagent lifecycle | 18 agent-lifecycle turns passed while the state was live |

No mechanism explains the content-dependence. Every general model tried is dead.

## The bridge bug

Two module globals held the prompt capture from `before_agent_start`. pi fires that per agent loop and sub-agents run in their own `AgentSession`, so a sub-agent overwrote the parent's capture and nothing restored it: every later parent turn carried the sub-agent's `<sub_agent_context>` and lost its own context files (`ctxFiles` 1 → 0) for the rest of the session. Captures are now keyed by the assembled system prompt, so a query resolves to its own agent's capture or to none.

Worth having on its own — the parent was being told it was a sub-agent and silently losing its project instructions — and it removes most of the exposure above, since the clobbered prompt is the one that fails. That covers the 14 of 20 failures that are parent turns. The other 6 are the sub-agent's own request, which legitimately builds its own long prompt; nothing local can immunise those.

## Billing anomaly

Separate, and the one costing money. On 08-06 the account was funded with Extra Usage enabled; the bridge saw `overageStatus: allowed` at 18:04:31 and `rejected / out_of_credits` nine minutes later, against a balance the account holder reports as unspent. `isUsingOverage: true` occurs **0 times** that day, and the five-hour and seven-day windows stood at 0.57 and 0.39 — nothing had drawn on it and overage had no reason to engage. Funding is not a remedy.

## Upstream

[#80750](https://github.com/anthropics/claude-code/issues/80750) (credits consumed while plan allowance untouched) matches the billing anomaly directly. Also [#45020](https://github.com/anthropics/claude-code/issues/45020), [#63761](https://github.com/anthropics/claude-code/issues/63761), [#65514](https://github.com/anthropics/claude-code/issues/65514), [#84141](https://github.com/anthropics/claude-code/issues/84141).

The contribution worth making is the reproducer — one saved body that 400s deterministically while siblings from the same account return 200 — plus the ruled-out table, so nobody repeats it. Captured bodies hold whole conversations; sanitise before sending.

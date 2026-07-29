# Silent-loss audit

Scanners for the two boundaries where the bridge can lose or corrupt data without
anything throwing:

1. **Write path** — pi history → `convertPiMessages` → `repairToolPairing` →
   `Session.importMessages` → JSONL → `--resume`.
2. **Tool loop** — pi tools served over in-process MCP, `tool_use` blocks streamed
   back into pi, results paired by `_meta["claudecode/toolUseId"]`.

Both bugs found in July 2026 failed silently — nothing threw, no test went red,
and the only evidence sat on disk. These scripts make that evidence greppable.

```
node --import tsx diag/audit-transcripts.mjs [file.jsonl | projects-dir] [--since YYYY-MM-DD]
node --import tsx diag/audit-cache.mjs       [claude-bridge.log] [--since YYYY-MM-DD] [--ceiling 0.30]
node --import tsx diag/audit-warnings.mjs    [claude-bridge.log] [--since YYYY-MM-DD]
node --import tsx diag/replay-write-path.mjs <pi-session.jsonl>
```

Defaults are `~/.claude/projects` and `~/.pi/agent/claude-bridge.log`.

**`--since` is what makes these gates rather than reports.** Everything found is
always printed, but the exit code counts only records and log lines inside the
window. Most of what is on disk is damage from bugs already fixed, and correctness
today will never remove it — without a window the check is red forever and stops
being read. Pass the date of the last known-good run to ask "has anything gone
wrong since?". One caveat: a rebuild re-stamps old messages with the time it ran,
so a session rebuilt inside the window drags its whole history in with it.

`--ceiling` exists because the 24.5% boundary break rate below is an open finding
rather than a regression; set it just above the current rate to catch that number
getting *worse* while the cause is unresolved.

Baselines below are from the 2026-07-29 audit over 1,810 transcripts and an
April–July bridge log. Compare a future run against these, not against zero.

---

## Anchoring — read this before changing any log scan

Tool output is echoed into `claude-bridge.log` verbatim. A bare `grep WARNING:`
or `grep '[no tool result recorded]'` matches compiler output, other tools' logs,
and any file an agent happened to read. Every scan here anchors on the bridge's
own line prefix `^\[<iso-ts>\] \[<module-id>\] `, and the transcript scanner only
substring-matches markers inside bodies under 200 chars.

How much this matters: raw `grep -c` over the transcripts reports 900
`[no tool result recorded]`, 126 `[image]`, 95 `[empty]`, 26 `[document]`,
13 `[thinking]`, 13 `[orphaned tool result removed]`. The structured count is
**799** and **zero** for all the others. Five of those six numbers are pure echo.

---

## `audit-transcripts.mjs`

Walks `~/.claude/projects/**/*.jsonl`, classifies each record, and reports loss
markers and structural defects. Takes a single file to investigate one session.

**Bridge-written vs CC-authored.** Bridge records carry `message.id` =
`msg_syn_*` and `requestId` = `req_syn_*`, minted by cc-session-io
(`syntheticMessageId`/`syntheticRequestId`). CC's are real `msg_01*`/`req_*`, with
`promptId` on user records and populated `usage` cache fields. High confidence.
A file usually contains **both** — the bridge writes the prefix at a rebuild, then
CC appends its live turns to the same file (352 of 1,810 files are mixed).

**Record regrouping is mandatory.** Claude Code stores *one content block per
record*: a single assistant message spans several `assistant` records sharing one
`message.id`, and each `tool_result` gets its own `user` record. cc-session-io
writes one record per message. A scanner that does not regroup by `message.id`
first reports hundreds of phantom defects on CC's own files — the first pass of
this audit reported 538 unpaired `tool_use`, 536 orphan `tool_result` and 432
split result records that all vanished after regrouping.

> **CC splits a turn's tool results across records** — 365 times in real
> transcripts, all CC-authored. Example:
> `~/.claude/projects/-Users-esd-Obsidian-eli-note-helper/93bcaf3e-f74c-4ca3-9328-b25f66619e60.jsonl`
> lines 6–9. The single-message shape `convertPiMessages` emits is what
> `repairToolPairing` requires, not a copy of CC's layout; an early draft of this
> audit and of the `src/convert.ts` comment both got that backwards by reading
> bridge-written records as CC's own. `tests/int-cc-contracts.mjs` pins both facts.

### Baseline (2026-07-29)

```
scanned: 1810   cc-authored 854 | bridge-written 564 | mixed 352 | no-assistant 40

REAL PROJECTS
  [no tool result recorded]        407
  [incompatible content omitted]   125
  tool_use unanswered at EOF        30
  bridge-written non-MCP tool name  20
  tool_use with no tool_result       5
  tool_result after next turn        5
```

### What a clean run looks like

Zero markers and zero defects in real projects. It will not be clean today; the
baseline above is the known state. What matters is a **new** defect kind, or any
of the counts growing.

### Known-benign patterns

- **`[no tool result recorded]` × 407** — the parallel-results bug (fixed in
  ff60313c). 389 of 406 non-subagent occurrences sit in a record that *also*
  holds a real result from the same turn, which is the fingerprint of results
  2..N being dropped. Only 17 are genuine never-answered calls (lone stub, single
  `tool_use` in the turn). Should stop growing; existing files are historical.
- **`[incompatible content omitted]` × 125** — not lost content. Replaying all
  1,455 pi sessions through `convertPiMessages` shows ~75% replace assistant
  messages that were **already empty in pi** (606 such messages corpus-wide:
  325 `aborted`, 232 `error`, 49 `stop`), and the rest are thinking-only messages
  from *other* providers whose signatures we correctly refuse to replay
  (openai-codex 31, stepfun 24, cerebras 13, …). 72 pi sessions mix
  `claude-bridge` with another provider.
- **`tool_use` unanswered at EOF × 30** — all CC-authored tails, cut off by an
  abort or process exit. The bridge rotates the session on abort and never
  resumes them.
- **bridge-written non-MCP tool name × 20** — all `Read {"path":"token0.txt"}`
  unit-test fixtures. The same defect fires 5,525 times in test/temp dirs; that is
  not benign and has its own section below.
- **`tool_use with no tool_result` / `tool_result after next turn` × 5 each** —
  all inside CC's own `subagents/*.jsonl` sidechains, which interleave records
  across concurrent subagents. CC-authored, not ours.

### Checked and clean

`[empty]`, `[image]`, `[document]`, `[thinking]`, `[orphaned tool result removed]`
— zero real occurrences. Duplicate `tool_use` ids, orphan `tool_result`, empty
assistant records, transcripts starting mid-turn — zero in real projects. Image
fidelity holds: 104 images survive inside `tool_result` content and 4 as
top-level user blocks; none was flattened to `[image]` text.

---

## The benchmark harness manufactures the phantom-tool-call condition

Not a production defect, but it compromises the tool we would use to *test* for
one. Worth knowing before trusting a benchmark result.

`audit-transcripts.mjs` reports **5,525** bridge-written `tool_use` blocks with a
non-MCP name in test/temp dirs, across 469 files — `McpCustomToolsBash` ×3843,
`McpCustomToolsAgent` ×330, `McpCustomToolsGrep` ×314, `McpCustomToolsRead` ×311,
`Bash` ×176, `McpCustomToolsEdit` ×170, `McpCustomToolsWrite` ×137, plus bare
`Read`/`Edit`/`Write`. In those same dirs only **6** tool_use blocks carry a
correct `mcp__*` name.

Cause: the replay harness calls the conversion without a populated
`customToolNameToSdk` map, so `mapPiToolNameToSdk` (`src/convert.ts:43`) falls
through — to `PI_TO_SDK_TOOL_NAME`, turning pi's `bash` into Claude Code's builtin
`Bash`, or to `pascalCase` for anything else. The `McpCustomTools*` names in the
corpus came from that same map-less call handed an *already-prefixed* name, which
now throws (c31560bd); the builtin-name and `pascalCase` halves are unchanged, so
a map-less replay still manufactures the condition.

Why it matters: the provider path runs with `tools: []`, so a rebuilt transcript
claiming Claude previously called `Bash` is telling the model that a builtin it
cannot call is available and was used. That is precisely the prompt condition that
induced the bare-builtin `tool_use` blocks behind the phantom-call deadlock fixed
in 122914dd. **A benchmark replay can therefore reproduce that bug for reasons
that have nothing to do with the code under test, and can equally mask a real
regression by making the mangled state look normal.**

Production is unaffected, verified rather than assumed: across 86,652 real pi
messages exactly **4** `toolCall.name` values begin with `mcp__`, all genuine
`mcp__context7__*` from an external server in one session. In real project dirs
the bridge wrote 3,991 `mcp__*` names against 18 non-MCP ones, and those 18 are
the `token0.txt` unit-test fixtures.

Fix shape: have the replay harness pass the recorded tool list through to
`convertPiMessages`, or make the `pascalCase` fallback throw when handed a name
that already starts with `mcp__` — it can only be a double-mapping.

---

## `audit-cache.mjs`

The Anthropic prompt cache is keyed on exact prompt-prefix bytes, so a request
reading back less cache than the previous one wrote means the prefix diverged.
Both known bugs were prefix-mutation bugs, making this the cheapest always-on
integrity signal available.

**Metric.** In a healthy continuation, `cacheRead[N] == in + cacheRead +
cacheWrite [N-1]` — the previous turn's *prompt* tokens, not its total; the
previous output lands in `cacheWrite`. Calibrated over 5,923 healthy pairs:
median −2 tokens, p05 −3, p95 −1. A break is a shortfall ≥ 2,000 tokens, matching
`MIN_CACHE_MISS_TOKENS` in Claude Code's own
`src/services/api/promptCacheBreakDetection.ts`.

**The control group is the point.** Within one `query()` call the bridge cannot
mutate the prefix — it only appends tool results — so the in-query rate is pure
server-side eviction. Comparing the `--resume` boundary rate against it separates
"Anthropic evicted us" from "we sent different bytes".

Two parsing traps, both of which produced wrong answers on the first pass:
- A turn emits several `usage:` lines as its output grows. Dedupe on
  (cacheRead, cacheWrite, model), and when collapsing, **keep the first record's
  preceding log lines** — replacing the object swaps in the lines that came
  *after* the request, which silently reclassifies query boundaries as in-query.
- Skip pairs where the current request's own `cachePct ≥ 95`. A large shortfall
  with a high hit rate means the prefix legitimately got *shorter* (a rebuild that
  dropped messages), which is a shrink, not a break.

### Baseline (2026-07-29, 7,543 requests)

```
in-query   40 / 6372 pairs   0.6%   3.2M tok    <- control
boundary  133 /  542 pairs  24.5%  12.3M tok    <- --resume boundaries
breaks on a rebuild boundary: 35
```

Classified out as benign: idle > 5 min (87), effort changed (30), model change
(29), compaction/new session (10), tool set changed (2).

### Finding: ~28% of `--resume` boundaries re-send the whole conversation

The one finding here that neither known bug explains.

Confirmed independently of the pair math, by bucketing the first `usage:` line
after every `provider: fresh query … resume=<id>`:

```
n=782    >=95%: 57.2%    50-94%: 1.3%    <50%: 41.6%
```

The distribution is **bimodal**: either the resume hits almost fully or it misses
almost entirely. Idle time explains the tail but not the body:

```
gap <1min    n=340   bad 27.6%
gap 1-5min   n=210   bad 30.0%
gap 5-15min  n= 71   bad 43.7%
gap 15-60min n= 46   bad 78.3%
gap >1h      n= 30   bad 96.7%     <- TTL expiry, expected
```

**28.5% of resumes within 5 minutes of the previous request re-send everything**,
against a 0.6% in-query control — roughly 40× the floor. Model, tool count,
effort, `appendSys` and `strictMcp` are identical across the boundary in the worst
cases; verified on `f7116u` 2026-07-29T02:23–02:54, five consecutive
`fresh query model=claude-opus-5[1m] tools=11 resume=f969ad62 effort=xhigh`, each
returning `cachePct=2%`. Worst single event: 2026-07-29T02:54:25, 409,454 tokens
re-cached 150 s after the previous turn, `path=reuse` (the bridge did not rewrite
the session at all).

Localization: among the 169 sub-5-minute failures, 43% have `cacheRead` exactly
equal to that pi process's *first*-request `cacheRead` — the system+tools preamble
(commonly 6,599 tokens) survives and divergence begins at the first conversation
message. A further 39% cache nothing at all (`cacheRead=0`), implicating the
preamble too. Break rate is flat across prefix sizes (<20k through >200k) and
across models, so it is not a large-context or model-specific effect.

#### It correlates with how many records CC appended during the previous query

Every bridge turn crosses a `--resume` boundary, and during the *previous* query
Claude Code appends its own live records to the session file — one per content
block, one per tool result. On the next resume CC reads those back and rebuilds
the API messages from them. If that disk round-trip is not byte-faithful, the
prefix diverges exactly where the conversation starts, which is the
`cacheRead == preamble` signature above.

Splitting the sub-5-minute, same-model boundaries by what the previous query did
(n=263, 59 cold):

```
previous query was TEXT-ONLY (no tool calls)   n=118   cold  11   9.3%
previous query made tool calls                 n=145   cold  48  33.1%

by tool-call count in the previous query:
   0        n=118   cold 11    9.3%
   1-2      n= 69   cold 13   18.8%
   3-9      n= 57   cold 24   42.1%
   10+      n= 19   cold 11   57.9%
```

Monotone dose-response: the more records CC wrote during the previous query, the
likelier the next resume is cold. That supports the re-serialization hypothesis and
turns the next step from a general hunt into "diff what CC sent live against what it
reloads". The residual matters too — text-only predecessors are still cold 9.3% of
the time against a 0.6% control — so record round-tripping is not the whole story.

**Thinking blocks are untested, not exonerated.** The obvious log-side proxy does
not exist: `reasoning=` appears in **0** of 14,994 `usage:` lines, so the SDK never
reports reasoning tokens to the bridge and `src/index.ts:825`'s `reasoningText` is
dead in practice. The transcript-join fallback (match the 8-char `resume=` prefix
to a surviving `.jsonl`, then look at CC-authored records inside the previous
query's time window) only lands 20 of 263 boundaries — most sessions have since
been deleted and rewritten by a rebuild — and the cells are n=1–2. Underpowered;
do not read a result into it. Images are likewise untestable here: zero boundaries
in the window had an image in the prompt.

#### Cheapest next step

**The `cache-break-*.diff` route is not available on the installed SDK.**
`promptCacheBreakDetection.ts` exists in `reference-code/claude-code-rip/`, but
that fork is newer than what we run: the string `PROMPT CACHE BREAK` does not
appear anywhere in `@anthropic-ai/claude-agent-sdk` 0.2.141 / Claude Code 2.1.141,
and no `cache-break-*.diff` has ever been written on this machine. So there is no
gate to flip today.

Worth knowing for when the SDK is next bumped, because it then costs nothing: the
detector is wired into the ordinary API path (`services/api/claude.ts:1471`
`recordPromptState`, `:2384` `checkResponseForCacheBreak`), and the reason string
is emitted by a plain `logForDebugging(summary, { level: 'warn' })` gated only on
`isDebugMode()` — which the bridge already sets for every query via
`makeCliDebugOptions` (`src/index.ts:71`). It would land straight in
`~/.pi/agent/cc-cli-logs/*.log` as:

```
[PROMPT CACHE BREAK] <reason> [source=…, call #N, cache read: X → Y, creation: Z…]
```

with `<reason>` already naming the culprit ("system prompt changed (+N chars)",
"tools changed (+a/-b tools)", "effort changed", "possible 5min TTL expiry
(prompt unchanged)", "likely server-side (prompt unchanged, <5min gap)"). The
literal diff file is strictly more expensive — it additionally requires
`changes.buildPrevDiffableContent`, set only when a previous snapshot exists — so
grep the reason string first and only chase the diff if it is ambiguous.

**Available today, and decisive:** capture the request bodies. The shipped
`sdk.mjs` honours `ANTHROPIC_BASE_URL`, and the bridge passes `process.env`
through to the child, so pointing it at a local logging proxy and diffing turn
N's `messages` array against turn N+1's prefix names the exact block that changed.
Run one session with a text-only turn followed by a 5-tool turn — per the table
above that should reproduce at ~40%. Caveat to check first: subscription OAuth may
refuse a non-Anthropic base URL, in which case this needs an API key.

Cost, meanwhile, is real: 12.3M tokens re-cached in the classified-clean set alone.

#### If this is Claude Code's bug, it is not only ours

The correlation points at CC's own resume round-trip, not at anything the bridge
writes: the worst cases are `path=reuse` boundaries where the bridge did not touch
the session file at all, and the records implicated are the ones **CC itself**
appended during the previous query. If that holds, every SDK consumer that resumes
a session pays the same tax, and it belongs upstream rather than in this repo.

Evidence needed to make that case:

1. A request-body diff (the proxy experiment above) showing that the messages CC
   sends after `--resume` differ from what it sent live, with the differing block
   identified.
2. The same reproduced with a session file **written entirely by Claude Code** —
   no bridge involvement, no cc-session-io records — so the report does not depend
   on our writer. Take any CC-authored transcript from `~/.claude/projects/`, run
   `claude --resume <id>` twice, and compare cache hit rates.
3. The dose-response table above, which shows it scales with appended record
   count rather than firing at random.

Until (2) exists the finding is ambiguous between CC and the mixed-provenance
files the bridge produces, since 352 of 1,810 transcripts contain both record
shapes.

---

## `audit-warnings.mjs`

Inventories `WARNING:`/`BUG:` lines with counts and date spans, plus two tool-loop
invariants that have no WARNING of their own.

### Baseline (2026-07-29, 84,115 anchored lines, 1,929 pi processes)

```
   3  2026-04-10..2026-07-29   WARNING: N MCP handlers still waiting after delivering N results
   2  2026-04-12               WARNING session verify: forced test failure   (from tests/)
   1  2026-05-04               WARNING: mcp handler bash has no toolCallId
   1  2026-07-29               BUG: both maps non-empty! handlers=1 results=1

MCP handlers that waited and were never resolved: 32  (28 after abort/shutdown, 4 unexplained)
tool results queued for a handler that never claimed them: 14  (7 after abort/shutdown, 7 unexplained)
```

### Known-benign / explained

- **`mcp handler … has no toolCallId`** (1, 2026-05-04) predates `fc2efeb6`,
  which switched pairing to `_meta["claudecode/toolUseId"]`. None since.
- **`session verify: forced test failure`** (2) is `tests/` doing its job.
- **`BUG: both maps non-empty!`** (1, 2026-07-29T15:33:17.805Z, module `ere6hm`)
  is the phantom-tool bug caught live: the queued id
  `toolu_01JzMLYBmz7yEx9R9Zc4AvdB` appears in
  `~/.pi/agent/cc-cli-logs/2026-07-29T15-27-41-863Z-provider-3.log` as
  `Unknown tool bash`. The turn hung 27 minutes until the user aborted. Fixed in
  122914dd.
- **28 of 32 stranded handlers** are followed by `wasAborted=true`,
  `abort detected`, or `session_shutdown` — pi tore the turn down before
  delivering, which is expected. The remaining 4 are pi processes whose last log
  line *ever* is the `waiting`; for each, the matching cc-cli log ends with
  `LSP server manager shut down successfully` within 0.3–3.2 s, i.e. the pi
  process exited mid-dispatch. Corroborated CC-side: only 5 `tool_dispatch_start`
  events across 1,135 logs lack a matching `tool_dispatch_end`.
- **10 of the 14 orphan queued results** match an `Unknown tool <name>` id in the
  corresponding cc-cli log — the phantom-tool bug's other half.

### Checked and clean

`WARNING: currentPiStream overwritten before terminal event` — 0 occurrences.
`WARNING: steer with no prompt stream, dropping` — 0. `extractAllToolResults`
returning 0 while a handler waits — 0 (10 zero-result calls, all on a
single-message or genuinely empty context). Results-vs-handlers accounting: 5,350
exact matches, 1,033 results-ahead-of-handler (normal, they park in
`pendingResults`), 2 handlers-ahead-of-results (both are the logged WARNINGs).

---

## Not covered by these scripts

One incident class lives in the cc-cli logs and has no scanner yet.

**Orphaned Claude Code subprocess — trigger unknown.** A CC child outlived its pi
session and kept working: every MCP call failed instantly with `Stream closed`
(the transport was gone), CC treated that as a normal tool error, fed it to the
model, and issued another API request — for the better part of an hour.

| # | cc-cli log | onset | end | `Stream closed` | API requests | stopped by |
|---|---|---|---|---|---|---|
| A | `2026-07-10T22-48-21-609Z-provider-1.log:474` | 23:08:21 | 00:07:30 | 1,396 | 1,416 | LSP shutdown, 59 min |
| B | `2026-06-03T20-19-06-231Z-provider-1.log:422` | 20:24:12 | 20:42:08 | 356 | 375 | **429 rate_limit_error**, 23 min |

All failures are `after 0s`. Incident B consumed enough quota to trip the account
rate limit, which would have hit the user's other sessions. Bridge-side, both
processes' last log line precedes the storm (`claude-bridge.log:48337` for A,
`:29487` for B).

**"After the pi process dies" was this section's first guess and it is wrong.**
`tests/int-shutdown-kills-cc.mjs` drives both reachable triggers against the
installed CC/SDK and the child dies within a second either way: pi exiting closes
the child's stdin, which CC treats as EOF even with a tool call parked, and a user
abort fails the prompt stream and then interrupts and closes the query. So both
incidents needed a third condition that leaves pi *alive* with its control channel
closed — the child is only unreapable while the pi process still holds it.

What the timeline does say, for incident A: pi logged `mcp handler: bash
[toolu_01MVF…] → waiting` at 23:08:17.766 and never logged again, and CC failed
that same dispatch `outcome=error durationMs=1215` 1.2 s later, then re-issued the
call under a fresh id. CC's log runs continuously for the next 59 minutes with no
timestamp gap, so the machine was awake and pi was not merely suspended. Both
incidents predate the July 2026 tool-loop fixes (122914dd, 7ff04fd2, 549bab95,
da8513b5), there are exactly two in 1,159 cc-cli logs, none since 2026-07-10, and
the distribution is binary — no log has between 1 and 5 `Stream closed` failures.
That is consistent with an already-fixed cause, which is why nothing is being
built for it; the two tests are the tripwire if it returns.

Also unscanned: **thinking blocks dropped for want of a signature**.
`src/index.ts:1056` stores `thinkingSignature: block.signature ?? ""` and
`src/convert.ts:135` requires a truthy signature to replay. Across all pi
sessions, 26 of 2,363 `claude-bridge` thinking blocks (1.1%, 59,785 chars) have an
empty signature and are dropped from every rebuild — largest single loss 6,013
chars. The drop is correct behaviour (Anthropic rejects unverifiable signatures);
what is unexplained is why the SDK omits the signature. A WARNING at the
`?? ""` site would make the rate visible.

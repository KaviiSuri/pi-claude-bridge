# TODO

## Open Correctness Issues

From the 2026-07-29 silent-loss audit. `diag/AUDIT.md` holds the evidence and the
scanners that produced it; this section is the actionable residue. Re-run the
scanners with `--since <date of last good run>` before assuming any of it is stale.

- **~28% of `--resume` boundaries re-send the whole conversation** (12.3M tokens
  in the audited window). Correlates monotonically with how many records CC
  appended during the previous query, and the worst cases are `path=reuse`
  boundaries where the bridge never touched the session file — so this may be
  Claude Code's resume round-trip, not ours. Next step is decisive and available
  today: point `ANTHROPIC_BASE_URL` at a logging proxy and diff turn N's
  `messages` against turn N+1's prefix. To take it upstream it also needs a
  repro on a session file CC wrote entirely itself. See `diag/AUDIT.md` →
  "Finding: ~28% of `--resume` boundaries".

- **Orphaned Claude Code subprocess, trigger unknown**: a CC child outlived its
  pi session and burned API requests for 59 minutes (a second incident ran 23 and
  tripped an account-wide 429). Probed rather than assumed:
  `tests/int-shutdown-kills-cc.mjs` shows both reachable triggers already reap the
  child — pi exiting closes its stdin, which CC honours even mid-tool-call, and a
  user abort interrupts and closes the query. So the incidents needed a third
  condition that leaves pi alive with its control channel closed, and there is
  nothing to fix on the paths we can reach. Both predate the July 2026 tool-loop
  fixes, there are two in 1,159 cc-cli logs, none since 2026-07-10, and no log has
  between 1 and 5 failures — likely already fixed. The two tests are the tripwire;
  reopen this only if one goes red or a third storm appears.
  See `diag/AUDIT.md` → "Not covered by these scripts".

- **4 stranded MCP handlers and 7 orphan queued results remain unexplained**
  (out of 32 and 14; the rest are accounted for by abort/shutdown or the
  phantom-tool bug). Each of the 4 is a pi process whose last log line ever is
  the `waiting` warning, with the CC log ending 0.3–3.2 s later — consistent with
  pi exiting mid-dispatch, not confirmed. Related open decision: whether the
  bridge should time out a handler that has waited implausibly long instead of
  only warning. That is a fallback path and needs explicit sign-off before
  anyone builds it.

- **A failure that arrives while no pi stream is open never reaches the user.**
  7ff04fd2 made `consumeQuery` record the error (stopReason, errorMessage, log)
  when a result lands after the turn already ended on a tool call, but there is no
  open `currentPiStream` to push an error event onto, so the user sees a stalled
  turn rather than "rate limited". Surfacing it means synthesizing a turn that pi
  did not ask for — a fallback path, so it needs explicit sign-off on the shape
  before it is built. `tests/unit-error-result.mjs` covers the recording; nothing
  covers the surfacing, because there is nothing to surface it with.

- **17 never-answered tool calls** (`[no tool result recorded]` as the lone stub
  of a single-`tool_use` turn) have no explanation. The other 389 occurrences are
  the fixed parallel-results bug. Needs a repro before it can be fixed.

- **1.1% of thinking blocks are dropped for want of a signature**: 26 of 2,363
  `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
  `src/convert.ts:135` correctly refuses to replay them (Anthropic rejects
  unverifiable signatures). Unexplained: why the SDK omits the signature. Cheap
  first step is a WARNING at the `?? ""` site (`src/index.ts:1056`) to make the
  rate visible going forward.

- **`reasoningText` is dead code** (`src/index.ts:825`): `reasoning=` appears in
  0 of 14,994 `usage:` lines, so the SDK never reports reasoning tokens to the
  bridge. Either delete it or record that the SDK doesn't supply the field —
  right now it reads as a working diagnostic.

- **The benchmark harness manufactures the phantom-tool-call condition**: replay
  calls the conversion without a populated `customToolNameToSdk` map, so pi's
  `bash` is rebuilt as Claude Code's builtin `Bash` — telling the model a builtin
  it cannot call was already used, which is the prompt condition behind the
  deadlock fixed in 122914dd. A benchmark run can reproduce or mask that bug for
  reasons unrelated to the code under test. Fix: pass the recorded tool list
  through to `convertPiMessages`. Production is unaffected (verified over 86,652
  real pi messages).

- **Local-only docs to mirror into tracked files**: `eli/lifecycle-coverage-gaps.md`
  (the QueryContext lifecycle × sync-path coverage map) and the "claims about how
  Claude Code behaves" provenance rule in `.claude/CLAUDE.md` both live in
  gitignored directories, so nobody else gets them. The provenance rule belongs
  in `AGENTS.md`; the coverage map in `docs/` or as a section of `diag/AUDIT.md`.

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@earendil-works/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently
  requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but
  not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added
  because pi's bash has no default while Claude Code expects one. Other bridged
  tools may have similar mismatches (units, defaults, optional-vs-required params).
  Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible Enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees
  AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
  user questions interactively. Port a pi-native version using `ctx.ui.custom()`
  for an option picker with free-text fallback. Not applicable to AskClaude
  subagents (can't interact with user). See `fractary/pi-claude-code`
  `AskUserQuestion.ts` for reference.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
  ExitPlanMode are blocked. A pi-native plan mode could use
  `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
  via `tool_call` event, and surface plan approval through pi's TUI. Not
  applicable to AskClaude subagents. See `fractary/pi-claude-code`
  `PlanMode.ts`.

## Testing Gaps

- **`int-session-resume` Turn 8 flake (low priority)**: The isolated-AskClaude
  assertion fails intermittently (~1-in-5). The alt provider invokes AskClaude
  with a verbatim prompt in some runs (test passes — isolated CC correctly
  returns "UNKNOWN") but may embed the secret word into the prompt in others
  (test fails — but the leak is in the calling model, not in our isolation).
  We confirmed the verbatim case from logs; the failing case wasn't captured
  before the next run overwrote the log. Either pin the alt model to one with
  strict prompt fidelity, or instrument the test to assert on the AskClaude
  prompt args (not just the response) so we can distinguish "calling model
  embedded the answer" from a real bridge-side context leak.

- **No replay fixtures from real SDK streams**: Every unit test of
  `consumeQuery` hand-writes the SDK messages it feeds in, so they only cover
  shapes we already knew to expect — a stream event CC starts emitting (or
  stops emitting) is invisible until an int test happens to trip over it.
  `tests/int-cc-contracts.mjs` pins the shapes we depend on, but nothing
  captures a whole stream. Fix: record the raw SDK message sequence from one
  real turn per scenario (plain text, parallel tools, steer mid-tool, error
  result) into `tests/fixtures/`, and replay them through `consumeQuery`.
  Scrub args and text the way `pi-history-310.jsonl` is scrubbed.

- **Nothing asserts the int suite runs warning-free**: `deliverToolResults`
  logs `WARNING:`/`BUG:` lines (stranded handlers, both maps non-empty,
  steer with no prompt stream) that mean a real defect, and the int suite can
  emit them while still passing — the stuck-handler bug shipped that way.
  Fix: fail an int run whose debug log contains `BUG:` or an unexpected
  `WARNING:`, with an explicit allowlist for the tests that induce one on
  purpose. `diag/audit-warnings.mjs` already parses these lines; the gap is
  that no test consults it.

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

- **verifyWrittenSession failure paths untested**: The helper throws on
  missing file / record-count mismatch / malformed JSONL / sessionId drift,
  but no unit test deliberately induces each failure to confirm the error
  messages stay useful. Low priority — the logic is simple and visual
  inspection of the current code is enough for now.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.

- **Bun/Node hash mismatch for >200-char paths** (cc-session-io known
  limitation, documented in its README). Node writes with djb2, Bun reads
  with wyhash — for long encoded paths the dirs don't match and CC can't
  find the session. Rare in practice (requires deep nesting), but the fix is
  to make cc-session-io's `projectPathToHash` Bun-aware at write time. Would
  live upstream in cc-session-io.

- **Post-abort rebuild rotates sessionId** (see `Case 4 post-abort` log line).
  Normal Case 4 rebuilds preserve the sessionId by wiping the file in place
  (`deleteSession` + `createSession({sessionId})`). The post-abort path can't
  safely do that: the killed CC subprocess flushes a late `[Request interrupted
  by user]` record during its own cleanup, and if that write lands on the
  freshly-rewritten file it appends an orphan record with a dangling
  `parentUuid`, which breaks CC's parent-uuid chain on the next resume — CC
  silently starts with an empty context and produces a confidently-wrong
  answer. Diagnosed in debug log during branch work, see commit e317461.

  Current fix: post-abort rebuild takes a fresh UUID, so the orphan writes can
  only land on a dead inode. Deterministic, zero-latency, costs one extra UUID
  in the debug log per abort.

  Considered and rejected:
  - **Append-only session (never delete+recreate).** Doesn't help. The race
    isn't specific to delete+recreate — it's that two processes write to the
    same file with no coordination. After abort, the bridge appends new records
    (parentUuid chained from its last known record) while the dying subprocess
    flushes a late write (parentUuid chained from *its* last record). Order is
    nondeterministic; either way the parent-uuid chain forks and CC sees
    orphaned records on resume. Append-only just moves the corruption from
    "orphan on a fresh file" to "orphan in the middle of an existing file."
    Any approach sharing a mutable file between bridge and CC subprocess is
    inherently racy after abort.

  Options to revisit:
  - **Short delay (~500ms) before post-abort rebuild**, keep the UUID stable.
    Overprovisions the observed ~1–2ms race window by 250–500×. Adds visible
    latency on the post-abort turn. Eli's lean: 500ms feels like plenty and
    the UX is fine. Risk: still probabilistic — loaded systems could extend
    subprocess cleanup past the delay and we'd never know until a user hits
    the silent context-loss path.
  - **Drain the aborted query's AsyncGenerator to completion**, then rebuild.
    Investigated in detail. The real SDK's Query class (`lX`) delegates its
    iterator protocol (`next`/`return`/`throw`/`[Symbol.asyncIterator]`) to
    a native async generator. Draining the generator only observes messages
    CC has emitted via stream — it says nothing about pending `fs.appendFile`
    calls CC has queued in its event loop for the session JSONL. CC can emit
    the orphan marker's stream message, pi's drain sees it and returns, pi
    rebuilds, and CC's *still-pending* file write lands on the fresh inode.
    Drain narrows the race window but doesn't close it. Also requires making
    `syncSharedSession` async and restructuring `streamClaudeAgentSdk`'s
    kickoff path to await a pending drain promise — 4+ pieces of added state
    for a still-probabilistic fix. Strictly worse than rotation.
  - **Listen for the ChildProcess `exit` event directly.** This is the only
    deterministic fix (open-claude-agent-sdk does exactly this in its
    `gracefulClose()` via `proc.on('exit', ...)`). Official SDK's Query
    interface doesn't expose the child process — would need to either fork
    the SDK or reach into private state. Rejected unless the SDK grows a
    `close({ graceful: true })` or equivalent hook that awaits subprocess
    exit.


# One live-session owner for run admission, execution, and delivery

Accepted design; implementation and test verification are tracked separately. Async acceptance is a promise of responsibility, but splitting lifetime across a watcher, runner, and widget registry can leave an accepted run without an outcome or silently lose an outcome at the host delivery boundary. We choose one authoritative owner per live parent session for all dispatch modes, with bounded admission and explicit delivery confirmation; this refines [ADR-0014](0014-async-default-delegation.md), not its async-default product decision.

## Ownership and admission

- The owner records every admitted run's identity, queue position, startup/running state, terminal outcome, and delivery state. Async and blocking single/parallel dispatches and blocking chain steps all use it. The widget and `status` project that record; neither is another lifetime registry. Accepted queued work is owned work, not a spawned Worker.
- One FIFO capacity pool spans all delegate calls in the parent session. `maxConcurrency` defaults to `4` and accepts positive safe integers; `maxQueuedRuns` defaults to `32` and accepts nonnegative safe integers. Both have an upper bound of `9007199254740991`; missing or invalid runtime values fall back to defaults. Zero queued capacity means no waiting: all tasks must fit available active slots.
- Validate and admit an entire parallel batch atomically before launching any task or returning any acceptance. If the complete batch cannot fit the available active and waiting capacity, reject it without partial admission. The existing maximum of eight tasks per parallel request remains. Already queued work retains FIFO precedence.
- Chains remain blocking and sequential, using the same owner and capacity pool for each step; `{previous}` still consumes the prior result. Blocking is a way to await an owned run, not a separate execution lifecycle. It returns outcomes through the tool result and never also pushes them.
- Load limits through the existing configuration lifecycle: extension initialization and `session_start` reload, with no new live file watcher. Once changed limits take effect, no accepted run is killed or evicted to satisfy them. Lower limits constrain new admissions and starts while existing work drains; a queue already over its new limit retains its entries.

The shared configuration definition and generated editor schema must describe these optional settings and defaults. This is a bounded addition to normalization, not schema-driven validation of all settings or a change to [ADR-0019](0019-config-json-schema.md)'s editor/runtime boundary.

## Execution and cleanup

The owner controls the run from admission through terminal outcome and delivery. The runner owns process resources, RPC, timers, and cleanup, not a competing lifetime registry. An active slot is released only after runner/process cleanup finishes, not merely when a task settles or cancellation is requested. Startup failures and unexpected runner rejections become failed outcomes under the original run id rather than escaping the owner's accounting.

Per-run cancellation applies to queued, starting, and running work and produces a cancelled outcome through the appropriate async or blocking channel. Cancelling queued work never spawns a Worker. ESC and session teardown instead stop all accepted work, including the queue, and suppress result pushes into the interrupted or departed parent session. Late completion or confirmation callbacks cannot attach old-session work to a new parent session.

Native RPC sub-sessions and their on-disk discovery remain as in [ADR-0011](0011-persistent-sub-sessions.md). Preserve turn budgets, stall enforcement, partial outputs, and the child-side parent-death guard. A queued run has no child transcript yet, and a child killed before pi materializes its session may have none; this design does not invent transcripts for those cases.

## Shared wait refinement (ADR-0021)

[ADR-0021](0021-shared-wait-agent-leases.md) extends this same owner with atomic result leases. Busy or claimed outcomes are held; successful committed handoff consumes them instead of native insertion. Boundary drafts remain retained until branch receipts, and parent Escape/teardown still cancels claimed work. The delivery guarantees below otherwise remain unchanged.

## Delivery confirmation, not blind retries

For each async terminal outcome, submit once automatically and retain the outcome until a matching `custom_message` is observed in the **current parent's in-memory transcript**. Correlate the observation to the run and parent session. Calling `pi.sendMessage` is not confirmation: the current extension host exposes a `void` API that hides asynchronous failure. A generic `message_end` is not evidence of the matching outcome's insertion either.

Expose pending or reported failed delivery in the widget and `status`; do not discard an unconfirmed outcome or label a returned submission as delivered. An unobserved asynchronous host failure may remain pending because its cause is not exposed. There are **no automatic blind retries, retry timers, or automatic three-attempt policy**. That earlier retry proposal was revised: after an ambiguous submission, retrying automatically can duplicate a message that was already inserted.

`delegate({action: "retry-delivery", runId})` is the explicit manual escape hatch for a retained, unconfirmed async outcome. Warn that an earlier ambiguous attempt may cause duplicates. Retry only delivery under the same run id, never the Worker; a confirmed insertion must not be resent. No manual retry revives work stopped by session teardown or overrides suppressed pushes. Blocking results require no async submission or confirmation.

The positive guarantee is **observed in-memory transcript insertion**, not model consumption, completed follow-up processing, or disk durability. During the live session, unconfirmed outcomes remain visible and retained rather than silently forgotten. This does not promise exactly-once insertion across an ambiguous host call, success through arbitrary host failure, or recovery after process restart.

## Trade-offs and boundaries

Separate async and blocking owners, per-call parallel limits, and a widget-backed registry were rejected: they permit different lifecycle accounting for the same Worker and let overlapping calls bypass a global cap. The single owner makes admission, cancellation, cleanup, and delivery independently visible without making the runner responsible for parent conversation state.

Blind automatic delivery retries were rejected because the host offers no reliable failure acknowledgement. Explicit retry puts the duplicate risk at a visible user-controlled boundary. Stronger durable delivery would require a different host contract or persistence protocol, outside this change.

No restart recovery, pi-durable integration, new dependencies, unrelated AUTO-mode fix, version bump, or release is included. Persistent child transcripts are inspection artifacts, not a recovered live-run queue or delivery outbox.

## Verification contract

The normal `npm test` command must include watcher tests and deterministic fixture-child tests, not just an optional separate invocation. Verify shared capacity across calls and modes, FIFO and zero-queue admission, atomic batch rejection before launch, limit reductions without eviction, rejection-to-failure conversion, queued and active cancellation, and slot release only after cleanup. Also verify single automatic submission, matching current-parent transcript confirmation, manual retry without Worker execution, confirmed-outcome no-resend, blocking no-push, and teardown/ESC suppression including queued work and late callbacks.

Preserve regression coverage for native RPC sessions, budget/stall failure, partial outputs, and the parent-death guard. Fixture children must not need model calls. Test inclusion and results must be checked against the implementation; this ADR claims no verified test count or completed runtime verification.

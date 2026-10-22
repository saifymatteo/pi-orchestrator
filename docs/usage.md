# Usage

[Quickstart](../README.md) · [Configuration](configuration.md) · [Custom agents](custom-agents.md) · [Development](development.md)

## On this page

- [Dispatch modes](#dispatch-modes)
- [Discovery and control actions](#discovery-and-control-actions)
- [Live-session lifecycle](#live-session-lifecycle)
- [Event-bus integration (Pi 1.3.0)](#event-bus-integration-pi-130)
- [Delivery boundary](#delivery-boundary)
- [Cancellation and recovery](#cancellation-and-recovery)
- [Child transcripts and session ids](#child-transcripts-and-session-ids)

## Dispatch modes

Ask Pi for work in natural language; the model uses `delegate` to hand off self-contained tasks. Include the goal, relevant paths, constraints, and expected output. Workers have isolated contexts, so they need the facts required to do the task.

The tool accepts exactly one dispatch shape:

```js
// Single job (async by default).
{ agent: "scout", task: "Find the configuration loader and summarize its fallback rules." }

// Independent parallel work (maximum 8 tasks per request).
{ tasks: [
  { agent: "scout", task: "Find the configuration loader and cite relevant files." },
  { agent: "reviewer", task: "Review the configuration tests for missing edge cases; do not edit files." }
] }

// Dependent steps: always blocking; {previous} inserts the prior output.
{ chain: [
  { agent: "scout", task: "Find the configuration loader and cite relevant files." },
  { agent: "planner", task: "Using these findings, propose a test plan: {previous}" }
] }
```

Single and parallel dispatches return run ids after admission by default; outcomes arrive in the parent conversation automatically. **Accepted means owned, not necessarily started:** the run may be queued. Keep working or end the turn; do not poll for completion.

Pass `async: false` on a single or parallel request to block until the outcome. It returns in the tool result without a duplicate push. The per-call parameter overrides the [configured default](configuration.md#choosing-the-dispatch-mode). Chains are sequential and blocking because each step consumes the prior result; `async: true` is rejected for chains. A failed step stops the chain.

An optional `cwd` sets the child's working directory: at the top level for single mode, or on each entry in `tasks[]` / `chain[]`. Persistent child transcripts still go into the parent's session directory, not a directory chosen by `cwd`.

## Discovery and control actions

These actions never launch Workers:

| Tool arguments | Purpose |
|---|---|
| `{action: "list"}` | Show the current fleet. |
| `{action: "sessions"}` | List the current parent's persistent subagent transcripts, newest first. |
| `{action: "status"}` | Show queued and active runs, plus pending or failed outcome delivery. |
| `{action: "cancel", runId}` | Cancel one run, including queued work; its cancelled outcome is still returned or delivered. |
| `{action: "retry-delivery", runId}` | Explicitly resubmit a retained async outcome, never rerun the Worker. An earlier ambiguous submission may cause duplicates; confirmed insertion is never resent. |

Every `agent` field in the tool schema carries an enum of the fleet discovered at extension load (free-form input when the fleet is empty). The `list` action and `Unknown agent` error reflect the current fleet, including agents added mid-session. See [agent discovery](custom-agents.md#agent-discovery) for directories and precedence.

## Live-session lifecycle

One owner per live parent session tracks every admitted run from queue through startup, execution, cleanup, terminal outcome, and delivery. The fleet widget above the editor projects that state, including Worker progress; it is not a separate registry.

Single, parallel, blocking, and chain work share a FIFO capacity pool: by default **4 active Workers and 32 queued runs**, rather than a separate concurrency allowance per parallel call. Each chain step uses the same pool. A parallel batch is admitted atomically: all tasks must fit available active and queue capacity before any launches or acceptance, otherwise none is accepted.

Lowering limits never kills or evicts accepted work. Active slots remain occupied until runner/process cleanup finishes. See [capacity configuration](configuration.md#shared-worker-capacity) and [ADR-0020](adr/0020-live-session-run-lifecycle.md).

pi-orchestrator tracks child success through the RPC `agent_settled` event; exit codes are informational only. Unexpected runner rejections become failed outcomes under the original run id.

## Event-bus integration (Pi 1.3.0)

Other extensions can tap into pi-orchestrator's agent-result mechanism through the **`async-work:providers:v1` event-bus protocol**. It uses **Pi 1.3.0** public lifecycle and extension event APIs. The package's declared base peer minimum remains **Pi >= 1.0.4**; this integration does not change that declaration.

The consumer extension must run in the **same parent session**. There is no direct package dependency between producer and consumer, and no particular consumer is required. A consumer may combine agent results with other compatible providers; those providers and their lifetime policies are outside this package.

### Discover the agent provider

pi-orchestrator listens for discovery requests on `pi.events`. Your extension emits a request with the current `sessionFile` and an `add(provider)` callback. Our listener synchronously passes the session's agent provider to that callback. This is a discovery handshake, **not a stream of completion notifications**; results come from the provider's lease promise.

Inside a consumer's tool or lifecycle handler, where `pi` is the extension API and `ctx` is the current context:

```ts
const providers: any[] = [];
pi.events.emit("async-work:providers:v1", {
  sessionFile: ctx.sessionManager.getSessionFile(),
  add: (provider: any) => providers.push(provider),
});

const agents = providers.find((provider) => provider.source === "agent");
if (!agents) throw new Error("No agent provider available in this session.");

// runIds are async run ids returned by delegate; use your own owner label.
const lease = agents.claim(runIds, "my-extension:collect");
try {
  const outcomes = await lease.result;
  // Hand outcomes to your consumer before committing consumption.
  await handleOutcomes(outcomes);
  lease.commit();
} finally {
  lease.release(); // Safe after commit; also releases ownership on failure.
}
```

`runIds` and `handleOutcomes` are supplied by your extension. Rediscover the provider after session replacement or parent abort; old providers and outstanding result handoffs are session-scoped.

### Claims and leases

Discovery carries `{sessionFile?: string, add(provider)}`; the file must match the active parent session. The agent producer exposes `{source: "agent", claim(ids, owner)}`. A claim validates the entire batch before changing ownership and returns a lease with `result`, `commit()`, and `release()`:

1. Claim async run ids before completion, or after completion while their outcomes are still held. Missing/consumed, blocking, already-claimed, and already-submitted runs are rejected; a submitted or queued native outcome cannot be withdrawn.
2. Await `result` for outcomes shaped as `{source: "agent", id, content, details}`, including Worker failures. Commit after receiving results to consume them without another push.
3. On consumer timeout or independent cancellation, release ownership so normal fallback delivery can resume; this does not cancel agent execution.

Commit and release are synchronous, idempotent, and nonthrowing. An early commit while execution is unfinished is a no-op. Stale-session handoff is rejected; repeated or stale cleanup cannot replay consumed results. Manual `retry-delivery` cannot override lease ownership.

**Escape still cancels the fleet, including claimed agents**, as does session teardown. A lease is not a keep-alive exemption.

### Handoff and fallback

Async outcomes remain held while the parent is busy or a consumer owns them. At a completed pre-settle boundary, eligible outcomes are appended as custom-message drafts without replacing existing entries. Aborted/error boundaries and queued user messages are not rewritten. Offering a draft alone does not consume the outcome: positive branch receipts establish insertion; committed consumer handoff consumes it instead.

After final settlement, a session-scoped one-shot check confirms receipts and true idle state, restoring missing boundary offers and flushing eligible held results. It is not a polling or retry timer. Ambiguous native submissions remain retained for explicit manual retry only.

To test a checkout, start Pi 1.3.0 with `pi -e <path-to-your-clone>/pi-orchestrator/src/index.ts` alongside your consumer extension. Avoid loading a second installed copy; start a fresh session after changing extension code. See [ADR-0021](adr/0021-shared-wait-agent-leases.md).

## Delivery boundary

Outside committed handoff, each async outcome gets one automatic submission and retains its original run id. There are **no automatic blind retries or retry timers**.

The extension host's `pi.sendMessage` returns `void` and can hide asynchronous failure: returning from that call is not confirmation. Only a matching `custom_message` observed in the current parent's in-memory transcript confirms insertion; `message_end` alone does not. Until then, the outcome stays retained and its pending/failure state remains visible in the widget and `status`, with explicit `retry-delivery` available if needed.

Confirmation proves transcript insertion, **not model consumption or disk durability**. This is a live-session guarantee only: no restart recovery or exactly-once delivery claim. Persistent transcripts are inspection artifacts, not a recovered live queue or delivery outbox.

## Cancellation and recovery

Per-run cancellation produces a cancelled outcome, whether the run is queued, starting, or running. Cancelling queued work never spawns a Worker.

Escape and session teardown instead stop all accepted work, including queued runs, and suppress result pushes into the interrupted or departed session. Late callbacks cannot attach old-session work to a new parent session. A crashed parent's children self-terminate within about 5 seconds via the parent-PID heartbeat, provided pi-orchestrator is loaded in them; see [child extension control](configuration.md#child-extension-control).

Native RPC sub-sessions, [turn budgets and stall recovery](configuration.md#turn-budgets-and-stall-recovery), and partial outputs are preserved. A queued run has no child transcript yet; a child killed before its first message may leave no session file.

## Child transcripts and session ids

Persistent child sessions are enabled by default (`childSessions: true`): each run gets its own transcript linked to the parent, named `orch: <agent> — <task-summary>`. Inspect them through `/resume` (Ctrl+N filters named sessions), the session path in results, or `{action: "sessions"}`. On-disk session discovery works after restarts and resumes, but does not recover live-run ownership. See [persistent child transcripts](configuration.md#persistent-child-transcripts) for storage details.

### Stable child session ids

Only **ephemeral** children (`childSessions: false`, using `--no-session`) receive a deterministic `--session-id`: a hash of `orchestrator:<agent-name>:<model>`, stable per (agent, model) pair across spawns and parent restarts. `--no-session` disables on-disk persistence, not the session id.

OpenAI-compatible providers derive their cache-affinity key from that id, keeping an agent's requests on the same cache shard. Anthropic's native caching is content-prefix based and unaffected. Persistent sessions remain file-per-run; concurrent runs of the same agent never share a JSONL.

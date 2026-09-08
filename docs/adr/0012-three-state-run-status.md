# Three-state run status, derived once

The fleet widget and the `delegate` tool block are the user's only view into a running fleet, so "working", "succeeded" and "failed" have to be distinguishable at a glance. They were not: parallel and chain runs rendered **working** subagents as red ✗ failures and flipped to green on completion, while single mode rendered the same states correctly.

## Why it broke

Success was derived at each render site from `isFailedResult()` — `!completedNormally || stopReason ∈ failure set`. A live, in-flight result has `completedNormally: false`, so the predicate that names a dead child also names a working one. Single mode escaped only because its render site added an `isPartial` bail-out; parallel and chain had their own copies of the same ternary without it (three copies, one bug).

The `running` state itself was encoded three inconsistent ways: `isPartial` in the single renderer, `exitCode: -1` in the parallel placeholders, and nowhere in live emissions — `emitUpdate` published the result's initial `exitCode: 0`, overwriting the placeholder sentinel the moment a child produced its first event. That second symptom was visible in the progress line: two working subagents reported `Parallel: 0/2 done, 0 running...`, counted as neither.

## Decision

- **One predicate**: `taskStatus(result, callIsPartial) → running | failed | success`, aggregated by `runStatus()` for the header, with glyph and color paired exactly once in `STATUS_GLYPH`. Render sites ask for an icon; they no longer decide what anything means.
- **Running is encoded, not inferred.** Unsettled results are published with the `exitCode: -1` sentinel by `emitUpdate` — the same sentinel the parallel placeholders already used, so one meaning has one spelling. A real child exit code is never `-1`. The emission is a copy (`{ ...currentResult, exitCode: -1 }`) because `currentResult` keeps being mutated until settle.
- **`running` outranks the header.** Yellow ◐ while any task is unsettled; green only for a finished run with no failures; red only once the run is finished with at least one failure. Before this the multi-task header had no red state at all, so per-task icons carried the entire status signal.
- **Definitive failure outranks `callIsPartial`.** A failure stop reason or an `errorMessage` is final even mid-run, so a child that dies while its siblings keep working still reads red rather than waiting for the final render.
- Status stays **state-derived, never exit-code-derived** (ADR-0006: RPC children are SIGTERMed right after `agent_settled`, so their exit code means nothing). `exitCode` remains informational, which is what makes it a legal carrier for "not settled yet".

## Considered options

Adding a `status` field to `SingleResult` was rejected: it duplicates state already derivable from existing fields and can contradict it, and it would persist a rendering concern into every transcript `details` blob. Fixing only the render sites (pass `isPartial` through) was rejected too: it leaves the progress-line miscount and keeps `running` unencodable outside the renderer, which is where the miscount came from.

## Consequences

Both signals are deliberately redundant: the sentinel or `callIsPartial` alone is enough to keep working tasks out of red. A mutation that deletes the sentinel rule from `taskStatus` fails the status tests even though the renderer backstop still holds, and the mid-run render tests pin the user-visible contract (⏳/◐, never ✗) for parallel and chain alike.

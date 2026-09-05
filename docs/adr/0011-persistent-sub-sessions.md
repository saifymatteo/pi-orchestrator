# Persistent sub-sessions for subagents

Subagent children previously ran `pi --mode rpc --no-session` — fully ephemeral. Only the distilled tool result (final message + touched files + usage) came back to the parent; the transcript (intermediate tool calls, everything the child read, partial work before a kill) was lost. For orchestration work that is a real gap: the orchestrator often needs to know *what a worker actually did*, not just its claim about what it did — and a stall-killed child's last hour of work vanished entirely. We decided to make subagent sessions persistent by default: each dispatch writes a real pi session file (file-per-run) into the parent's session directory, linked back to the parent session via pi's native `parentSession` header, named for its agent and task, and referenced from every delegate result; `delegate({action: "sessions"})` lists them from disk.

## Mechanism (all pi-native, verified empirically)

- Spawn: children drop `--no-session`; `--session-dir` points at the parent's session directory (dirname of the parent's session file), so sub-sessions of a session live together regardless of any per-task `cwd` override. pi creates the file lazily on the child's first message — a child killed before that leaves nothing on disk.
- Link: before the task prompt, the parent sends RPC `new_session {parentSession: <parent session file>}`. pi writes `parentSession` into the child's session header (session format v3). Ordering is guaranteed: RPC processes stdin serially, so link commands precede the prompt. pi creates the startup session lazily, so switching before the prompt leaves no stray file (verified: no file exists after `new_session`, the post-switch session materializes with the parent header).
- Spawn flags survive the switch: `--model`, `--tools`, `--exclude-tools` are process-level, verified unchanged across `new_session` via `get_state`.
- Name: RPC `set_session_name` = `orch: <agent> — <task summary (40 chars)>` — findable in `/resume` via the named-sessions filter.
- Reference: every delegate result text ends with `Subagent session: <path>`; `delegate({action: "sessions"})` scans the directory's session headers for `parentSession === <parent file>` (state-based, survives restarts, no in-memory bookkeeping).
- Config: `childSessions` (default `true`); `false` restores the ephemeral behavior.

## Considered options

- One session file per agent, reused across runs (worker "memory"): gives run-to-run continuity and a stable cache shard, but concurrent same-agent spawns (allowed: parallel tasks can name the same agent twice) would point two writers at one JSONL — rejected for v1. File-per-run is the safe default; a shared-file mode can be added later if continuity proves valuable.
- Storing sub-sessions in a separate dedicated directory (e.g. `sessions/orchestrator/`): cleaner separation from human sessions, but pi's `/resume` scans the standard per-project directory, so the sessions would be invisible to the picker — the opposite of "the parent can use it as a reference". Rejected; names (`orch: ...`) carry the identification instead.
- Linking via the parent appending custom extension entries to its own session (in-memory + appendEntry): duplicates what pi already records in the child's header, and in-memory maps die with the process. The on-disk header link is authoritative and works across restarts — chosen.
- Keeping `--no-session` and writing our own transcript format: reinvents sessions pi already persists, and would not be resumable in the TUI. Rejected.

## Consequences

- Sessions are file-per-run: the deterministic per-(agent, model) `--session-id` (kept for its OpenAI-compat `prompt_cache_key` stability) applies only to ephemeral runs; persistent runs get a fresh id per file, so OpenAI-compat providers may land on different cache shards per run (Anthropic content-prefix caching is unaffected).
- `action: "sessions"` is derived purely from on-disk headers — no registry to keep in sync, works after parent restarts/resumes, and includes runs from earlier parent sessions stored in the same directory only if they link back to this parent file.
- Killed children (turn budget, stall watchdog, aborts, parent death) leave partial transcripts — the post-mortem story improves; disk usage grows with every dispatch (bounded by what subagents actually do; no automatic cleanup — pi owns the directory).
- `new_session` triggers a child-side extension reload; extensions with stale-ctx bugs log `extension_error` lines at child startup (the ADR-0008 class of problems — mitigate via `childExtensions`).

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-10-24

### Added

- Optional pi-atelier **Orchestrator Fleet** panel (`orchestrator:fleet`) through the public `pi-atelier:sidebar-panels` protocol v1, showing the existing fleet state in compact left-aligned structured text rows (no `keyValues`), with idle AUTO/ENGAGED mode and a bullet roster, plus a two-line active header, without task/prompt excerpts or a dependency. New panels start hidden; enable it via `/atelier` → Settings → Display or `/atelier display`. No native Subagents cost graph integration.
- `showFleetWidget` (default `true`) controls only the live transcript-area fleet widget. Set it to `false` for manual sidebar handoff; Result messages, acceptance messages, and transcripts are unaffected. Consumer discovery never hides the widget automatically: the sidebar protocol has no visibility acknowledgement.

## [0.9.0] - 2026-10-22

### Added

- Session-scoped agent producer exposed through the `async-work:providers:v1` event-bus protocol: atomic result leases let other extensions collect outcomes without another run registry. Timeout/independent cancellation releases ownership; parent Escape and teardown still cancel the fleet (ADR-0021).

### Changed

- Reorganize documentation into a quickstart README and focused configuration, usage, custom-agent, and development guides.
- Async agent outcomes remain held while the parent is busy or an extension consumer owns them. Completed pre-settle boundaries append result drafts without replacing existing work; positive branch receipts or committed handoff consume outcomes, with a one-shot true-idle fallback for late completions and missing boundary drafts.

## [0.8.0] - 2026-10-19

### Added

- Shared per-session Worker capacity: `maxConcurrency` (default `4`), `maxQueuedRuns` (default `32`, `0` disables queueing), and explicit `retry-delivery` for retained async outcomes without rerunning Workers (ADR-0020).
- `keepToolOverrides` (default `{}`): case-insensitive exact tool-name exceptions with `allowed` / `blocked` values, applied after the unchanged `keepTools` baseline for the engaged parent only. `delegate` remains always allowed; AUTO mode and Workers are unchanged.

### Changed

- All dispatch modes share one live-session lifecycle owner and FIFO queue, with atomic parallel-batch admission; the widget and status expose queued work and pending or failed delivery. Async insertion requires matching current-parent transcript confirmation, with no automatic blind retries.

### Fixed

- Parent prompt forwarding captures current pre-policy guidelines in AUTO as well as engaged mode, avoiding missing guidelines in fresh AUTO sessions and stale guidelines after disengaging. AUTO tool access and policy behavior remain unchanged.
- Accepted runs retain their original id through unexpected runner failure and per-run cancellation, including queued work. Slots remain occupied through cleanup; ESC and teardown stop all accepted work and suppress result pushes.
- `/orchestrator-tools` now saves binary per-tool choices as overrides instead of rewriting `keepTools`, preserving automatic discovery and group rules for siblings and future tools. Choosing the baseline result removes that tool's override. Successful manual edits refresh the advertised policy; failed saves restore the previous choice without applying new permissions.
- Successful configuration writes are no longer reported as failed when subsequent legacy-file cleanup fails; cleanup emits a warning instead.

## [0.7.0] - 2026-10-18

### Added

- Shared-source configuration JSON Schema for editor completion, hover documentation, and strict unknown-key diagnostics, with a committed `schemas/orchestrator.schema.json` artifact and version-pinned public references. Normal saves add or refresh extension-owned `$schema` references while preserving custom URLs and comments; loading never writes or fetches schemas, and runtime acceptance remains unchanged. README documents setup, development references pending the first schema-bearing release, and maintainer regeneration via `npm run schema:generate` (ADR-0019)

## [0.6.0] - 2026-10-09

### Added

- Mode-invariant delegate usage guidance (when to reach for the tool, mode selection, self-contained task prompts, result reporting, one-level-deep) is now contributed as the `delegate` tool's `promptGuidelines`, so it lands in the system-prompt rules section in **both** AUTO and engaged mode — AUTO sessions no longer rely on the tool description alone to reach for the tool. The guidelines carry no config-derived text (the dispatch default stays in the tool description and schema), so the rules section is stable across config changes; the delegation policy keeps only engaged-only content, removing the previous duplication (ADR-0018)

## [0.5.0] - 2026-10-06

### Changed

- README: new "Match custom and local extensions" section explains how `ext:<id>` is derived from a tool's `sourceInfo` path (package name under `node_modules`, otherwise the entry file's name), why settings.json `extensions` entries like hindsight's `dist/pi.js` must be matched by tool-name glob (`hindsight_*`, not `ext:hindsight`), and a goal-by-goal table for keeping/blocking a tool on the parent vs. children
- Engaged-mode policy text audited and de-duplicated: async-delivery semantics stated once (intro rule) instead of three times, allow-list folded into the intro sentence, single-agent flow line trimmed to the live half, vague rule-3 clause dropped; ~1 in 7 tokens off every engaged turn
- Trim the delegate tool description and async acceptance text (model-facing context): modes/actions/escape-hatch restatements removed (they live in the parameter schema), the "only way to read/write" line removed (it duplicates the engaged-mode policy text and is false in AUTO mode), and the no-poll boilerplate compressed
- Delivered background subagent results now render like bg-bash's finished-job rows: a single capped ✓/✗ status line on the purple `customMessage` background with output padding, click- or ctrl+o-expandable to the full delivered text
- Delegate tool render no longer shows the task/instruction text in the call row (agent names only); the collapsed result is a compact per-agent status line, and ctrl+o expansion shows the full task text untruncated plus the agent's output
- Async delegate acceptance (the "Accepted run N" result) renders as a compact per-run row (◐ Run N — agent · accepted) instead of a full plain-text block; ctrl+o expands to the full task text. The no-poll instruction stays in the model-facing text only and is never rendered
- Delivered run-result rows now show the originating task (dimmed, untruncated) with blank-line spacing between header, task, output, and metadata in the expanded view
- Orchestrator AUTO notifications (startup notice and `/orchestrator` disengage) now use info severity instead of warning — AUTO is an intentional state, not a problem
## [0.4.0] - 2026-10-06

### Changed

- Blocked-tool matchers that pi's `--exclude-tools` accepts (exact names, `*` globs) now pass through verbatim to the child spawn flag (ADR-0017), so the child's own registry filters them — covering tools the parent's registry cannot see; `ext:<id>` and `?` matchers still expand parent-side, and the child-side gate remains the backstop
- Require pi ≥ 1.0.4 (`@earendil-works/*` peer dependencies), the first version whose `--exclude-tools` accepts `*` patterns

### Added

- Agent frontmatter `tools` and `blockTools` now accept `*` patterns, passed to pi's `--tools`/`--exclude-tools` (pi ≥ 1.0.4); documented only — the values were already forwarded unmodified. Note: pi ≥ 1.0.4's `--tools` keeps MCP tools unless an entry starts with `mcp__`, so a restricted child gains MCP tools it did not have on older pi — add `mcp__*` to `tools` (or a `blockTools` entry) to keep them out

## [0.3.2] - 2026-09-30

### Fixed

- Declare host-provided `typebox` in `peerDependencies` and drop the unused `@sinclair/typebox` dependency, fixing pi's extension-loader warnings

## [0.3.1] - 2026-09-29

### Fixed

- Update agents content

## [0.3.0] - 2026-09-28

### Added

- Per-agent thinking levels and per-builtin fleet overrides

## [0.2.2] - 2026-09-25

### Fixed

- Ensure default tools are set back when toggling mode
- Minor UI text case change

## [0.2.1] - 2026-09-25

### Changed

- Tag release (no functional changes on top of 0.2.0)

## [0.2.0] - 2026-09-25

### Added

- Config-level async default via `orchestrator.jsonc` `async` key (ADR-0016)
- Async-default delegation (ADR-0014) and JSONC config support (ADR-0015)

### Changed

- Move extension sources to `src/`; root keeps project metadata

## [0.1.3] - 2026-09-23

### Changed

- Test against pi 0.87.1

## [0.1.2] - 2026-09-11

### Added

- CI/CD for test and publish
- TypeScript lint support

### Fixed

- Harden the Policy text flow in system prompt

## [0.1.1] - 2026-09-09

### Added

- Fleet widget labeled engaged/auto from real gate state

### Fixed

- RPC: settle only the waiter whose response arrived
- Fleet: render working subagents as running instead of failed

## [0.1.0] - 2026-09-06

### Added

- Optional persistent session for subagents

### Changed

- Harden the valid agent discovery

## [0.0.8] - 2026-09-03

### Changed

- Tag release (prompt inheritance pipeline stabilization)

## [0.0.7] - 2026-09-02

### Added

- Allow subagent to inherit parent prompt
- Forward parent prompt child-side with stable session ids
- Delta-strip duplicated parent segments from forwarded prompt

### Changed

- Align peerDependencies with pi packaging requirements

### Fixed

- Fleet: display tool-bearing turn count to match TUI tool calls

## [0.0.6] - 2026-09-02

### Added

- Child tool gating with blocklist expansion and extension control
- Include touched file paths in delegate results

### Changed

- Derive autoKeepExtensions behavior from keepTools emptiness

### Fixed

- Fleet: unique per-invocation keys so concurrent delegate calls don't collide

## [0.0.1] - 2026-09-01

### Added

- First version of the project: orchestrator extension for pi with fleet delegation, unit tests, ADRs, and npm packaging

[0.7.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.3.2...v0.4.0
[0.3.1]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.3.0...v0.3.1
[0.3.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.3.1...v0.3.2
[0.3.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.1...v0.1.2
[0.8.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.7.0...v0.8.0
[0.9.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.8.0...v0.9.0
[0.10.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.9.0...v0.10.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.3.1]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.3.0...v0.3.1
[0.3.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.3.1...v0.3.2
[0.3.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/saifymatteo/pi-orchestrator/compare/v0.1.1...v0.1.2
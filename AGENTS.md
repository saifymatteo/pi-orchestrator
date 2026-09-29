## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage role strings are used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). After a user-facing change (feature, fix, behavior change, packaging), add a bullet under the `## [Unreleased]` section in the matching Added / Changed / Fixed subsection (create the section if missing). Internal-only work (chore commits, refactors with no observable behavior change) is not listed. When bumping the version in `package.json`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` with today's date, add a fresh empty `## [Unreleased]` above it, and append a compare link at the bottom.

# Dependency Overrides: brace-expansion Security Pin

`package.json` carries `"overrides": { "brace-expansion": "^5.0.12" }`, mirrored in `package-lock.json` (`packages[""].overrides`). npm ci validates that the two match — edit them together or the CI `npm ci` step fails.

## Why it exists

Three GHSA DoS advisories against `brace-expansion` < 5.0.12, triggered by the copy `minimatch` pulls into the auto-installed `@earendil-works/pi-coding-agent` peer subtree. The vendor ships an `npm-shrinkwrap.json` pinning `brace-expansion@5.0.9`, and a shipped lockfile outranks root overrides, the repo lockfile, and cache state. The override is therefore inert for that subtree, but it keeps the repo lockfile — what `npm audit` and Dependabot read — on the fixed line, and it catches any future re-resolve if the vendor drops the shrinkwrap.

The physical dev tree still materializes a nested `brace-expansion@5.0.9` folder; that is the vendor's pin at work, not a stale install. It is dev-only transitive tooling, this repo feeds no untrusted input through it, and the published tarball ships no dependencies.

## When @earendil-works fixes it upstream

Once a `pi-coding-agent` release resolves `brace-expansion` >= 5.0.12 on its own, the override is removable:

1. Delete the `overrides` block from `package.json`.
2. `npm install` — syncs the recorded override out of the lockfile.
3. `npm ci && npm audit` must report 0 vulnerabilities, then `npm run typecheck && npm test`.

To check whether a release qualifies: after installing it, read the `brace-expansion` entry in the package's shipped `npm-shrinkwrap.json` (or confirm the shrinkwrap is gone entirely).

## If an alert reopens

A future `pi-coding-agent` update can pin a newly vulnerable version through its shrinkwrap. The repo-side remedy that closed the 2026-09-30 alerts: point the repo lockfile at a fixed version (single hoisted `node_modules/brace-expansion` entry with full registry metadata), keep manifest and lockfile in sync, push, and let Dependabot rescan. The subtree itself is only durably fixed upstream — report it to @earendil-works rather than patching `node_modules` by hand.

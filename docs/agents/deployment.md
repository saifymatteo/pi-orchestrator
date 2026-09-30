# Deployment: Tag-Triggered npm Publish

A release is a version bump plus a pushed `v*` tag. GitHub Actions does the rest.

## Release sequence

1. **Bump**: `npm version X.Y.Z --no-git-tag-version` — updates `package.json` and `package-lock.json` together. The flag matters: without it npm auto-commits and auto-tags with its own message. Fixes bump the patch version, features bump minor.
2. **Changelog**: apply the Changelog rule in `AGENTS.md` — rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, append the compare link at the bottom.
3. **Push main**: commit as `chore: update package version X.Y.Z` (matching release history) and push. Pushing main alone publishes nothing.
4. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag push is the deploy trigger.
5. **Verify**: `gh run list --limit 3` shows the "Publish to npm" run for the tag; `gh run watch <run-id>` until green. Done when the run succeeds and the version appears on npmjs.com.

## How publishing works

- `.github/workflows/publish.yml` triggers on `v*` tag pushes only. It runs the CI checks (npm ci, typecheck, test) on the tagged tree, then `npm publish --ignore-scripts` — so it gates itself: tagging a broken tree fails visibly.
- Auth is npm Trusted Publishing (OIDC): no `NPM_TOKEN`, no secrets to configure. The workflow ensures npm >= 11.5 itself.
- `.github/workflows/ci.yml` runs the same checks on every main push.

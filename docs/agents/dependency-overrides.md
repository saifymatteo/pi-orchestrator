# Dependency Security Maintenance

## Current resolution

The repository lockfile resolves the `@earendil-works/*` host peers to 1.5.0. The published `pi-coding-agent@1.5.0` package pins `brace-expansion@5.0.12`, `minimatch@11.0.3`, and `undici@8.12.3`, and ships no `npm-shrinkwrap.json`. These versions fix the dependency advisories found during the 2026-11-06 maintenance pass.

`package.json` retains the `brace-expansion` override (`^5.0.12`) as a repository-side security floor. The current upstream version already satisfies it. An override in this package does not repair dependencies in an existing user's host installation; those users must update their host separately.

## When an alert opens

1. Inspect both the open Dependabot alerts and `npm audit`: the audit may report advisories that have not appeared as repository alerts yet.
2. Trace the affected entry in `package-lock.json` to its parent. Prefer a parent release that declares fixed dependencies over forcing a possibly incompatible transitive major version through an override.
3. Check the parent's published manifest and tarball for exact dependency pins and `npm-shrinkwrap.json`. A root override is not evidence that a vendor-controlled subtree is fixed; verify the fresh installed tree in CI as well as the lockfile.
4. Run the CI checks: `npm ci`, `npm audit --audit-level=moderate`, `npm run typecheck`, and `npm test`. CI also runs weekly, and the publish workflow repeats the audit gate before releasing.
5. After merging, confirm that GitHub closes the affected alerts. Do not dismiss a real vulnerability merely to clear the dashboard.

## Release scope

A lockfile-only host-peer update does not require an npm release: npm excludes `package-lock.json` from the published tarball, and the host peers' compatibility ranges remain unchanged. The extension has a runtime dependency on `jsonc-parser`; it does not bundle the host dependency tree. Follow `deployment.md` when a fix changes shipped runtime code or dependency requirements.

## Historical brace-expansion workaround

The September 2026 maintenance notes described a vendor shrinkwrap pinning `brace-expansion@5.0.9`, for which a root override alone did not repair the physical nested copy. That is historical context, not the current 1.5.0 package layout. If a future vendor release introduces a shrinkwrap again, inspect the artifact rather than assuming either the old limitation or today's layout still holds.

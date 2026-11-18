 not checked | Logs only through the framework LoggerToken (no document contents); no health check | 2026-11-18 || 0.2.0-next.0 via changeset (pre next); not staged | 2026-11-18 || README.md; docs site page not written | 2026-11-18 || Installer idempotent and reversible on a skeleton-shaped app (test/installer.test.ts); no installer e2e on a real skeleton app | 2026-11-18 || `check-package.mjs` and `check-deps.mjs` run locally; publint/attw not run | 2026-11-18 || Failure tests: engine creation/set-up retry, sync failures after commit (report/throw), timeouts and unreachable servers (test/manager.test.ts, test/engines.test.ts, test/sync.test.ts). No soak test | 2026-11-18 || Attack-style tests: test/tenancy.test.ts, test/definition.test.ts, test/filters.test.ts (fast-check), test/servers/engines.test.ts (injection on real servers), test/commands.test.ts (path safety). No written threat model or security-reviewer pass yet | 2026-11-18 || Windows / Node 24.21 only, gate 3x by the agent (agent-reported, see NEXT.md); CI matrix not run yet | 2026-11-18 |agent-reported pass | `npm run ci` (biome, both tsc projects), `check-code-rules.mjs` clean; TSDoc on every export | 2026-11-18 |# Release readiness

<!--
  Created once by strutvane-tooling (canonical/RELEASE-READINESS.md). This repo owns this file:
  sync never overwrites it. Gates and rules: hub docs/19-production-readiness.md
  (https://github.com/vishwajit-vm/strutvane/blob/main/docs/19-production-readiness.md).

  A version reaches npm `latest` only when every gate below is "pass" with evidence. One row per
  gate: the status (pass / fail / not checked), a link to the evidence (CI run, report or test
  file; never "trust me"), and the date it was checked (YYYY-MM-DD). The coordinator re-runs the
  checks before a gate is accepted; the project lead approves the staged release.
-->

Package: @strutvane/search · Version: 0.2.0-next.0 · Last reviewed: 2026-11-18

| Gate | What must be true (summary; docs/19 is the source) | Checked by | Status | Evidence | Date |
|---|---|---|---|---|---|
| R1 Code | Strict TS, ESM, lint clean, no `console.` in `src/`, no TODO/FIXME without an issue, TSDoc on every export | CI `verify` (`npm run ci`, `check-code-rules.mjs`) | not checked | | |
| R2 Tests | Green on Node 24 and 26 × Linux, Windows, macOS; coverage ≥ 90/90/85/90; type-level tests; 3 green runs in a row; no unhandled rejections or open handles | CI `verify` matrix and `repeat` job | not checked | | |
| R3 Security | Threat model; attack-style tests; parsers fuzzed; review with 0 open critical/high; `npm audit --omit=dev` 0 high/critical; secrets scan clean | `security-reviewer` report; CI `security` job | not checked | | |
| R4 Resilience | Failure scenarios named and tested; fails closed; idempotent retries; soak test with no growth | Resilience suites; `npm run test:soak` | not checked | | |
| R5 Packaging | publint and attw clean; tarball has no tests, fixtures, secrets or local map paths; exports resolve; `engines.node` ≥ 24.3; one framework copy; LICENSE, README, CHANGELOG; a changeset | CI `package-check` job | not checked | | |
| R6 Integration | Installs alone and with every package, in any order, identically; re-install is a no-op; complete `.env.example`; boot fails closed; only the six connections; Northwind Ops green | Hub nightly ecosystem job; installer e2e | not checked | | |
| R7 Docs | Every public feature documented with tested examples; upgrade guide; packages data, what's-new, versioning table and deprecations updated in the same change | Docs site tests | not checked | | |
| R8 Release | Version per ADR-0020; staged by CI with provenance, approved with 2FA (ADR-0018); right dist-tag; release notes; rollback plan; `versions.json` updated | Release workflow; owner approval | not checked | | |
| R9 Operations | Logs only through the framework Logger with redaction (ADR-0022); health and readiness checks; no debug tool reachable in production | Tests; `security:check` | not checked | | |

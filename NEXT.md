# NEXT: `@strutvane/search` on `v2/search`

Stopped 2026-11-18 by the coordinator (usage limit). Nothing pushed.

## Done (committed)
- Scaffold (synced tooling files copied from tooling canonical; this repo is **not yet a target in
  tooling's manifest.json**, so `sync --check` doesn't cover it).
- Source: `Searchable()` mixin (overrides `save`/`forceDelete`), index definitions validated
  against the schema (hidden/secret columns refused), `SearchBuilder` (filters, sort, paginate,
  `query()`, `for(user, policy)`), engines database/memory/Meilisearch (official client, optional
  peer)/Typesense (own fetch client), after-commit sync (`searchTransaction`,
  `withoutSyncingToSearch`, `IndexDispatcher` for a future queue), config validation, provider,
  installer, `search:import` / `search:flush` / `install:search` commands.
- Tests (agent-reported, not re-run by the coordinator): sync 11, search 22, tenancy + definition
  60, all green on Windows / Node 24.21 against framework `fix/release-0.2` f658430 (tarball).

## Isolation model
One shared index per model; tenant models store `__tenant`; the builder adds
`__tenant = currentTenant()` (callers can't name it); no tenant → `tenant_required`; every hit is
re-read through the ORM tenant scope (tested with an engine that ignores filters).

## Next (in order)
1. Tests still to write: `filters.ts` compilers + fast-check fuzz (Meilisearch quoting, Typesense
   backtick refusal); config/createEngine; manager (lazy engine retry, ready() retry, report vs
   throw, process); provider (boot an Application with `config/search.ts`); installer (patch
   functions, runInstaller, idempotent, uninstall); commands (loadModel path safety, import/flush
   with a fake app loader); type-level tests (`*.test-d.ts`: unknown column fails to compile).
2. Real-server suites in `test/servers/`: Meilisearch `getmeili/meilisearch:v1.57.0` and Typesense
   `typesense/typesense:30.2` (images pulled), uniquely named containers removed afterwards, skip
   with a reason when Docker can't run Linux containers; conformance + filter-injection +
   cross-tenant tests. Check Typesense accepts the `__tenant` field name.
3. README (Scout-style), RELEASE-READINESS rows, changeset (pre `next`, minor) →
   `changeset version` → 0.2.0-next.0 (package.json is 0.1.0 until then).
4. Full gate (`npm run ci`) 3× with timeouts; coverage 90/90/85/90.

## How to run
`npm install --no-save --ignore-scripts <framework-0.2.0-next.0.tgz>` (pack a worktree of
framework `fix/release-0.2`); `package-lock.json` has no framework entry until it is on npm, so
`npm ci` fails with ETARGET until then. Typecheck: `tsc --noEmit && tsc --noEmit -p test/tsconfig.json`.

## Framework gaps (for the project lead)
- No model events/observers → search overrides `save()`/`forceDelete()` in a mixin.
- No `Connection.afterCommit()` → foreign transactions index before commit (warned once per model).
- `PolicyRegistryToken` / `allows()` not exported → `.for(user)` needs a policy passed or set in options.
- No public tenant column / tenancy mode accessor → tenant models detected by `t.tenant()` flag.
- No `install:<name>` built-in → this package contributes `install:search` itself.
- No devkit helper for `bootstrap/providers.ts` / `config/index.ts` edits (copied pattern from log-viewer).
- Catalogue entry lists env `SEARCH_HOST`/`SEARCH_API_KEY` and `frameworkRange ^1.0`; the package
  uses `SEARCH_DRIVER`, `MEILISEARCH_HOST`/`KEY`, `TYPESENSE_*` and `^0.2.0-next.0`.

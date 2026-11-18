# NEXT: `@strutvane/search` on `v2/search`

Version 0.2.0-next.0 (changeset, pre `next`). Depends on the published `@strutvane/framework`
0.2.0-next.1 (dev) / `^0.2.0-next.0` (peer). Nothing pushed by this session.

## Done
- `Searchable()` mixin (overrides `save`/`forceDelete`), validated index definitions (hidden and
  secret columns refused), `SearchBuilder` (where/whereNot/whereIn/filter, orderBy, query(),
  for(user, policy), get/paginate/keys), engines database (default) / memory / Meilisearch
  (official client, optional peer) / Typesense (built-in fetch client), after-commit sync
  (`searchTransaction`, `withoutSyncingToSearch`, `IndexDispatcher` seam for queues), config
  validation, `SearchServiceProvider`, installer, `search:import` / `search:flush` /
  `install:search`, README, CHANGELOG, RELEASE-READINESS rows.
- Tests: unit and behaviour suites on both the memory and database engines; tenancy attack
  tests; hidden-column leakage; fast-check fuzzing of the filter compilers; manager/config;
  provider in a real Application; installer (idempotent, reversible); commands (path safety);
  type-level tests; engine HTTP stubs; the conformance + injection + end-to-end suite on real
  Meilisearch v1.57.0 and Typesense 30.2 containers (uniquely named, removed afterwards; skipped
  with the reason without Docker, or with `SEARCH_SKIP_SERVERS=1`).
- Real-server runs found and fixed: both servers dropped words from multi-word queries
  (Meilisearch `matchingStrategy: 'all'`; Typesense `drop_tokens_threshold=0`, without
  `exhaustive_search`, which ignores it).

## Isolation model (decided here; for the project lead to confirm)
One shared index per model; tenant models store `__tenant`; the builder adds
`__tenant = currentTenant()` (callers can't name it); no tenant → `tenant_required`; every hit is
re-read through the ORM tenant scope (tested with an engine that ignores filters). Chosen over
index-per-tenant because it scales to many tenants and keeps one schema per model; the database
re-read is the second lock.

## Next
1. Coordinator: re-run the gate (`npm ci && npm run ci`) 3×; R2 CI matrix (symlink test runs on
   Linux/macOS only; it is skipped on Windows without developer mode).
2. R3: written threat model and a `security-reviewer` pass. R5: publint + attw (CI job).
   R6: installer e2e on a real skeleton app. R7: docs site page.
3. Tooling: add `search` as a library target in strutvane-tooling's manifest.json (the synced
   files here were copied from canonical by hand).
4. Hub catalogue entry `search`: env keys are `SEARCH_DRIVER`, `MEILISEARCH_HOST`/`KEY`,
   `TYPESENSE_*` (not `SEARCH_HOST`/`SEARCH_API_KEY`); frameworkRange `^0.2.0-next.0`, version
   0.2.0-next.0, commands also include `install:search`.
5. Later: queued indexing (when framework queues land), custom documents (`toSearchableArray`),
   policy lookup by model name, hybrid/vector search.

## Framework gaps (for the project lead)
- No model events/observers → search overrides `save()`/`forceDelete()` in a mixin.
- No `Connection.afterCommit()` → a foreign transaction indexes before its commit (warned once).
- `PolicyRegistryToken` / `allows()` not exported → `.for(user)` needs a policy passed or set.
- No public tenancy accessor (tenant column / mode) → tenant models detected by the `t.tenant()` flag.
- No built-in `install:<name>`; no devkit helper for `bootstrap/providers.ts` / `config/index.ts`
  edits (the log-viewer and search each carry a copy).
- `isolatedDeclarations` forbids `class Post extends Searchable(...)` in the package's own tests,
  so tests type-check through `test/tsconfig.json` (as an app compiles them).

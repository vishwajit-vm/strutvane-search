# CLAUDE.md: strutvane-search (`@strutvane/search`)

Project memory for Claude Code in this repo. The ecosystem rules are in `.claude/ECOSYSTEM.md`
(synced, identical in every repo): read it first.

@.claude/ECOSYSTEM.md

## What this is

Full-text search for Strutvane models, Laravel Scout's flow: `Searchable(Model('posts'), {...})`,
`Post.search('q').where(...).for(user).paginate()`, engines `database` (default), `memory`,
Meilisearch (`/meilisearch`, official client) and Typesense (`/typesense`, built-in fetch client),
`search:import` / `search:flush` / `install:search` commands, `SearchServiceProvider`.

## Invariants (security; each has tests)

- Hidden/secret columns (the framework's `settings().hidden`) are refused in the options and never
  in a document. Documents hold only `id`, declared fields and the tenant field.
- Tenant isolation: one shared index per model; every search on a tenant model carries
  `__tenant = currentTenant()` added by the builder (never by callers); no tenant → `tenant_required`.
  Hits are re-read through the ORM (tenant scope, soft deletes, global scopes) before returning.
- `.for(user)` re-checks each hit with the policy's `view` (deny by default); no policy → error.
- Filters: names from the `filterable`/`sortable` allow-lists only; values typed; strings quoted by
  one function per engine (`filters.ts`), fuzzed.
- Index writes run after the commit (`sync.ts`); `searchTransaction()` buffers and rolls back.

## State

Branch `v2/search`; see `NEXT.md` for what is done, the framework gaps and the next steps.

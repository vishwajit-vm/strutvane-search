# @strutvane/search

Full-text search for [Strutvane](https://github.com/vishwajit-vm/strutvane) models, in the
spirit of Laravel Scout. Mark a model searchable, and it stays in step with a search index as you
save and delete rows. Then search it with filters, sorting, pagination and policy checks.

| | |
|---|---|
| Package | `@strutvane/search` (pre-release `0.2.0-next.N`) |
| Engines | **database** (default, no server), **Meilisearch**, **Typesense**, **memory** (tests) |
| Needs | `@strutvane/framework` `^0.2.0-next.0` (peer), Node 24.3+ |
| License | MIT |

## Install

```bash
npm install @strutvane/search@next
node strut install:search                   # Meilisearch (default)
node strut install:search --engine typesense
node strut install:search --engine database # no server at all
```

The installer writes `config/search.ts`, lists it in `config/index.ts`, adds `SEARCH_DRIVER` and
the engine's keys to `.env` / `.env.example` (key values are written empty, never invented), and
registers `SearchServiceProvider` in `bootstrap/providers.ts`. `--dry-run --diff` previews it.
Running it again changes nothing. `node strut remove search` reverses it and keeps
`config/search.ts`.

For Meilisearch, also run `npm install meilisearch` (the official client is an optional peer). The
Typesense engine needs nothing extra.

## Make a model searchable

```ts
// app/models/post.ts
import { Model } from '@strutvane/framework/database'
import { Searchable } from '@strutvane/search'
import PostPolicy from '../policies/post.policy.ts'

export class Post extends Searchable(Model('posts', { fillable: ['title', 'body'] }), {
  searchable: ['title', 'body'],              // text columns the query matches, most important first
  filterable: ['status', 'author_id', 'published_on'],
  sortable: ['published_on'],
  perPage: 20,
  shouldBeSearchable: (post) => post.status === 'published',
  policy: new PostPolicy(),                   // used by .for(user)
}) {}
```

Column names are checked at compile time against your generated table types, and again at runtime
against the schema snapshot. **Hidden and secret columns can't be indexed.** These are the model's
`hidden` list, `.hidden()` / `.secret()` in a migration, and secret-looking names such as
`password`, `*_token` or `api_key`. Listing one is an error, and a document only ever holds the
primary key and the columns you declared. Only text columns can be `searchable`. JSON columns
aren't supported.

Then fill the index once:

```bash
node strut search:import Post                 # in chunks, by primary key; safe to run again
node strut search:import Project --tenant <id>
node strut search:flush Post                  # empty the index (the database is untouched)
```

## Search

```ts
const posts = await Post.search('release notes').get()

const page = await Post.search(request.query.q)
  .where('status', 'published')
  .whereIn('author_id', [1, 2])
  .filter('published_on', 'gte', new Date('2026-01-01'))
  .orderBy('published_on', 'desc')
  .query((q) => q.with('author'))   // narrow or eager-load the database read
  .for(ctx.user)                    // re-check every hit with the policy's view()
  .paginate(20, 2)                  // { data, total, perPage, currentPage, lastPage }
```

- Results are real model instances, in the engine's order.
- Every word of the query must match a searchable column, on every engine.
- Filters work on `filterable` columns: `eq`, `ne`, `gt`, `gte`, `lt`, `lte` and `in`. Ordering
  operators work on numbers and dates. `null` matches a missing value (Typesense refuses null
  filters).
- Sorting works on `sortable` columns. Without `orderBy`, results come in relevance order.
- Bad input (an unknown or non-filterable field, a wrong type, an oversized page) throws a
  `SearchError` with a stable `code` and HTTP `status` 400.

## How results stay safe

- **Re-read from the database.** Every hit is loaded again through the model's ORM query before it
  is returned. That query applies the tenant scope, soft deletes and global scopes. A stale or
  wrong index entry can make a result go missing, but it can never show a row the user shouldn't
  see.
- **Policies.** `.for(user)` keeps only hits the policy's `view(user, model)` allows (deny by
  default; `before()` is honoured). If there is no policy, the search fails with `policy_required`
  instead of skipping the check. Rows the policy removes shorten the page; `total` is the index's
  count.
- **Tenants.** Each model has one shared index. On a tenant model (a `t.tenant()` column), every
  document stores its row's tenant, and every search is filtered on the active tenant. Search adds
  that filter itself; callers can't name or remove it. Searching without an active tenant fails
  with `tenant_required`.
- **No filter injection.** Field names come only from your allow-lists. Values are converted to
  the field's type. Strings are quoted by one tested and fuzzed function per engine. A value
  Typesense can't quote safely (one containing a backtick) is refused.

## Keeping the index in step

Saving, deleting, soft-deleting and restoring a searchable model updates the index **after the
commit**:

```ts
import { searchTransaction, withoutSyncingToSearch } from '@strutvane/search'

await searchTransaction(async () => {
  const post = await Post.create({ title: 'Hello', body: '…' })
  await post.tags().attach([1, 2])
}) // indexed here, after COMMIT; a rollback indexes nothing

await withoutSyncingToSearch(() => seedTenThousandPosts()) // then: node strut search:import Post
```

A transaction opened some other way (`DB.transaction()`) can't be seen by search, because the
framework has no after-commit hook yet. The index is then written at once, and a warning is logged
once per model. If writing to the index fails after the database committed, the failure is logged
through the framework's logger and the request goes on (`SEARCH_SYNC_ERRORS=report`, the default).
`search:import` repairs the index. Set `SEARCH_SYNC_ERRORS=throw` to make the request fail
instead. Mass updates and raw SQL bypass models, as in Laravel, so run `search:import` after them.

Index writes go through an `IndexDispatcher` as plain-data jobs. Today they run right away; once
the framework has queues, a queue driver can take them over.

## Configuration (`config/search.ts`, `.env`)

| `.env` | Default | |
|---|---|---|
| `SEARCH_DRIVER` | `database` | `meilisearch`, `typesense`, `database`, `memory` |
| `SEARCH_PREFIX` | empty | prepended to every index name (`staging_`) |
| `SEARCH_SYNC` | `after-commit` | `off` stops model writes from touching the index |
| `SEARCH_SYNC_ERRORS` | `report` | or `throw` |
| `SEARCH_TIMEOUT_MS` | `5000` | per request to a search server |
| `MEILISEARCH_HOST` / `MEILISEARCH_KEY` | `http://127.0.0.1:7700` / empty | the key is required outside local development |
| `TYPESENSE_HOST` / `_PORT` / `_PROTOCOL` / `_API_KEY` | `127.0.0.1` / `8108` / `http` / empty | the key is always required |

A host must be a plain `http(s)` URL with no user name or password in it. A bad setting fails the
boot and names the setting.

## Engines

- **database**: no server. Each word is matched as a literal, case-insensitive substring of a
  searchable column, through the ORM. There is nothing to import.
- **meilisearch** (`@strutvane/search/meilisearch`): the official `meilisearch` client (MIT, no
  dependencies of its own). Index settings are applied once per process, `displayedAttributes` is
  `['id']`, and writes wait for their task by default.
- **typesense** (`@strutvane/search/typesense`): a small built-in client over `fetch`, rather than
  the official package, which pulls in axios, loglevel and tslib. Collections are typed from the
  model, fields added later are added to the collection, and requests never follow redirects.
- **memory**: an in-process index for tests and single-process apps.

Tested against Meilisearch v1.57.0 and Typesense 30.2 in throwaway containers.

## Testing your app

```ts
import { MemoryEngine, runWithSearch, SearchManager } from '@strutvane/search'

const manager = new SearchManager({ engine: new MemoryEngine(), onSyncError: 'throw' })
await runWithSearch(manager, async () => {
  await Post.create({ title: 'Hello' })
  expect(await Post.search('hello').get()).toHaveLength(1)
})
```

## Not yet

These are planned, not built: queued indexing (waiting on framework queues), custom documents
(`toSearchableArray`), hybrid and vector search, a policy lookup by model name (waiting on the
framework exporting its policy registry), and highlighting.

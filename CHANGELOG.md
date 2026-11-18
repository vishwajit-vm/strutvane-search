# @strutvane/search

## 0.2.0-next.0

### Minor Changes

- Full-text search for Strutvane models, in the spirit of Laravel Scout: `Searchable(Model(…), {
  searchable, filterable, sortable })`, `Post.search(q).where(…).orderBy(…).for(user).paginate()`,
  engines database (default), memory, Meilisearch and Typesense, after-commit index sync with
  `searchTransaction()` and `withoutSyncingToSearch()`, tenant-isolated and policy-checked results,
  hidden and secret columns never indexed, `node strut install:search`, `search:import` and
  `search:flush`.

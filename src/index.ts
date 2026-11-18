/**
 * `@strutvane/search`: full-text search for Strutvane models, in the spirit of Laravel Scout.
 *
 * ```ts
 * export class Post extends Searchable(Model('posts'), {
 *   searchable: ['title', 'body'],
 *   filterable: ['status'],
 * }) {}
 *
 * const page = await Post.search('release').where('status', 'published').for(user).paginate()
 * ```
 *
 * Engines: the database (default, no server), memory (tests), Meilisearch
 * (`@strutvane/search/meilisearch`) and Typesense (`@strutvane/search/typesense`). The provider
 * (`@strutvane/search/provider`) builds the manager from `config/search.ts`; the installer and
 * the `search:import` / `search:flush` commands come with the package.
 *
 * @packageDocumentation
 */

export { MAX_OFFSET, MAX_SEARCH_TEXT, SearchBuilder, type SearchPage } from './builder.ts'
export {
  createEngine,
  resolveSearchConfig,
  SEARCH_DRIVERS,
  type SearchConfig,
  type SearchDriver,
} from './config.ts'
export type {
  DocumentValue,
  EngineQuery,
  EngineResult,
  FieldType,
  FilterCondition,
  FilterOperator,
  IndexDefinition,
  IndexField,
  IndexModel,
  SearchDocument,
  SearchEngine,
  SortSpec,
} from './contract.ts'
export { MAX_PER_PAGE, TENANT_FIELD } from './definition.ts'
export { DatabaseEngine } from './engines/database.ts'
export { MemoryEngine } from './engines/memory.ts'
export {
  isSearchError,
  SEARCH_MESSAGES_EN,
  SearchError,
  type SearchErrorCode,
} from './errors.ts'
export {
  FILTER_OPERATORS,
  MAX_FILTER_STRING,
  MAX_IN_VALUES,
  meiliFilter,
  typesenseFilter,
} from './filters.ts'
export { canView, type HydrateQuery, type SearchPolicy } from './hydrate.ts'
export {
  currentSearch,
  type IndexDispatcher,
  type IndexJob,
  maybeCurrentSearch,
  runWithSearch,
  SearchManager,
  type SearchManagerOptions,
  SearchManagerToken,
  type SyncErrorMode,
  syncDispatcher,
  useSearch,
} from './manager.ts'
export { flushModel, type ImportOptions, type ImportReport, importModel } from './operations.ts'
export {
  type InstanceOfClass,
  type ModelConstructor,
  Searchable,
  type SearchableStatics,
} from './searchable.ts'
export { type ColumnName, type SearchableOptions, searchableModel } from './settings.ts'
export { searchTransaction, withoutSyncingToSearch } from './sync.ts'

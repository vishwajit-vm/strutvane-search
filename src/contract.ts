/**
 * The engine contract: what every search engine (database, memory, Meilisearch, Typesense)
 * implements, and the plain data that flows through it.
 *
 * Engines never see models, requests or users. They receive an {@link IndexDefinition} (built
 * and validated from the model once), plain {@link SearchDocument}s (hidden and secret columns
 * already excluded) and an {@link EngineQuery} whose filters were checked against the model's
 * allow-lists, with the tenant condition added by this package, never by the caller. So an
 * engine can't leak what it was never given, and a caller can't remove the tenant filter.
 *
 * @module
 */

/** The value types a search field can hold. */
export type FieldType = 'string' | 'int' | 'float' | 'bool' | 'datetime'

/** One field of an index. */
export interface IndexField {
  /** The column name (also the document key). */
  readonly name: string
  readonly type: FieldType
  /** The column kind in the schema (`timestamp`, `decimal`, …), for engines that query the database. */
  readonly kind: string
  /** Matched by the search text. Only `string` fields are searchable. */
  readonly searchable: boolean
  /** May be used in `where`/`filter`. */
  readonly filterable: boolean
  /** May be used in `orderBy`. */
  readonly sortable: boolean
  /** The column may hold `null`. */
  readonly nullable: boolean
}

/** The model side of an index, used by engines that query the database itself. */
export interface IndexModel {
  /** The model's table. */
  readonly table: string
  /** Start an ORM query on the model (tenant scope and global scopes included). */
  query(): unknown
}

/**
 * Everything an engine needs to know about one index. Built once per model by `Searchable()`.
 *
 * @example
 * await engine.ensureIndex(definition)
 */
export interface IndexDefinition {
  /** The engine-side index name, prefix included (`app_posts`). */
  readonly name: string
  /** The model class name, for messages. */
  readonly model: string
  /** The searchable, filterable and sortable fields (never a hidden column). */
  readonly fields: readonly IndexField[]
  /**
   * The document key holding the row's tenant, when the model belongs to tenants. Every search on
   * such an index is filtered on it (see `builder.ts`).
   */
  readonly tenantField: string | undefined
  /** How engine keys turn back into primary keys (numbers for integer keys). */
  readonly keyType: 'int' | 'string'
  /** The model, for the database engine (other engines ignore it). */
  readonly source: IndexModel
}

/** A primitive document value. Dates are stored as epoch milliseconds (`datetime`). */
export type DocumentValue = string | number | boolean | null

/**
 * One document: `id` (the primary key as a string) plus the declared fields, and the tenant field
 * when the model belongs to tenants.
 */
export interface SearchDocument {
  readonly id: string
  readonly [field: string]: DocumentValue
}

/** Comparison operators a filter may use. */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'

/**
 * One validated filter condition. Conditions are combined with AND. `value` is already converted
 * to the field's document type (a `Date` became epoch milliseconds, and so on).
 */
export interface FilterCondition {
  readonly field: string
  readonly type: FieldType
  readonly operator: FilterOperator
  /** A single value, or a non-empty list for `in`. */
  readonly value: DocumentValue | readonly DocumentValue[]
}

/** One sort key. */
export interface SortSpec {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

/** A validated search request, as an engine receives it. */
export interface EngineQuery {
  /** The search text, trimmed; empty means "every document" (filters still apply). */
  readonly text: string
  readonly filters: readonly FilterCondition[]
  /** Explicit sort keys; empty means relevance order. */
  readonly sort: readonly SortSpec[]
  readonly limit: number
  readonly offset: number
}

/** What an engine answers: matching keys in result order, and how many match in total. */
export interface EngineResult {
  readonly keys: readonly string[]
  /** Total matches (some engines estimate it). */
  readonly total: number
}

/**
 * A search engine. Implementations must be safe to call concurrently, must never log document
 * contents or credentials, and must throw `SearchError('engine_failed')` (never a raw client
 * error carrying URLs or keys) when the server fails.
 *
 * @example
 * const engine: SearchEngine = new MemoryEngine()
 */
export interface SearchEngine {
  /** Short name used in messages (`meilisearch`). */
  readonly name: string
  /** `false` when the engine reads the database directly and keeps no index (nothing to sync). */
  readonly keepsIndex: boolean
  /** Create the index if needed and apply its settings. Idempotent. */
  ensureIndex(index: IndexDefinition): Promise<void>
  /** Insert or replace documents (by `id`). */
  upsert(index: IndexDefinition, documents: readonly SearchDocument[]): Promise<void>
  /** Remove documents by key. Unknown keys are ignored. */
  remove(index: IndexDefinition, keys: readonly string[]): Promise<void>
  /** Run a search. */
  search(index: IndexDefinition, query: EngineQuery): Promise<EngineResult>
  /** Remove every document of the index (the index itself and its settings stay usable). */
  flush(index: IndexDefinition): Promise<void>
  /** Release connections. Optional. */
  close?(): Promise<void>
}

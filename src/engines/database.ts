/**
 * The database engine: no search server and no index; every search is an ORM query on the
 * model's table (Laravel Scout's `database` driver). Good for small apps, and the default, so a
 * fresh app searches before anyone sets up Meilisearch or Typesense.
 *
 * - **Matching:** every word of the search text must appear (case-insensitively, as a literal
 *   substring: `%` and `_` are not wildcards) in at least one searchable column. It uses the ORM's
 *   own `search()`, so hidden columns are refused there too.
 * - **Tenancy:** the ORM's tenant scope (and PostgreSQL row-level security, ADR-0007) applies, so
 *   the tenant condition search adds is already enforced by the query itself.
 * - **Indexing:** there is nothing to index, so `upsert`, `remove` and `flush` do nothing and
 *   `keepsIndex` is `false` (saving a model sends nothing anywhere).
 *
 * @module
 */
import type {
  DocumentValue,
  EngineQuery,
  EngineResult,
  FilterCondition,
  IndexDefinition,
  SearchDocument,
  SearchEngine,
} from '../contract.ts'
import { documentKey } from '../definition.ts'
import { words } from './memory.ts'

/** The ORM builder methods this engine calls (the framework's `Builder` has all of them). */
export interface OrmQuery {
  search(term: string, columns: readonly string[]): OrmQuery
  where(column: string, operator: string, value: unknown): OrmQuery
  where(group: (query: OrmQuery) => void): OrmQuery
  orWhere(column: string, value: unknown): OrmQuery
  whereIn(column: string, values: readonly unknown[]): OrmQuery
  orderBy(column: string, direction: 'asc' | 'desc'): OrmQuery
  limit(count: number): OrmQuery
  offset(count: number): OrmQuery
  clone(): OrmQuery
  count(): Promise<number>
  get(): Promise<object[]>
}

/** Narrow the model's `query()` result to the builder methods used here. */
export function ormQuery(index: IndexDefinition): OrmQuery {
  // `source.query()` is the framework's Builder, which implements OrmQuery at runtime; the typed
  // model face can't be named here because the app's table types are not known to this package.
  return index.source.query() as OrmQuery
}

const COMPARE: Readonly<Record<Exclude<FilterCondition['operator'], 'in'>, string>> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

/**
 * The search engine that queries the database.
 *
 * @example
 * new SearchManager({ engine: new DatabaseEngine() })
 */
export class DatabaseEngine implements SearchEngine {
  readonly name: string = 'database'
  readonly keepsIndex: boolean = false

  async ensureIndex(_index: IndexDefinition): Promise<void> {}

  async upsert(_index: IndexDefinition, _documents: readonly SearchDocument[]): Promise<void> {}

  async remove(_index: IndexDefinition, _keys: readonly string[]): Promise<void> {}

  async flush(_index: IndexDefinition): Promise<void> {}

  async search(index: IndexDefinition, query: EngineQuery): Promise<EngineResult> {
    const builder = ormQuery(index)
    const columns = index.fields.filter((field) => field.searchable).map((field) => field.name)
    // One literal "contains" group per word: every word must appear in some searchable column.
    for (const word of new Set(words(query.text))) builder.search(word, columns)
    for (const condition of query.filters) {
      // The ORM scopes every query to the active tenant itself (fail closed without one).
      if (condition.field === index.tenantField) continue
      applyCondition(builder, index, condition)
    }
    for (const spec of query.sort) builder.orderBy(spec.field, spec.direction)
    // A stable order for equal sort keys (and when nothing is sorted): the primary key.
    builder.orderBy('id', 'asc')
    const total = await builder.clone().count()
    const rows = await builder.limit(query.limit).offset(query.offset).get()
    return { keys: rows.map((row) => documentKey(Reflect.get(row, 'id'))), total }
  }
}

function applyCondition(
  builder: OrmQuery,
  index: IndexDefinition,
  condition: FilterCondition,
): void {
  const kind = index.fields.find((field) => field.name === condition.field)?.kind
  const { field, operator, value } = condition
  if (operator === 'in') {
    const list = (Array.isArray(value) ? value : [value]).map((item: DocumentValue) =>
      columnValue(kind, item),
    )
    const present = list.filter((item) => item !== null)
    if (present.length === list.length) {
      builder.whereIn(field, present)
      return
    }
    builder.where((group) => {
      if (present.length > 0) group.whereIn(field, present)
      group.orWhere(field, null)
    })
    return
  }
  builder.where(field, COMPARE[operator], columnValue(kind, value as DocumentValue))
}

/** A document value back to what the column holds (dates were epoch milliseconds). */
function columnValue(kind: string | undefined, value: DocumentValue): unknown {
  if (typeof value !== 'number') return value
  if (kind === 'timestamp') return new Date(value)
  if (kind === 'date') return new Date(value).toISOString().slice(0, 10)
  return value
}

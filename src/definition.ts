/**
 * From a model and its Searchable options to a validated {@link IndexDefinition}, and from a
 * model instance to the {@link SearchDocument} sent to the engine.
 *
 * The rules (each fails with a message that says how to fix it):
 * - Every listed field must be a real column of the table (from the schema snapshot).
 * - **A hidden or secret column can never be listed** (`hidden_field`). The hidden set is the
 *   framework's own: the model's `hidden`, `.hidden()`/`.secret()` in the migration, and
 *   secret-looking names. The schema decides first, so forgetting `hidden` on the model never
 *   sends a password hash to a search server.
 * - Only text columns are searchable; JSON columns are not supported at all.
 * - `id` and the tenant column are managed by search itself and can't be listed.
 * - A document holds exactly the declared fields plus `id` (and the tenant field), so nothing
 *   else of the row ever leaves the database.
 *
 * @module
 */
import type {
  DocumentValue,
  FieldType,
  IndexDefinition,
  IndexField,
  SearchDocument,
} from './contract.ts'
import { SearchError } from './errors.ts'
import { attribute, type ColumnInfo, type ModelRecord, type ModelRuntime } from './model.ts'

/** The document key that holds the row's tenant on tenant-scoped models. */
export const TENANT_FIELD = '__tenant'

/** Largest page a search may ask for (the ORM's own `maxPerPage`). */
export const MAX_PER_PAGE = 100

/** Field names search accepts: plain identifiers, never starting with `__` (reserved). */
const FIELD_NAME = /^(?!__)[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** Index names: what both Meilisearch uids and Typesense collection names accept. */
const INDEX_NAME = /^[A-Za-z0-9_-]{1,100}$/

/** Column kinds by search type. JSON is missing on purpose: it is not supported. */
const KIND_TYPES: Readonly<Record<string, FieldType>> = {
  string: 'string',
  text: 'string',
  slug: 'string',
  uuid: 'string',
  enum: 'string',
  id: 'int',
  integer: 'int',
  bigInteger: 'int',
  foreignId: 'int',
  decimal: 'float',
  double: 'float',
  boolean: 'bool',
  date: 'datetime',
  timestamp: 'datetime',
}

/**
 * The Searchable options that shape the index (the rest live in `searchable.ts`). Field names are
 * plain strings here; `Searchable()` types them as the model's columns.
 */
export interface IndexOptions {
  /** Text columns the search text is matched against, most important first. */
  readonly searchable: readonly string[]
  /** Columns `where()`/`filter()` may use. */
  readonly filterable?: readonly string[] | undefined
  /** Columns `orderBy()` may use. */
  readonly sortable?: readonly string[] | undefined
  /** Index name before the configured prefix. Default: the table name. */
  readonly index?: string | undefined
}

/** Build and validate the index definition of `model`. */
export function defineIndex(
  model: ModelRuntime,
  options: IndexOptions,
  prefix: string,
): IndexDefinition {
  const info = model.info()
  const hidden = model.settings().hidden
  const fail = (detail: string): SearchError =>
    new SearchError('invalid_options', { model: model.name, detail })
  if (!Array.isArray(options.searchable) || options.searchable.length === 0)
    throw fail('`searchable` must list at least one text column, e.g. { searchable: ["title"] }.')

  const tenantColumn = [...info.columns.values()].find((column) => column.tenant === true)
  const roles = new Map<string, { searchable: boolean; filterable: boolean; sortable: boolean }>()
  const mark = (
    list: readonly string[] | undefined,
    role: 'searchable' | 'filterable' | 'sortable',
  ) => {
    if (list === undefined) return
    if (!Array.isArray(list)) throw fail(`\`${role}\` must be an array of column names.`)
    for (const name of list) {
      if (typeof name !== 'string' || !FIELD_NAME.test(name))
        throw fail(`${JSON.stringify(name)} in \`${role}\` is not a column name.`)
      const entry = roles.get(name) ?? { searchable: false, filterable: false, sortable: false }
      entry[role] = true
      roles.set(name, entry)
    }
  }
  mark(options.searchable, 'searchable')
  mark(options.filterable, 'filterable')
  mark(options.sortable, 'sortable')

  const fields: IndexField[] = []
  for (const [name, role] of roles) {
    if (name === 'id' || name === info.primaryKey.name)
      throw fail(
        `"${name}" is the primary key: search always stores it as the document key. Remove it from the options; narrow results by key with .query((q) => q.whereIn(…)) instead.`,
      )
    const column = info.columns.get(name)
    if (column === undefined)
      throw new SearchError('unknown_field', {
        model: model.name,
        field: name,
        table: info.name,
        hint: hintFor(name, info.columns, hidden),
      })
    // Checked before anything else about the column, so a secret is refused even when it is
    // also mistyped for its role.
    if (hidden.has(name)) throw new SearchError('hidden_field', { model: model.name, field: name })
    if (column.tenant === true)
      throw fail(
        `"${name}" is the tenant column. Search isolates tenants itself (every search is filtered on the active tenant); remove it from the options.`,
      )
    const type = KIND_TYPES[column.kind]
    if (type === undefined)
      throw new SearchError('unsupported_field', {
        model: model.name,
        field: name,
        kind: column.kind,
        use: 'index',
        fix: 'Index a text or number column derived from it instead.',
      })
    if (role.searchable && type !== 'string')
      throw new SearchError('unsupported_field', {
        model: model.name,
        field: name,
        kind: column.kind,
        use: 'match search text against',
        fix: 'Only text columns can be searchable; list it under `filterable` or `sortable` instead.',
      })
    fields.push({ name, type, kind: column.kind, ...role, nullable: column.nullable })
  }

  const name = `${prefix}${options.index ?? info.name}`
  if (!INDEX_NAME.test(name))
    throw fail(
      `the index name "${name}" may only use letters, digits, "_" and "-" (at most 100 characters). Set \`index\` in the options or fix SEARCH_PREFIX.`,
    )
  return {
    name,
    model: model.name,
    fields,
    tenantField: tenantColumn === undefined ? undefined : TENANT_FIELD,
    keyType: KIND_TYPES[info.primaryKey.kind] === 'int' ? 'int' : 'string',
    source: model,
  }
}

/** The tenant column of the model's table, if it belongs to tenants. */
export function tenantColumnOf(model: ModelRuntime): string | undefined {
  return [...model.info().columns.values()].find((column) => column.tenant === true)?.name
}

/**
 * The document for one saved model instance: `id`, the declared fields (converted to their
 * search types) and, on tenant tables, the row's tenant. Nothing else of the row is read.
 *
 * @example
 * buildDocument(definition, Post, post) // { id: '7', title: 'Hello', status: 'published' }
 */
export function buildDocument(
  index: IndexDefinition,
  model: ModelRuntime,
  record: ModelRecord,
): SearchDocument {
  const key = attribute(record, model.info().primaryKey.name)
  if (key === undefined || key === null)
    throw new SearchError('invalid_document', {
      model: index.model,
      detail: 'the row has no primary key yet (index it after save()).',
    })
  const document: Record<string, DocumentValue> = { id: documentKey(key) }
  for (const field of index.fields) {
    document[field.name] = toDocumentValue(index, field, attribute(record, field.name))
  }
  if (index.tenantField !== undefined) {
    const column = tenantColumnOf(model)
    const tenant = column === undefined ? undefined : attribute(record, column)
    if (typeof tenant !== 'string' || tenant === '')
      throw new SearchError('tenant_required', { model: index.model })
    document[index.tenantField] = tenant
  }
  return document as SearchDocument
}

/** A primary key as a document key (engines key documents by string). */
export function documentKey(key: unknown): string {
  if (typeof key === 'number' && Number.isSafeInteger(key)) return String(key)
  if (typeof key === 'bigint') return key.toString()
  if (typeof key === 'string' && key !== '') return key
  throw new SearchError('invalid_document', {
    model: 'the model',
    detail: `a primary key must be an integer or a non-empty string; got ${typeof key}.`,
  })
}

/** An engine key back to a primary key value (numbers for integer keys). */
export function primaryKeyOf(index: IndexDefinition, key: string): string | number {
  if (index.keyType === 'string') return key
  const number = Number(key)
  return Number.isSafeInteger(number) ? number : key
}

/**
 * Convert a value to a field's search type: dates to epoch milliseconds, decimals to numbers.
 * Used for document values and for filter operands, so both sides always compare alike.
 */
export function toDocumentValue(
  index: Pick<IndexDefinition, 'model'>,
  field: Pick<IndexField, 'name' | 'type'>,
  value: unknown,
): DocumentValue {
  if (value === null || value === undefined) return null
  const invalid = (): SearchError =>
    new SearchError('invalid_document', {
      model: index.model,
      detail: `"${field.name}" should be ${article(field.type)}, got ${describeValue(value)}.`,
    })
  switch (field.type) {
    case 'string':
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      throw invalid()
    case 'int': {
      const number = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value)
      if (typeof value === 'boolean' || !Number.isSafeInteger(number)) throw invalid()
      return number
    }
    case 'float': {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number)) throw invalid()
      return number
    }
    case 'bool':
      if (typeof value === 'boolean') return value
      throw invalid()
    case 'datetime': {
      const time = toEpoch(value)
      if (time === undefined) throw invalid()
      return time
    }
  }
}

/** A date, an ISO date or date-time string, or epoch milliseconds → epoch milliseconds. */
function toEpoch(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  // A bare date ('2026-11-18', how the ORM returns DATE columns) is midnight UTC.
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return undefined
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : undefined
}

function article(type: FieldType): string {
  return {
    string: 'a string',
    int: 'an integer',
    float: 'a number',
    bool: 'a boolean',
    datetime: 'a date',
  }[type]
}

function describeValue(value: unknown): string {
  if (value instanceof Date) return 'an invalid date'
  return Array.isArray(value) ? 'a list' : typeof value
}

/** "Did you mean …?" for a mistyped column, never naming a hidden one. */
function hintFor(
  name: string,
  columns: ReadonlyMap<string, ColumnInfo>,
  hidden: ReadonlySet<string>,
): string {
  const lower = name.toLowerCase()
  const candidate = [...columns.keys()].find(
    (column) =>
      !hidden.has(column) &&
      (column.toLowerCase() === lower || distance(column.toLowerCase(), lower) <= 2),
  )
  return candidate === undefined ? '' : ` Did you mean "${candidate}"?`
}

/** Levenshtein distance, for short identifiers only. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] ?? 0
}

/**
 * The narrow, structural view of a framework model that search needs, and the one place that
 * checks an unknown value really is a model class.
 *
 * Search depends only on the published `@strutvane/framework/database` surface: `ModelBase`
 * (for the `instanceof` check), and the statics every model has at runtime (`info()` for the
 * columns from the schema snapshot, `settings()` for the full hidden set, `query()` for the
 * tenant-scoped ORM builder). The typed `Model('posts')` face doesn't declare `info()` and
 * `settings()`, so they are reached through {@link ModelRuntime}, checked here once.
 *
 * @module
 */
import { ModelBase } from '@strutvane/framework/database'
import { SearchError } from './errors.ts'

/** A column as the schema snapshot describes it (the parts search reads). */
export interface ColumnInfo {
  readonly name: string
  readonly kind: string
  readonly nullable: boolean
  /** Set by `t.tenant()`: the row's tenant. */
  readonly tenant?: true
}

/** A table as the schema snapshot describes it (the parts search reads). */
export interface TableFacts {
  readonly name: string
  readonly columns: ReadonlyMap<string, ColumnInfo>
  readonly primaryKey: ColumnInfo
  readonly softDeletes: boolean
}

/**
 * The runtime statics of a model class that search uses.
 *
 * - `info()`: the table's columns, from the schema snapshot (so a renamed column is caught).
 * - `settings().hidden`: every column the framework keeps out of output: the model's `hidden`,
 *   `.hidden()`/`.secret()` in the migration and secret-looking names. Search never indexes one.
 * - `query()`: an ORM query with the tenant scope and global scopes applied.
 */
export interface ModelRuntime {
  readonly name: string
  readonly table: string
  readonly prototype: object
  info(): TableFacts
  settings(): { readonly hidden: ReadonlySet<string> }
  query(): unknown
}

/** A model instance as search reads it: its column values are own properties. */
export type ModelRecord = object

/**
 * Check that `value` is a model class (extends `ModelBase`) and return its runtime view.
 *
 * @example
 * const runtime = modelRuntime(Post)
 * runtime.info().columns.has('title')
 */
export function modelRuntime(value: unknown): ModelRuntime {
  if (typeof value !== 'function' || !(value.prototype instanceof ModelBase))
    throw new SearchError('not_a_model', { got: describe(value) })
  // `value` extends ModelBase, whose statics implement ModelRuntime (checked by the line above).
  return value as unknown as ModelRuntime
}

/** Is `value` a model instance? */
export function isModelInstance(value: unknown): value is ModelRecord {
  return value instanceof ModelBase
}

/** Read one column value of a model instance (an own data property). */
export function attribute(model: ModelRecord, column: string): unknown {
  return Object.hasOwn(model, column) ? Reflect.get(model, column) : undefined
}

function describe(value: unknown): string {
  if (typeof value === 'function') return `the function ${value.name || '(anonymous)'}`
  if (value === null) return 'null'
  return typeof value
}

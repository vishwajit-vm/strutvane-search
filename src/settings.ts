/**
 * What `Searchable()` attaches to a model class, and the per-manager cache of its validated index
 * definition. Kept apart from `searchable.ts` so the builder, sync and commands can read it
 * without importing the mixin.
 *
 * @module
 */
import type { IndexDefinition } from './contract.ts'
import { defineIndex, MAX_PER_PAGE } from './definition.ts'
import { SearchError } from './errors.ts'
import type { SearchPolicy } from './hydrate.ts'
import type { SearchManager } from './manager.ts'
import { type ModelRecord, type ModelRuntime, modelRuntime } from './model.ts'

/** The column names of a model instance: its own non-function properties. */
export type ColumnName<TModel> = {
  [K in keyof TModel]-?: TModel[K] extends (...args: never[]) => unknown ? never : K
}[keyof TModel] &
  string

/**
 * How a model is searched. Field lists name the model's columns (checked at compile time against
 * the generated table types, and again at runtime against the schema snapshot).
 *
 * @example
 * Searchable(Model('posts'), {
 *   searchable: ['title', 'body'],
 *   filterable: ['status', 'author_id', 'published_on'],
 *   sortable: ['published_on'],
 * })
 */
export interface SearchableOptions<TModel> {
  /** Text columns the search text is matched against, most important first. */
  readonly searchable: readonly ColumnName<TModel>[]
  /** Columns `where()`, `whereIn()` and `filter()` may use. */
  readonly filterable?: readonly ColumnName<TModel>[]
  /** Columns `orderBy()` may use. */
  readonly sortable?: readonly ColumnName<TModel>[]
  /** Index name before the configured prefix. Default: the table name. */
  readonly index?: string
  /** Results per page by default (1–100). Default 15. */
  readonly perPage?: number
  /**
   * Index only rows that pass (Laravel's `shouldBeSearchable`); a row that stops passing is
   * removed from the index on its next save.
   */
  readonly shouldBeSearchable?: (model: TModel) => boolean
  /** The policy `.for(user)` re-checks each result with (its `view` method decides). */
  readonly policy?: SearchPolicy<TModel>
}

/** The options as the runtime keeps them. */
export interface SearchableSettings {
  readonly searchable: readonly string[]
  readonly filterable?: readonly string[] | undefined
  readonly sortable?: readonly string[] | undefined
  readonly index?: string | undefined
  readonly perPage?: number | undefined
  readonly shouldBeSearchable?: ((model: ModelRecord) => boolean) | undefined
  readonly policy?: SearchPolicy<ModelRecord> | undefined
}

/** The static property `Searchable()` stores its settings under. */
export const SEARCHABLE: unique symbol = Symbol.for('strutvane.search.searchable')

/** A searchable model: its runtime view and its settings. */
export interface SearchableModel {
  readonly runtime: ModelRuntime
  readonly settings: SearchableSettings
}

/**
 * The searchable view of a model class, or `undefined` when it isn't searchable.
 *
 * @example
 * searchableModel(Post)?.settings.searchable // ['title', 'body']
 */
export function searchableModel(value: unknown): SearchableModel | undefined {
  if (typeof value !== 'function') return undefined
  const settings: unknown = Reflect.get(value, SEARCHABLE)
  if (typeof settings !== 'object' || settings === null) return undefined
  return { runtime: modelRuntime(value), settings: settings as SearchableSettings }
}

/**
 * Like {@link searchableModel}, but a model that isn't searchable is an error.
 *
 * @example
 * const { runtime } = requireSearchable(Post)
 */
export function requireSearchable(value: unknown): SearchableModel {
  const found = searchableModel(value)
  if (found === undefined)
    throw new SearchError('not_searchable', {
      model: typeof value === 'function' ? value.name : String(value),
    })
  return found
}

/** Validate the options that don't depend on the schema (the rest is checked by defineIndex). */
export function checkSettings(model: string, settings: SearchableSettings): void {
  const fail = (detail: string): SearchError =>
    new SearchError('invalid_options', { model, detail })
  if (typeof settings !== 'object' || settings === null)
    throw fail('the options must be an object.')
  const perPage = settings.perPage
  if (
    perPage !== undefined &&
    (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE)
  )
    throw fail(`\`perPage\` must be a whole number from 1 to ${MAX_PER_PAGE}.`)
  if (
    settings.shouldBeSearchable !== undefined &&
    typeof settings.shouldBeSearchable !== 'function'
  )
    throw fail('`shouldBeSearchable` must be a function (model) => boolean.')
  if (
    settings.policy !== undefined &&
    (typeof settings.policy !== 'object' || settings.policy === null)
  )
    throw fail('`policy` must be a policy object (an instance of your policy class).')
}

const cache = new WeakMap<object, Map<string, IndexDefinition>>()

/**
 * The validated index definition of a searchable model for a manager (cached per model class and
 * index prefix; the schema snapshot is read once).
 *
 * @example
 * const index = indexFor(searchableModel(Post), manager)
 */
export function indexFor(model: SearchableModel, manager: SearchManager): IndexDefinition {
  let byPrefix = cache.get(model.runtime)
  if (byPrefix === undefined) {
    byPrefix = new Map()
    cache.set(model.runtime, byPrefix)
  }
  let index = byPrefix.get(manager.prefix)
  if (index === undefined) {
    index = defineIndex(model.runtime, model.settings, manager.prefix)
    byPrefix.set(manager.prefix, index)
  }
  manager.register(index)
  return index
}

// biome-ignore-all lint/complexity/noThisInStatic: the statics act on the subclass they are called on (Post.search() searches Post), as the framework's Model statics do.
/**
 * `Searchable()`: the opt-in that makes a model searchable (Laravel Scout's `Searchable` trait).
 *
 * ```ts
 * // app/models/post.ts
 * import { Model } from '@strutvane/framework/database'
 * import { Searchable } from '@strutvane/search'
 *
 * export class Post extends Searchable(Model('posts', { fillable: ['title', 'body'] }), {
 *   searchable: ['title', 'body'],
 *   filterable: ['status', 'author_id'],
 *   sortable: ['published_on'],
 * }) {}
 *
 * await Post.search('release').where('status', 'published').get()
 * ```
 *
 * Why a mixin around `Model()`: the framework's models have no model events or observers yet, so
 * search hooks in where every write passes, `save()` and `forceDelete()` (soft `delete()` and
 * `restore()` go through `save()`; a hard `delete()` goes through `forceDelete()`). Each override
 * calls the framework's method first and touches the index only after it succeeded, after the
 * commit (see `sync.ts`). Mass updates and raw SQL bypass models, as in Laravel: run
 * `node strut search:import` after them.
 *
 * @module
 */
import type { ModelBase } from '@strutvane/framework/database'
import { SearchBuilder } from './builder.ts'
import type { IndexDefinition } from './contract.ts'
import { buildDocument, documentKey } from './definition.ts'
import type { IndexJob } from './manager.ts'
import { maybeCurrentSearch } from './manager.ts'
import { attribute, type ModelRecord, modelRuntime } from './model.ts'
import { flushModel, type ImportOptions, type ImportReport, importModel } from './operations.ts'
import {
  checkSettings,
  indexFor,
  requireSearchable,
  SEARCHABLE,
  type SearchableModel,
  type SearchableOptions,
  type SearchableSettings,
} from './settings.ts'
import { afterCommit, syncingDisabled } from './sync.ts'

/** The instance type of a class. */
export type InstanceOfClass<TClass> = TClass extends abstract new () => infer TInstance
  ? TInstance
  : never

/** A model class (what `Model('table', …)` returns, or a class extending it). */
export type ModelConstructor = abstract new () => object

/** The statics `Searchable()` adds to a model class. */
export interface SearchableStatics {
  /**
   * Start a search. An empty text matches everything (filters and sorting still apply).
   *
   * @example
   * await Post.search('hello').get()
   */
  search<TSelf extends ModelConstructor>(
    this: TSelf,
    text?: string,
  ): SearchBuilder<InstanceOfClass<TSelf>>
  /**
   * Index every row (in chunks, by primary key), like `node strut search:import`.
   *
   * @example
   * await Post.makeAllSearchable()
   */
  makeAllSearchable(options?: ImportOptions): Promise<ImportReport>
  /**
   * Remove every document of this model from the index, like `node strut search:flush`.
   *
   * @example
   * await Post.removeAllFromSearch()
   */
  removeAllFromSearch(): Promise<void>
}

/**
 * Make a model searchable. Wrap the `Model(…)` call your model extends; the options name the
 * columns to index (hidden and secret columns are refused).
 *
 * @example
 * export class Post extends Searchable(Model('posts'), { searchable: ['title', 'body'] }) {}
 */
export function Searchable<TBase extends ModelConstructor>(
  Base: TBase,
  options: SearchableOptions<InstanceOfClass<TBase>>,
): TBase & SearchableStatics {
  const base = modelRuntime(Base) as unknown as typeof ModelBase
  // The options are typed for the model's own instances; the runtime keeps them as plain data.
  const settings = Object.freeze({ ...options }) as unknown as SearchableSettings
  checkSettings(base.name || 'The model', settings)

  class SearchableModelClass extends base {
    static readonly [SEARCHABLE]: SearchableSettings = settings

    override async save(): Promise<this> {
      const saved = await super.save()
      await syncRecord(this, this.trashed())
      return saved
    }

    override async forceDelete(): Promise<void> {
      await super.forceDelete()
      await syncRecord(this, true)
    }

    static search(text?: string): SearchBuilder<ModelRecord> {
      return new SearchBuilder(requireSearchable(this), text)
    }

    static makeAllSearchable(options?: ImportOptions): Promise<ImportReport> {
      return importModel(this, options)
    }

    static removeAllFromSearch(): Promise<void> {
      return flushModel(this)
    }
  }
  // The class above is `Base` plus the statics declared in SearchableStatics; TypeScript can't
  // express a mixin over a generic base without `any`, so the result is typed here, once.
  return SearchableModelClass as unknown as TBase & SearchableStatics
}

/**
 * Index (or remove) one saved model. Called by the overrides above, after the database write.
 * Nothing happens when syncing is off, no manager is set up, or the engine keeps no index.
 */
async function syncRecord(record: ModelBase, removed: boolean): Promise<void> {
  if (syncingDisabled()) return
  const manager = maybeCurrentSearch()
  if (manager === undefined || manager.sync === 'off') return
  const model = requireSearchable(record.constructor)
  let job: IndexJob
  try {
    const engine = await manager.engine()
    if (!engine.keepsIndex) return
    job = jobFor(model, indexFor(model, manager), record, removed)
  } catch (error) {
    manager.syncFailed(error, {
      model: model.runtime.name,
      operation: removed ? 'remove' : 'upsert',
    })
    return
  }
  await afterCommit(job, model.runtime.name)
}

function jobFor(
  model: SearchableModel,
  index: IndexDefinition,
  record: ModelRecord,
  removed: boolean,
): IndexJob {
  const keep = !removed && (model.settings.shouldBeSearchable?.(record) ?? true)
  if (!keep) {
    const key = documentKey(attribute(record, model.runtime.info().primaryKey.name))
    return { index: index.name, operation: 'remove', documents: [], keys: [key] }
  }
  return {
    index: index.name,
    operation: 'upsert',
    documents: [buildDocument(index, model.runtime, record)],
    keys: [],
  }
}

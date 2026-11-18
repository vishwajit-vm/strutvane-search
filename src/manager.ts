/**
 * The search manager: one per app. It owns the engine (created lazily, so an app that never
 * searches never connects), the index-name prefix, the logger and the index dispatcher, and it
 * remembers which indexes it has already set up.
 *
 * **Which manager is current.** Models don't hold a manager; each search or sync asks for the
 * current one, in this order:
 * 1. `runWithSearch(manager, fn)`: tests and scripts.
 * 2. The running application's container (`SearchManagerToken`, bound by
 *    `SearchServiceProvider`), so two apps in one process never share an index connection.
 * 3. A process-wide manager set with `useSearch(manager)`.
 * Otherwise `SearchError('not_configured')`, which says how to set search up.
 *
 * **Queues.** Index writes go through an {@link IndexDispatcher}. Today the framework has no queue,
 * so the default dispatcher runs each job at once, after the commit. A job is plain data (the
 * index name, the operation, the documents or keys), so a queue driver can take the dispatcher
 * over later: serialise the job, and have the worker call `manager.process(job)`.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { app, isBootError } from '@strutvane/framework'
import type { Logger } from '@strutvane/framework/contracts'
import { type Token, token } from '@strutvane/framework/core'
import type { IndexDefinition, SearchDocument, SearchEngine } from './contract.ts'
import { SearchError } from './errors.ts'

/**
 * One index write, as plain data. `documents` (for `upsert`) hold only declared fields, never a
 * hidden or secret column, so a job is safe to serialise into a queue.
 */
export interface IndexJob {
  /** The engine-side index name. */
  readonly index: string
  readonly operation: 'upsert' | 'remove'
  /** For `upsert`. */
  readonly documents: readonly SearchDocument[]
  /** For `remove`. */
  readonly keys: readonly string[]
}

/**
 * Decides when an index job runs. The default runs it at once; a queue driver would enqueue it
 * and later call `manager.process(job)` in a worker.
 *
 * @example
 * const inline: IndexDispatcher = { dispatch: (job, run) => run(job) }
 */
export interface IndexDispatcher {
  dispatch(job: IndexJob, run: (job: IndexJob) => Promise<void>): Promise<void>
}

/** The default dispatcher: run every job right away (index writes happen after the commit). */
export const syncDispatcher: IndexDispatcher = Object.freeze({
  dispatch: (job: IndexJob, run: (job: IndexJob) => Promise<void>): Promise<void> => run(job),
})

/** What to do when writing to the index fails after the database already committed. */
export type SyncErrorMode = 'report' | 'throw'

/** Options for {@link SearchManager}. */
export interface SearchManagerOptions {
  /** The engine, or a function that creates it on first use. */
  readonly engine: SearchEngine | (() => Promise<SearchEngine>)
  /** Prepended to every index name (`SEARCH_PREFIX`, e.g. `staging_`). Default: none. */
  readonly prefix?: string
  /** Where sync failures and warnings go (the framework's logger). Default: nowhere. */
  readonly logger?: Logger | (() => Logger)
  /** Default: {@link syncDispatcher}. */
  readonly dispatcher?: IndexDispatcher
  /** `off` stops saving and deleting models from touching the index. Default `after-commit`. */
  readonly sync?: 'after-commit' | 'off'
  /**
   * `report` (default): a failed index write is logged and the request goes on (the row *is*
   * saved; `node strut search:import` repairs the index). `throw`: the error reaches the caller.
   */
  readonly onSyncError?: SyncErrorMode
  /** Rows per batch for `search:import`. Default 500. */
  readonly chunkSize?: number
}

const PREFIX = /^[A-Za-z0-9_-]{0,40}$/

/**
 * The search manager. Usually created by `SearchServiceProvider` from `config/search.ts`.
 *
 * @example
 * const manager = new SearchManager({ engine: new MemoryEngine() })
 * await runWithSearch(manager, () => Post.search('hello').get())
 */
export class SearchManager {
  /** The index-name prefix. */
  readonly prefix: string
  readonly sync: 'after-commit' | 'off'
  readonly onSyncError: SyncErrorMode
  readonly chunkSize: number
  readonly #engine: SearchEngine | (() => Promise<SearchEngine>)
  #resolved: Promise<SearchEngine> | undefined
  readonly #logger: Logger | (() => Logger) | undefined
  readonly #dispatcher: IndexDispatcher
  /** Indexes already created and configured, by name (settings are applied once per process). */
  readonly #ready = new Map<string, Promise<void>>()
  readonly #definitions = new Map<string, IndexDefinition>()
  readonly #warned = new Set<string>()

  constructor(options: SearchManagerOptions) {
    const prefix = options.prefix ?? ''
    if (!PREFIX.test(prefix))
      throw new SearchError('invalid_config', {
        detail: `the index prefix "${prefix}" may only use letters, digits, "_" and "-" (at most 40).`,
      })
    const chunkSize = options.chunkSize ?? 500
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 10_000)
      throw new SearchError('invalid_config', {
        detail: 'the import chunk size must be a whole number from 1 to 10000.',
      })
    this.prefix = prefix
    this.sync = options.sync ?? 'after-commit'
    this.onSyncError = options.onSyncError ?? 'report'
    this.chunkSize = chunkSize
    this.#engine = options.engine
    this.#logger = options.logger
    this.#dispatcher = options.dispatcher ?? syncDispatcher
  }

  /**
   * The engine (created on first use; a failed creation is retried on the next call).
   *
   * @example
   * const engine = await manager.engine()
   */
  engine(): Promise<SearchEngine> {
    if (typeof this.#engine !== 'function') return Promise.resolve(this.#engine)
    if (this.#resolved === undefined) {
      const created = this.#engine()
      this.#resolved = created
      created.catch(() => {
        if (this.#resolved === created) this.#resolved = undefined
      })
    }
    return this.#resolved
  }

  /**
   * The engine, with `index` created and configured (once per process and index).
   *
   * @example
   * const engine = await manager.ready(definition)
   */
  async ready(index: IndexDefinition): Promise<SearchEngine> {
    const engine = await this.engine()
    this.register(index)
    let setup = this.#ready.get(index.name)
    if (setup === undefined) {
      setup = engine.ensureIndex(index)
      this.#ready.set(index.name, setup)
      // A failed setup is retried next time instead of being remembered as done.
      setup.catch(() => {
        if (this.#ready.get(index.name) === setup) this.#ready.delete(index.name)
      })
    }
    await setup
    return engine
  }

  /** Forget that `index` was set up (after a flush that dropped it, or settings changed). */
  forget(index: string): void {
    this.#ready.delete(index)
  }

  /** The definition of an index this manager has used (for queue workers). */
  definition(index: string): IndexDefinition | undefined {
    return this.#definitions.get(index)
  }

  /**
   * Hand a job to the dispatcher. Failures follow {@link SearchManagerOptions.onSyncError}.
   *
   * @example
   * await manager.dispatch({ index: 'posts', operation: 'remove', documents: [], keys: ['7'] })
   */
  async dispatch(job: IndexJob): Promise<void> {
    try {
      await this.#dispatcher.dispatch(job, (next) => this.process(next))
    } catch (error) {
      this.syncFailed(error, {
        index: job.index,
        operation: job.operation,
        count: job.operation === 'upsert' ? job.documents.length : job.keys.length,
      })
    }
  }

  /**
   * A sync step failed after the database committed: rethrow (`onSyncError: 'throw'`) or log it
   * without document contents (`report`).
   *
   * @example
   * manager.syncFailed(error, { index: 'posts', operation: 'upsert' })
   */
  syncFailed(error: unknown, fields: Readonly<Record<string, unknown>>): void {
    if (this.onSyncError === 'throw') throw error
    this.logger()?.error(
      'search: writing to the index failed; run node strut search:import to repair it',
      { ...fields, error: describeError(error) },
    )
  }

  /**
   * Remember an index definition, so {@link SearchManager.process} can run jobs for it.
   *
   * @example
   * manager.register(definition)
   */
  register(index: IndexDefinition): void {
    this.#definitions.set(index.name, index)
  }

  /**
   * Run one job against the engine (what a queue worker calls).
   *
   * @example
   * await manager.process(job)
   */
  async process(job: IndexJob): Promise<void> {
    const index = this.#definitions.get(job.index)
    if (index === undefined)
      throw new SearchError('engine_failed', {
        engine: 'search',
        action: `write to "${job.index}"`,
        detail: 'this process has not loaded the model of that index yet.',
      })
    const engine = await this.ready(index)
    if (job.operation === 'upsert') await engine.upsert(index, job.documents)
    else await engine.remove(index, job.keys)
  }

  /** Log a warning once per `key` (e.g. one per model for a sync inside a foreign transaction). */
  warnOnce(key: string, message: string, fields: Readonly<Record<string, unknown>>): void {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    this.logger()?.warn(message, fields)
  }

  /** The logger, or `undefined` when none was given. */
  logger(): Logger | undefined {
    const logger = this.#logger
    return typeof logger === 'function' ? logger() : logger
  }

  /**
   * Close the engine's connections (the provider calls this on shutdown).
   *
   * @example
   * await manager.close()
   */
  async close(): Promise<void> {
    const pending =
      typeof this.#engine === 'function' ? this.#resolved : Promise.resolve(this.#engine)
    if (pending === undefined) return
    const engine = await pending.catch(() => undefined)
    await engine?.close?.()
  }
}

/** An error as safe log fields: name, code and message only (never a stack with URLs or keys). */
function describeError(error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof Error)) return { message: String(error) }
  const code = (error as { code?: unknown }).code
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// The current manager
// ---------------------------------------------------------------------------------------------

/**
 * The container token `SearchServiceProvider` binds the app's manager to.
 *
 * @example
 * app.make(SearchManagerToken).engine()
 */
export const SearchManagerToken: Token<SearchManager> = token<SearchManager>(
  'strutvane.search.manager',
)

const scoped = new AsyncLocalStorage<SearchManager>()
let processWide: SearchManager | undefined

/**
 * Run `work` with `manager` as the current search manager (tests, scripts, queue workers).
 *
 * @example
 * await runWithSearch(new SearchManager({ engine: new MemoryEngine() }), () => Post.search('a').get())
 */
export function runWithSearch<TResult>(manager: SearchManager, work: () => TResult): TResult {
  return scoped.run(manager, work)
}

/**
 * Set (or clear, with `undefined`) the process-wide manager used outside an app.
 *
 * @example
 * useSearch(new SearchManager({ engine: new DatabaseEngine() }))
 */
export function useSearch(manager: SearchManager | undefined): void {
  processWide = manager
}

/**
 * The current manager, or `undefined` when search is not set up here.
 *
 * @example
 * const manager = maybeCurrentSearch()
 */
export function maybeCurrentSearch(): SearchManager | undefined {
  const own = scoped.getStore()
  if (own !== undefined) return own
  const container = currentContainer()
  if (container?.has(SearchManagerToken) === true) return container.make(SearchManagerToken)
  return processWide
}

/**
 * The current manager; `SearchError('not_configured')` when there is none.
 *
 * @example
 * const engine = await currentSearch().engine()
 */
export function currentSearch(): SearchManager {
  const manager = maybeCurrentSearch()
  if (manager === undefined) throw new SearchError('not_configured')
  return manager
}

interface ContainerLike {
  has(key: Token<unknown>): boolean
  make<TValue>(key: Token<TValue>): TValue
}

/** The running application's container, if code runs inside an app (request, command, app.run). */
function currentContainer(): ContainerLike | undefined {
  try {
    return app().container
  } catch (error) {
    if (isBootError(error) && error.code === 'no_current_application') return undefined
    throw error
  }
}

/**
 * `@strutvane/search/meilisearch`: the Meilisearch engine, on the official `meilisearch` client
 * (MIT, no dependencies of its own; an optional peer of this package, so install it next to it).
 *
 * - **Index settings** are applied by `ensureIndex` once per process: the searchable attributes
 *   in the declared order (Meilisearch ranks earlier ones higher), the filterable ones plus the
 *   tenant field, the sortable ones, and `displayedAttributes: ['id']`, so even a direct query to
 *   the server returns keys, never field values.
 * - **Writes wait for their task** (`waitForTasks`, default `true`): search after save then sees
 *   the change, and a rejected task (a bad document) becomes an error instead of passing silently.
 * - **Errors** become `SearchError('engine_failed')` with Meilisearch's error code and message;
 *   the client's own error (which carries the request) never escapes, and the key is never logged.
 *
 * @module
 */
import { type EnqueuedTaskPromise, Meilisearch, MeilisearchApiError } from 'meilisearch'
import type {
  EngineQuery,
  EngineResult,
  IndexDefinition,
  SearchDocument,
  SearchEngine,
} from '../contract.ts'
import { SearchError } from '../errors.ts'
import { meiliFilter, meiliSort } from '../filters.ts'

/** Options for {@link MeilisearchEngine}. */
export interface MeilisearchEngineOptions {
  /** The server URL (`MEILISEARCH_HOST`). */
  readonly host: string
  /** The admin or a scoped key (`MEILISEARCH_KEY`). */
  readonly apiKey?: string
  /** Milliseconds per request. Default 5000. */
  readonly timeoutMs?: number
  /** Wait for each write's task to finish (and fail on a failed task). Default `true`. */
  readonly waitForTasks?: boolean
  /** A custom fetch (tests). */
  readonly httpClient?: (input: string | URL | Request, init?: RequestInit) => Promise<unknown>
}

/**
 * The Meilisearch engine.
 *
 * @example
 * new MeilisearchEngine({ host: 'http://127.0.0.1:7700', apiKey: process.env.MEILISEARCH_KEY })
 */
export class MeilisearchEngine implements SearchEngine {
  readonly name: string = 'meilisearch'
  readonly keepsIndex: boolean = true
  readonly #client: Meilisearch
  readonly #wait: boolean
  readonly #timeoutMs: number

  constructor(options: MeilisearchEngineOptions) {
    this.#timeoutMs = options.timeoutMs ?? 5000
    this.#wait = options.waitForTasks ?? true
    this.#client = new Meilisearch({
      host: options.host,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      timeout: this.#timeoutMs,
      ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
    })
  }

  async ensureIndex(index: IndexDefinition): Promise<void> {
    await this.#call('create the index', async () => {
      // Waited for even when writes aren't: the settings below need the index to exist.
      const created = await this.#client
        .createIndex(index.name, { primaryKey: 'id' })
        .waitTask({ timeout: this.#taskTimeout() })
      if (created.status === 'failed' && created.error?.code !== 'index_already_exists')
        throw taskError(created.error)
    })
    const filterable = index.fields.filter((field) => field.filterable).map((field) => field.name)
    if (index.tenantField !== undefined) filterable.push(index.tenantField)
    await this.#write('apply the index settings', true, () =>
      this.#client.index(index.name).updateSettings({
        searchableAttributes: index.fields
          .filter((field) => field.searchable)
          .map((field) => field.name),
        filterableAttributes: filterable,
        sortableAttributes: index.fields
          .filter((field) => field.sortable)
          .map((field) => field.name),
        displayedAttributes: ['id'],
      }),
    )
  }

  async upsert(index: IndexDefinition, documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return
    await this.#write('index documents', this.#wait, () =>
      this.#client.index(index.name).addDocuments([...documents], { primaryKey: 'id' }),
    )
  }

  async remove(index: IndexDefinition, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return
    await this.#write('remove documents', this.#wait, () =>
      this.#client.index(index.name).deleteDocuments([...keys]),
    )
  }

  async search(index: IndexDefinition, query: EngineQuery): Promise<EngineResult> {
    return this.#call('search', async () => {
      const filter = meiliFilter(query.filters)
      const sort = meiliSort(query.sort)
      const response = await this.#client.index(index.name).search(query.text, {
        limit: query.limit,
        offset: query.offset,
        attributesToRetrieve: ['id'],
        ...(filter === undefined ? {} : { filter }),
        ...(sort.length === 0 ? {} : { sort }),
      })
      const keys = response.hits.map((hit) => String((hit as { id?: unknown }).id))
      return { keys, total: response.estimatedTotalHits ?? keys.length }
    })
  }

  async flush(index: IndexDefinition): Promise<void> {
    await this.#write('empty the index', true, () =>
      this.#client.index(index.name).deleteAllDocuments(),
    )
  }

  /** How long to wait for a task: a few request timeouts (indexing a batch takes a while). */
  #taskTimeout(): number {
    return this.#timeoutMs * 6
  }

  async #write(action: string, wait: boolean, start: () => EnqueuedTaskPromise): Promise<void> {
    await this.#call(action, async () => {
      const enqueued = start()
      if (!wait) {
        await enqueued
        return
      }
      const task = await enqueued.waitTask({ timeout: this.#taskTimeout() })
      if (task.status === 'failed') throw taskError(task.error)
    })
  }

  async #call<TResult>(action: string, work: () => Promise<TResult>): Promise<TResult> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof SearchError) throw error
      throw new SearchError('engine_failed', {
        engine: 'meilisearch',
        action,
        detail: describe(error),
      })
    }
  }
}

/** A failed task's error as a SearchError (the code and message Meilisearch gave). */
function taskError(
  error: { readonly code?: string; readonly message?: string } | null | undefined,
): SearchError {
  return new SearchError('engine_failed', {
    engine: 'meilisearch',
    action: 'finish a task',
    detail: `${error?.code ?? 'unknown'}: ${truncate(error?.message ?? 'no message')}`,
  })
}

/** What went wrong, without the request (URL, headers) the client's errors carry. */
function describe(error: unknown): string {
  if (error instanceof MeilisearchApiError)
    return `${error.cause?.code ?? 'api_error'}: ${truncate(error.cause?.message ?? error.message)}`
  if (error instanceof Error) return truncate(`${error.name}: ${error.message}`)
  return 'unknown error'
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

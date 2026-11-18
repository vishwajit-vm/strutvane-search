/**
 * `Post.search('hello')`: the search builder (Laravel Scout's `Builder`).
 *
 * ```ts
 * const page = await Post.search(request.query.q)
 *   .where('status', 'published')
 *   .whereIn('author_id', [1, 2])
 *   .orderBy('published_on', 'desc')
 *   .query((q) => q.with('author'))
 *   .for(ctx.user)                      // re-check each hit with the post policy's view()
 *   .paginate(20, 2)
 * ```
 *
 * Everything that reaches the engine is validated here, at run time, against the model's index
 * definition: filter and sort fields against the `filterable`/`sortable` allow-lists, values
 * against the field types, page sizes against the limits. On a tenant model the tenant condition
 * is added here from the active tenant (never from the caller), and a search without an active
 * tenant fails closed with `tenant_required`.
 *
 * @module
 */
import type { AuthUser } from '@strutvane/framework'
import { currentTenant } from '@strutvane/framework/database'
import type { EngineQuery, FilterCondition, SortSpec } from './contract.ts'
import { MAX_PER_PAGE } from './definition.ts'
import { SearchError } from './errors.ts'
import { filterCondition, sortSpec, tenantCondition } from './filters.ts'
import { type Authorization, type HydrateQuery, hydrate, type SearchPolicy } from './hydrate.ts'
import { currentSearch } from './manager.ts'
import { indexFor, type SearchableModel } from './settings.ts'

/** Longest search text accepted (characters). */
export const MAX_SEARCH_TEXT = 512

/** Deepest result a page may reach (`(page - 1) * perPage`): engines refuse deep paging anyway. */
export const MAX_OFFSET = 10_000

/** One page of results (the ORM's `Page` shape). */
export interface SearchPage<TModel> {
  readonly data: TModel[]
  /** Matches in the index (rows a policy or constraint removes are not subtracted). */
  readonly total: number
  readonly perPage: number
  readonly currentPage: number
  readonly lastPage: number
}

interface PendingFilter {
  readonly field: string
  readonly operator: string
  readonly value: unknown
}

/**
 * A search on one model. Methods return the builder, so calls chain; nothing runs until
 * `get()`, `paginate()` or `keys()`.
 *
 * @example
 * const posts = await Post.search('release notes').where('status', 'published').get()
 */
export class SearchBuilder<TModel extends object> {
  readonly #model: SearchableModel
  readonly #text: string
  readonly #filters: PendingFilter[] = []
  readonly #sort: { readonly field: string; readonly direction: string }[] = []
  #constrain: ((query: HydrateQuery) => void) | undefined
  #authorization:
    | { readonly user: AuthUser | null; readonly policy?: SearchPolicy<TModel> }
    | undefined
  #take: number | undefined

  constructor(model: SearchableModel, text: unknown) {
    this.#model = model
    this.#text = searchText(text)
  }

  /**
   * Keep results whose `field` equals `value` (`null` matches a missing value).
   *
   * @example
   * Post.search('a').where('status', 'published')
   */
  where(field: string, value: unknown): this {
    return this.filter(field, 'eq', value)
  }

  /**
   * Keep results whose `field` is not `value`.
   *
   * @example
   * Post.search('a').whereNot('status', 'archived')
   */
  whereNot(field: string, value: unknown): this {
    return this.filter(field, 'ne', value)
  }

  /**
   * Keep results whose `field` is one of `values`.
   *
   * @example
   * Post.search('a').whereIn('author_id', [1, 2, 3])
   */
  whereIn(field: string, values: readonly unknown[]): this {
    return this.filter(field, 'in', values)
  }

  /**
   * Any filter: `eq`, `ne`, `gt`, `gte`, `lt`, `lte` or `in`. Ordering operators work on number
   * and date fields.
   *
   * @example
   * Post.search('a').filter('published_on', 'gte', new Date('2026-01-01'))
   */
  filter(field: string, operator: string, value: unknown): this {
    this.#filters.push({ field, operator, value })
    return this
  }

  /**
   * Sort by a `sortable` field instead of relevance (several calls sort by several fields).
   *
   * @example
   * Post.search('').orderBy('published_on', 'desc')
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.#sort.push({ field, direction })
    return this
  }

  /**
   * Narrow or enrich the database query that loads the hits: eager loads, `wherePolicy`, extra
   * conditions. Rows it excludes are dropped from the results.
   *
   * @example
   * Post.search('a').query((q) => q.with('author'))
   */
  query(constrain: (query: HydrateQuery) => void): this {
    this.#constrain = constrain
    return this
  }

  /**
   * Re-check every result with a policy's `view(user, model)` (deny by default): the policy given
   * here, else the `policy` in the Searchable options, else the search fails with
   * `policy_required` (it never silently skips the check).
   *
   * @example
   * Post.search('a').for(ctx.user)
   * Post.search('a').for(ctx.user, new PostPolicy())
   */
  for(user: AuthUser | null, policy?: SearchPolicy<TModel>): this {
    this.#authorization = policy === undefined ? { user } : { user, policy }
    return this
  }

  /**
   * How many results `get()` returns (1–100). Default: the model's `perPage`.
   *
   * @example
   * Post.search('a').take(5).get()
   */
  take(count: number): this {
    this.#take = pageSize(count)
    return this
  }

  /**
   * The first results (see {@link SearchBuilder.take}), as models in result order.
   *
   * @example
   * const posts = await Post.search('hello').get()
   */
  async get(): Promise<TModel[]> {
    const limit = this.#take ?? this.#perPage()
    return (await this.#run(limit, 0)).data
  }

  /**
   * One page of results.
   *
   * @example
   * const page = await Post.search('hello').paginate(20, 2)
   */
  async paginate(perPage?: number, page = 1): Promise<SearchPage<TModel>> {
    const size = perPage === undefined ? this.#perPage() : pageSize(perPage)
    if (!Number.isSafeInteger(page) || page < 1)
      throw new SearchError('invalid_page', { detail: `pages start at 1; got ${String(page)}.` })
    const offset = (page - 1) * size
    if (offset > MAX_OFFSET)
      throw new SearchError('invalid_page', {
        detail: `results deeper than ${MAX_OFFSET} can't be paged to; narrow the search instead.`,
      })
    const { data, total } = await this.#run(size, offset)
    return {
      data,
      total,
      perPage: size,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / size)),
    }
  }

  /**
   * The engine's matching keys for the first results, without loading models (no policy check:
   * don't show these to a user).
   *
   * @example
   * const keys = await Post.search('hello').keys()
   */
  async keys(): Promise<string[]> {
    const { query, run } = await this.#prepare(this.#take ?? this.#perPage(), 0)
    return [...(await run(query)).keys]
  }

  #perPage(): number {
    return this.#model.settings.perPage ?? 15
  }

  async #prepare(limit: number, offset: number) {
    const manager = currentSearch()
    const index = indexFor(this.#model, manager)
    const filters: FilterCondition[] = this.#filters.map((pending) =>
      filterCondition(index, pending.field, pending.operator, pending.value),
    )
    if (index.tenantField !== undefined) {
      const tenant = currentTenant()
      if (tenant === undefined) throw new SearchError('tenant_required', { model: index.model })
      filters.unshift(tenantCondition(index, tenant))
    }
    const sort: SortSpec[] = this.#sort.map((spec) => sortSpec(index, spec.field, spec.direction))
    const engine = await manager.ready(index)
    const query: EngineQuery = { text: this.#text, filters, sort, limit, offset }
    return { index, query, run: (q: EngineQuery) => engine.search(index, q) }
  }

  async #run(limit: number, offset: number): Promise<{ data: TModel[]; total: number }> {
    const authorization = this.#resolveAuthorization()
    const { index, query, run } = await this.#prepare(limit, offset)
    const result = await run(query)
    const data = await hydrate<TModel>(
      index,
      this.#model.runtime,
      result.keys,
      this.#constrain,
      authorization,
    )
    return { data, total: result.total }
  }

  #resolveAuthorization(): Authorization<TModel> | undefined {
    const requested = this.#authorization
    if (requested === undefined) return undefined
    const policy =
      requested.policy ?? (this.#model.settings.policy as SearchPolicy<TModel> | undefined)
    if (policy === undefined)
      throw new SearchError('policy_required', { model: this.#model.runtime.name })
    return { user: requested.user, policy }
  }
}

/** Validate the search text: a string (or nothing), at most {@link MAX_SEARCH_TEXT} characters. */
function searchText(text: unknown): string {
  if (text === undefined || text === null) return ''
  if (typeof text !== 'string')
    throw new SearchError('invalid_query', { detail: 'the search text must be a string.' })
  const trimmed = text.trim()
  if (trimmed.length > MAX_SEARCH_TEXT)
    throw new SearchError('invalid_query', {
      detail: `it is longer than ${MAX_SEARCH_TEXT} characters.`,
    })
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed))
    throw new SearchError('invalid_query', { detail: 'it contains control characters.' })
  return trimmed
}

function pageSize(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PER_PAGE)
    throw new SearchError('invalid_page', {
      detail: `a page holds 1 to ${MAX_PER_PAGE} results; got ${String(count)}.`,
    })
  return count
}

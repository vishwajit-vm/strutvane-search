/**
 * `@strutvane/search/typesense`: the Typesense engine, on a small built-in client over `fetch`.
 *
 * Why not the official `typesense` package: it pulls in axios, loglevel and tslib, and wants
 * `@babel/runtime` as a peer. Five REST calls don't justify four more packages in every app's
 * supply chain, so this engine speaks the documented HTTP API directly (Typesense 27+; tested
 * against 30.2): collections, documents import (upsert), delete, search.
 *
 * - **Schema**: one collection per index; every declared field is typed (`string`, `int64`,
 *   `float`, `bool`; dates as `int64` epoch milliseconds) and optional; filterable fields are
 *   facets, sortable fields are sortable. Fields added to the model later are added to the
 *   collection; a field whose type changed needs `node strut search:flush` + `search:import`.
 * - **Requests** carry the key in the `X-TYPESENSE-API-KEY` header only, have a timeout, and never
 *   follow redirects (a redirect could send the key elsewhere).
 * - **Errors** become `SearchError('engine_failed')` with the status and Typesense's message;
 *   the key never appears in an error or a log.
 *
 * @module
 */
import type {
  EngineQuery,
  EngineResult,
  FieldType,
  IndexDefinition,
  SearchDocument,
  SearchEngine,
} from '../contract.ts'
import { SearchError } from '../errors.ts'
import { typesenseFilter, typesenseSort } from '../filters.ts'

/** Options for {@link TypesenseEngine}. */
export interface TypesenseEngineOptions {
  /** `protocol://host:port` (from `TYPESENSE_PROTOCOL`, `TYPESENSE_HOST`, `TYPESENSE_PORT`). */
  readonly url: string
  /** `TYPESENSE_API_KEY`. */
  readonly apiKey: string
  /** Milliseconds per request. Default 5000. */
  readonly timeoutMs?: number
  /** A custom fetch (tests). */
  readonly fetch?: typeof fetch
}

const TYPES: Readonly<Record<FieldType, string>> = {
  string: 'string',
  int: 'int64',
  float: 'float',
  bool: 'bool',
  datetime: 'int64',
}

interface CollectionField {
  readonly name: string
  readonly type: string
  readonly facet?: boolean
  readonly sort?: boolean
  readonly optional?: boolean
  readonly index?: boolean
}

/** Keys Typesense accepts in a delete filter: ours are integers or UUID-like strings. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/

/** Most keys removed in one request (the filter is a URL parameter). */
const DELETE_BATCH = 100

/**
 * The Typesense engine.
 *
 * @example
 * new TypesenseEngine({ url: 'http://127.0.0.1:8108', apiKey: process.env.TYPESENSE_API_KEY ?? '' })
 */
export class TypesenseEngine implements SearchEngine {
  readonly name: string = 'typesense'
  readonly keepsIndex: boolean = true
  readonly #url: string
  readonly #apiKey: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: TypesenseEngineOptions) {
    if (options.apiKey === '')
      throw new SearchError('invalid_config', { detail: 'TYPESENSE_API_KEY is empty.' })
    this.#url = options.url.replace(/\/$/, '')
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 5000
    this.#fetch = options.fetch ?? fetch
  }

  async ensureIndex(index: IndexDefinition): Promise<void> {
    const wanted = collectionFields(index)
    const path = `/collections/${encodeURIComponent(index.name)}`
    const existing = await this.#request('read the collection', 'GET', path, undefined, [404])
    if (existing.status === 404) {
      const created = await this.#request(
        'create the collection',
        'POST',
        '/collections',
        JSON.stringify({ name: index.name, fields: wanted }),
        [409],
      )
      // 409: another process created it in between; fall through to the field check.
      if (created.status !== 409) return
    }
    const current = await this.#request('read the collection', 'GET', path)
    const fields = readFields(current.body)
    const missing = wanted.filter((field) => !fields.has(field.name))
    if (missing.length > 0)
      await this.#request('add fields', 'PATCH', path, JSON.stringify({ fields: missing }))
  }

  async upsert(index: IndexDefinition, documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return
    const body = documents.map((document) => JSON.stringify(withoutNulls(document))).join('\n')
    const response = await this.#request(
      'index documents',
      'POST',
      `/collections/${encodeURIComponent(index.name)}/documents/import?action=upsert`,
      body,
      [],
      'text/plain',
    )
    // The import answers 200 with one JSON line per document; a document can fail on its own.
    for (const line of String(response.text).split('\n')) {
      if (line.trim() === '') continue
      const result = parseJson(line)
      if (result !== undefined && Reflect.get(result, 'success') === false)
        throw new SearchError('engine_failed', {
          engine: 'typesense',
          action: 'index a document',
          detail: truncate(String(Reflect.get(result, 'error') ?? 'rejected')),
        })
    }
  }

  async remove(index: IndexDefinition, keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH)
      for (const key of batch)
        if (!SAFE_KEY.test(key))
          throw new SearchError('unsafe_filter_value', {
            field: 'id',
            engine: 'typesense',
            detail: 'a key with characters other than letters, digits, "_" and "-"',
          })
      const filter = encodeURIComponent(`id:[${batch.join(',')}]`)
      await this.#request(
        'remove documents',
        'DELETE',
        `/collections/${encodeURIComponent(index.name)}/documents?filter_by=${filter}`,
        undefined,
        [404],
      )
    }
  }

  async search(index: IndexDefinition, query: EngineQuery): Promise<EngineResult> {
    const params = new URLSearchParams({
      q: query.text === '' ? '*' : query.text,
      query_by: index.fields
        .filter((field) => field.searchable)
        .map((field) => field.name)
        .join(','),
      include_fields: 'id',
      limit: String(query.limit),
      offset: String(query.offset),
      // Every word must match, as on every other engine (Typesense drops words when few hits). Not combined with
      // exhaustive_search, which ignores this threshold.
      drop_tokens_threshold: '0',
    })
    const filter = typesenseFilter(query.filters)
    if (filter !== undefined) params.set('filter_by', filter)
    const sort = typesenseSort(query.sort)
    if (sort !== undefined) params.set('sort_by', sort)
    const response = await this.#request(
      'search',
      'GET',
      `/collections/${encodeURIComponent(index.name)}/documents/search?${params.toString()}`,
    )
    const hits: unknown = Reflect.get(asObject(response.body), 'hits')
    const keys = (Array.isArray(hits) ? hits : []).map((hit: unknown) =>
      String(Reflect.get(asObject(Reflect.get(asObject(hit), 'document')), 'id')),
    )
    const found: unknown = Reflect.get(asObject(response.body), 'found')
    return { keys, total: typeof found === 'number' ? found : keys.length }
  }

  async flush(index: IndexDefinition): Promise<void> {
    // Typesense deletes "every document" only through a filter; dropping and re-creating the
    // collection is the clean equivalent and keeps the schema in step with the model.
    await this.#request(
      'drop the collection',
      'DELETE',
      `/collections/${encodeURIComponent(index.name)}`,
      undefined,
      [404],
    )
    await this.ensureIndex(index)
  }

  async #request(
    action: string,
    method: string,
    path: string,
    body?: string,
    allowed: readonly number[] = [],
    contentType = 'application/json',
  ): Promise<{ readonly status: number; readonly body: unknown; readonly text: string }> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method,
        headers: {
          'X-TYPESENSE-API-KEY': this.#apiKey,
          ...(body === undefined ? {} : { 'Content-Type': contentType }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new SearchError('engine_failed', {
        engine: 'typesense',
        action,
        detail:
          error instanceof Error && error.name === 'TimeoutError'
            ? `no answer within ${this.#timeoutMs} ms`
            : `the server could not be reached (${error instanceof Error ? error.name : 'error'})`,
      })
    }
    const text = await response.text()
    const parsed = parseJson(text)
    if (response.ok || allowed.includes(response.status))
      return { status: response.status, body: parsed, text }
    const message = parsed === undefined ? '' : String(Reflect.get(parsed, 'message') ?? '')
    throw new SearchError('engine_failed', {
      engine: 'typesense',
      action,
      detail: `HTTP ${response.status}${message === '' ? '' : `: ${truncate(message)}`}`,
    })
  }
}

/** The collection fields for an index: declared fields plus the tenant field. */
export function collectionFields(index: IndexDefinition): CollectionField[] {
  const fields: CollectionField[] = index.fields.map((field) => ({
    name: field.name,
    type: TYPES[field.type],
    facet: field.filterable,
    sort: field.sortable,
    optional: true,
    index: true,
  }))
  if (index.tenantField !== undefined)
    fields.push({
      name: index.tenantField,
      type: 'string',
      facet: true,
      optional: false,
      index: true,
    })
  return fields
}

/** Typesense rejects `null` for typed fields; a missing optional field means the same. */
function withoutNulls(document: SearchDocument): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(document)) if (value !== null) copy[key] = value
  return copy
}

function readFields(body: unknown): Set<string> {
  const fields: unknown = Reflect.get(asObject(body), 'fields')
  const names = new Set<string>()
  if (Array.isArray(fields))
    for (const field of fields) {
      const name: unknown = Reflect.get(asObject(field), 'name')
      if (typeof name === 'string') names.add(name)
    }
  return names
}

function parseJson(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

function asObject(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

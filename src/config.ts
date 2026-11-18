/**
 * `config/search.ts`: the search settings, validated, and the engine they describe.
 *
 * ```ts
 * export default defineConfig((env) => ({
 *   driver: env.string('SEARCH_DRIVER', 'database'),
 *   prefix: env.string('SEARCH_PREFIX', ''),
 *   meilisearch: { host: env.string('MEILISEARCH_HOST', 'http://127.0.0.1:7700'), key: env.optional('MEILISEARCH_KEY') },
 *   typesense: { host: env.string('TYPESENSE_HOST', '127.0.0.1'), port: env.integer('TYPESENSE_PORT', 8108), … },
 * }))
 * ```
 *
 * Failure scenarios: an unknown driver, a host that is not a plain `http(s)` URL (or carries a
 * user name or password, which would end up in logs), a missing key for a server engine outside
 * local development, or a bad number: each fails the boot naming the setting, because a typo must
 * never silently send data to the wrong place.
 *
 * @module
 */
import type { SearchEngine } from './contract.ts'
import { DatabaseEngine } from './engines/database.ts'
import { MemoryEngine } from './engines/memory.ts'
import { SearchError } from './errors.ts'
import type { SyncErrorMode } from './manager.ts'

/** The engines search can use. */
export const SEARCH_DRIVERS: readonly SearchDriver[] = [
  'database',
  'memory',
  'meilisearch',
  'typesense',
]

/** An engine name (`SEARCH_DRIVER`). */
export type SearchDriver = 'database' | 'memory' | 'meilisearch' | 'typesense'

/** Validated search settings. */
export interface SearchConfig {
  readonly driver: SearchDriver
  readonly prefix: string
  readonly sync: 'after-commit' | 'off'
  readonly onSyncError: SyncErrorMode
  readonly chunkSize: number
  /** Milliseconds before a request to a search server is abandoned. */
  readonly timeoutMs: number
  readonly meilisearch: {
    readonly host: string
    readonly key: string | undefined
    readonly wait: boolean
  }
  readonly typesense: { readonly url: string; readonly apiKey: string | undefined }
}

const DEFAULTS = {
  meilisearchHost: 'http://127.0.0.1:7700',
  typesenseHost: '127.0.0.1',
  typesensePort: 8108,
  typesenseProtocol: 'http',
  timeoutMs: 5000,
  chunkSize: 500,
} as const

/**
 * Validate the raw `config('search')` value (missing keys take their defaults).
 *
 * @example
 * const config = resolveSearchConfig({ driver: 'meilisearch', meilisearch: { host: 'http://127.0.0.1:7700' } })
 */
export function resolveSearchConfig(raw: unknown = {}): SearchConfig {
  const root = record(raw, 'search')
  const driver = oneOf(root, 'driver', SEARCH_DRIVERS, 'database')
  const meili = record(root['meilisearch'] ?? {}, 'meilisearch')
  const typesense = record(root['typesense'] ?? {}, 'typesense')
  const protocol = oneOf(
    typesense,
    'protocol',
    ['http', 'https'] as const,
    DEFAULTS.typesenseProtocol,
  )
  const host = text(typesense, 'host', DEFAULTS.typesenseHost)
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/.test(host))
    throw invalid('typesense.host must be a host name or IP address (no scheme, port or path).')
  const port = integer(typesense, 'port', DEFAULTS.typesensePort, 1, 65_535)
  return {
    driver,
    prefix: text(root, 'prefix', ''),
    sync: oneOf(root, 'sync', ['after-commit', 'off'] as const, 'after-commit'),
    onSyncError: oneOf(root, 'onSyncError', ['report', 'throw'] as const, 'report'),
    chunkSize: integer(root, 'chunkSize', DEFAULTS.chunkSize, 1, 10_000),
    timeoutMs: integer(root, 'timeoutMs', DEFAULTS.timeoutMs, 100, 120_000),
    meilisearch: {
      host: serverUrl(text(meili, 'host', DEFAULTS.meilisearchHost), 'meilisearch.host'),
      key: optionalText(meili, 'key'),
      wait: bool(meili, 'wait', true),
    },
    typesense: {
      url: serverUrl(`${protocol}://${host}:${port}`, 'typesense.host'),
      apiKey: optionalText(typesense, 'apiKey'),
    },
  }
}

/**
 * Create the engine `config` names. The Meilisearch and Typesense engines are loaded only when
 * chosen, so an app never loads a client it doesn't use. A server engine without a key is refused
 * outside local development (an open search server would expose every indexed field).
 *
 * @example
 * const engine = await createEngine(resolveSearchConfig({ driver: 'memory' }))
 */
export async function createEngine(
  config: SearchConfig,
  options: { readonly environment?: string } = {},
): Promise<SearchEngine> {
  const local = ['local', 'development', 'testing', 'test'].includes(
    options.environment ?? 'production',
  )
  switch (config.driver) {
    case 'database':
      return new DatabaseEngine()
    case 'memory':
      return new MemoryEngine()
    case 'meilisearch': {
      if (config.meilisearch.key === undefined && !local) throw missingKey('MEILISEARCH_KEY')
      const { MeilisearchEngine } = await import('./engines/meilisearch.ts')
      return new MeilisearchEngine({
        host: config.meilisearch.host,
        ...(config.meilisearch.key === undefined ? {} : { apiKey: config.meilisearch.key }),
        timeoutMs: config.timeoutMs,
        waitForTasks: config.meilisearch.wait,
      })
    }
    case 'typesense': {
      if (config.typesense.apiKey === undefined) throw missingKey('TYPESENSE_API_KEY')
      const { TypesenseEngine } = await import('./engines/typesense.ts')
      return new TypesenseEngine({
        url: config.typesense.url,
        apiKey: config.typesense.apiKey,
        timeoutMs: config.timeoutMs,
      })
    }
  }
}

function missingKey(name: string): SearchError {
  return invalid(
    `${name} is empty. A search server without a key lets anyone read every indexed field; set ${name} in .env (Typesense always needs one).`,
  )
}

function invalid(detail: string): SearchError {
  return new SearchError('invalid_config', { detail })
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid(`${path} must be an object.`)
  return value as Readonly<Record<string, unknown>>
}

function text(source: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw invalid(`${key} must be a string.`)
  return value.trim()
}

function optionalText(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = text(source, key, '')
  return value === '' ? undefined : value
}

function bool(source: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false.`)
  return value
}

function integer(
  source: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw invalid(`${key} must be a whole number from ${min} to ${max}.`)
  return value
}

function oneOf<const TValue extends string>(
  source: Readonly<Record<string, unknown>>,
  key: string,
  values: readonly TValue[],
  fallback: TValue,
): TValue {
  const value = source[key]
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    throw invalid(`${key} must be one of ${values.join(', ')}; got ${JSON.stringify(value)}.`)
  return value as TValue
}

/** A plain http(s) origin (optionally with a path): no credentials, query or fragment. */
function serverUrl(value: string, setting: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid(`${setting} is not a URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw invalid(`${setting} must start with http:// or https://.`)
  if (url.username !== '' || url.password !== '')
    throw invalid(
      `${setting} must not contain a user name or password; put the key in its own setting.`,
    )
  if (url.search !== '' || url.hash !== '')
    throw invalid(`${setting} must not have a query or fragment.`)
  return url.href.replace(/\/$/, '')
}

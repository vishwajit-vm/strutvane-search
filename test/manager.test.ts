/**
 * The manager and the config: lazy engine creation with retry, index set-up once (and again after
 * a failure), sync failures reported without document contents or thrown, config validation and
 * engine selection (keys required outside local development).
 */
import { describe, expect, test, vi } from 'vitest'
import { MeilisearchEngine } from '../src/engines/meilisearch.ts'
import { TypesenseEngine } from '../src/engines/typesense.ts'
import {
  createEngine,
  currentSearch,
  DatabaseEngine,
  type IndexDefinition,
  type IndexJob,
  MemoryEngine,
  maybeCurrentSearch,
  resolveSearchConfig,
  runWithSearch,
  SearchManager,
  syncDispatcher,
  useSearch,
} from '../src/index.ts'

const index = {
  name: 'posts',
  model: 'Post',
  fields: [],
  tenantField: undefined,
  keyType: 'int',
  source: { table: 'posts', query: () => undefined },
} as unknown as IndexDefinition

const upsert: IndexJob = {
  index: 'posts',
  operation: 'upsert',
  documents: [{ id: '1', title: 'very private words' }],
  keys: [],
}

function logger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: () => true,
    flush: async () => undefined,
  }
}

describe('SearchManager', () => {
  test('creates the engine once, lazily, and retries after a failed creation', async () => {
    const engine = new MemoryEngine()
    const factory = vi
      .fn<() => Promise<MemoryEngine>>()
      .mockRejectedValueOnce(new Error('server down'))
      .mockResolvedValue(engine)
    const manager = new SearchManager({ engine: factory })
    expect(factory).not.toHaveBeenCalled()
    await expect(manager.engine()).rejects.toThrow('server down')
    await Promise.resolve()
    expect(await manager.engine()).toBe(engine)
    expect(await manager.engine()).toBe(engine)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  test('sets an index up once; a failed set-up is retried', async () => {
    const engine = new MemoryEngine()
    const ensure = vi
      .spyOn(engine, 'ensureIndex')
      .mockRejectedValueOnce(new Error('settings rejected'))
    const manager = new SearchManager({ engine })
    await expect(manager.ready(index)).rejects.toThrow('settings rejected')
    await Promise.resolve()
    await manager.ready(index)
    await manager.ready(index)
    expect(ensure).toHaveBeenCalledTimes(2)
    manager.forget('posts')
    await manager.ready(index)
    expect(ensure).toHaveBeenCalledTimes(3)
    expect(manager.definition('posts')).toBe(index)
  })

  test('process() runs jobs against the engine; unknown indexes are refused', async () => {
    const engine = new MemoryEngine()
    const manager = new SearchManager({ engine })
    await expect(manager.process(upsert)).rejects.toMatchObject({ code: 'engine_failed' })
    manager.register(index)
    await manager.process(upsert)
    expect(engine.size(index)).toBe(1)
    await manager.process({ index: 'posts', operation: 'remove', documents: [], keys: ['1'] })
    expect(engine.size(index)).toBe(0)
  })

  test('a failed write is logged without document contents (report) or rethrown (throw)', async () => {
    const engine = new MemoryEngine()
    vi.spyOn(engine, 'upsert').mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'econnrefused' }),
    )
    const log = logger()
    const reporting = new SearchManager({ engine, logger: () => log })
    reporting.register(index)
    await reporting.dispatch(upsert)
    expect(log.error).toHaveBeenCalledTimes(1)
    const fields = JSON.stringify(log.error.mock.calls[0])
    expect(fields).toContain('econnrefused')
    expect(fields).not.toContain('very private words')
    await reporting.dispatch({ ...upsert, operation: 'remove', keys: ['1'], documents: [] })
    reporting.syncFailed('not an error', { model: 'Post' })
    expect(JSON.stringify(log.error.mock.calls[1])).toContain('not an error')

    const throwing = new SearchManager({ engine, onSyncError: 'throw' })
    throwing.register(index)
    await expect(throwing.dispatch(upsert)).rejects.toThrow('boom')
    // Without a logger, reporting is silent rather than crashing.
    const silent = new SearchManager({ engine })
    silent.register(index)
    await expect(silent.dispatch(upsert)).resolves.toBeUndefined()
  })

  test('a custom dispatcher decides when jobs run (the queue seam)', async () => {
    const queued: IndexJob[] = []
    const manager = new SearchManager({
      engine: new MemoryEngine(),
      dispatcher: { dispatch: async (job) => void queued.push(job) },
    })
    await manager.dispatch(upsert)
    expect(queued).toEqual([upsert])
    expect(JSON.parse(JSON.stringify(queued[0]))).toEqual(upsert)
    const ran: IndexJob[] = []
    await syncDispatcher.dispatch(upsert, async (job) => void ran.push(job))
    expect(ran).toEqual([upsert])
  })

  test('warnOnce warns once per key; close() closes a created engine only', async () => {
    const log = logger()
    const engine = new MemoryEngine()
    const close = vi.fn(async () => undefined)
    Object.assign(engine, { close })
    const manager = new SearchManager({ engine: async () => engine, logger: log })
    manager.warnOnce('a', 'first', {})
    manager.warnOnce('a', 'again', {})
    manager.warnOnce('b', 'other', {})
    expect(log.warn).toHaveBeenCalledTimes(2)
    await manager.close()
    expect(close).not.toHaveBeenCalled()
    await manager.engine()
    await manager.close()
    expect(close).toHaveBeenCalledTimes(1)
    await new SearchManager({ engine }).close()
    expect(close).toHaveBeenCalledTimes(2)
    const failing = new SearchManager({ engine: () => Promise.reject(new Error('x')) })
    await failing.engine().catch(() => undefined)
    await expect(failing.close()).resolves.toBeUndefined()
  })

  test.each([[{ prefix: 'bad prefix' }], [{ chunkSize: 0 }], [{ chunkSize: 1.5 }]])(
    'refuses %j',
    (options) => {
      expect(() => new SearchManager({ engine: new MemoryEngine(), ...options })).toThrow(
        /invalid_config|prefix|chunk/,
      )
    },
  )
})

describe('the current manager', () => {
  test('runWithSearch wins over the process-wide one; none means not_configured', () => {
    const a = new SearchManager({ engine: new MemoryEngine() })
    const b = new SearchManager({ engine: new MemoryEngine() })
    expect(maybeCurrentSearch()).toBeUndefined()
    expect(() => currentSearch()).toThrow(/install:search/)
    useSearch(a)
    try {
      expect(currentSearch()).toBe(a)
      expect(runWithSearch(b, () => currentSearch())).toBe(b)
    } finally {
      useSearch(undefined)
    }
  })
})

describe('config/search.ts', () => {
  test('defaults', () => {
    expect(resolveSearchConfig()).toEqual({
      driver: 'database',
      prefix: '',
      sync: 'after-commit',
      onSyncError: 'report',
      chunkSize: 500,
      timeoutMs: 5000,
      meilisearch: { host: 'http://127.0.0.1:7700', key: undefined, wait: true },
      typesense: { url: 'http://127.0.0.1:8108', apiKey: undefined },
    })
  })

  test('every setting', () => {
    const config = resolveSearchConfig({
      driver: 'typesense',
      prefix: 'staging_',
      sync: 'off',
      onSyncError: 'throw',
      chunkSize: 100,
      timeoutMs: 1000,
      meilisearch: { host: 'https://search.example.com/', key: ' k ', wait: false },
      typesense: { host: 'ts.internal', port: 443, protocol: 'https', apiKey: 'xyz' },
    })
    expect(config).toMatchObject({
      driver: 'typesense',
      prefix: 'staging_',
      sync: 'off',
      onSyncError: 'throw',
      meilisearch: { host: 'https://search.example.com', key: 'k', wait: false },
      typesense: { url: 'https://ts.internal', apiKey: 'xyz' },
    })
  })

  test.each([
    [null, /must be an object/],
    [{ driver: 'elastic' }, /driver must be one of/],
    [{ driver: 7 }, /driver must be one of/],
    [{ prefix: 3 }, /prefix must be a string/],
    [{ chunkSize: 0 }, /chunkSize/],
    [{ timeoutMs: '5' }, /timeoutMs/],
    [{ meilisearch: [] }, /meilisearch must be an object/],
    [{ meilisearch: { host: 'not a url' } }, /not a URL/],
    [{ meilisearch: { host: 'ftp://x' } }, /http/],
    [{ meilisearch: { host: 'http://user:pass@x' } }, /user name or password/],
    [{ meilisearch: { host: 'http://x/?a=1' } }, /query or fragment/],
    [{ meilisearch: { wait: 'yes' } }, /true or false/],
    [{ typesense: { host: 'http://x' } }, /host name/],
    [{ typesense: { port: 70000 } }, /port/],
  ])('refuses %j', (raw, message) => {
    expect(() => resolveSearchConfig(raw)).toThrow(message)
  })

  test('createEngine picks the engine; server engines need their key outside local', async () => {
    expect(await createEngine(resolveSearchConfig())).toBeInstanceOf(DatabaseEngine)
    expect(await createEngine(resolveSearchConfig({ driver: 'memory' }))).toBeInstanceOf(
      MemoryEngine,
    )
    const meili = resolveSearchConfig({ driver: 'meilisearch' })
    await expect(createEngine(meili)).rejects.toThrow(/MEILISEARCH_KEY/)
    expect(await createEngine(meili, { environment: 'local' })).toBeInstanceOf(MeilisearchEngine)
    expect(
      await createEngine(resolveSearchConfig({ driver: 'meilisearch', meilisearch: { key: 'k' } })),
    ).toBeInstanceOf(MeilisearchEngine)
    const typesense = resolveSearchConfig({ driver: 'typesense' })
    await expect(createEngine(typesense, { environment: 'local' })).rejects.toThrow(
      /TYPESENSE_API_KEY/,
    )
    expect(
      await createEngine(resolveSearchConfig({ driver: 'typesense', typesense: { apiKey: 'k' } })),
    ).toBeInstanceOf(TypesenseEngine)
  })
})

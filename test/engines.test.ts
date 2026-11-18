/**
 * The server engines without a server: requests and failure handling against a stubbed HTTP
 * layer, so they are covered where Docker isn't available. What a failure looks like matters for
 * security too: errors carry the status and the server's message, never the key.
 */
import { describe, expect, test, vi } from 'vitest'
import type { IndexDefinition } from '../src/contract.ts'
import { MeilisearchEngine } from '../src/engines/meilisearch.ts'
import { collectionFields, TypesenseEngine } from '../src/engines/typesense.ts'
import { tenantCondition } from '../src/filters.ts'

const KEY = 'super-secret-key-123'

const index: IndexDefinition = {
  name: 'posts',
  model: 'Post',
  tenantField: '__tenant',
  keyType: 'int',
  source: { table: 'posts', query: () => undefined },
  fields: [
    {
      name: 'title',
      type: 'string',
      kind: 'string',
      searchable: true,
      filterable: false,
      sortable: true,
      nullable: false,
    },
    {
      name: 'views',
      type: 'int',
      kind: 'integer',
      searchable: false,
      filterable: true,
      sortable: true,
      nullable: true,
    },
  ],
}

const query = {
  text: '',
  filters: [tenantCondition(index, 't1')],
  sort: [{ field: 'views', direction: 'desc' as const }],
  limit: 10,
  offset: 0,
}

type Reply = { readonly status: number; readonly body: string }
type Handler = (method: string, url: URL, body: string | undefined) => Reply

/** A fetch that answers from `handler` and records every request. */
function stubFetch(handler: Handler) {
  const calls: {
    method: string
    url: URL
    body: string | undefined
    headers: Headers
    redirect?: string | undefined
  }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, url, body, headers: new Headers(init?.headers), redirect: init?.redirect })
    const reply = handler(method, url, body)
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const json = (status: number, value: unknown): Reply => ({ status, body: JSON.stringify(value) })

describe('TypesenseEngine', () => {
  test('creates a missing collection with typed fields and the tenant facet', async () => {
    const { fetch, calls } = stubFetch((method) =>
      method === 'GET' ? json(404, { message: 'Not Found' }) : json(201, {}),
    )
    const engine = new TypesenseEngine({ url: 'http://ts:8108/', apiKey: KEY, fetch })
    await engine.ensureIndex(index)
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /collections/posts',
      'POST /collections',
    ])
    expect(JSON.parse(calls[1]?.body ?? '{}').fields).toEqual(collectionFields(index))
    expect(calls[0]?.headers.get('x-typesense-api-key')).toBe(KEY)
    expect(calls[0]?.redirect).toBe('error')
    expect(collectionFields({ ...index, tenantField: undefined })).toHaveLength(2)
  })

  test('adds only missing fields to an existing collection; a create race is fine', async () => {
    let gets = 0
    const { fetch, calls } = stubFetch((method) => {
      if (method === 'GET')
        return (gets += 1) === 1
          ? json(404, {})
          : json(200, { fields: [{ name: 'title' }, { other: 1 }] })
      if (method === 'POST') return json(409, { message: 'already exists' })
      return json(200, {})
    })
    await new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch }).ensureIndex(index)
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(
      JSON.parse(patch?.body ?? '{}').fields.map((field: { name: string }) => field.name),
    ).toEqual(['views', '__tenant'])
    const { fetch: complete, calls: none } = stubFetch(() =>
      json(200, { fields: collectionFields(index) }),
    )
    await new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: complete }).ensureIndex(
      index,
    )
    expect(none.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  test('upsert sends JSON lines without nulls and fails on a rejected document', async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: '{"success":true}\n\n{"success":true}',
    }))
    const engine = new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch })
    await engine.upsert(index, [
      { id: '1', title: 'a', views: null },
      { id: '2', title: 'b', views: 3 },
    ])
    expect(calls[0]?.body).toBe('{"id":"1","title":"a"}\n{"id":"2","title":"b","views":3}')
    expect(calls[0]?.url.search).toBe('?action=upsert')
    await engine.upsert(index, [])
    expect(calls).toHaveLength(1)
    const { fetch: rejecting } = stubFetch(() => ({
      status: 200,
      body: '{"success":false,"error":"Field `views` must be an int64."}',
    }))
    await expect(
      new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: rejecting }).upsert(index, [
        { id: '1' },
      ]),
    ).rejects.toThrow(/must be an int64/)
  })

  test('remove batches keys into id filters and refuses unsafe keys', async () => {
    const { fetch, calls } = stubFetch(() => json(200, { num_deleted: 1 }))
    const engine = new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch })
    await engine.remove(
      index,
      Array.from({ length: 150 }, (_, i) => String(i)),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.searchParams.get('filter_by')).toMatch(/^id:\[0,1,2,/)
    await expect(engine.remove(index, ['1,2]||id:[*'])).rejects.toMatchObject({
      code: 'unsafe_filter_value',
    })
  })

  test('search sends the compiled query and reads keys and the total', async () => {
    const { fetch, calls } = stubFetch(() =>
      json(200, { found: 7, hits: [{ document: { id: '3' } }, { document: { id: '1' } }, 'junk'] }),
    )
    const engine = new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch })
    expect(await engine.search(index, query)).toEqual({ keys: ['3', '1', 'undefined'], total: 7 })
    const params = calls[0]?.url.searchParams
    expect(params?.get('q')).toBe('*')
    expect(params?.get('query_by')).toBe('title')
    expect(params?.get('filter_by')).toBe('__tenant:=`t1`')
    expect(params?.get('sort_by')).toBe('views:desc')
    expect(params?.get('drop_tokens_threshold')).toBe('0')
    const { fetch: odd } = stubFetch(() => ({ status: 200, body: 'not json' }))
    expect(
      await new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: odd }).search(index, {
        ...query,
        text: 'x',
        filters: [],
        sort: [],
      }),
    ).toEqual({ keys: [], total: 0 })
  })

  test('flush drops and re-creates the collection', async () => {
    const { fetch, calls } = stubFetch((method) =>
      method === 'GET' ? json(404, {}) : json(200, {}),
    )
    await new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch }).flush(index)
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'GET', 'POST'])
  })

  test('failures name the status and message, never the key', async () => {
    const { fetch } = stubFetch(() =>
      json(401, { message: `Forbidden - a valid key is required (${'x'.repeat(400)})` }),
    )
    const error = await new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch })
      .search(index, query)
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'engine_failed', status: 503 })
    expect(String(error)).toMatch(/HTTP 401: Forbidden/)
    expect(String(error)).not.toContain(KEY)
    const { fetch: bare } = stubFetch(() => ({ status: 500, body: '' }))
    await expect(
      new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: bare }).search(index, query),
    ).rejects.toThrow(/HTTP 500$/)
  })

  test('an unreachable server or a timeout is an engine failure', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(
      new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: down }).search(index, query),
    ).rejects.toThrow(/could not be reached \(TypeError\)/)
    const slow = (async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch
    await expect(
      new TypesenseEngine({
        url: 'http://ts:8108',
        apiKey: KEY,
        timeoutMs: 50,
        fetch: slow,
      }).search(index, query),
    ).rejects.toThrow(/no answer within 50 ms/)
    const weird = (async () => {
      throw 'string'
    }) as unknown as typeof fetch
    await expect(
      new TypesenseEngine({ url: 'http://ts:8108', apiKey: KEY, fetch: weird }).search(
        index,
        query,
      ),
    ).rejects.toThrow(/could not be reached \(error\)/)
  })

  test('an empty key is refused', () => {
    expect(() => new TypesenseEngine({ url: 'http://ts:8108', apiKey: '' })).toThrow(
      /TYPESENSE_API_KEY/,
    )
  })
})

describe('MeilisearchEngine', () => {
  /** A Meilisearch HTTP stub: tasks succeed unless `fail` names the route. */
  function meili(fail?: { route: RegExp; reply: Reply }) {
    let uid = 0
    const { fetch, calls } = stubFetch((method, url) => {
      const route = `${method} ${url.pathname}`
      if (fail !== undefined && fail.route.test(route)) return fail.reply
      if (url.pathname.startsWith('/tasks/'))
        return json(200, {
          uid: Number(url.pathname.split('/')[2]),
          status: 'succeeded',
          type: 'x',
          indexUid: 'posts',
          error: null,
        })
      if (url.pathname.endsWith('/search'))
        return json(200, {
          hits: [{ id: '2' }, { id: '1' }],
          estimatedTotalHits: 2,
          query: '',
          limit: 10,
          offset: 0,
          processingTimeMs: 1,
        })
      uid += 1
      return json(202, {
        taskUid: uid,
        indexUid: 'posts',
        status: 'enqueued',
        type: 'x',
        enqueuedAt: new Date().toISOString(),
      })
    })
    // The client's own httpClient option skips its response handling, so stub fetch itself.
    vi.stubGlobal('fetch', fetch)
    return {
      engine: new MeilisearchEngine({ host: 'http://meili:7700', apiKey: KEY, timeoutMs: 1000 }),
      calls,
    }
  }

  test('sets up the index and its settings (only ids are displayed)', async () => {
    const { engine, calls } = meili()
    await engine.ensureIndex(index)
    const settings = calls.find((call) => call.url.pathname === '/indexes/posts/settings')
    expect(JSON.parse(settings?.body ?? '{}')).toEqual({
      searchableAttributes: ['title'],
      filterableAttributes: ['views', '__tenant'],
      sortableAttributes: ['title', 'views'],
      displayedAttributes: ['id'],
    })
  })

  test('writes and searches', async () => {
    const { engine, calls } = meili()
    await engine.upsert(index, [{ id: '1', title: 'a' }])
    await engine.upsert(index, [])
    await engine.remove(index, ['1'])
    await engine.remove(index, [])
    await engine.flush(index)
    expect(await engine.search(index, query)).toEqual({ keys: ['2', '1'], total: 2 })
    const search = calls.find((call) => call.url.pathname.endsWith('/search'))
    expect(JSON.parse(search?.body ?? '{}')).toMatchObject({
      filter: '__tenant = "t1"',
      sort: ['views:desc'],
      matchingStrategy: 'all',
      attributesToRetrieve: ['id'],
    })
    const noWait = new MeilisearchEngine({
      host: 'http://meili:7700',
      apiKey: KEY,
      waitForTasks: false,
    })
    await noWait.upsert(index, [{ id: '1' }])
    expect(calls.filter((call) => call.url.pathname.startsWith('/tasks/')).length).toBeGreaterThan(
      0,
    )
  })

  test('an existing index is fine; other failed tasks are errors', async () => {
    const exists = meili({
      route: /^GET \/tasks\/1$/,
      reply: json(200, {
        uid: 1,
        status: 'failed',
        error: { code: 'index_already_exists', message: 'exists' },
      }),
    })
    await expect(exists.engine.ensureIndex(index)).resolves.toBeUndefined()
    const rejected = meili({
      route: /^GET \/tasks\/1$/,
      reply: json(200, {
        uid: 1,
        status: 'failed',
        error: { code: 'invalid_document_id', message: 'bad id' },
      }),
    })
    await expect(rejected.engine.upsert(index, [{ id: '1' }])).rejects.toThrow(
      /invalid_document_id: bad id/,
    )
    const created = meili({
      route: /^GET \/tasks\/1$/,
      reply: json(200, { uid: 1, status: 'failed', error: null }),
    })
    await expect(created.engine.ensureIndex(index)).rejects.toThrow(/unknown: no message/)
  })

  test('API errors carry the code and message, never the key', async () => {
    const { engine } = meili({
      route: /search$/,
      reply: json(400, {
        code: 'invalid_search_filter',
        message: 'Attribute `x` is not filterable.',
        type: 'invalid_request',
        link: '',
      }),
    })
    const error = await engine.search(index, query).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'engine_failed' })
    expect(String(error)).toMatch(/invalid_search_filter: Attribute `x` is not filterable/)
    expect(String(error)).not.toContain(KEY)
    const down = new MeilisearchEngine({
      host: 'http://meili:7700',
      httpClient: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(down.search(index, query)).rejects.toThrow(/meilisearch search engine failed/)
  })
})

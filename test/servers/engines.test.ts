/**
 * The engine conformance suite, run against the memory engine (the reference) and real Meilisearch
 * and Typesense servers in throwaway containers: indexing, text, every filter type, sorting,
 * paging, removal, flush, tenant filters and filter injection. Then end to end through models.
 *
 * Skipped with the reason when Docker can't run Linux containers (the memory engine still runs).
 */
import { runWithTenant } from '@strutvane/framework/database'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type {
  FilterCondition,
  IndexDefinition,
  SearchDocument,
  SearchEngine,
} from '../../src/contract.ts'
import { MeilisearchEngine } from '../../src/engines/meilisearch.ts'
import { TypesenseEngine } from '../../src/engines/typesense.ts'
import { filterCondition, tenantCondition } from '../../src/filters.ts'
import { MemoryEngine, SearchManager, useSearch } from '../../src/index.ts'
import { TENANT_A, TENANT_B, useTestDatabase } from '../support/database.ts'
import { Post, Project } from '../support/models.ts'
import {
  dockerUnavailable,
  startMeilisearch,
  startTypesense,
  type TestServer,
} from '../support/servers.ts'

const skipped = await dockerUnavailable()

useTestDatabase()

function definition(name: string): IndexDefinition {
  const field = (
    fieldName: string,
    type: 'string' | 'int' | 'float' | 'bool' | 'datetime',
    roles: { searchable?: boolean; filterable?: boolean; sortable?: boolean },
  ) => ({
    name: fieldName,
    type,
    kind: type,
    searchable: roles.searchable ?? false,
    filterable: roles.filterable ?? false,
    sortable: roles.sortable ?? false,
    nullable: true,
  })
  return {
    name,
    model: 'Doc',
    tenantField: '__tenant',
    keyType: 'int',
    source: { table: 'docs', query: () => undefined },
    fields: [
      field('title', 'string', { searchable: true, sortable: true }),
      field('body', 'string', { searchable: true }),
      field('status', 'string', { filterable: true }),
      field('views', 'int', { filterable: true, sortable: true }),
      field('rating', 'float', { filterable: true }),
      field('featured', 'bool', { filterable: true }),
      field('published', 'datetime', { filterable: true, sortable: true }),
    ],
  }
}

const DOCS: SearchDocument[] = [
  {
    id: '1',
    title: 'Release notes',
    body: 'search arrives',
    status: 'published',
    views: 50,
    rating: 4.5,
    featured: true,
    published: Date.UTC(2026, 10, 1),
    __tenant: TENANT_A,
  },
  {
    id: '2',
    title: 'Release planning',
    body: 'next steps',
    status: 'draft',
    views: 5,
    rating: null,
    featured: false,
    published: null,
    __tenant: TENANT_A,
  },
  {
    id: '3',
    title: 'Quarterly report',
    body: 'release dates',
    status: 'published',
    views: 20,
    rating: 2.25,
    featured: true,
    published: Date.UTC(2026, 8, 30),
    __tenant: TENANT_A,
  },
  {
    id: '4',
    title: 'Borealis secret release',
    body: 'tenant b only',
    status: 'published',
    views: 999,
    rating: 5,
    featured: true,
    published: Date.UTC(2026, 10, 2),
    __tenant: TENANT_B,
  },
  {
    id: '5',
    title: 'Quote "inside" `ticks` and \\ slashes',
    body: 'odd',
    status: 'say "hi"',
    views: 1,
    rating: 1,
    featured: false,
    published: Date.UTC(2026, 0, 1),
    __tenant: TENANT_A,
  },
]

interface Target {
  readonly name: string
  readonly reason: string | undefined
  readonly start: () => Promise<{ engine: SearchEngine; stop: () => Promise<void> }>
}

const targets: readonly Target[] = [
  {
    name: 'memory',
    reason: undefined,
    start: async () => ({ engine: new MemoryEngine(), stop: async () => undefined }),
  },
  {
    name: 'meilisearch',
    reason: skipped,
    start: async () => {
      const server: TestServer = await startMeilisearch()
      return {
        engine: new MeilisearchEngine({ host: server.url, apiKey: server.key, timeoutMs: 15_000 }),
        stop: server.stop,
      }
    },
  },
  {
    name: 'typesense',
    reason: skipped,
    start: async () => {
      const server: TestServer = await startTypesense()
      return {
        engine: new TypesenseEngine({ url: server.url, apiKey: server.key, timeoutMs: 15_000 }),
        stop: server.stop,
      }
    },
  },
]

for (const target of targets) {
  describe.skipIf(target.reason !== undefined)(
    `${target.name}${target.reason === undefined ? '' : ` (skipped: ${target.reason})`}`,
    () => {
      let engine: SearchEngine
      let stop: () => Promise<void> = async () => undefined
      const index = definition(`conformance_${target.name}`)
      const asA = (conditions: FilterCondition[] = []) => [
        tenantCondition(index, TENANT_A),
        ...conditions,
      ]
      const keys = async (
        text: string,
        filters: FilterCondition[] = asA(),
        sort: { field: string; direction: 'asc' | 'desc' }[] = [],
      ) =>
        [...(await engine.search(index, { text, filters, sort, limit: 20, offset: 0 })).keys].sort()
      const f = (field: string, operator: string, value: unknown) =>
        filterCondition(index, field, operator, value)

      beforeAll(async () => {
        ;({ engine, stop } = await target.start())
        await engine.ensureIndex(index)
        await engine.ensureIndex(index)
        await engine.upsert(index, DOCS)
      })
      afterAll(async () => {
        await engine?.close?.()
        await stop()
      })

      test('text search matches words in searchable fields, inside the tenant', async () => {
        expect(await keys('release')).toEqual(['1', '2', '3'])
        expect(await keys('quarterly')).toEqual(['3'])
        expect(await keys('borealis')).toEqual([])
        expect(await keys('')).toEqual(['1', '2', '3', '5'])
      })

      test('filters of every type', async () => {
        expect(await keys('', asA([f('status', 'eq', 'published')]))).toEqual(['1', '3'])
        expect(await keys('', asA([f('status', 'ne', 'published')]))).toEqual(['2', '5'])
        expect(await keys('', asA([f('status', 'in', ['draft', 'published'])]))).toEqual([
          '1',
          '2',
          '3',
        ])
        expect(await keys('', asA([f('views', 'gt', 5)]))).toEqual(['1', '3'])
        expect(await keys('', asA([f('views', 'gte', 5), f('views', 'lte', 20)]))).toEqual([
          '2',
          '3',
        ])
        expect(await keys('', asA([f('views', 'lt', 5)]))).toEqual(['5'])
        expect(await keys('', asA([f('rating', 'gte', 2.25)]))).toEqual(['1', '3'])
        expect(await keys('', asA([f('featured', 'eq', true)]))).toEqual(['1', '3'])
        expect(
          await keys('', asA([f('published', 'gte', new Date(Date.UTC(2026, 9, 1)))])),
        ).toEqual(['1'])
        expect(await keys('', asA([f('views', 'in', [1, 50])]))).toEqual(['1', '5'])
      })

      test('filter injection: quotes, backticks and operators in values stay values', async () => {
        expect(await keys('', asA([f('status', 'eq', 'say "hi"')]))).toEqual(['5'])
        for (const payload of [
          `published" OR __tenant = "${TENANT_B}`,
          `published\\" OR status != "x`,
          'published) OR (views > 0',
          `published && __tenant:=${TENANT_B}`,
          `published\`,\`draft`,
          '*',
        ]) {
          let found: string[]
          try {
            found = await keys('', asA([f('status', 'eq', payload)]))
          } catch (error) {
            // Typesense can't quote a backtick: refused, never mangled.
            expect(String(error)).toMatch(/backtick/)
            continue
          }
          expect(found).toEqual([])
        }
      })

      test('null filters (Typesense refuses them instead of guessing)', async () => {
        if (target.name === 'typesense') {
          await expect(keys('', asA([f('rating', 'eq', null)]))).rejects.toThrow(/null/)
          return
        }
        expect(await keys('', asA([f('rating', 'eq', null)]))).toEqual(['2'])
        expect(await keys('', asA([f('rating', 'ne', null)]))).toEqual(['1', '3', '5'])
      })

      test('sorting and paging', async () => {
        const sorted = await engine.search(index, {
          text: '',
          filters: asA(),
          sort: [{ field: 'views', direction: 'desc' }],
          limit: 2,
          offset: 1,
        })
        expect(sorted.keys).toEqual(['3', '2'])
        expect(sorted.total).toBe(4)
        const byTitle = await engine.search(index, {
          text: '',
          filters: asA(),
          sort: [{ field: 'title', direction: 'asc' }],
          limit: 10,
          offset: 0,
        })
        expect(byTitle.keys).toEqual(['3', '5', '1', '2'])
      })

      test('upsert replaces, remove deletes, flush empties', async () => {
        const temp = definition(`lifecycle_${target.name}`)
        await engine.ensureIndex(temp)
        await engine.upsert(temp, [DOCS[0] as SearchDocument, DOCS[1] as SearchDocument])
        await engine.upsert(temp, [{ ...(DOCS[0] as SearchDocument), title: 'Renamed entirely' }])
        const search = (text: string) =>
          engine.search(temp, {
            text,
            filters: [tenantCondition(temp, TENANT_A)],
            sort: [],
            limit: 10,
            offset: 0,
          })
        expect((await search('renamed')).keys).toEqual(['1'])
        expect((await search('notes')).keys).toEqual([])
        await engine.remove(temp, ['2', 'unknown'])
        expect((await search('')).keys).toEqual(['1'])
        await engine.flush(temp)
        expect((await search('')).keys).toEqual([])
        await engine.upsert(temp, [DOCS[2] as SearchDocument])
        expect((await search('')).keys).toEqual(['3'])
        await engine.upsert(temp, [])
        await engine.remove(temp, [])
      })

      test('a field added to the model later is added to the index', async () => {
        const grown: IndexDefinition = {
          ...index,
          fields: [
            ...index.fields,
            {
              name: 'extra',
              type: 'int',
              kind: 'integer',
              searchable: false,
              filterable: true,
              sortable: false,
              nullable: true,
            },
          ],
        }
        await engine.ensureIndex(grown)
        await engine.upsert(grown, [{ ...(DOCS[0] as SearchDocument), extra: 7 }])
        const found = await engine.search(grown, {
          text: '',
          filters: [tenantCondition(grown, TENANT_A), filterCondition(grown, 'extra', 'eq', 7)],
          sort: [],
          limit: 5,
          offset: 0,
        })
        expect(found.keys).toEqual(['1'])
      })
    },
  )
}

describe.skipIf(skipped !== undefined)(
  `models end to end on real servers${skipped === undefined ? '' : ` (skipped: ${skipped})`}`,
  () => {
    const servers: TestServer[] = []
    const engines: [string, SearchEngine][] = []
    beforeAll(async () => {
      const [meili, typesense] = await Promise.all([startMeilisearch(), startTypesense()])
      servers.push(meili, typesense)
      engines.push(
        [
          'meilisearch',
          new MeilisearchEngine({ host: meili.url, apiKey: meili.key, timeoutMs: 15_000 }),
        ],
        [
          'typesense',
          new TypesenseEngine({ url: typesense.url, apiKey: typesense.key, timeoutMs: 15_000 }),
        ],
      )
    })
    afterAll(async () => {
      await Promise.all(servers.map((server) => server.stop()))
    })
    beforeEach(() => () => useSearch(undefined))

    test('save, search, update, delete; tenants never see each other; secrets never indexed', async () => {
      for (const [name, engine] of engines) {
        useSearch(new SearchManager({ engine, prefix: `e2e_${name}_`, onSyncError: 'throw' }))
        const post = await Post.forceCreate({
          title: `Server ${name} post`,
          author_id: 1,
          api_token: 'tok_never_indexed',
        })
        expect((await Post.search(`server ${name}`).get()).map((p) => p.id)).toEqual([post.id])
        expect(await Post.search('tok_never_indexed').get()).toEqual([])
        post.title = `Renamed ${name} post`
        await post.save()
        expect(await Post.search(`server ${name}`).get()).toEqual([])
        expect(await Post.search(`renamed ${name}`).get()).toHaveLength(1)
        await post.delete()
        expect(await Post.search(`renamed ${name}`).get()).toEqual([])

        await runWithTenant(TENANT_A, () =>
          Project.create({ name: `Apollo ${name}`, notes: 'orbit' }),
        )
        await runWithTenant(TENANT_B, () =>
          Project.create({ name: `Borealis ${name}`, notes: 'orbit' }),
        )
        const seenByA = await runWithTenant(TENANT_A, () => Project.search(`orbit`).get())
        expect(seenByA.map((project) => project.name)).toEqual([`Apollo ${name}`])
        const keysByA = await runWithTenant(TENANT_A, () => Project.search('borealis').keys())
        expect(keysByA).toEqual([])
      }
    })
  },
)

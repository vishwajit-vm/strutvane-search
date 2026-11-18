/**
 * Tenant isolation, attack-style: tenant A tries to reach tenant B's rows through search, on both
 * the memory engine (a shared index) and the database engine. The isolation model is one shared
 * index per model with a tenant field; the tenant condition is added by search from the active
 * tenant, and every hit is re-read through the ORM's tenant scope.
 */
import { runWithTenant } from '@strutvane/framework/database'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  DatabaseEngine,
  type EngineQuery,
  type IndexDefinition,
  importModel,
  MemoryEngine,
  type SearchEngine,
  SearchManager,
  TENANT_FIELD,
  useSearch,
} from '../src/index.ts'
import { TENANT_A, TENANT_B, useTestDatabase } from './support/database.ts'
import { Project } from './support/models.ts'

useTestDatabase()

const asA = <T>(work: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, work)
const asB = <T>(work: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, work)
const projects = { name: 'projects' }

async function seedBoth(): Promise<{ readonly secretId: string }> {
  await asA(() => Project.create({ name: 'Apollo launch', notes: 'shared word: orbit' }))
  const secret = await asB(() =>
    Project.create({ name: 'Borealis secret', notes: 'shared word: orbit', budget: '999.00' }),
  )
  return { secretId: secret.id }
}

describe.each([
  ['memory', () => new MemoryEngine()],
  ['database', () => new DatabaseEngine()],
] as const)('the %s engine', (_name, makeEngine) => {
  beforeEach(() => {
    useSearch(new SearchManager({ engine: makeEngine(), onSyncError: 'throw' }))
    return () => useSearch(undefined)
  })

  test('a tenant finds only its own rows, even for words both tenants use', async () => {
    await seedBoth()
    const seenByA = await asA(() => Project.search('orbit').get())
    expect(seenByA.map((project) => project.name)).toEqual(['Apollo launch'])
    const seenByB = await asB(() => Project.search('').get())
    expect(seenByB.map((project) => project.name)).toEqual(['Borealis secret'])
    expect(await asA(() => Project.search('borealis').get())).toEqual([])
  })

  test('totals, keys and filters never count or reveal the other tenant', async () => {
    await seedBoth()
    const page = await asA(() => Project.search('').paginate())
    expect(page.total).toBe(1)
    expect(await asA(() => Project.search('').where('budget', 999).keys())).toEqual([])
    expect(await asA(() => Project.search('').where('name', 'Borealis secret').get())).toEqual([])
  })

  test('the tenant field can never be filtered on by callers', async () => {
    await seedBoth()
    await expect(
      asA(() => Project.search('').where(TENANT_FIELD, TENANT_B).get()),
    ).rejects.toMatchObject({ code: 'not_filterable' })
    await expect(
      asA(() => Project.search('').where('tenant_id', TENANT_B).get()),
    ).rejects.toMatchObject({ code: 'not_filterable' })
  })

  test('searching a tenant model without an active tenant fails closed', async () => {
    await seedBoth()
    await expect(Project.search('orbit').get()).rejects.toMatchObject({ code: 'tenant_required' })
  })
})

describe('the shared index', () => {
  let engine: MemoryEngine
  beforeEach(() => {
    engine = new MemoryEngine()
    useSearch(new SearchManager({ engine, onSyncError: 'throw' }))
    return () => useSearch(undefined)
  })

  test("each document carries its own row's tenant", async () => {
    const { secretId } = await seedBoth()
    expect(engine.document(projects, secretId)?.[TENANT_FIELD]).toBe(TENANT_B)
    expect(engine.size(projects)).toBe(2)
  })

  test('a rogue or misconfigured engine that ignores the tenant filter still leaks nothing', async () => {
    const { secretId } = await seedBoth()
    // An engine that answers every key it holds, whatever the filters say.
    const leaky: SearchEngine = {
      name: 'leaky',
      keepsIndex: true,
      ensureIndex: async () => undefined,
      upsert: async () => undefined,
      remove: async () => undefined,
      flush: async () => undefined,
      search: async (index: IndexDefinition, query: EngineQuery) => {
        const all = await engine.search(index, { ...query, filters: [] })
        expect(all.keys).toContain(secretId)
        return all
      },
    }
    useSearch(new SearchManager({ engine: leaky }))
    const seen = await asA(() => Project.search('orbit').get())
    expect(seen.map((project) => project.name)).toEqual(['Apollo launch'])
  })

  test('import inside a tenant indexes only that tenant; without one, every tenant', async () => {
    await seedBoth()
    await engine.flush({ name: 'projects' } as IndexDefinition)
    const one = await asA(() => importModel(Project))
    expect(one).toEqual({ indexed: 1, skipped: 0, applicable: true })
    expect(engine.size(projects)).toBe(1)
    const all = await importModel(Project)
    expect(all.indexed).toBe(2)
    expect(engine.size(projects)).toBe(2)
    // After a full import each tenant still sees only its own rows.
    expect((await asA(() => Project.search('').get())).map((p) => p.name)).toEqual([
      'Apollo launch',
    ])
  })
})

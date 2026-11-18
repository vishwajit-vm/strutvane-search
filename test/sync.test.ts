/**
 * Index sync: saving, updating, soft-deleting, restoring and force-deleting a searchable model
 * keeps the index in step, after the commit; transactions defer and roll back index writes.
 */
import { transaction } from '@strutvane/framework/database'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  MemoryEngine,
  SearchManager,
  searchTransaction,
  TENANT_FIELD,
  useSearch,
  withoutSyncingToSearch,
} from '../src/index.ts'
import { useTestDatabase } from './support/database.ts'
import { Post } from './support/models.ts'

useTestDatabase()

let engine: MemoryEngine
let manager: SearchManager
const posts = { name: 'posts' }

beforeEach(() => {
  engine = new MemoryEngine()
  manager = new SearchManager({ engine, onSyncError: 'throw' })
  useSearch(manager)
  return () => useSearch(undefined)
})

const create = (title: string, extra: Record<string, unknown> = {}) =>
  Post.forceCreate({ title, body: `${title} body`, author_id: 1, ...extra })

describe('saving a model', () => {
  test('create indexes exactly the declared fields, never a hidden one', async () => {
    const post = await create('Hello world', {
      api_token: 'tok_live_secret',
      reset_code: 'reset-123',
      internal_note: 'only staff',
      rating: '4.50',
      published_on: '2026-11-18',
    })
    const document = engine.document(posts, String(post.id))
    expect(document).toEqual({
      id: String(post.id),
      title: 'Hello world',
      body: 'Hello world body',
      status: 'draft',
      author_id: 1,
      views: 0,
      rating: 4.5,
      featured: false,
      published_on: Date.UTC(2026, 10, 18),
      created_at: expect.any(Number),
    })
    expect(JSON.stringify(document)).not.toMatch(/tok_live|reset-123|only staff/)
    expect(document).not.toHaveProperty(TENANT_FIELD)
  })

  test('update re-indexes, soft delete removes, restore brings back, forceDelete removes', async () => {
    const post = await create('First title')
    post.title = 'Second title'
    await post.save()
    expect(engine.document(posts, String(post.id))?.['title']).toBe('Second title')
    await post.delete()
    expect(engine.document(posts, String(post.id))).toBeUndefined()
    await post.restore()
    expect(engine.document(posts, String(post.id))?.['title']).toBe('Second title')
    await post.forceDelete()
    expect(engine.size(posts)).toBe(0)
  })

  test('shouldBeSearchable keeps rows out, and removes a row that stops passing', async () => {
    const hidden = await create('never index me')
    expect(engine.size(posts)).toBe(0)
    hidden.title = 'now visible'
    await hidden.save()
    expect(engine.size(posts)).toBe(1)
    hidden.title = 'never index me'
    await hidden.save()
    expect(engine.size(posts)).toBe(0)
  })

  test('withoutSyncingToSearch leaves the index alone', async () => {
    await withoutSyncingToSearch(() => create('Quiet'))
    expect(engine.size(posts)).toBe(0)
  })

  test('sync "off" leaves the index alone', async () => {
    useSearch(new SearchManager({ engine, sync: 'off' }))
    await create('Off')
    expect(engine.size(posts)).toBe(0)
  })

  test('without a search manager, saving still works and indexes nothing', async () => {
    useSearch(undefined)
    const post = await create('No search here')
    expect(post.id).toBeGreaterThan(0)
    expect(engine.size(posts)).toBe(0)
  })
})

describe('transactions', () => {
  test('searchTransaction indexes after the commit, not before', async () => {
    let sizeInside = -1
    await searchTransaction(async () => {
      await create('In a transaction')
      sizeInside = engine.size(posts)
    })
    expect(sizeInside).toBe(0)
    expect(engine.size(posts)).toBe(1)
  })

  test('a rollback drops the pending index writes', async () => {
    await expect(
      searchTransaction(async () => {
        await create('Rolled back')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(engine.size(posts)).toBe(0)
    expect(await Post.query().count()).toBe(0)
  })

  test('a failed savepoint drops only its own writes', async () => {
    await searchTransaction(async () => {
      await create('Kept')
      await searchTransaction(async () => {
        await create('Inner, rolled back')
        throw new Error('inner')
      }).catch(() => undefined)
    })
    const titles = (await Post.search('').get()).map((post) => post.title)
    expect(titles).toEqual(['Kept'])
    expect(engine.size(posts)).toBe(1)
  })

  test('inside withoutSyncingToSearch, a searchTransaction still commits and indexes nothing', async () => {
    await withoutSyncingToSearch(() => searchTransaction(() => create('Silent')))
    expect(await Post.query().count()).toBe(1)
    expect(engine.size(posts)).toBe(0)
  })

  test('a foreign transaction indexes at once and warns once per model', async () => {
    const warn = vi.fn()
    const logger = { warn, error: vi.fn() }
    useSearch(new SearchManager({ engine, logger: logger as never }))
    await transaction(async () => {
      await create('Foreign one')
      await create('Foreign two')
    })
    expect(engine.size(posts)).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('searchTransaction')
  })
})

describe('model statics and sync failures', () => {
  test('makeAllSearchable and removeAllFromSearch', async () => {
    await withoutSyncingToSearch(async () => {
      await create('One')
      await create('never index me')
    })
    expect(await Post.makeAllSearchable()).toEqual({ indexed: 1, skipped: 1, applicable: true })
    expect(engine.size(posts)).toBe(1)
    await Post.removeAllFromSearch()
    expect(engine.size(posts)).toBe(0)
  })

  test('an engine that cannot be created fails the save only with onSyncError "throw"', async () => {
    const error = vi.fn()
    useSearch(
      new SearchManager({
        engine: () => Promise.reject(new Error('meilisearch is not installed')),
        logger: { warn: vi.fn(), error } as never,
      }),
    )
    const saved = await create('Saved anyway')
    expect(saved.isPersisted()).toBe(true)
    expect(String(JSON.stringify(error.mock.calls[0]))).toContain('meilisearch is not installed')
    useSearch(
      new SearchManager({
        engine: () => Promise.reject(new Error('down')),
        onSyncError: 'throw',
      }),
    )
    await expect(create('Throws after the commit')).rejects.toThrow('down')
    expect(await Post.query().count()).toBe(2)
  })

  test('a searchTransaction with no search set up just commits', async () => {
    useSearch(undefined)
    await searchTransaction(() => create('No manager'))
    expect(await Post.query().count()).toBe(1)
  })
})

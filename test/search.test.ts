/**
 * Searching: the same behaviour on the memory engine (a real index) and the database engine (SQL),
 * from text matching and every filter type to sorting, pagination, constraints and policies.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  DatabaseEngine,
  isSearchError,
  MAX_SEARCH_TEXT,
  MemoryEngine,
  type SearchEngine,
  SearchManager,
  useSearch,
  withoutSyncingToSearch,
} from '../src/index.ts'
import { useTestDatabase } from './support/database.ts'
import { Post, Project } from './support/models.ts'

useTestDatabase()

const engines: readonly (readonly [string, () => SearchEngine])[] = [
  ['memory', () => new MemoryEngine()],
  ['database', () => new DatabaseEngine()],
]

const ROWS = [
  {
    title: 'Release notes for November',
    body: 'Search arrives',
    status: 'published',
    author_id: 1,
    views: 50,
    rating: '4.50',
    featured: true,
    published_on: '2026-11-01',
  },
  {
    title: 'Release planning',
    body: 'What comes next',
    status: 'draft',
    author_id: 2,
    views: 5,
    rating: null,
    featured: false,
    published_on: null,
  },
  {
    title: 'Café opening',
    body: 'Crème brûlée for everyone',
    status: 'published',
    author_id: 1,
    views: 500,
    rating: '3.00',
    featured: false,
    published_on: '2026-10-15',
  },
  {
    title: 'Quarterly report',
    body: 'Numbers and release dates',
    status: 'published',
    author_id: 3,
    views: 20,
    rating: '2.25',
    featured: true,
    published_on: '2026-09-30',
  },
] as const

async function seed(): Promise<void> {
  for (const row of ROWS) await Post.forceCreate({ ...row })
}

/** The error code a call fails with ('no error' when it succeeds). */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isSearchError(error) ? error.code : String(error)
  }
  return 'no error'
}

const titles = (posts: readonly Post[]): string[] => posts.map((post) => post.title).sort()

describe.each(engines)('the %s engine', (_name, makeEngine) => {
  beforeEach(async () => {
    useSearch(new SearchManager({ engine: makeEngine(), onSyncError: 'throw' }))
    await seed()
    return () => useSearch(undefined)
  })

  test('every word of the text must match a searchable field', async () => {
    expect(titles(await Post.search('release').get())).toEqual([
      'Quarterly report',
      'Release notes for November',
      'Release planning',
    ])
    expect(titles(await Post.search('release notes').get())).toEqual(['Release notes for November'])
    expect(titles(await Post.search('RELEASE PLANNING').get())).toEqual(['Release planning'])
    expect(titles(await Post.search('café').get())).toEqual(['Café opening'])
    expect(await Post.search('nothing matches this').get()).toEqual([])
  })

  test('results are real model instances, loaded from the database', async () => {
    const [post] = await Post.search('quarterly').get()
    expect(post).toBeInstanceOf(Post)
    expect(post?.isPersisted()).toBe(true)
    expect(post?.views).toBe(20)
  })

  test('an empty text matches everything; filters still apply', async () => {
    expect(await Post.search('').get()).toHaveLength(4)
    expect(await Post.search().where('status', 'draft').get()).toHaveLength(1)
  })

  test('string, integer, decimal, boolean, date and null filters', async () => {
    expect(titles(await Post.search('').where('author_id', 1).get())).toEqual([
      'Café opening',
      'Release notes for November',
    ])
    expect(titles(await Post.search('').whereNot('status', 'published').get())).toEqual([
      'Release planning',
    ])
    expect(titles(await Post.search('').whereIn('author_id', [2, 3]).get())).toEqual([
      'Quarterly report',
      'Release planning',
    ])
    expect(titles(await Post.search('').filter('views', 'gte', 50).get())).toEqual([
      'Café opening',
      'Release notes for November',
    ])
    expect(titles(await Post.search('').filter('views', 'lte', 5).get())).toEqual([
      'Release planning',
    ])
    expect(titles(await Post.search('').filter('rating', 'gt', 3).get())).toEqual([
      'Release notes for November',
    ])
    expect(titles(await Post.search('').where('featured', true).get())).toEqual([
      'Quarterly report',
      'Release notes for November',
    ])
    expect(
      titles(
        await Post.search('').filter('published_on', 'lt', new Date('2026-10-20T00:00:00Z')).get(),
      ),
    ).toEqual(['Café opening', 'Quarterly report'])
    expect(titles(await Post.search('').filter('published_on', 'gte', '2026-11-01').get())).toEqual(
      ['Release notes for November'],
    )
    expect(titles(await Post.search('').where('rating', null).get())).toEqual(['Release planning'])
    expect(await Post.search('').whereNot('rating', null).get()).toHaveLength(3)
    expect(titles(await Post.search('').whereIn('rating', [null, 3]).get())).toEqual([
      'Café opening',
      'Release planning',
    ])
    expect(titles(await Post.search('').whereIn('rating', [null]).get())).toEqual([
      'Release planning',
    ])
  })

  test('orderBy sorts by sortable fields; keys() returns engine keys in that order', async () => {
    const byViews = await Post.search('').orderBy('views', 'desc').get()
    expect(byViews.map((post) => post.views)).toEqual([500, 50, 20, 5])
    const keys = await Post.search('').orderBy('views', 'asc').keys()
    expect(keys).toEqual(byViews.map((post) => String(post.id)).reverse())
    const byTitle = await Post.search('').orderBy('title').get()
    expect(byTitle.map((post) => post.title)).toEqual([
      'Café opening',
      'Quarterly report',
      'Release notes for November',
      'Release planning',
    ])
  })

  test('paginate gives pages with totals; take() limits get()', async () => {
    const first = await Post.search('').orderBy('views').paginate(3)
    expect(first).toMatchObject({ total: 4, perPage: 3, currentPage: 1, lastPage: 2 })
    expect(first.data.map((post) => post.views)).toEqual([5, 20, 50])
    const second = await Post.search('').orderBy('views').paginate(3, 2)
    expect(second.data.map((post) => post.views)).toEqual([500])
    expect((await Post.search('').paginate()).perPage).toBe(10)
    expect(await Post.search('').take(2).get()).toHaveLength(2)
    expect(await Post.search('').take(2).keys()).toHaveLength(2)
  })

  test('query() narrows the database read; rows it drops are removed, never replaced', async () => {
    const page = await Post.search('')
      .query((q) => {
        q.where('views', '>', 10)
      })
      .orderBy('views')
      .paginate(2)
    expect(page.data.map((post) => post.views)).toEqual([20])
    expect(page.total).toBe(4)
  })

  test('soft-deleted rows are never returned, even while the index still holds them', async () => {
    const [post] = await Post.search('quarterly').get()
    await withoutSyncingToSearch(() => post?.delete())
    expect(await Post.search('quarterly').get()).toEqual([])
  })

  test('for(user) re-checks every hit with the policy: deny by default', async () => {
    const mine = await Post.search('')
      .for({ id: 1 } as never)
      .get()
    expect(titles(mine)).toEqual(['Café opening', 'Release notes for November'])
    expect(await Post.search('').for(null).get()).toEqual([])
    expect(
      await Post.search('')
        .for({ id: 1 } as never, {})
        .get(),
    ).toEqual([])
    expect(
      await Post.search('')
        .for(null, { before: () => true })
        .get(),
    ).toHaveLength(4)
    expect(
      await Post.search('')
        .for({ id: 1 } as never, { before: () => false, view: () => true })
        .get(),
    ).toEqual([])
    // Only `true` allows: a truthy non-boolean is a denial.
    expect(
      await Post.search('')
        .for(null, { view: () => 1 as never })
        .get(),
    ).toEqual([])
  })

  test('bad input is refused with a clear code before the engine runs', async () => {
    const many = Array.from({ length: 1001 }, (_, index) => index)
    const cases: readonly (readonly [string, () => unknown])[] = [
      ['not_filterable', () => Post.search('').where('body', 'x').get()],
      ['not_filterable', () => Post.search('').where('api_token', 'x').get()],
      ['not_filterable', () => Post.search('').where('__tenant', 'x').get()],
      ['not_filterable', () => Post.search('').where('status" OR 1=1', 'x').get()],
      ['not_sortable', () => Post.search('').orderBy('body').get()],
      ['invalid_filter', () => Post.search('').filter('views', 'like', 1).get()],
      ['invalid_filter', () => Post.search('').filter('status', 'gt', 'a').get()],
      ['invalid_filter', () => Post.search('').filter('featured', 'gt', true).get()],
      ['invalid_filter', () => Post.search('').filter('views', 'gt', null).get()],
      ['invalid_filter', () => Post.search('').where('views', 'many').get()],
      ['invalid_filter', () => Post.search('').where('views', [1]).get()],
      ['invalid_filter', () => Post.search('').whereIn('views', []).get()],
      ['invalid_filter', () => Post.search('').whereIn('views', many).get()],
      ['invalid_filter', () => Post.search('').where('status', 'x'.repeat(1025)).get()],
      ['invalid_filter', () => Post.search('').where('published_on', 'yesterday').get()],
      ['invalid_filter', () => Post.search('').where('featured', 'yes').get()],
      ['invalid_filter', () => Post.search('').where('rating', 'NaN').get()],
      [
        'invalid_filter',
        () =>
          Post.search('')
            .orderBy('views', 'sideways' as never)
            .get(),
      ],
      ['invalid_query', () => Post.search('x'.repeat(MAX_SEARCH_TEXT + 1))],
      ['invalid_query', () => Post.search('a\u0000b')],
      ['invalid_query', () => Post.search(42 as never)],
      ['invalid_page', () => Post.search('').paginate(0)],
      ['invalid_page', () => Post.search('').paginate(10, 0)],
      ['invalid_page', () => Post.search('').paginate(100, 102)],
      ['invalid_page', () => Post.search('').take(101)],
    ]
    for (const [expected, run] of cases) expect(await codeOf(run)).toBe(expected)
  })
})

describe('without set-up', () => {
  test('for(user) on a model without a policy fails instead of skipping the check', async () => {
    useSearch(new SearchManager({ engine: new MemoryEngine() }))
    try {
      expect(await codeOf(() => Project.search('').for(null).get())).toBe('policy_required')
    } finally {
      useSearch(undefined)
    }
  })

  test('searching with no search manager says how to set search up', async () => {
    expect(await codeOf(() => Post.search('x').get())).toBe('not_configured')
  })
})

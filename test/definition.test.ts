/**
 * Searchable options are validated against the schema: hidden and secret columns are refused
 * (secret-field leakage), unsupported or misplaced columns are explained, and documents hold
 * only the declared fields.
 */
import { Model, ModelBase } from '@strutvane/framework/database'
import { beforeEach, describe, expect, test } from 'vitest'
import { buildDocument, documentKey, primaryKeyOf, toDocumentValue } from '../src/definition.ts'
import { isSearchError, MemoryEngine, Searchable, SearchManager, useSearch } from '../src/index.ts'
import { modelRuntime } from '../src/model.ts'
import { useTestDatabase } from './support/database.ts'
import { Post } from './support/models.ts'

useTestDatabase()

beforeEach(() => {
  useSearch(new SearchManager({ engine: new MemoryEngine() }))
  return () => useSearch(undefined)
})

/** The code the first search on a model with these options fails with. */
async function problem(options: Record<string, unknown>, table = 'posts'): Promise<string> {
  try {
    const Bad = Searchable(Model(table as 'posts'), options as never)
    await Bad.search('').get()
  } catch (error) {
    return isSearchError(error) ? `${error.code}: ${error.message}` : String(error)
  }
  return 'no error'
}

describe('hidden and secret columns never reach an engine', () => {
  test.each([
    ['api_token', 'secret by its name'],
    ['reset_code', '.secret() in the migration'],
    ['internal_note', '.hidden() in the migration'],
  ])('%s (%s) is refused in every role', async (column) => {
    for (const role of ['searchable', 'filterable', 'sortable'])
      expect(
        await problem({
          searchable: role === 'searchable' ? [column] : ['title'],
          [role]: [column],
        }),
      ).toMatch(/^hidden_field/)
  })

  test("the model's own hidden list counts too", async () => {
    const Hidden = Searchable(Model('posts', { hidden: ['body'] }), { searchable: ['body'] })
    await expect(Hidden.search('').get()).rejects.toMatchObject({ code: 'hidden_field' })
  })

  test('a hint for a mistyped column never names a hidden one', async () => {
    const message = await problem({ searchable: ['api_tokn'] })
    expect(message).toMatch(/^unknown_field/)
    expect(message).not.toContain('api_token')
    expect(await problem({ searchable: ['titel'] })).toContain('Did you mean "title"?')
  })

  test('a document holds only id and the declared fields', async () => {
    const post = await Post.forceCreate({
      title: 'Doc',
      author_id: 9,
      api_token: 'tok_secret',
      reset_code: 'r',
      internal_note: 'n',
      meta: { a: 1 },
    })
    const runtime = modelRuntime(Post)
    const manager = new SearchManager({ engine: new MemoryEngine() })
    const { indexFor, requireSearchable } = await import('../src/settings.ts')
    const index = indexFor(requireSearchable(Post), manager)
    const document = buildDocument(index, runtime, post)
    expect(Object.keys(document).sort()).toEqual(
      [
        'id',
        'title',
        'body',
        'status',
        'author_id',
        'views',
        'rating',
        'featured',
        'published_on',
        'created_at',
      ].sort(),
    )
  })
})

describe('options that are refused with a fix', () => {
  test.each([
    [{ searchable: [] }, /^invalid_options.*at least one/],
    [{ searchable: 'title' }, /^invalid_options/],
    [{ searchable: ['title'], filterable: 'status' }, /^invalid_options/],
    [{ searchable: ['ti tle'] }, /^invalid_options.*not a column name/],
    [{ searchable: ['__tenant'] }, /^invalid_options/],
    [{ searchable: ['id'] }, /^invalid_options.*primary key/],
    [{ searchable: ['title'], filterable: ['meta'] }, /^unsupported_field.*json/],
    [{ searchable: ['views'] }, /^unsupported_field.*Only text columns/],
    [{ searchable: ['title'], index: 'bad name!' }, /^invalid_options.*index name/],
  ])('%j', async (options, expected) => {
    expect(await problem(options)).toMatch(expected)
  })

  test('the tenant column is managed by search', async () => {
    expect(await problem({ searchable: ['name'], filterable: ['tenant_id'] }, 'projects')).toMatch(
      /^invalid_options.*tenant column/,
    )
  })

  test.each([
    [{ searchable: ['title'], perPage: 0 }],
    [{ searchable: ['title'], perPage: 101 }],
    [{ searchable: ['title'], shouldBeSearchable: 'yes' }],
    [{ searchable: ['title'], policy: 'PostPolicy' }],
  ])('%j fails when the class is declared', (options) => {
    expect(() => Searchable(Model('posts'), options as never)).toThrow(
      /invalid_options|perPage|must be/,
    )
  })

  test('only model classes can be made searchable', () => {
    expect(() => Searchable(class NotAModel {} as never, { searchable: [] })).toThrow(
      /not_a_model|Model\('table'/,
    )
    expect(() => modelRuntime(null)).toThrow(/null/)
    expect(() => modelRuntime({})).toThrow(/object/)
    expect(modelRuntime(Post).table).toBe('posts')
    expect(Post.prototype).toBeInstanceOf(ModelBase)
  })

  test('a custom index name and the prefix are applied', async () => {
    const Named = Searchable(Model('posts'), { searchable: ['title'], index: 'articles' })
    const engine = new MemoryEngine()
    useSearch(new SearchManager({ engine, prefix: 'staging_' }))
    await Named.search('').get()
    const { indexFor, requireSearchable } = await import('../src/settings.ts')
    expect(
      indexFor(requireSearchable(Named), new SearchManager({ engine, prefix: 'staging_' })).name,
    ).toBe('staging_articles')
  })
})

describe('value conversion', () => {
  const index = { model: 'Post' }
  const field = (type: 'string' | 'int' | 'float' | 'bool' | 'datetime') => ({ name: 'f', type })

  test.each([
    ['string', 'a', 'a'],
    ['string', 5, '5'],
    ['string', true, 'true'],
    ['int', '12', 12],
    ['int', 12n, 12],
    ['float', '4.50', 4.5],
    ['float', 2.5, 2.5],
    ['bool', false, false],
    ['datetime', new Date(Date.UTC(2026, 0, 2)), Date.UTC(2026, 0, 2)],
    ['datetime', '2026-01-02', Date.UTC(2026, 0, 2)],
    ['datetime', '2026-01-02T03:04:05Z', Date.UTC(2026, 0, 2, 3, 4, 5)],
    ['datetime', 1234, 1234],
    ['int', null, null],
    ['string', undefined, null],
  ] as const)('%s %s → %s', (type, value, expected) => {
    expect(toDocumentValue(index, field(type), value)).toBe(expected)
  })

  test.each([
    ['string', {}],
    ['int', 1.5],
    ['int', ''],
    ['int', true],
    ['float', 'abc'],
    ['float', Number.POSITIVE_INFINITY],
    ['bool', 'true'],
    ['datetime', 'yesterday'],
    ['datetime', new Date('nope')],
    ['datetime', 1.5],
    ['datetime', []],
  ] as const)('%s %j is refused', (type, value) => {
    expect(() => toDocumentValue(index, field(type), value)).toThrow(/invalid_document|should be/)
  })

  test('keys: integers and strings round-trip, anything else is refused', () => {
    expect(documentKey(7)).toBe('7')
    expect(documentKey(7n)).toBe('7')
    expect(documentKey('a-b')).toBe('a-b')
    expect(() => documentKey('')).toThrow()
    expect(() => documentKey(1.5)).toThrow()
    const intIndex = { keyType: 'int' } as Parameters<typeof primaryKeyOf>[0]
    expect(primaryKeyOf(intIndex, '7')).toBe(7)
    expect(primaryKeyOf(intIndex, 'x')).toBe('x')
    expect(primaryKeyOf({ keyType: 'string' } as typeof intIndex, '7')).toBe('7')
  })

  test('a document needs a saved row', async () => {
    const { indexFor, requireSearchable } = await import('../src/settings.ts')
    const index = indexFor(
      requireSearchable(Post),
      new SearchManager({ engine: new MemoryEngine() }),
    )
    expect(() => buildDocument(index, modelRuntime(Post), Post.make())).toThrow(/primary key/)
  })
})

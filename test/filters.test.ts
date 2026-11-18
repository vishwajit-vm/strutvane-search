/**
 * Filter compilation and filter injection. The compilers are fuzzed with generated values: for
 * any string, the Meilisearch literal decodes back to exactly that string and nothing outside it,
 * and the Typesense literal is either exactly one backtick-quoted value or a refusal.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { FilterCondition, IndexDefinition } from '../src/contract.ts'
import {
  filterCondition,
  meiliFilter,
  meiliSort,
  meiliString,
  sortSpec,
  tenantCondition,
  typesenseFilter,
  typesenseSort,
  typesenseString,
} from '../src/filters.ts'

const index: IndexDefinition = {
  name: 'posts',
  model: 'Post',
  tenantField: '__tenant',
  keyType: 'int',
  source: { table: 'posts', query: () => undefined },
  fields: [
    {
      name: 'status',
      type: 'string',
      kind: 'enum',
      searchable: false,
      filterable: true,
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
      nullable: false,
    },
    {
      name: 'title',
      type: 'string',
      kind: 'string',
      searchable: true,
      filterable: false,
      sortable: false,
      nullable: false,
    },
  ],
}

const eq = (value: string): FilterCondition => ({
  field: 'status',
  type: 'string',
  operator: 'eq',
  value,
})

/** Decode one Meilisearch double-quoted literal at the start of `text`; returns value and rest. */
function decodeMeili(text: string): { value: string; rest: string } {
  expect(text.startsWith('"')).toBe(true)
  let value = ''
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') {
      value += text[i + 1] ?? ''
      i += 1
    } else if (char === '"') return { value, rest: text.slice(i + 1) }
    else value += char
  }
  throw new Error('unterminated literal')
}

describe('Meilisearch', () => {
  test('every operator and type', () => {
    expect(meiliFilter([])).toBeUndefined()
    expect(
      meiliFilter([
        eq('pub"lished'),
        { field: 'views', type: 'int', operator: 'gte', value: 10 },
        { field: 'views', type: 'int', operator: 'lt', value: 99 },
        { field: 'flag', type: 'bool', operator: 'ne', value: true },
        { field: 'views', type: 'int', operator: 'in', value: [1, 2] },
        { field: 'rating', type: 'float', operator: 'in', value: [null, 3] },
        { field: 'rating', type: 'float', operator: 'in', value: [null] },
        { field: 'rating', type: 'float', operator: 'eq', value: null },
        { field: 'rating', type: 'float', operator: 'ne', value: null },
        { field: 'flag', type: 'bool', operator: 'eq', value: false },
        { field: 'views', type: 'int', operator: 'gt', value: 1 },
        { field: 'views', type: 'int', operator: 'lte', value: 2 },
      ]),
    ).toBe(
      'status = "pub\\"lished" AND views >= 10 AND views < 99 AND flag != true AND views IN [1, 2] AND (rating IN [3] OR rating IS NULL) AND rating IS NULL AND rating IS NULL AND rating IS NOT NULL AND flag = false AND views > 1 AND views <= 2',
    )
    expect(meiliSort([{ field: 'views', direction: 'desc' }])).toEqual(['views:desc'])
    expect(meiliString('a\\b')).toBe('"a\\\\b"')
  })

  test('fuzz: any string value decodes back to itself, with nothing after the literal', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (value) => {
        const compiled = meiliFilter([eq(value)]) ?? ''
        expect(compiled.startsWith('status = ')).toBe(true)
        const decoded = decodeMeili(compiled.slice('status = '.length))
        expect(decoded.value).toBe(value)
        expect(decoded.rest).toBe('')
      }),
      { numRuns: 500 },
    )
  })

  test('fuzz: classic injection payloads stay inside the literal', () => {
    for (const payload of [
      '" OR __tenant != "x',
      'x" OR 1 = 1 OR status = "y',
      '\\" OR status EXISTS',
      '") OR (__tenant = "b',
    ]) {
      const decoded = decodeMeili((meiliFilter([eq(payload)]) ?? '').slice('status = '.length))
      expect(decoded).toEqual({ value: payload, rest: '' })
    }
  })

  test('field names are re-checked where the string is built', () => {
    expect(() => meiliFilter([{ ...eq('x'), field: 'a b' }])).toThrow(/not a field name/)
    expect(() => meiliSort([{ field: 'x:desc,y', direction: 'asc' }])).toThrow()
    expect(() =>
      meiliFilter([{ field: 'views', type: 'int', operator: 'eq', value: Number.NaN }]),
    ).toThrow()
    expect(() =>
      meiliFilter([{ field: 'views', type: 'int', operator: 'eq', value: [1] as never }]),
    ).toThrow()
  })
})

describe('Typesense', () => {
  test('every operator and type', () => {
    expect(typesenseFilter([])).toBeUndefined()
    expect(
      typesenseFilter([
        eq('a && b'),
        { field: 'views', type: 'int', operator: 'gt', value: 1 },
        { field: 'views', type: 'int', operator: 'gte', value: 2 },
        { field: 'views', type: 'int', operator: 'lt', value: 3 },
        { field: 'views', type: 'int', operator: 'lte', value: 4 },
        { field: 'views', type: 'int', operator: 'ne', value: 5 },
        { field: 'flag', type: 'bool', operator: 'eq', value: true },
        { field: 'status', type: 'string', operator: 'in', value: ['x', 'y,z'] },
      ]),
    ).toBe(
      'status:=`a && b` && views:>1 && views:>=2 && views:<3 && views:<=4 && views:!=5 && flag:=true && status:=[`x`,`y,z`]',
    )
    expect(typesenseSort([])).toBeUndefined()
    expect(typesenseSort([{ field: 'views', direction: 'asc' }])).toBe('views:asc')
    expect(() =>
      typesenseSort(['a', 'b', 'c', 'd'].map((field) => ({ field, direction: 'asc' as const }))),
    ).toThrow(/three/)
  })

  test('a backtick or a null is refused, never mangled', () => {
    expect(() => typesenseString('status', 'a`b')).toThrow(/unsafe|backtick/)
    expect(() =>
      typesenseFilter([{ field: 'rating', type: 'float', operator: 'eq', value: null }]),
    ).toThrow(/null/)
    expect(() =>
      typesenseFilter([{ field: 'views', type: 'int', operator: 'eq', value: [1] as never }]),
    ).toThrow()
  })

  test('fuzz: any value is one backtick literal or a refusal', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (value) => {
        let compiled: string | undefined
        try {
          compiled = typesenseFilter([eq(value)])
        } catch (error) {
          expect(value).toContain('`')
          expect(String(error)).toMatch(/backtick/)
          return
        }
        expect(compiled).toBe(`status:=\`${value}\``)
        expect(value).not.toContain('`')
      }),
      { numRuns: 500 },
    )
  })
})

describe('validation of app input', () => {
  test('conditions are typed and allow-listed', () => {
    expect(filterCondition(index, 'views', 'in', ['1', 2])).toEqual({
      field: 'views',
      type: 'int',
      operator: 'in',
      value: [1, 2],
    })
    expect(sortSpec(index, 'views', 'desc')).toEqual({ field: 'views', direction: 'desc' })
    expect(tenantCondition(index, 't')).toMatchObject({ field: '__tenant', value: 't' })
    expect(() => tenantCondition({ ...index, tenantField: undefined }, 't')).toThrow()
    expect(() => filterCondition(index, 'title', 'eq', 'x')).toThrow(/not filterable/)
    expect(() => filterCondition(index, '\u0000bad'.repeat(20), 'eq', 'x')).toThrow(/\?bad/)
  })

  test('fuzz: names outside the allow-list are always refused', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (field) => {
        fc.pre(field !== 'status' && field !== 'views')
        expect(() => filterCondition(index, field, 'eq', 'x')).toThrow(/not filterable/)
        expect(() => sortSpec(index, field, 'asc')).toThrow(/not sortable/)
      }),
      { numRuns: 300 },
    )
  })
})

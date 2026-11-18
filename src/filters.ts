/**
 * Filters: from what app code passes (`where('status', 'published')`) to validated
 * {@link FilterCondition}s, and from those to each engine's filter syntax.
 *
 * Filter injection is closed at three points:
 * 1. **Names come from an allow-list.** A filter or sort may only name a field the model declared
 *    `filterable` / `sortable`; anything else (an unknown name, a hidden column, the tenant field,
 *    a name with quotes or spaces) is refused before an engine sees it.
 * 2. **Values are typed.** A value is converted to the field's type (numbers must be finite, dates
 *    become epoch milliseconds), so only strings ever need quoting.
 * 3. **Strings are quoted by one function per engine**, tested with generated input (fast-check)
 *    and against the real servers: Meilisearch gets a double-quoted string with `\` and `"`
 *    escaped; Typesense gets a backtick-quoted string, and a value containing a backtick (which
 *    Typesense can't escape) is refused instead of being guessed at.
 *
 * @module
 */
import type {
  DocumentValue,
  FilterCondition,
  FilterOperator,
  IndexDefinition,
  IndexField,
  SortSpec,
} from './contract.ts'
import { toDocumentValue } from './definition.ts'
import { SearchError } from './errors.ts'

/** The operators app code may use. */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
]

/** Most values an `in` filter may list (the ORM's own `maxInValues` is 1000). */
export const MAX_IN_VALUES = 1000

/** Longest string a filter value may be. */
export const MAX_FILTER_STRING = 1024

/**
 * Validate one filter from app code against the index's allow-list.
 *
 * @example
 * filterCondition(index, 'status', 'in', ['draft', 'published'])
 */
export function filterCondition(
  index: IndexDefinition,
  field: string,
  operator: string,
  value: unknown,
): FilterCondition {
  const declared = allowedField(index, field, 'filterable')
  if (!(FILTER_OPERATORS as readonly string[]).includes(operator))
    throw new SearchError('invalid_filter', {
      field,
      detail: `"${String(operator)}" is not an operator; use one of ${FILTER_OPERATORS.join(', ')}.`,
    })
  const op = operator as FilterOperator
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0)
      throw new SearchError('invalid_filter', { field, detail: '"in" needs a non-empty list.' })
    if (value.length > MAX_IN_VALUES)
      throw new SearchError('invalid_filter', {
        field,
        detail: `"in" may list at most ${MAX_IN_VALUES} values.`,
      })
    return {
      field,
      type: declared.type,
      operator: op,
      value: value.map((item: unknown) => operand(index, declared, item, false)),
    }
  }
  if (Array.isArray(value))
    throw new SearchError('invalid_filter', {
      field,
      detail: `"${op}" takes one value, not a list.`,
    })
  const ordering = op !== 'eq' && op !== 'ne'
  if (ordering && declared.type === 'string')
    throw new SearchError('invalid_filter', {
      field,
      detail: `"${op}" compares numbers and dates; "${field}" is text, so use "eq", "ne" or "in".`,
    })
  if (ordering && declared.type === 'bool')
    throw new SearchError('invalid_filter', {
      field,
      detail: `"${op}" can't compare booleans; use "eq" or "ne".`,
    })
  return {
    field,
    type: declared.type,
    operator: op,
    value: operand(index, declared, value, ordering),
  }
}

/**
 * Validate one sort key.
 *
 * @example
 * sortSpec(index, 'created_at', 'desc')
 */
export function sortSpec(index: IndexDefinition, field: string, direction: string): SortSpec {
  allowedField(index, field, 'sortable')
  if (direction !== 'asc' && direction !== 'desc')
    throw new SearchError('invalid_filter', {
      field,
      detail: `the sort direction must be "asc" or "desc", not ${JSON.stringify(direction)}.`,
    })
  return { field, direction }
}

/** The tenant condition every search on a tenant index carries (added by search, never by callers). */
export function tenantCondition(index: IndexDefinition, tenant: string): FilterCondition {
  if (index.tenantField === undefined)
    throw new Error(`tenantCondition() called for ${index.model}, which has no tenants.`)
  return { field: index.tenantField, type: 'string', operator: 'eq', value: tenant }
}

function allowedField(
  index: IndexDefinition,
  field: string,
  role: 'filterable' | 'sortable',
): IndexField {
  const declared = index.fields.find((candidate) => candidate.name === field)
  if (typeof field !== 'string' || declared === undefined || !declared[role])
    throw new SearchError(role === 'filterable' ? 'not_filterable' : 'not_sortable', {
      field: printable(field),
      model: index.model,
    })
  return declared
}

function operand(
  index: IndexDefinition,
  field: IndexField,
  value: unknown,
  ordering: boolean,
): DocumentValue {
  if (value === null || value === undefined) {
    if (ordering)
      throw new SearchError('invalid_filter', {
        field: field.name,
        detail: 'null can only be compared with "eq" or "ne".',
      })
    return null
  }
  let converted: DocumentValue
  try {
    converted = toDocumentValue(index, field, value)
  } catch (error) {
    throw new SearchError(
      'invalid_filter',
      { field: field.name, detail: `the value is not ${typeName(field)}.` },
      { cause: error },
    )
  }
  if (typeof converted === 'string' && converted.length > MAX_FILTER_STRING)
    throw new SearchError('invalid_filter', {
      field: field.name,
      detail: `the value is longer than ${MAX_FILTER_STRING} characters.`,
    })
  return converted
}

function typeName(field: IndexField): string {
  return {
    string: 'text',
    int: 'an integer',
    float: 'a number',
    bool: 'true or false',
    datetime: 'a date',
  }[field.type]
}

/** A short, printable form of an untrusted name for messages. */
function printable(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean
}

// ---------------------------------------------------------------------------------------------
// Meilisearch
// ---------------------------------------------------------------------------------------------

/** Field names are validated identifiers; this re-checks it where the string is built. */
function assertFieldName(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field))
    throw new SearchError('invalid_filter', {
      field: printable(field),
      detail: 'not a field name.',
    })
  return field
}

/**
 * A string literal in Meilisearch's filter syntax: double quotes, with `\` and `"` escaped.
 *
 * @example
 * meiliString('say "hi"') // '"say \\"hi\\""'
 */
export function meiliString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function meiliValue(condition: FilterCondition, value: DocumentValue): string {
  if (typeof value === 'string') return meiliString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new SearchError('invalid_filter', { field: condition.field, detail: 'not a filter value.' })
}

const MEILI_COMPARE: Readonly<Record<Exclude<FilterOperator, 'in'>, string>> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

/**
 * Compile conditions to a Meilisearch filter expression (conditions joined with AND).
 *
 * @example
 * meiliFilter([{ field: 'status', type: 'string', operator: 'eq', value: 'published' }])
 * // 'status = "published"'
 */
export function meiliFilter(conditions: readonly FilterCondition[]): string | undefined {
  if (conditions.length === 0) return undefined
  return conditions
    .map((condition) => {
      const field = assertFieldName(condition.field)
      const { value, operator } = condition
      if (operator === 'in') {
        const list = Array.isArray(value) ? value : [value]
        const nonNull = list.filter((item): item is Exclude<DocumentValue, null> => item !== null)
        const parts: string[] = []
        if (nonNull.length > 0)
          parts.push(
            `${field} IN [${nonNull.map((item) => meiliValue(condition, item)).join(', ')}]`,
          )
        if (nonNull.length !== list.length) parts.push(`${field} IS NULL`)
        return parts.length === 1 ? (parts[0] ?? '') : `(${parts.join(' OR ')})`
      }
      if (Array.isArray(value))
        throw new SearchError('invalid_filter', { field, detail: 'a list needs "in".' })
      const single = value as DocumentValue
      if (single === null) return operator === 'ne' ? `${field} IS NOT NULL` : `${field} IS NULL`
      // "!=" alone also matches documents where the field is null; that is what `ne` means.
      return `${field} ${MEILI_COMPARE[operator]} ${meiliValue(condition, single)}`
    })
    .join(' AND ')
}

/** Sort keys in Meilisearch's syntax (`created_at:desc`). */
export function meiliSort(sort: readonly SortSpec[]): string[] {
  return sort.map((spec) => `${assertFieldName(spec.field)}:${spec.direction}`)
}

// ---------------------------------------------------------------------------------------------
// Typesense
// ---------------------------------------------------------------------------------------------

/**
 * A string literal in Typesense's `filter_by` syntax: wrapped in backticks, which makes commas,
 * brackets, `&&` and `||` inside it plain text. Typesense has no escape for a backtick inside a
 * backtick-quoted value, so such a value is refused (fail closed) rather than mangled.
 *
 * @example
 * typesenseString('a && b') // '`a && b`'
 */
export function typesenseString(field: string, value: string): string {
  if (value.includes('`'))
    throw new SearchError('unsafe_filter_value', {
      field,
      engine: 'typesense',
      detail: 'a backtick',
    })
  return `\`${value}\``
}

function typesenseValue(condition: FilterCondition, value: DocumentValue): string {
  if (typeof value === 'string') return typesenseString(condition.field, value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new SearchError('unsafe_filter_value', {
    field: condition.field,
    engine: 'typesense',
    detail: 'null (Typesense cannot filter on missing values)',
  })
}

const TYPESENSE_COMPARE: Readonly<Record<Exclude<FilterOperator, 'in'>, string>> = {
  eq: ':=',
  ne: ':!=',
  gt: ':>',
  gte: ':>=',
  lt: ':<',
  lte: ':<=',
}

/**
 * Compile conditions to a Typesense `filter_by` expression (conditions joined with `&&`).
 *
 * @example
 * typesenseFilter([{ field: 'status', type: 'string', operator: 'in', value: ['a', 'b'] }])
 * // 'status:=[`a`,`b`]'
 */
export function typesenseFilter(conditions: readonly FilterCondition[]): string | undefined {
  if (conditions.length === 0) return undefined
  return conditions
    .map((condition) => {
      const field = assertFieldName(condition.field)
      const { value, operator } = condition
      if (operator === 'in') {
        const list = Array.isArray(value) ? value : [value]
        return `${field}:=[${list.map((item: DocumentValue) => typesenseValue(condition, item)).join(',')}]`
      }
      if (Array.isArray(value))
        throw new SearchError('invalid_filter', { field, detail: 'a list needs "in".' })
      return `${field}${TYPESENSE_COMPARE[operator]}${typesenseValue(condition, value as DocumentValue)}`
    })
    .join(' && ')
}

/** Sort keys in Typesense's syntax (`created_at:desc`); Typesense accepts at most three. */
export function typesenseSort(sort: readonly SortSpec[]): string | undefined {
  if (sort.length === 0) return undefined
  if (sort.length > 3)
    throw new SearchError('invalid_filter', {
      field: sort[3]?.field ?? '',
      detail: 'Typesense sorts by at most three fields.',
    })
  return sort.map((spec) => `${assertFieldName(spec.field)}:${spec.direction}`).join(',')
}

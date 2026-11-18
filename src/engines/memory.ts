/**
 * The in-memory engine: a real index kept in the process, for tests and small single-process
 * apps (data is lost on restart; `node strut search:import` rebuilds it).
 *
 * It implements the whole engine contract (the same conformance suite runs against it, Meilisearch
 * and Typesense), so the after-commit sync, tenant isolation and filters are tested without a
 * server. Matching is deliberately simple and predictable: the text is split into words, and a
 * document matches when every word is a prefix of a word in one of its searchable fields
 * (case- and accent-insensitive). Relevance: the more words matched in earlier fields, the higher.
 *
 * @module
 */
import type {
  DocumentValue,
  EngineQuery,
  EngineResult,
  FilterCondition,
  IndexDefinition,
  SearchDocument,
  SearchEngine,
} from '../contract.ts'

/** Fold text for matching: lower case, accents removed. */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Split folded text into words (letters and digits). */
export function words(text: string): string[] {
  return foldText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Does one document pass one filter condition? Shared with tests as the reference semantics:
 * `ne` and `in` follow SQL-like rules except that `ne` also matches a missing (null) value, as
 * Meilisearch's `!=` does.
 */
export function matchesCondition(document: SearchDocument, condition: FilterCondition): boolean {
  const actual: DocumentValue = document[condition.field] ?? null
  const { operator, value } = condition
  if (operator === 'in') {
    const list = Array.isArray(value) ? value : [value]
    return list.some((item: DocumentValue) => item === actual)
  }
  const expected = value as DocumentValue
  switch (operator) {
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    default: {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false
      if (operator === 'gt') return actual > expected
      if (operator === 'gte') return actual >= expected
      if (operator === 'lt') return actual < expected
      return actual <= expected
    }
  }
}

/**
 * An engine that keeps its indexes in memory.
 *
 * @example
 * const manager = new SearchManager({ engine: new MemoryEngine() })
 */
export class MemoryEngine implements SearchEngine {
  readonly name: string = 'memory'
  readonly keepsIndex: boolean = true
  readonly #indexes = new Map<string, Map<string, SearchDocument>>()

  async ensureIndex(index: IndexDefinition): Promise<void> {
    this.#index(index)
  }

  async upsert(index: IndexDefinition, documents: readonly SearchDocument[]): Promise<void> {
    const store = this.#index(index)
    // A frozen copy: later changes to the caller's object never change the index.
    for (const document of documents) store.set(document.id, Object.freeze({ ...document }))
  }

  async remove(index: IndexDefinition, keys: readonly string[]): Promise<void> {
    const store = this.#index(index)
    for (const key of keys) store.delete(key)
  }

  async search(index: IndexDefinition, query: EngineQuery): Promise<EngineResult> {
    const store = this.#index(index)
    const terms = words(query.text)
    const searchable = index.fields.filter((field) => field.searchable).map((field) => field.name)
    const hits: { readonly document: SearchDocument; readonly score: number }[] = []
    for (const document of store.values()) {
      if (!query.filters.every((condition) => matchesCondition(document, condition))) continue
      const score = terms.length === 0 ? 0 : relevance(document, searchable, terms)
      if (score < 0) continue
      hits.push({ document, score })
    }
    hits.sort((a, b) => {
      for (const spec of query.sort) {
        const order = compareValues(a.document[spec.field] ?? null, b.document[spec.field] ?? null)
        if (order !== 0) return spec.direction === 'asc' ? order : -order
      }
      if (b.score !== a.score) return b.score - a.score
      return compareKeys(a.document.id, b.document.id)
    })
    return {
      keys: hits.slice(query.offset, query.offset + query.limit).map((hit) => hit.document.id),
      total: hits.length,
    }
  }

  async flush(index: IndexDefinition): Promise<void> {
    this.#index(index).clear()
  }

  /** How many documents an index holds (tests). */
  size(index: Pick<IndexDefinition, 'name'>): number {
    return this.#indexes.get(index.name)?.size ?? 0
  }

  /** A copy of one stored document (tests). */
  document(index: Pick<IndexDefinition, 'name'>, key: string): SearchDocument | undefined {
    const found = this.#indexes.get(index.name)?.get(key)
    return found === undefined ? undefined : { ...found }
  }

  #index(index: Pick<IndexDefinition, 'name'>): Map<string, SearchDocument> {
    let store = this.#indexes.get(index.name)
    if (store === undefined) {
      store = new Map()
      this.#indexes.set(index.name, store)
    }
    return store
  }
}

/**
 * -1 when some term matches nothing; otherwise a score that favours terms matched in earlier
 * (more important) fields.
 */
function relevance(
  document: SearchDocument,
  fields: readonly string[],
  terms: readonly string[],
): number {
  const fieldWords = fields.map((field) => {
    const value = document[field]
    return typeof value === 'string' ? words(value) : []
  })
  let score = 0
  for (const term of terms) {
    const position = fieldWords.findIndex((list) => list.some((word) => word.startsWith(term)))
    if (position === -1) return -1
    score += fields.length - position
  }
  return score
}

/** Order values of one field; nulls sort last in ascending order. */
function compareValues(a: DocumentValue, b: DocumentValue): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

/** Numeric keys in numeric order, others as text. */
function compareKeys(a: string, b: string): number {
  const x = Number(a)
  const y = Number(b)
  if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) return x - y
  return a < b ? -1 : a > b ? 1 : 0
}

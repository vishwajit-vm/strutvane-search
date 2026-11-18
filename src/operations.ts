/**
 * Whole-index operations: import every row (`node strut search:import`, `Post.makeAllSearchable()`)
 * and empty the index (`node strut search:flush`, `Post.removeAllFromSearch()`).
 *
 * **Import** reads the table in primary-key order, in chunks (`chunkSize`, default 500), so memory
 * stays flat on any table size and a failed run can simply be started again (every write is an
 * upsert by key: idempotent). Soft-deleted rows and rows `shouldBeSearchable` rejects are not
 * indexed; rejected rows are also removed, so an import repairs a stale index.
 *
 * **Tenancy.** On a tenant model, an import inside a tenant (`runWithTenant`, or `--tenant` on the
 * command) covers that tenant only. Without an active tenant it covers every tenant through the
 * ORM's audited bypass (`unsafeWithoutTenancy`, reported to `onUnsafeTenancy`); each document
 * still carries its own row's tenant, so searches stay isolated. On PostgreSQL, row-level security
 * still applies to that bypass unless the database role is exempt: import per tenant there.
 *
 * @module
 */
import { currentTenant } from '@strutvane/framework/database'
import type { SearchDocument } from './contract.ts'
import { buildDocument, documentKey } from './definition.ts'
import { currentSearch } from './manager.ts'
import { attribute } from './model.ts'
import { indexFor, requireSearchable } from './settings.ts'

/** Options for {@link importModel}. */
export interface ImportOptions {
  /** Rows per batch. Default: the manager's `chunkSize` (500). */
  readonly chunkSize?: number
  /** Called after each batch (the command prints progress). */
  readonly onProgress?: (progress: ImportReport) => void
}

/** What an import did. */
export interface ImportReport {
  /** Documents written to the index. */
  readonly indexed: number
  /** Rows `shouldBeSearchable` rejected (removed from the index). */
  readonly skipped: number
  /** `false` when the engine keeps no index (the database engine): nothing to import. */
  readonly applicable: boolean
}

/** The builder methods an import uses (the framework's `Builder` has them). */
interface ChunkQuery {
  where(column: string, operator: string, value: unknown): ChunkQuery
  orderBy(column: string, direction: 'asc' | 'desc'): ChunkQuery
  limit(count: number): ChunkQuery
  unsafeWithoutTenancy(reason: string): ChunkQuery
  get(): Promise<object[]>
}

/** Why an import may read every tenant's rows (recorded by the ORM's bypass audit hook). */
export const IMPORT_BYPASS_REASON =
  'search:import indexes every tenant (each document keeps its tenant)'

/**
 * Index every row of a searchable model.
 *
 * @example
 * const report = await importModel(Post)
 */
export async function importModel(
  model: unknown,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const searchable = requireSearchable(model)
  const manager = currentSearch()
  const index = indexFor(searchable, manager)
  const engine = await manager.ready(index)
  if (!engine.keepsIndex) return { indexed: 0, skipped: 0, applicable: false }
  const chunkSize = options.chunkSize ?? manager.chunkSize
  const { runtime, settings } = searchable
  const primaryKey = runtime.info().primaryKey.name
  const everyTenant = index.tenantField !== undefined && currentTenant() === undefined
  let indexed = 0
  let skipped = 0
  let after: unknown
  for (;;) {
    // The framework's Builder implements ChunkQuery at runtime (see the note in hydrate.ts).
    const query = runtime.query() as ChunkQuery
    if (everyTenant) query.unsafeWithoutTenancy(IMPORT_BYPASS_REASON)
    if (after !== undefined) query.where(primaryKey, '>', after)
    const rows = await query.orderBy(primaryKey, 'asc').limit(chunkSize).get()
    if (rows.length === 0) break
    const documents: SearchDocument[] = []
    const rejected: string[] = []
    for (const row of rows) {
      if (settings.shouldBeSearchable?.(row) === false)
        rejected.push(documentKey(attribute(row, primaryKey)))
      else documents.push(buildDocument(index, runtime, row))
    }
    if (documents.length > 0) await engine.upsert(index, documents)
    if (rejected.length > 0) await engine.remove(index, rejected)
    indexed += documents.length
    skipped += rejected.length
    options.onProgress?.({ indexed, skipped, applicable: true })
    after = attribute(rows[rows.length - 1] ?? {}, primaryKey)
    if (rows.length < chunkSize) break
  }
  return { indexed, skipped, applicable: true }
}

/**
 * Remove every document of a searchable model from its index.
 *
 * @example
 * await flushModel(Post)
 */
export async function flushModel(model: unknown): Promise<void> {
  const searchable = requireSearchable(model)
  const manager = currentSearch()
  const index = indexFor(searchable, manager)
  const engine = await manager.ready(index)
  await engine.flush(index)
  manager.forget(index.name)
}

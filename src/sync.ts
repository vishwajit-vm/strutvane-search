/**
 * Keeping the index in step with the database: what happens after a searchable model is saved,
 * deleted or restored, and when.
 *
 * **After the commit, never before.** An index write must not run while the database write could
 * still roll back, or search would show a row that never existed (or hide one that still does).
 * - Outside a transaction, `save()` has committed by the time it returns, so the index is written
 *   right after it.
 * - Inside {@link searchTransaction}, index writes are buffered and run only once the outermost
 *   transaction commits; a rollback (of the transaction or of a savepoint around the write)
 *   discards them.
 * - Inside a transaction opened some other way (`DB.transaction()`), this package can't see the
 *   commit: the framework's connection has no after-commit hook yet. The write then runs right
 *   away and a warning is logged once per model, pointing at `searchTransaction()`. Results stay
 *   safe even then: every hit is re-read from the database before it is returned (see
 *   `hydrate.ts`), so a rolled-back row can never be shown, only missed.
 *
 * **Failures after the commit** follow the manager's `onSyncError`: `report` (default) logs them
 * and lets the request finish (the row *is* saved; `node strut search:import` repairs the index),
 * `throw` lets them reach the caller.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { defaultConnection } from '@strutvane/framework/database'
import { type IndexJob, maybeCurrentSearch } from './manager.ts'

/** Inside {@link withoutSyncingToSearch}: model writes don't touch the index. */
const OFF = 'off'
const buffer = new AsyncLocalStorage<IndexJob[] | typeof OFF>()

/** Is syncing switched off for the current async call chain? */
export function syncingDisabled(): boolean {
  return buffer.getStore() === OFF
}

/**
 * Run `work` without saving and deleting models touching the index (Scout's
 * `withoutSyncingToSearch`): bulk seeding, data migrations, then one `search:import`.
 *
 * @example
 * await withoutSyncingToSearch(() => seedTenThousandPosts())
 */
export function withoutSyncingToSearch<TResult>(work: () => TResult): TResult {
  return buffer.run(OFF, work)
}

/**
 * Run `work` in a database transaction whose index writes wait for the commit (and are dropped on
 * a rollback). Nested calls become savepoints; their writes join the outer transaction's buffer
 * only if the savepoint succeeds.
 *
 * @example
 * await searchTransaction(async () => {
 *   const post = await Post.create({ title: 'Hello' })
 *   await post.tags().attach([1, 2])
 * }) // Post is indexed here, after COMMIT
 */
export async function searchTransaction<TResult>(work: () => Promise<TResult>): Promise<TResult> {
  const connection = defaultConnection()
  const parent = buffer.getStore()
  if (parent === OFF) return connection.transaction(work)
  const jobs: IndexJob[] = []
  const result = await connection.transaction(() => buffer.run(jobs, work))
  if (parent !== undefined) {
    // A savepoint inside an outer searchTransaction: only the outermost commit makes it durable.
    parent.push(...jobs)
    return result
  }
  const manager = maybeCurrentSearch()
  if (manager !== undefined) for (const job of jobs) await manager.dispatch(job)
  return result
}

/**
 * Queue an index job for after the commit, or run it now (see the module notes).
 *
 * @example
 * await afterCommit(job, 'Post')
 */
export async function afterCommit(job: IndexJob, model: string): Promise<void> {
  const pending = buffer.getStore()
  if (pending === OFF) return
  if (pending !== undefined) {
    pending.push(job)
    return
  }
  const manager = maybeCurrentSearch()
  if (manager === undefined) return
  if (defaultConnection().inTransaction())
    manager.warnOnce(
      `transaction:${model}`,
      'search: a searchable model was saved inside a transaction search cannot see the end of, so it was indexed before the commit. Wrap the transaction in searchTransaction() so a rollback cannot leave the index ahead of the database.',
      { model },
    )
  await manager.dispatch(job)
}

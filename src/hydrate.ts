/**
 * From engine hits back to model instances, safely.
 *
 * A search engine is a copy of the data, and a copy can be stale or wrong. So no hit is ever
 * returned as the engine stored it: every key is re-read from the database through the model's
 * ORM query, which applies
 * - the **tenant scope** (and PostgreSQL row-level security): a key from another tenant comes back
 *   empty even if an index mix-up returned it;
 * - **soft deletes and global scopes**: a deleted or out-of-scope row is not returned;
 * - the caller's own constraints (`.query((q) => q.wherePolicy(…))`);
 * and then, with `.for(user)`, the model policy's `view` check, deny by default.
 *
 * Results keep the engine's order. Rows that drop out are removed from the page, never replaced,
 * so a page can be shorter than asked; `total` is the engine's count.
 *
 * @module
 */
import type { AuthUser } from '@strutvane/framework'
import type { IndexDefinition } from './contract.ts'
import { documentKey, primaryKeyOf } from './definition.ts'
import { attribute, type ModelRuntime } from './model.ts'

/**
 * The visibility rule results are re-checked with: the same shape as a framework model policy
 * (`app/policies/post.policy.ts`), so the app's policy class can be passed as it is.
 *
 * @example
 * const policy: SearchPolicy<Post> = { view: (user, post) => post.author_id === user?.id }
 */
export interface SearchPolicy<TModel> {
  /** Runs first; `true`/`false` decides for every ability, `undefined` defers to `view`. */
  before?(user: AuthUser | null, ability: string): boolean | undefined
  /** May `user` see `model`? Only `true` allows. */
  view?(user: AuthUser | null, model: TModel): boolean | Promise<boolean>
}

/** A user and the policy their results are checked with. */
export interface Authorization<TModel> {
  readonly user: AuthUser | null
  readonly policy: SearchPolicy<TModel>
}

/**
 * The ORM query methods a `.query()` callback can use to narrow results (the framework's
 * `Builder` has these and more).
 */
export interface HydrateQuery {
  where(column: string, value: unknown): HydrateQuery
  where(column: string, operator: string, value: unknown): HydrateQuery
  whereIn(column: string, values: readonly unknown[]): HydrateQuery
  whereNull(column: string): HydrateQuery
  whereNotNull(column: string): HydrateQuery
  wherePolicy(filter: unknown, options: { readonly actor: unknown }): HydrateQuery
  with(...paths: string[]): HydrateQuery
  withCount(...names: string[]): HydrateQuery
}

/** The builder methods hydration calls itself. */
interface LoadQuery extends HydrateQuery {
  get(): Promise<object[]>
}

/**
 * Does the policy let `user` view `model`? The framework gate's semantics, deny by default:
 * `before()` decides when it answers, otherwise only a `view()` that returns exactly `true`
 * allows, and a missing `view()` denies.
 *
 * @example
 * await canView(policy, user, post)
 */
export async function canView<TModel>(
  policy: SearchPolicy<TModel>,
  user: AuthUser | null,
  model: TModel,
): Promise<boolean> {
  const early = policy.before?.(user, 'view')
  if (early !== undefined) return early === true
  if (typeof policy.view !== 'function') return false
  return (await policy.view(user, model)) === true
}

/**
 * Load the models behind `keys`, in that order, dropping any the database, the constraints or
 * the policy rule out.
 *
 * @example
 * const posts = await hydrate(index, runtime, ['7', '3'])
 */
export async function hydrate<TModel extends object>(
  index: IndexDefinition,
  model: ModelRuntime,
  keys: readonly string[],
  constrain?: (query: HydrateQuery) => void,
  authorization?: Authorization<TModel>,
): Promise<TModel[]> {
  if (keys.length === 0) return []
  const primaryKey = model.info().primaryKey.name
  // The framework's Builder implements LoadQuery at runtime; the app's typed builder can't be
  // named here because this package doesn't know the app's table types.
  const query = model.query() as LoadQuery
  query.whereIn(
    primaryKey,
    keys.map((key) => primaryKeyOf(index, key)),
  )
  constrain?.(query)
  const rows = await query.get()
  const byKey = new Map<string, TModel>()
  for (const row of rows) byKey.set(documentKey(attribute(row, primaryKey)), row as TModel)
  const ordered: TModel[] = []
  for (const key of keys) {
    const found = byKey.get(key)
    if (found === undefined) continue
    if (
      authorization !== undefined &&
      !(await canView(authorization.policy, authorization.user, found))
    )
      continue
    ordered.push(found)
  }
  return ordered
}

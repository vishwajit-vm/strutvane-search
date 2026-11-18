/**
 * The one error type of `@strutvane/search`, with stable lowercase codes (RFC-0003) and messages
 * from a catalog (never written inline at the throw site), each saying how to fix the problem.
 *
 * Why one class with a code instead of a class per failure: callers branch on `error.code`, the
 * HTTP layer maps `status` to an RFC 9457 problem, and adding a failure is one catalog line.
 *
 * @module
 */

/** Every failure this package reports, by stable code. */
export type SearchErrorCode =
  | 'not_configured'
  | 'invalid_config'
  | 'not_a_model'
  | 'not_searchable'
  | 'invalid_options'
  | 'unknown_field'
  | 'hidden_field'
  | 'unsupported_field'
  | 'not_filterable'
  | 'not_sortable'
  | 'invalid_filter'
  | 'unsafe_filter_value'
  | 'invalid_query'
  | 'invalid_page'
  | 'tenant_required'
  | 'policy_required'
  | 'secret_in_document'
  | 'invalid_document'
  | 'engine_failed'
  | 'unknown_model'

/** Parameters a message template may use. */
export type MessageParams = Readonly<Record<string, string | number>>

/**
 * The English message catalog. `{name}` placeholders are filled from the error's parameters.
 * Messages name the setting or call to change, so the reader can act on them.
 */
export const SEARCH_MESSAGES_EN: Readonly<Record<SearchErrorCode, string>> = Object.freeze({
  not_configured:
    'Search is not configured in this app. Run `node strut install:search` (it registers SearchServiceProvider and writes config/search.ts), or wrap scripts and tests in runWithSearch(manager, …).',
  invalid_config: 'config/search.ts: {detail}',
  not_a_model:
    "Searchable() needs a model class made with Model('table', …) from @strutvane/framework/database; got {got}.",
  not_searchable:
    '{model} is not searchable. Extend it with Searchable(Model(…), { searchable: [...] }) to index it.',
  invalid_options: '{model}: {detail}',
  unknown_field:
    '{model} lists "{field}" for search, but the table "{table}" has no such column.{hint}',
  hidden_field:
    '{model} lists "{field}" for search, but it is hidden or secret (the model\'s hidden list, .hidden()/.secret() in the migration, or a secret-looking name). Hidden columns are never sent to a search engine; remove it from the search options.',
  unsupported_field: '{model}: "{field}" is a {kind} column, which search can not {use}. {fix}',
  not_filterable:
    '"{field}" is not filterable on {model}. Add it to `filterable` in the Searchable options (and run node strut search:import {model}).',
  not_sortable:
    '"{field}" is not sortable on {model}. Add it to `sortable` in the Searchable options (and run node strut search:import {model}).',
  invalid_filter: 'The filter on "{field}" is invalid: {detail}',
  unsafe_filter_value:
    'The filter value for "{field}" contains characters the {engine} engine can not quote safely ({detail}), so the search was refused.',
  invalid_query: 'The search text is invalid: {detail}',
  invalid_page: 'Invalid pagination: {detail}',
  tenant_required:
    '{model} belongs to tenants, so searching or indexing it needs an active tenant. Run it inside a request of a tenant, or runWithTenant(tenantId, …).',
  policy_required:
    '{model}.search(…).for(user) needs a policy to re-check each result: pass one with .for(user, policy), or set `policy` in the Searchable options.',
  secret_in_document:
    '{model}: the search document has a value equal to the hidden column "{field}". Hidden and secret values are never indexed; fix toSearchableDocument().',
  invalid_document: '{model}: the search document is invalid: {detail}',
  engine_failed: 'The {engine} search engine failed while trying to {action}: {detail}',
  unknown_model:
    'No searchable model named "{model}" was found in app/models. Pass the class name (e.g. Post) of a model that extends Searchable(…).',
})

/** The HTTP status each code maps to when it reaches a response. */
const STATUS: Readonly<Record<SearchErrorCode, number>> = {
  not_configured: 500,
  invalid_config: 500,
  not_a_model: 500,
  not_searchable: 500,
  invalid_options: 500,
  unknown_field: 500,
  hidden_field: 500,
  unsupported_field: 500,
  not_filterable: 400,
  not_sortable: 400,
  invalid_filter: 400,
  unsafe_filter_value: 400,
  invalid_query: 400,
  invalid_page: 400,
  tenant_required: 500,
  policy_required: 500,
  secret_in_document: 500,
  invalid_document: 500,
  engine_failed: 503,
  unknown_model: 400,
}

/** Fill a template's `{name}` placeholders; unknown placeholders are left as they are. */
export function formatMessage(template: string, params: MessageParams): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => {
    const value = params[key]
    return value === undefined ? whole : String(value)
  })
}

/**
 * A search failure. `code` is stable (branch on it), `status` is the HTTP status it maps to, and
 * the message says how to fix it.
 *
 * @example
 * try { await Post.search(q).where('secret', 1).get() } catch (error) {
 *   if (error instanceof SearchError && error.code === 'not_filterable') …
 * }
 */
export class SearchError extends Error {
  override readonly name: string = 'SearchError'
  /** The stable failure code. */
  readonly code: SearchErrorCode
  /** The HTTP status this failure maps to (400 for bad input, 503 for an engine outage, 500 otherwise). */
  readonly status: number

  constructor(code: SearchErrorCode, params: MessageParams = {}, options?: ErrorOptions) {
    super(formatMessage(SEARCH_MESSAGES_EN[code], params), options)
    this.code = code
    this.status = STATUS[code]
  }
}

/**
 * Is `value` a {@link SearchError} (optionally with this code)?
 *
 * @example
 * if (isSearchError(error, 'tenant_required')) …
 */
export function isSearchError(value: unknown, code?: SearchErrorCode): value is SearchError {
  return value instanceof SearchError && (code === undefined || value.code === code)
}

/**
 * The two small source edits the installer makes in an app (blueprint §3.3: a package installs
 * itself completely), kept pure so they are easy to test:
 *
 * - `bootstrap/providers.ts`: import `SearchServiceProvider` and add it to the `providers` array.
 * - `config/index.ts`: import `config/search.ts` and list it under the `search` key.
 *
 * Every edit is text-level and minimal (one import line, one list item), so the developer's
 * formatting and comments stay untouched, and every edit is:
 * - **idempotent:** applying it to an already-edited file returns the file unchanged;
 * - **reversible:** the `remove*` function undoes exactly what the `add*` function added;
 * - **refused on an unknown shape:** when the file doesn't look like the skeleton's (not exactly
 *   one flat `const providers = [ … ]` array, or one flat `export default { … }` object), the
 *   function returns `undefined` and the installer prints the manual step instead of guessing.
 *
 * (`@strutvane/log-viewer` makes the same two edits with its own copy: add-ons never import each
 * other. A shared helper belongs in the framework's devkit; see NEXT.md.)
 *
 * @module
 */

/** The import specifier of the provider. */
export const PROVIDER_SPECIFIER = '@strutvane/search/provider'
/** The local name the provider is imported as. */
export const PROVIDER_LOCAL = 'SearchServiceProvider'
/** The local name (and config key) `config/search.ts` is imported as. */
export const CONFIG_LOCAL = 'search'
/** The config file's path relative to `config/index.ts`. */
export const CONFIG_SPECIFIER = './search.ts'

const PROVIDER_IMPORT = `import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}'`
const CONFIG_IMPORT = `import ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}'`

/** A top-level import statement, single- or multi-line, up to the end of its specifier's line. */
const IMPORT_STATEMENT = /^import\b[^'"]*['"][^'"\n]+['"][^\n]*\n/gm

/** The `providers` array of `bootstrap/providers.ts`: a flat list (no nested brackets). */
const PROVIDERS_ARRAY = /(\bconst\s+providers\b[^=]*=\s*\[)([^[\]]*)(\])/g

/** The `export default { … }` object of `config/index.ts`: a flat list of keys. */
const DEFAULT_OBJECT = /(\bexport\s+default\s+\{)([^{}]*)(\})/g

function addImport(source: string, line: string): string {
  const imports = [...source.matchAll(IMPORT_STATEMENT)]
  const last = imports.at(-1)
  if (last === undefined) return `${line}\n${source}`
  const at = last.index + last[0].length
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`
}

function removeImport(source: string, line: string): string {
  return source.replace(`${line}\n`, '')
}

/** Append an item to a bracketed list, following its layout (multi-line or inline, trailing comma). */
function appendItem(body: string, item: string): string {
  const trimmed = body.trimEnd()
  const tail = body.slice(trimmed.length)
  if (body.includes('\n')) {
    if (trimmed.trim() === '') return `\n  ${item},${tail}`
    const indent = /\n([ \t]*)\S/.exec(body)?.[1] ?? '  '
    return trimmed.endsWith(',')
      ? `${trimmed}\n${indent}${item},${tail}`
      : `${trimmed},\n${indent}${item}${tail}`
  }
  if (trimmed.trim() === '') return `${item}${body}`
  return trimmed.endsWith(',') ? `${trimmed} ${item},${tail}` : `${trimmed}, ${item}${tail}`
}

/** Remove exactly what {@link appendItem} added. */
function dropItem(body: string, item: string): string {
  const end = '(?![\\w$])'
  for (const pattern of [
    `\\n[ \\t]*${item}${end},`,
    `,\\n[ \\t]*${item}${end}`,
    `, ${item}${end}`,
    ` ${item}${end},`,
  ]) {
    const re = new RegExp(pattern)
    if (re.test(body)) return body.replace(re, '')
  }
  return body.trim() === item ? body.replace(item, '') : body
}

function editBody(
  source: string,
  pattern: RegExp,
  edit: (body: string) => string,
): string | undefined {
  const matches = [...source.matchAll(pattern)]
  const match = matches[0]
  if (matches.length !== 1 || match === undefined) return undefined
  const [whole, open = '', body = '', close = ''] = match
  return `${source.slice(0, match.index)}${open}${edit(body)}${close}${source.slice(match.index + whole.length)}`
}

function imports(source: string, specifier: string): boolean {
  return source.includes(`'${specifier}'`) || source.includes(`"${specifier}"`)
}

/**
 * Register the provider in `bootstrap/providers.ts`.
 *
 * @returns the edited source, the same source when already registered, or `undefined` for an
 *   unknown shape
 *
 * @example
 * addProvider("const providers = [AppServiceProvider]\n")
 */
export function addProvider(source: string): string | undefined {
  if (imports(source, PROVIDER_SPECIFIER)) return source
  const edited = editBody(source, PROVIDERS_ARRAY, (body) => appendItem(body, PROVIDER_LOCAL))
  return edited === undefined ? undefined : addImport(edited, PROVIDER_IMPORT)
}

/**
 * Undo {@link addProvider}.
 *
 * @example
 * removeProvider(addProvider(source) ?? source) === source
 */
export function removeProvider(source: string): string {
  if (!source.includes(PROVIDER_IMPORT)) return source
  const edited =
    editBody(source, PROVIDERS_ARRAY, (body) => dropItem(body, PROVIDER_LOCAL)) ?? source
  return removeImport(edited, PROVIDER_IMPORT)
}

/**
 * List `config/search.ts` in `config/index.ts` under the `search` key.
 *
 * @returns the edited source, the same source when already listed, or `undefined` for an
 *   unknown shape
 *
 * @example
 * addConfigKey("export default { app, logging } satisfies ConfigFiles\n")
 */
export function addConfigKey(source: string): string | undefined {
  if (imports(source, CONFIG_SPECIFIER)) return source
  const edited = editBody(source, DEFAULT_OBJECT, (body) => appendItem(body, CONFIG_LOCAL))
  return edited === undefined ? undefined : addImport(edited, CONFIG_IMPORT)
}

/**
 * Undo {@link addConfigKey}.
 *
 * @example
 * removeConfigKey(addConfigKey(source) ?? source) === source
 */
export function removeConfigKey(source: string): string {
  if (!source.includes(CONFIG_IMPORT)) return source
  const edited = editBody(source, DEFAULT_OBJECT, (body) => dropItem(body, CONFIG_LOCAL)) ?? source
  return removeImport(edited, CONFIG_IMPORT)
}

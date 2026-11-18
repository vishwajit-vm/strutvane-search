/**
 * `@strutvane/search/installer`: what `node strut install:search` (and `node strut add search`)
 * runs, declared as `strutvane.installer` in package.json (blueprint §3.3). It installs search
 * completely, in one transaction the framework's devkit previews (`--dry-run --diff`) and commits
 * or rolls back:
 *
 * 1. `config/search.ts`: the settings (kept if it exists: it is the app's).
 * 2. `config/index.ts`: lists it under the `search` key.
 * 3. `.env` / `.env.example`: `SEARCH_DRIVER` (from `--engine`: `meilisearch` by default, or
 *    `typesense` or `database`), `SEARCH_PREFIX`, and the chosen server's settings. Keys are never
 *    overwritten, and secret keys are written empty (never a real key in `.env.example`).
 * 4. `bootstrap/providers.ts`: registers `SearchServiceProvider` (an older app with a
 *    `strutvane.config.ts` gets it through the framework's config patcher instead).
 *
 * Install order never changes the result, running it twice changes nothing the second time, and a
 * file that doesn't look like the skeleton's is never guessed at: the installer prints the line to
 * add by hand instead. `uninstall` reverses steps 2–4 and keeps `config/search.ts`.
 *
 * @module
 */
import {
  type DevkitInstallContext,
  type DevkitInstaller,
  defineInstaller,
} from '@strutvane/framework/devkit'
import {
  addConfigKey,
  addProvider,
  CONFIG_LOCAL,
  CONFIG_SPECIFIER,
  PROVIDER_LOCAL,
  PROVIDER_SPECIFIER,
  removeConfigKey,
  removeProvider,
} from './install/patch.ts'

/** Where the installer writes and edits files, relative to the project root. */
export const INSTALL_PATHS = {
  config: 'config/search.ts',
  configIndex: 'config/index.ts',
  providers: 'bootstrap/providers.ts',
  legacyConfig: 'strutvane.config.ts',
} as const

/** The engines `--engine` accepts. */
export const INSTALL_ENGINES: readonly string[] = ['meilisearch', 'typesense', 'database']

/** Every `.env` key the installer may add (uninstall removes them). */
export const ENV_KEYS: readonly string[] = [
  'SEARCH_DRIVER',
  'SEARCH_PREFIX',
  'MEILISEARCH_HOST',
  'MEILISEARCH_KEY',
  'TYPESENSE_HOST',
  'TYPESENSE_PORT',
  'TYPESENSE_PROTOCOL',
  'TYPESENSE_API_KEY',
]

/** The `config/search.ts` the installer writes. */
export const CONFIG_TEMPLATE = `// Full-text search (@strutvane/search): which engine indexes your searchable models.
//
//   SEARCH_DRIVER=meilisearch   meilisearch, typesense, database (no server; SQL LIKE) or memory
//   SEARCH_PREFIX=              prepended to every index name (e.g. staging_)
//
// Make a model searchable in app/models, then fill the index with node strut search:import Post:
//
//   export class Post extends Searchable(Model('posts'), { searchable: ['title', 'body'] }) {}
import { defineConfig } from '@strutvane/framework'

export default defineConfig((env) => ({
  /** The engine. */
  driver: env.oneOf('SEARCH_DRIVER', ['meilisearch', 'typesense', 'database', 'memory'], 'database'),
  /** Prepended to every index name. Letters, digits, _ and - only. */
  prefix: env.string('SEARCH_PREFIX', ''),
  /** after-commit: saving or deleting a searchable model updates the index; off: never. */
  sync: env.oneOf('SEARCH_SYNC', ['after-commit', 'off'], 'after-commit'),
  /** report: a failed index write is logged and the request goes on; throw: it fails the request. */
  onSyncError: env.oneOf('SEARCH_SYNC_ERRORS', ['report', 'throw'], 'report'),
  /** Rows per batch for node strut search:import. */
  chunkSize: 500,
  /** Milliseconds before a request to the search server is abandoned. */
  timeoutMs: env.integer('SEARCH_TIMEOUT_MS', 5000),
  meilisearch: {
    host: env.string('MEILISEARCH_HOST', 'http://127.0.0.1:7700'),
    /** Required outside local development. */
    key: env.optional('MEILISEARCH_KEY'),
    /** Wait for each index write to finish, so a search right after a save sees it. */
    wait: true,
  },
  typesense: {
    host: env.string('TYPESENSE_HOST', '127.0.0.1'),
    port: env.integer('TYPESENSE_PORT', 8108),
    protocol: env.oneOf('TYPESENSE_PROTOCOL', ['http', 'https'], 'http'),
    /** Always required. */
    apiKey: env.optional('TYPESENSE_API_KEY'),
  },
}))
`

async function readIfExists(ctx: DevkitInstallContext, path: string): Promise<string | undefined> {
  return (await ctx.fs.exists(path)) ? ctx.fs.read(path) : undefined
}

/** The engine from `--engine` (the catalogue's follow-up question), meilisearch by default. */
export function chosenEngine(answers: Readonly<Record<string, unknown>>): string {
  const answer = answers['engine']
  if (answer === undefined || answer === true || answer === '') return 'meilisearch'
  if (typeof answer === 'string' && INSTALL_ENGINES.includes(answer)) return answer
  throw new Error(
    `--engine must be one of ${INSTALL_ENGINES.join(', ')}; got ${JSON.stringify(answer)}.`,
  )
}

async function registerConfig(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.configIndex)
  if (source === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} was not found, so search uses its defaults. To use ${INSTALL_PATHS.config}, import it as ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}' and add ${CONFIG_LOCAL} to your config files.`,
    )
    return
  }
  const edited = addConfigKey(source)
  if (edited === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} has an unexpected shape, so it was not changed. Add these two lines yourself: import ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}', and ${CONFIG_LOCAL} in the exported object.`,
    )
    return
  }
  if (edited !== source) await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
}

async function registerProvider(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.providers)
  if (source !== undefined) {
    const edited = addProvider(source)
    if (edited === undefined) {
      ctx.log.warn(
        `${INSTALL_PATHS.providers} has an unexpected shape, so it was not changed. Add the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}', and ${PROVIDER_LOCAL} in the providers array.`,
      )
      return
    }
    if (edited !== source) await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    return
  }
  if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig)) {
    await ctx.config.registerProvider(PROVIDER_SPECIFIER)
    return
  }
  ctx.log.warn(
    `Neither ${INSTALL_PATHS.providers} nor ${INSTALL_PATHS.legacyConfig} was found. Register the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}' and add it to your providers.`,
  )
}

async function addEnv(ctx: DevkitInstallContext, engine: string): Promise<void> {
  await ctx.env.add('Search (@strutvane/search)', [
    {
      key: 'SEARCH_DRIVER',
      value: engine,
      comment: 'meilisearch, typesense, database (no server) or memory.',
    },
    { key: 'SEARCH_PREFIX', value: '', comment: 'Prepended to every index name.' },
  ])
  if (engine === 'meilisearch')
    await ctx.env.add('Meilisearch', [
      { key: 'MEILISEARCH_HOST', value: 'http://127.0.0.1:7700' },
      {
        key: 'MEILISEARCH_KEY',
        value: '',
        comment: 'The master or an admin key. Required outside local development.',
      },
    ])
  if (engine === 'typesense')
    await ctx.env.add('Typesense', [
      { key: 'TYPESENSE_HOST', value: '127.0.0.1' },
      { key: 'TYPESENSE_PORT', value: '8108' },
      { key: 'TYPESENSE_PROTOCOL', value: 'http' },
      { key: 'TYPESENSE_API_KEY', value: '', comment: 'The admin API key. Always required.' },
    ])
}

/**
 * The installer, loaded by `node strut install:search`, `node strut add search` and
 * `node strut remove search`.
 *
 * @example
 * await runInstaller(installer, { projectRoot: '/srv/blog', answers: { engine: 'typesense' }, dryRun: true })
 */
export const installer: DevkitInstaller = defineInstaller({
  name: 'search',
  description: 'Full-text search for your models with Meilisearch, Typesense or the database.',
  async install(ctx: DevkitInstallContext): Promise<void> {
    const engine = chosenEngine(ctx.answers)
    if (!(await ctx.fs.exists(INSTALL_PATHS.config)))
      await ctx.fs.write(INSTALL_PATHS.config, CONFIG_TEMPLATE)
    await registerConfig(ctx)
    await addEnv(ctx, engine)
    await registerProvider(ctx)
    ctx.log.info(
      engine === 'database'
        ? 'Search uses the database engine: no server needed. Make a model searchable with Searchable(Model(…), { searchable: [...] }).'
        : `Search uses ${engine}: start the server, set its key in .env, then run node strut search:import <Model>.`,
    )
  },
  async uninstall(ctx: DevkitInstallContext): Promise<void> {
    const index = await readIfExists(ctx, INSTALL_PATHS.configIndex)
    if (index !== undefined) {
      const edited = removeConfigKey(index)
      if (edited !== index)
        await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
    }
    const providers = await readIfExists(ctx, INSTALL_PATHS.providers)
    if (providers !== undefined) {
      const edited = removeProvider(providers)
      if (edited !== providers)
        await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    } else if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig)) {
      await ctx.config.unregisterProvider(PROVIDER_SPECIFIER)
    }
    await ctx.env.remove(ENV_KEYS)
    ctx.log.info(`${INSTALL_PATHS.config} was kept: it may hold your settings.`)
  },
})

export default installer

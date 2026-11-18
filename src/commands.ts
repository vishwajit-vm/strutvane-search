/**
 * CLI commands contributed by `@strutvane/search` (package.json `strutvane.commands`), loaded by
 * the project's `node strut` from the app's `node_modules`:
 *
 * - `search:import <Model>`: index every row of a searchable model (in chunks; safe to re-run).
 *   `--tenant <uuid>` limits it to one tenant.
 * - `search:flush <Model>`: remove every document of the model from its index.
 * - `install:search`: run the installer (config, `.env`, provider), `--engine meilisearch|typesense|database`.
 *
 * The model argument is a class name (`Post`, `BlogPost`) or file name (`blog-post`) of a model
 * in `app/models`. Only a file inside `app/models` (after following symlinks) is ever imported.
 * Exit codes follow the CLI: 0 success, 2 usage, 3 validation, 1 failure.
 *
 * @module
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Application, loadApplication } from '@strutvane/framework'
import { runWithTenant } from '@strutvane/framework/database'
import { runInstaller } from '@strutvane/framework/devkit'
import { isSearchError } from './errors.ts'
import { installer } from './installer.ts'
import { flushModel, importModel } from './operations.ts'
import { searchableModel } from './settings.ts'

/** The parts of the CLI's command context these commands use. */
export interface SearchCommandContext {
  readonly args: Readonly<Record<string, string | string[] | undefined>>
  readonly flags: Readonly<Record<string, string | boolean | string[] | undefined>>
  readonly extraFlags: Readonly<Record<string, string | boolean>>
  readonly globals: { readonly dryRun: boolean }
  requireProject(): {
    readonly root: string
    readonly packageJson: Readonly<Record<string, unknown>>
  }
  readonly out: {
    line(text?: string): void
    success(text: string): void
    info(text: string): void
    warn(text: string): void
  }
}

/** What a command returns (the CLI's `CommandOutcome`). */
export interface SearchCommandOutcome {
  readonly exitCode?: 0 | 1 | 2 | 3
  readonly data?: unknown
}

/** A contributed command, in the CLI's shape. */
export interface SearchCommand {
  readonly name: string
  readonly description: string
  readonly details?: string
  readonly examples?: readonly string[]
  readonly allowUnknownFlags?: boolean
  readonly args?: Readonly<
    Record<string, { readonly required?: boolean; readonly description?: string }>
  >
  readonly flags?: Readonly<
    Record<string, { readonly type: 'boolean' | 'string'; readonly description?: string }>
  >
  run(ctx: SearchCommandContext): Promise<SearchCommandOutcome | undefined>
}

/** What the commands need from the outside world (tests replace the app loader). */
export interface SearchCommandDeps {
  readonly loadApp: (root: string) => Promise<Application>
}

const DEFAULT_DEPS: SearchCommandDeps = { loadApp: loadApplication }

const MODEL_ARGUMENT = /^[A-Za-z][A-Za-z0-9-]{0,99}$/
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTENSIONS = ['ts', 'mts', 'js', 'mjs']

/** `BlogPost` / `blogPost` / `blog-post` → `blog-post`. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** `blog-post` / `blogPost` → `BlogPost`. */
export function pascal(name: string): string {
  return kebab(name)
    .split('-')
    .filter((part) => part !== '')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

/** A usage problem: printed, with exit code 2. */
class UsageProblem extends Error {}

/**
 * Find and import a searchable model class of the app by name. Only files directly in
 * `app/models` (real path inside it) are considered.
 *
 * @example
 * const Post = await loadModel('/srv/blog', 'Post')
 */
export async function loadModel(root: string, name: string): Promise<unknown> {
  if (!MODEL_ARGUMENT.test(name))
    throw new UsageProblem(`"${name}" is not a model name. Pass a class name such as Post.`)
  const folder = join(root, 'app', 'models')
  if (!existsSync(folder)) throw new UsageProblem(`${join('app', 'models')} does not exist.`)
  const realFolder = realpathSync(folder)
  const file = EXTENSIONS.map((extension) => join(folder, `${kebab(name)}.${extension}`)).find(
    (candidate) => existsSync(candidate),
  )
  if (file === undefined)
    throw new UsageProblem(`No ${join('app', 'models', `${kebab(name)}.ts`)} was found.`)
  const real = realpathSync(file)
  const inside = relative(realFolder, real)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || !statSync(real).isFile())
    throw new UsageProblem(`${file} resolves outside ${join('app', 'models')}; it was not loaded.`)
  const module: Record<string, unknown> = await import(pathToFileURL(real).href)
  const preferred = module[pascal(name)] ?? module['default']
  if (searchableModel(preferred) !== undefined) return preferred
  const found = Object.values(module).filter((value) => searchableModel(value) !== undefined)
  if (found.length === 1) return found[0]
  throw new UsageProblem(
    `${relative(root, real)} exports no searchable model named ${pascal(name)}. Extend it with Searchable(Model(…), { searchable: [...] }).`,
  )
}

/** Boot the app, run `work` inside it, always shut it down. */
async function withApp<TResult>(
  root: string,
  deps: SearchCommandDeps,
  work: (app: Application) => Promise<TResult>,
): Promise<TResult> {
  const app = await deps.loadApp(root)
  try {
    await app.boot()
    return await app.run(() => work(app))
  } finally {
    if (app.state === 'booted') await app.shutdown()
  }
}

/** Expected failures become a message and an exit code; anything else is the CLI's to report. */
async function guarded(
  ctx: SearchCommandContext,
  run: () => Promise<SearchCommandOutcome>,
): Promise<SearchCommandOutcome> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof UsageProblem) {
      ctx.out.warn(error.message)
      return { exitCode: 2 }
    }
    if (isSearchError(error)) {
      ctx.out.warn(error.message)
      return { exitCode: error.status === 503 ? 1 : 3, data: { code: error.code } }
    }
    throw error
  }
}

function modelArgument(ctx: SearchCommandContext): string {
  const value = ctx.args['model']
  if (typeof value !== 'string' || value === '') throw new UsageProblem('Pass a model, e.g. Post.')
  return value
}

/**
 * The `search:import` command.
 *
 * @example
 * importCommand().run(ctx)
 */
export function importCommand(deps: SearchCommandDeps = DEFAULT_DEPS): SearchCommand {
  return {
    name: 'search:import',
    description: 'Index every searchable record of a model',
    details:
      'Reads the table in primary-key order, in chunks, and upserts every row into the search index (safe to run again). On a tenant model it covers every tenant, or one with --tenant.',
    args: { model: { required: true, description: 'The model class, e.g. Post' } },
    flags: {
      tenant: { type: 'string', description: 'Only this tenant (its UUID)' },
      chunk: { type: 'string', description: 'Rows per batch (default: config search.chunkSize)' },
    },
    examples: ['node strut search:import Post', 'node strut search:import Project --tenant <uuid>'],
    run: (ctx) =>
      guarded(ctx, async () => {
        const root = ctx.requireProject().root
        const name = modelArgument(ctx)
        const tenant = ctx.flags['tenant']
        if (tenant !== undefined && (typeof tenant !== 'string' || !TENANT.test(tenant)))
          throw new UsageProblem('--tenant must be a tenant id (a UUID).')
        const chunk = ctx.flags['chunk']
        const chunkSize = chunk === undefined ? undefined : Number(chunk)
        if (
          chunkSize !== undefined &&
          (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 10_000)
        )
          throw new UsageProblem('--chunk must be a whole number from 1 to 10000.')
        const model = await loadModel(root, name)
        const report = await withApp(root, deps, () => {
          const work = () =>
            importModel(model, {
              ...(chunkSize === undefined ? {} : { chunkSize }),
              onProgress: (progress) => ctx.out.line(`  ${progress.indexed} indexed`),
            })
          return typeof tenant === 'string' ? runWithTenant(tenant, work) : work()
        })
        if (!report.applicable) {
          ctx.out.info(
            'The search engine is the database: there is no index to fill, searches read the table directly.',
          )
          return { data: report }
        }
        ctx.out.success(
          `${report.indexed} ${pascal(name)} record(s) indexed${report.skipped > 0 ? `, ${report.skipped} skipped by shouldBeSearchable` : ''}.`,
        )
        return { data: report }
      }),
  }
}

/**
 * The `search:flush` command.
 *
 * @example
 * flushCommand().run(ctx)
 */
export function flushCommand(deps: SearchCommandDeps = DEFAULT_DEPS): SearchCommand {
  return {
    name: 'search:flush',
    description: 'Remove every record of a model from the search index',
    details:
      "Empties the model's index on the search server (every tenant). The database is not touched; run search:import to fill the index again.",
    args: { model: { required: true, description: 'The model class, e.g. Post' } },
    examples: ['node strut search:flush Post'],
    run: (ctx) =>
      guarded(ctx, async () => {
        const root = ctx.requireProject().root
        const name = modelArgument(ctx)
        const model = await loadModel(root, name)
        await withApp(root, deps, () => flushModel(model))
        ctx.out.success(
          `The ${pascal(name)} index is empty. Run node strut search:import ${pascal(name)} to fill it.`,
        )
        return { data: { flushed: pascal(name) } }
      }),
  }
}

/**
 * The `install:search` command: runs the package's installer (what `node strut add search` runs
 * after installing the package).
 *
 * @example
 * installCommand().run(ctx)
 */
export function installCommand(): SearchCommand {
  return {
    name: 'install:search',
    description: 'Set up search: config/search.ts, .env keys and the service provider',
    details:
      'Pass --engine meilisearch (default), typesense or database. Previews with --dry-run --diff; running it again changes nothing.',
    allowUnknownFlags: true,
    examples: [
      'node strut install:search',
      'node strut install:search --engine typesense --dry-run',
    ],
    run: (ctx) =>
      guarded(ctx, async () => {
        const project = ctx.requireProject()
        const dependencies = {
          ...asRecord(project.packageJson['dependencies']),
          ...asRecord(project.packageJson['devDependencies']),
        }
        let result: Awaited<ReturnType<typeof runInstaller>>
        try {
          result = await runInstaller(installer, {
            projectRoot: project.root,
            answers: ctx.extraFlags,
            dryRun: ctx.globals.dryRun,
            installedPackages: Object.keys(dependencies),
            logger: { info: (m) => ctx.out.info(m), warn: (m) => ctx.out.warn(m) },
          })
        } catch (error) {
          if (error instanceof Error && /--engine/.test(error.message))
            throw new UsageProblem(error.message)
          throw error
        }
        for (const change of result.changes)
          ctx.out.line(`  ${result.dryRun ? `would ${change.kind}` : change.kind} ${change.path}`)
        ctx.out.success(
          result.dryRun
            ? `Dry run: ${result.changes.length} change(s), nothing written.`
            : `Search is installed (${result.changes.length} file(s) changed).`,
        )
        return {
          data: {
            dryRun: result.dryRun,
            changes: result.changes.map((change) => ({ path: change.path, kind: change.kind })),
          },
        }
      }),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The commands the CLI loads (its default export). */
const commands: readonly SearchCommand[] = [importCommand(), flushCommand(), installCommand()]

export default commands

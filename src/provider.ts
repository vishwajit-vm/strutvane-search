/**
 * `@strutvane/search/provider`: the service provider an app lists in `bootstrap/providers.ts`
 * (`node strut install:search` adds it).
 *
 * It binds the app's {@link SearchManager} to `SearchManagerToken` (integration map: container
 * tokens), built from `config/search.ts` (key `search`) and logging through the framework's
 * `LoggerToken` (ADR-0022: no `console`, redaction always on). The engine is created on first
 * use, so booting never connects to a search server; a misconfigured `config/search.ts` fails the
 * boot, naming the setting.
 *
 * Failure scenarios:
 * - **No `config/search.ts`:** the defaults (the database engine, no prefix).
 * - **An invalid setting or a server engine without its key outside local development:** the boot
 *   fails with `SearchError('invalid_config')`.
 * - **The search server is down:** saves go on (the failure is logged, `onSyncError: 'report'`),
 *   searches fail with `engine_failed` (HTTP 503).
 *
 * @module
 */
import { type Application, ServiceProvider } from '@strutvane/framework'
import { LoggerToken } from '@strutvane/framework/core'
import { createEngine, resolveSearchConfig } from './config.ts'
import { SearchManager, SearchManagerToken } from './manager.ts'

/** The config key the installer registers `config/search.ts` under. */
export const CONFIG_KEY = 'search'

/**
 * Search for a Strutvane app: binds the search manager from `config/search.ts`.
 *
 * @example
 * // bootstrap/providers.ts
 * import SearchServiceProvider from '@strutvane/search/provider'
 * const providers = [AppServiceProvider, SearchServiceProvider]
 */
export class SearchServiceProvider extends ServiceProvider {
  override register(app: Application): void {
    app.container.singleton(SearchManagerToken, () => {
      const config = resolveSearchConfig(
        app.configRepository.has(CONFIG_KEY) ? app.config(CONFIG_KEY) : {},
      )
      return new SearchManager({
        engine: () => createEngine(config, { environment: app.environment }),
        prefix: config.prefix,
        sync: config.sync,
        onSyncError: config.onSyncError,
        chunkSize: config.chunkSize,
        logger: () => app.make(LoggerToken),
      })
    })
  }

  override boot(app: Application): void {
    // Resolve once at boot, so a bad config/search.ts fails the boot instead of the first search.
    app.make(SearchManagerToken)
  }

  override async shutdown(app: Application): Promise<void> {
    if (app.container.has(SearchManagerToken)) await app.make(SearchManagerToken).close()
  }
}

export default SearchServiceProvider

import { defineConfig } from 'tsdown'

// One entry per public subpath. The engines with a client of their own live on subpaths
// (`/meilisearch`, `/typesense`) so an app only loads the client of the engine it uses. The
// framework and the Meilisearch client stay external: they are peers, and an app must have exactly
// one copy of the framework (container tokens and `instanceof ModelBase` rely on it).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    meilisearch: 'src/engines/meilisearch.ts',
    typesense: 'src/engines/typesense.ts',
    provider: 'src/provider.ts',
    commands: 'src/commands.ts',
    installer: 'src/installer.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^@strutvane\//, 'meilisearch'],
  },
})

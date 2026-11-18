import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. Shared defaults come from strutvane-tooling.
// - The real-server suites (test/servers) start throwaway Meilisearch and Typesense containers;
//   pulling an image or waiting for a server to be ready can take far longer than 5 s.
// - Each test file gets its own in-memory SQLite database, so files run in parallel safely.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  }),
)

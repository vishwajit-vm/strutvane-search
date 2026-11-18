# Contributing to @strutvane/search

Thanks for your interest! `@strutvane/search` is the full-text search add-on of
[Strutvane](https://github.com/vishwajit-vm/strutvane): Laravel Scout's flow for TypeScript
models, on Meilisearch, Typesense or the database.

## Before you start

Read `.claude/ECOSYSTEM.md` (the rules every Strutvane repo follows) and this repo's `CLAUDE.md`.
Search is an add-on: it depends only on the published `@strutvane/framework` (peer + dev
dependency), never on another add-on, and connects to apps only through the integration map's
connections (container tokens, the installer, contributed commands).

## Workflow

```bash
npm ci              # npm >= 11.19 (devEngines); never pnpm or yarn
npm run ci          # biome → tsc → vitest with coverage → build
```

- The real-server suites (`test/servers`) start throwaway Meilisearch and Typesense containers
  when Docker can run Linux containers, and skip with the reason otherwise.
- Every behaviour has a test; every security fix ships with a test for its whole class.
- Public API changes need TSDoc (what, why, an example) and a README update.
- Add a changeset for anything that changes the published package: `npx changeset`.
- Conventional commits, signed off (`git commit -s`).

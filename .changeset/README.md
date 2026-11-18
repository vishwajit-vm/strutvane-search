# Changesets

Every pull request that changes the published package adds a changeset:

```bash
npx changeset
```

Pick the bump type and describe the change for users. Before 1.0, breaking changes ride a
`minor` bump (blueprint §8, consistency decision 128), never `major`. The release workflow turns
pending changesets into a version bump and a CHANGELOG entry, then publishes to npm.

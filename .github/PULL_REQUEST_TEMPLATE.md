## What & why
<!-- What does this change and why? Link the issue/RFC. -->

## Checklist
- [ ] Tests added or updated (including attack-style tests for tenancy, hidden columns and filters)
- [ ] Hidden and secret columns still never reach an engine; tenant filter still added by search only
- [ ] README updated for any public API change
- [ ] Changeset added (`npx changeset`)
- [ ] No secrets, `.env` or Docker files committed
- [ ] Respects package boundaries (`@strutvane/framework` as a peer only; no other add-on imported)

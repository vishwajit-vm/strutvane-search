# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub security advisories](https://github.com/vishwajit-vm/strutvane-search/security/advisories/new),
not in public issues. You will get an answer within a few days.

## Scope

`@strutvane/search` copies application data into a search engine and serves results back to
users, so relevant issues include anything that:

- sends a hidden or secret column (or any undeclared column) to a search engine;
- returns one tenant's rows to another tenant, or a row a policy denies;
- lets request input change a filter's meaning (filter injection) or name a non-allow-listed field;
- leaks an engine key or URL credentials into logs, errors or responses;
- lets a model name passed to `search:import` / `search:flush` load a file outside `app/models`.

## Supported versions

Search has not been released yet (`0.2.0-next.N` pre-releases). Once 1.0 ships, the supported
versions and LTS policy will be published here and in the
[docs](https://github.com/vishwajit-vm/strutvane/blob/main/docs/10-repositories-publishing-versioning.md).

---
'@nxgt/mongo-search-kit': patch
---

Docs: each entry's sync now takes a lease on its name (from `@nxgt/mongo-meilisearch` 0.3.0), so a second process is refused with `RUNNING` and `leaseMs` is an entry option; `LEASE_LOST` can reject `failed`. The "no lock today" trap is gone.

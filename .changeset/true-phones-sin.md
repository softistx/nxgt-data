---
---

CI only: nothing is published by this change.

The four server binaries the specs need — mongod, Meilisearch, SeaweedFS and
a Redis compiled from source — were cached by a workflow that ran on
`pull_request` alone, so every cache landed under `refs/pull/<N>/merge`,
which no other branch can read. Every run started cold and did four downloads
and a build in parallel before the first test. Measured: 173 cache entries,
seven separate copies of mongod, and nothing on `refs/heads/develop` but the
`bun-` one.

CI now also runs on a push to `develop`, which fills that scope once per
merge; every pull request after it starts warm.

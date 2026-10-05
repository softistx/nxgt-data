# `@nxgt/mongo-meilisearch` documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one.

| Page | Read it when |
| --- | --- |
| [The sync's lifecycle](guide/sync-lifecycle.md) | you are wiring one collection to an index for the first time, or looking for an option and its default |
| [Wiring it over a Mongo](guide/search-syncs/wiring.md) | one config has to follow several collections: an index and a transform each, under the keys `openMongo` wires, with `createSearchSyncs` |
| [The search syncs' lifecycle](guide/search-syncs/lifecycle.md) | you are reindexing, starting the syncs of several collections at once, watching for a failure, or shutting the process down |
| [Reindexing](guide/reindex.md) | the index has to be filled, or refilled, from the collection |
| [Following changes](guide/following-changes.md) | a process has to keep the index in step, and stop cleanly; several processes run the same sync and one must follow; or it stopped and you need to know why |
| [What it leaves out](guide/boundaries.md) | you want to know what the lease on a sync name does not give, are about to join another collection in, or wonder who applies the index settings |
| [Troubleshooting](troubleshooting.md) | something threw, and you have the message |
| [Roadmap](roadmap.md) | you want to know what is coming, and what will not |

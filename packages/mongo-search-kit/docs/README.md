# `@nxgt/mongo-search-kit` documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one.

| Page | Read it when |
| --- | --- |
| [Wiring it over a Mongo kit](guide/wiring.md) | you are writing the config: one entry per collection, its index and its transform |
| [The kit's lifecycle](guide/lifecycle.md) | you are reindexing, starting the syncs, watching for a failure, or shutting the process down |
| [Troubleshooting](troubleshooting.md) | something threw, and you have the message |
| [Roadmap](roadmap.md) | you want to know what is coming, and what will not |

Each entry's sync is [`@nxgt/mongo-meilisearch`](https://www.npmjs.com/package/@nxgt/mongo-meilisearch)'s,
unchanged: its own docs cover the transform, the batches, the resume point
and the errors this kit passes through.

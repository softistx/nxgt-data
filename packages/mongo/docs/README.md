# @nxgt/mongo documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one — the options, the defaults,
the errors, and the second example.

| Page | Read it when |
| --- | --- |
| [Collections and definitions](guide/collections.md) | you are describing a collection: its schema, its stamps, its indexes, its validator |
| [Documents](guide/documents.md) | you are reading and writing — and passing it the strings that arrive over HTTP |
| [Upsert](guide/upsert.md) | one write has to insert or change, in one round trip |
| [Hooks](guide/hooks.md) | something must happen around every write: a normalised field, an audit line, a tenant |
| [Sync](guide/sync.md) | the validator and the indexes have to be on the server, in a deploy or in a test |
| [Pagination](guide/pagination.md) | a list endpoint, by page number or by cursor |
| [Transactions and locking](guide/transactions.md) | several writes must stand or fall together, or two writers race on one document |
| [Change subscriptions](guide/changes.md) | something else has to hear about every change, and pick up where it left off |
| [Aggregation](guide/aggregation.md) | distinct values, counts per group, or related documents beside the ones you read |
| [Errors](guide/errors.md) | you are turning a failed write into an HTTP answer |
| [Connecting](guide/connecting.md) | opening the client, health checks, shutting down, and running tests against a real MongoDB |
| [Migrations](guide/migrations.md) | documents have to be rewritten, in order, once, and recorded |
| [Files (GridFS)](guide/gridfs.md) | files live in MongoDB: uploading, serving ranges, storing the same bytes once |
| [Wiring: configuration](guide/wiring/configuration.md) | you describe an application's databases and collections once, with `defineMongo`, one database or several |
| [Wiring: the `db` scope](guide/wiring/db-scope.md) | you read `mongo.db.users`, reach for what only the driver's `Db` has, or build a `Mongo` per request |
| [Wiring: the actor, sessions and transactions](guide/wiring/actor-and-transactions.md) | a write has to be stamped with who made it, or several writes across collections and buckets commit together |
| [Wiring: syncing](guide/wiring/sync.md) | `mongo.sync()` has to put every wired collection on the server, as a deployment step |
| [Wiring: files](guide/wiring/files.md) | GridFS buckets are wired beside the collections, in the same transactions, with `syncBuckets()` |
| [Wiring: health](guide/wiring/health.md) | a health endpoint has to say whether each database answers, and how fast |
| [Wiring: `discoverCollections`](guide/wiring/discover-collections.md) | a script has to find a repository's definitions without importing each one (Bun only) |
| [Troubleshooting](troubleshooting.md) | you have an error message, or a warning in the log, and want the fix |
| [Roadmap](roadmap.md) | you want to know what is coming, and what will not |

The wiring pages are the long form of the README's quick start: `defineMongo`
and `openMongo` over everything the other pages describe. Their refusals,
`WiringError`, are in [Errors](guide/errors.md#wiring-errors).

Every example is TypeScript, imports from `@nxgt/mongo` — or
`@nxgt/mongo/migrations`, `@nxgt/mongo/gridfs` — and assumes a `db` from
[Connecting](guide/connecting.md) and the definitions of
[Collections](guide/collections.md).

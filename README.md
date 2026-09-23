# nxgt-data

Data access for TypeScript apps: the code written around every table, once.

| Package | | |
| --- | --- | --- |
| [`@nxgt/drizzle`](packages/drizzle) | typed repositories over Drizzle ORM tables, offset and cursor pagination, transactions, database errors you can `instanceof`, and the columns every table has. PostgreSQL first | [npm](https://www.npmjs.com/package/@nxgt/drizzle) |
| [`@nxgt/drizzle-meilisearch`](packages/drizzle-meilisearch) | keeps a Meilisearch index in step with a PostgreSQL table: a transform typed by both sides, a full reindex that also takes out what the table no longer holds, and one call per write. No change feed, and none pretended | [npm](https://www.npmjs.com/package/@nxgt/drizzle-meilisearch) |
| [`@nxgt/meilisearch`](packages/meilisearch) | a typed Meilisearch index on the official SDK: one definition for its uid, primary key and settings, settings synced idempotently, and documents and searches typed by it | [npm](https://www.npmjs.com/package/@nxgt/meilisearch) |
| [`@nxgt/mongo`](packages/mongo) | a typed MongoDB collection from one Zod schema: the same schema types the documents and becomes the collection's `$jsonSchema` validator, synced with its indexes and MongoDB's own collection options, plus a collection that carries the driver's own methods, with pagination, soft delete, optimistic locking and transactions | [npm](https://www.npmjs.com/package/@nxgt/mongo) |
| [`@nxgt/mongo-meilisearch`](packages/mongo-meilisearch) | keeps a Meilisearch index in step with a MongoDB collection: a transform typed by both definitions, a full reindex, and a change stream that resumes where it stopped | [npm](https://www.npmjs.com/package/@nxgt/mongo-meilisearch) |
| [`@nxgt/mongo-kit`](packages/mongo-kit) | an application's MongoDB wiring in one object: a configuration checked once, the clients it opens from it, and every collection typed on the driver's own `Db` — `db.users` — with the actor, the session and transactions carried for you | [npm](https://www.npmjs.com/package/@nxgt/mongo-kit) |
| [`@nxgt/mongo-search-kit`](packages/mongo-search-kit) | a search kit over that wiring: one entry per collection — an index and a transform — and one `reindexAll`, `start` and `close` for all of them | [npm](https://www.npmjs.com/package/@nxgt/mongo-search-kit) |
| [`@nxgt/redis`](packages/redis) | Redis on Bun's own client: one connection shared per URI, typed caches and channels, and a lock that is safe to release | [npm](https://www.npmjs.com/package/@nxgt/redis) |
| [`@nxgt/redis-guard`](packages/redis-guard) | guards on Bun's own Redis client: rate limits described once and checked by one atomic script, timed by the Redis server's clock, with the delay to wait on every answer | [npm](https://www.npmjs.com/package/@nxgt/redis-guard) |
| [`@nxgt/redis-kit`](packages/redis-kit) | an application's Redis wiring in one object: a configuration checked once, the clients it opens from it, and every cache and channel typed under the key it is exported as — `kit.cache.users` — with the deployment's prefix in front of every key, plus the lock, the health check and the subscriptions it closes | [npm](https://www.npmjs.com/package/@nxgt/redis-kit) |
| [`@nxgt/s3`](packages/s3) | S3 on Bun's own client: a bucket described once, keys built by a typed function, uploads refused before they are sent, and presigned URLs from the same definition | [npm](https://www.npmjs.com/package/@nxgt/s3) |

Each package's README, its npm page, shows how to use it, then documents
every function, class and type it exports in its **API** section.

`examples/` holds applications built on them, which are not published:
[`examples/hono-api`](examples/hono-api) is a Hono API on `@nxgt/mongo-kit`
whose routes come from an OpenAPI spec.

## Development

Bun 1.4.2.

```sh
bun install
bun run build        # first: exports point at dist/
bun run typecheck
bun run test         # PostgreSQL in process (PGlite), a real Meilisearch and a real mongod: no Docker
bun run verify:artifacts
./node_modules/.bin/biome check --write
```

A change under `packages/` needs a changeset (`bun changeset`). Merging to
`develop` opens a "Version packages" PR, and merging that PR publishes.
[AGENTS.md](AGENTS.md) explains why each of these steps exists.

## License

[MIT](LICENSE), for every package.

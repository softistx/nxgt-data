# nxgt-data

Data access for TypeScript apps: the code written around every table, once.

| Package | | |
| --- | --- | --- |
| [`@nxgt/drizzle`](packages/drizzle) | typed repositories over Drizzle ORM tables, offset and cursor pagination, transactions, database errors you can `instanceof`, and the columns every table has. PostgreSQL first | [npm](https://www.npmjs.com/package/@nxgt/drizzle) |
| [`@nxgt/meilisearch`](packages/meilisearch) | a typed Meilisearch index on the official SDK: one definition for its uid, primary key and settings, settings synced idempotently, and documents and searches typed by it | [npm](https://www.npmjs.com/package/@nxgt/meilisearch) |
| [`@nxgt/mongo`](packages/mongo) | a typed MongoDB collection from one Zod schema: the same schema types the documents and becomes the collection's `$jsonSchema` validator, synced with its indexes and MongoDB's own collection options, plus a collection that carries the driver's own methods, with pagination, soft delete, optimistic locking and transactions | [npm](https://www.npmjs.com/package/@nxgt/mongo) |
| [`@nxgt/mongo-meilisearch`](packages/mongo-meilisearch) | keeps a Meilisearch index in step with a MongoDB collection: a transform typed by both definitions, a full reindex, and a change stream that resumes where it stopped | [npm](https://www.npmjs.com/package/@nxgt/mongo-meilisearch) |
| [`@nxgt/mongo-kit`](packages/mongo-kit) | an application's MongoDB wiring in one object: a configuration checked once, the clients it opens from it, and every collection typed on the driver's own `Db` — `db.users` — with the actor, the session and transactions carried for you | [npm](https://www.npmjs.com/package/@nxgt/mongo-kit) |

Each package's README, its npm page, shows how to use it, then documents
every function, class and type it exports in its **API** section.

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

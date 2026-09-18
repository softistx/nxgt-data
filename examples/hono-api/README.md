# A Hono API on `@nxgt/mongo-kit`

A small blog — users and articles — written to show what the kit wires in a
real application: one configuration, a **kit per request** carrying the
author, and the collections typed on the driver's own `Db`.

The OpenAPI spec is the source of the routes:
[`@nxgt/openapi-codegen`](https://www.npmjs.com/package/@nxgt/openapi-codegen)
generates the types and validators from `openapi/openapi.yaml`, and
[`@nxgt/openapi-hono`](https://www.npmjs.com/package/@nxgt/openapi-hono) binds
them to Hono, so a request the spec refuses never reaches a handler and a
reply the spec does not declare does not compile.

> This example is **not published**: it is `private`, outside `packages/`,
> and the release scripts never see it.

## Run it

```sh
bun install                      # from the repository root
bun run --filter hono-api-example generate:api
MONGO_URI=mongodb://127.0.0.1:27017/blog bun run --filter hono-api-example sync
MONGO_URI=mongodb://127.0.0.1:27017/blog bun run --filter hono-api-example dev
```

```sh
curl -X POST localhost:3000/users -H 'x-user-id: 68ca1f0f2b1c4d5e6f7a8b90' \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
```

`bun run --filter hono-api-example test` needs no server of its own: the spec
starts a mongod in memory, as the packages' specs do.

## What to look at

| File | What it shows |
| --- | --- |
| `src/db.ts` | the whole configuration: one `defineConfig`, the collections as a module object, the options every collection gets |
| `src/models/*.model.ts` | the definitions, and the module that gathers them — `db.users` comes from the name a definition is **exported** under, not from its collection name |
| `src/app.ts` | `kit.as(actor)` once per request, put on the context. A handler gets the collections already stamping this user, and never the root kit — so it cannot write as anyone else, nor close it |
| `src/routes/articles.ts` | `paginate` behind a paged reply, a **transaction** across two collections, and a soft delete |
| `src/routes/users.ts` | the boundary between the stored document and the API document, written once |
| `src/index.ts` | the kit opened **once** for the process, closed on `SIGINT`/`SIGTERM` |
| `src/sync.ts` | `kit.sync()` as a deployment step, with `--dry-run` |
| `src/app.spec.ts` | the whole thing over a mongod in memory, called as a client would |

## The wiring, in one page

```ts
// src/db.ts — the application's MongoDB, described once
export const config = defineConfig({
	uri: process.env.MONGO_URI!,
	collections,                       // import * as collections from './models'
	options: { maxPageSize: 50 },
});

// src/app.ts — one kit per request, carrying who is writing
app.use('*', async (c, next) => {
	const actor = tryObjectId(c.req.header('x-user-id'));
	if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
	const asUser = kit.as(actor);
	c.set('kit', asUser);
	c.set('db', asUser.db);
	await next();
});

// src/routes/articles.ts — two collections, one transaction
const written = await c.get('kit').transaction(async (tx) => {
	const author = await tx.db.users.findById(c.get('actor'));
	if (!author) return null;
	const article = await tx.db.articles.create(body);
	await tx.db.users.update(author._id, { articles: author.articles + 1 });
	return article;
});
```

Nothing carries a session or a client by hand: `as` gives another kit over
the same clients, and the transaction's kit puts every collection it touches
in the session.

## The spec

`openapi/` is split the way the applications here split it — a root document
with `$ref`s into `paths/` and `components/` — and `redocly.yaml` lints it
with Redocly's `recommended` ruleset, run by the generator before it writes:

```sh
bun run --filter hono-api-example generate:api   # lints, then writes src/generated
bun run --filter hono-api-example check:api      # writes nothing, exits 1 if stale
```

`src/generated/` is **git-ignored** and rebuilt before every typecheck and
test run, so the spec is the only source in the repository.

Two rules are set in `redocly.yaml`, and both are worth reading: the actor is
declared as a `securityScheme` rather than a header parameter, because it is
the credential; and `operation-4xx-response` is off, because the generator
declares the 400 of a refused request itself, on every operation that takes
an input.

For the docs site — `redocly preview` and `redocly build-docs` — add
`@redocly/cli`; the generator needs only `@redocly/openapi-core`, which is
here.

## Traps this example was written to avoid

- **The kit is opened once**, not per request. A kit per request would open a
  client per request; `as` is what a request costs.
- **A handler never sees the root kit.** It cannot write as another user, and
  `close()` on a derived kit throws.
- **The transaction body may run twice.** The driver retries it, so the
  article count is read *inside* the transaction, never from something the
  handler kept.
- **`autoSync` is not what a deployment does.** It syncs once per collection
  and per process, so the specs call `kit.sync()` after they drop the
  database; production runs `bun run sync`.
- **The stored document is not the API document.** `_id` is an `ObjectId`
  and the stamps are `Date`s; the mapping to what the spec declares is
  written once per collection.

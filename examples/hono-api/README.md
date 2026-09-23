# A Hono API on `@nxgt/mongo-kit`

A small blog — users and articles — written to show what the kit wires in a
real application: one configuration, a **kit per request** carrying the
author, services that take that kit, and the collections typed on the
driver's own `Db`.

Writing an article is guarded by
[`@nxgt/redis-guard`](../../packages/redis-guard/README.md), on a Redis:
**five writes a minute per user**, with the `RateLimit-*` headers and a 429,
and an **`Idempotency-Key`** that makes a retried write publish once — see
[The guards](#the-guards).

It is laid out **by module**, not by layer: everything about users sits in
`src/modules/users/`, and a module exports its own Hono app rather than
being handed one.

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
bun run --filter hono-api-example sync      # MONGO_URI defaults to localhost
bun run --filter hono-api-example dev
```

It needs a **MongoDB** replica set (writing an article is a transaction) and
a **Redis** — 7.x, or anything that runs Lua scripts and `TIME`, since every
guard is a script on the server:

```sh
docker run --rm -d -p 6379:6379 redis:7.4   # or any redis-server you have
```

`MONGO_URI`, `REDIS_URL`, `PORT` and `NODE_ENV` all have defaults —
`REDIS_URL` is `redis://127.0.0.1:6379` — so it starts with none of them set;
each is declared in `bun.d.ts` and parsed in `src/env.ts`.

```sh
curl -X POST localhost:3000/users -H 'x-user-id: 68ca1f0f2b1c4d5e6f7a8b90' \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'

# The id comes back as a string, and goes back as one: nothing parses it.
curl -X PATCH localhost:3000/users/<id> -H 'x-user-id: <id>' \
  -H 'content-type: application/json' -d '{"name":"Ada Lovelace"}'

# Send it twice: one article, and the second answer says it is a replay.
curl -i -X POST localhost:3000/articles -H 'x-user-id: <id>' \
  -H 'Idempotency-Key: 5f1c…' \
  -H 'content-type: application/json' -d '{"title":"On wiring","body":"One object."}'
```

`bun run --filter hono-api-example test` needs no server of its own: the
specs start a mongod in memory and a Redis on a free port, as the packages'
specs do. Its `test` script runs `scripts/redis.ts` first, which **compiles**
the repository's one pinned Redis into `.cache/redis` — nobody publishes a
prebuilt one — so the first run on a fresh checkout takes a few minutes and
every later one none. The script prints the binary's path, and the `test`
script hands it to the specs as `$REDIS_BIN`; a bare `bun test` has no
Redis to start and says so. Set `REDIS_BIN` yourself to use another
`redis-server`.

## The layout

```
bun.d.ts            the names this app reads from the environment
src/
  env.ts            the only file that reads `Bun.env`, parsed with zod
  db.ts             the configuration, and the `Kit` type read from it
  collections.ts    where the modules' models meet the kit
  api.ts            the spec's registry, shared by every module
  context.ts        what a request carries: the modules' services and guards, composed
  guards.ts         the HTTP side of the guards: milliseconds to headers
  app.ts            the middlewares, and the modules mounted
  middlewares/      what every request goes through, one file per concern
  modules/
    index.ts        the one list of mounted modules
    users/          users.model.ts · users.service.ts · users.route.ts (+ .spec.ts)
    articles/       articles.model.ts · articles.service.ts · articles.route.ts (+ .spec.ts)
                    articles.guards.ts (+ .spec.ts)
test/
  kit.ts            a mongod and a kit per spec file
  redis.ts          a Redis per spec file, emptied before each test
  api.ts            both, plus the built app
  types/routes.ts   what the types refuse, never run
```

A subject is one folder, and the three files are always the same three: what
is stored, what is done, what is served — each with its spec beside it, so a
module is measured where it is read.

## What to look at

| File | What it shows |
| --- | --- |
| `bun.d.ts` | `declare module 'bun'`: what `Bun.env` holds for this app, at the package root so TypeScript sweeps it up |
| `src/env.ts` | the environment parsed once with zod — enums, `z.coerce.number()`, a default per variable, `safeParse` and a readable refusal. Nothing else reads `Bun.env` |
| `src/db.ts` | the whole configuration: one `defineConfig`, the collections as a module object, the options every collection gets, and `Kit` derived from it with `KitOf` |
| `src/collections.ts` | the one module `defineConfig` reads — `db.users` comes from the name a definition is **exported** under, not from its collection name |
| `src/modules/<name>/<name>.model.ts` | the definitions, each beside the service that uses it |
| `src/modules/<name>/<name>.service.ts` | the work, as a **class whose constructor takes the kit**, so the same service is built from a request, a script or a test. Its writes take the **validated body** (`NewUser`, `NewArticle`, `UserPatch`, `ArticlePatch`), never the stored document. `paginate`, a **transaction** across two collections, an `update` that stamps `updatedAt` and `updatedBy` on its own, a soft delete |
| `src/modules/<name>/<name>.route.ts` | the controllers, on the module's **own** `Hono`, exported as `router`: validated input in, a reply the spec declares out, and the boundary between the stored document and the API document |
| `src/modules/<name>/index.ts` | what the module offers the rest of the app, its `router` included |
| `src/modules/index.ts` | the one list of mounted modules. Adding a module is a line here, and forgetting it is a **startup** error, not a 404 |
| `src/middlewares/` | what every request goes through, one file per concern — `provideServices(kit)`, which also puts the checked user on the context as `actor`, and `provideGuards(guards)` |
| `src/api.ts` | one registry for the spec, imported by each module — `tag: 'users'` bounds a module to its own operations, and `api.assertComplete()` refuses to start with one nobody serves |
| `src/context.ts` | `Env`, `buildServices(kit)` and `bindGuards(redis)` — it only **composes** the slices each module declares, so a new module is one line here and nothing else |
| `src/modules/articles/articles.guards.ts` | the module's guards, described once: `defineRateLimit` keyed on the user, `defineIdempotency` keyed on the user **and** the key, its result checked by the spec's own `zArticle` — and `ArticleGuards`, which binds both to one `RedisClient` |
| `src/guards.ts` | the guide's HTTP recipe: `rateLimitHeaders(result)` and `seconds(ms)`, rounding **up** |
| `src/app.ts` | the middlewares, then every module in `src/modules/index.ts` mounted. It holds no middleware and no route of its own. `assertServed` reads the assembled app, so a module left out of that list is a startup error |
| `src/index.ts` | the kit and the Redis client opened **once** for the process, closed on `SIGINT`/`SIGTERM` |
| `src/sync.ts` | `kit.sync()` as a deployment step, with `--dry-run` |
| `src/modules/<name>/<name>.service.spec.ts` | the module's services with no HTTP at all — that is what the layer buys |
| `src/modules/<name>/<name>.route.spec.ts` | the module's routes over HTTP, called as a client would, over a mongod in memory |
| `src/modules/articles/articles.guards.spec.ts` | the guards over HTTP, against a real Redis: the headers counting down and the 429, a bucket per user, the replay and its header, the 422 (a re-spaced body included), the 500 for an `INVALID` record and for an error that is not a `GuardError`, and the 409 — two concurrent requests, the first held inside its write by a gate |
| `src/app.spec.ts` | what is left over: the middleware every request goes through, and that the mounted modules serve the whole spec |
| `test/kit.ts` | one mongod and one kit per spec file, the database emptied and synced before each test |
| `test/redis.ts` | one Redis per spec file, `FLUSHDB` before each test, started from the binary `$REDIS_BIN` names — it pins no version and builds nothing |
| `test/api.ts` | both, plus the built app: `call(path, { as })`, a user to send requests as, and `callWith(options)` for a second app on the same servers |
| `test/types/routes.ts` | the `@ts-expect-error`s: the users module cannot register `/articles`, a service takes the API's types, and a guard's key needs the user. Nothing imports it — `tsc --noEmit` reading it is the test |

## The wiring, in one page

```ts
// src/db.ts — the application's MongoDB, described once
export const config = defineConfig({
	uri: process.env.MONGO_URI!,
	collections,                       // import * as collections from './collections'
	options: { maxPageSize: 50 },
});
export type Kit = KitOf<typeof config>;

// src/modules/articles/articles.route.ts — the module's own app, exported
export const router = new Hono<Env>();
const routes = api.routes(router, { tag: 'articles' });

routes.patch('/articles/{id}', async (c) => {   // the shape of every route
	const written = await c
		.get('services')
		.articles.edit(c.req.valid('param').id, c.req.valid('json'));
	if (!written) return c.json({ message: 'errors.not-found' }, 404);
	return c.json(toArticle(written), 200);
});
// `POST /articles` adds the guards — see "The guards" below.

// src/middlewares/services.ts — one kit per request, bound into the services
export const provideServices = (kit: Kit) =>
	createMiddleware<Env>(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		c.set('actor', actor.toHexString());   // what a guard keys on
		await next();
	});

// src/modules/index.ts — the one list of what is mounted
export const routes = { articles, users };

// src/app.ts — the middlewares, then every module in that list
app.use(provideServices(kit));
app.use(provideGuards(bindGuards(redis)));    // bound once, shared by every request
for (const router of Object.values(routes)) app.route('/', router);
api.assertComplete();   // every operation has a handler
assertServed(app);      // and every handler is actually mounted

// src/modules/articles/articles.service.ts — the kit in the constructor,
// the validated body in, two collections, one transaction
export class ArticleService {
	constructor(private readonly kit: Kit) {}

	async write(values: NewArticle) {            // the spec's body, already checked
		const author = this.kit.actor;             // the kit carries who writes
		if (!author) throw new TypeError('ArticleService.write: this kit stamps nobody');
		return this.kit.transaction(async (tx) => {
			const user = await tx.db.users.findById(author);
			if (!user) return undefined;
			const article = await tx.db.articles.create(values);
			await tx.db.users.update(user._id, { articles: user.articles + 1 });
			return article;
		});
	}
}
```

Nothing carries a session or a client by hand: `as` gives another kit over
the same clients, and the transaction's kit puts every collection it touches
in the session.

## The environment

One module reads it, once, and everything else reads that module:

```ts
// bun.d.ts — the names, at the package root
declare module 'bun' {
	interface Env {
		/** Server */
		PORT: string;
		/** Database */
		MONGO_URI: string;
		/** Redis, for the rate limit and the idempotency keys */
		REDIS_URL: string;
	}
}

// src/env.ts — the values, parsed
const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.coerce.number().default(3000),
	MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/blog'),
	REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
});

export type Env = z.infer<typeof envSchema>;

const parseEnv = (value: Record<keyof Env, string | undefined>): Env => {
	const result = envSchema.safeParse(value);
	if (!result.success) {
		console.error('❌ Invalid environment variables:');
		console.error(z.prettifyError(result.error));
		throw new Error('Invalid environment variables');
	}
	return result.data;
};

export const env = parseEnv({
	NODE_ENV: Bun.env.NODE_ENV,
	PORT: Bun.env.PORT,
	MONGO_URI: Bun.env.MONGO_URI,
	REDIS_URL: Bun.env.REDIS_URL,
});
```

The map is explicit rather than `Bun.env` as a whole, and typed by the
schema's own keys, so the two ways it can rot are compile errors:

```
Property 'MONGO_URI' is missing … but required in type
  'Record<"NODE_ENV" | "PORT" | "MONGO_URI" | "REDIS_URL", string | undefined>'
Object literal may only specify known properties, and 'LOG_LEVEL' does not
  exist in type 'Record<"NODE_ENV" | "PORT" | "MONGO_URI" | "REDIS_URL", string | undefined>'
```

`PORT=abc bun src/index.ts` stops before it opens a connection:

```
❌ Invalid environment variables:
✖ Invalid input: expected number, received NaN
  → at PORT
```

## The server

`src/index.ts` opens the kit and the Redis client, hands the app to
`Bun.serve`, and gives the clients back on a signal:

```ts
const kit = await createKit(config);
const redis = new RedisClient(env.REDIS_URL);   // Bun's own; no driver
await redis.connect();

const server = serve({
	fetch: buildApp(kit, redis).fetch,
	port: env.PORT,
	hostname: '0.0.0.0',
	development: env.NODE_ENV !== 'production' && { hmr: true, console: true },
});

console.log(`🚀 Server running at ${server.url} ${env.NODE_ENV}`);
```

## The guards

`POST /articles` is the one guarded route: it writes, in a transaction that
also raises the author's count, so it is what a client hammering or retrying
would do real damage with. Both guards are
[`@nxgt/redis-guard`](../../packages/redis-guard/README.md)'s, each a Lua
script timed by the Redis server's clock, and the route follows its guides'
HTTP recipes
([rate limits](../../packages/redis-guard/docs/guide/rate-limits.md#http-headers-for-any-framework),
[idempotency](../../packages/redis-guard/docs/guide/idempotency.md#http-the-idempotency-key-header-for-any-framework)).

```ts
// src/modules/articles/articles.guards.ts — described once, bound once per app
export const articleWrites = defineRateLimit({
	name: 'articles.write',
	key: (params: { user: string }) => params.user,
	limit: 5,
	per: 60_000,
});

export const articleCreation = defineIdempotency({
	name: 'articles.create',
	key: (params: { user: string; key: string }) => `${params.user}/${params.key}`,
	ttl: 86_400,                     // a retry within a day gets the replay
	lease: 10_000,
	schema: zArticle.nullable(),     // the spec's own schema; null is the 404
});
```

What `POST /articles` answers, in the order it decides:

| Request | Status | Headers |
| --- | --- | --- |
| a sixth write within the minute | **429** `errors.rate-limited`, nothing written | `RateLimit-*`, `Retry-After` |
| no `Idempotency-Key` | 201 — every request writes | `RateLimit-*` |
| a new key | 201 — written once | `RateLimit-*` |
| the same key and body again | the **same** status and body as the first time | `RateLimit-*`, `Idempotent-Replayed: true` |
| the same key while the first still runs | **409** `errors.idempotency-in-progress`, after waiting up to 2 s for the replay | `RateLimit-*`, `Retry-After` |
| the same key, another body | **422** `errors.idempotency-key-reused` | `RateLimit-*` |

- **Keyed on the user**, both of them. The rate limit counts per user, not
  per address: `x-user-id` is this API's credential, and an address from an
  `x-forwarded-for` no proxy of yours set is whatever the client wants, a
  fresh bucket per value. The idempotency key is the user's **and** the
  client's key: an `Idempotency-Key` is unique only to whoever made it up.
- **The limit is counted first.** A denied write takes no idempotency key,
  so the same request, retried once the bucket refills, writes; a replay is
  a request too, and counts. So a client whose 201 was lost can spend its
  retries on replays and get a 429, which hides the stored result until the
  bucket refills.
- **The fingerprint is the raw body**, `c.req.text()` — the validator read
  the body through `c.req`, which keeps the text for the next reader. The
  same fields in another order are another request, and a 422. Never
  `JSON.stringify` of the parsed body: it depends on key order and on what
  the parser dropped.
- **Only a `GuardError` is mapped**, and only `IN_PROGRESS` and `MISMATCH`.
  Anything else — the write failing, Redis down, `INVALID`, `LEASE_LOST` —
  goes on to Hono's error handler and is a 500: `LEASE_LOST` means the write
  may have happened twice, which is an alert, not an answer.
- **A 404 is a result.** An author who is no user is a `null` result,
  stored and replayed like an article, so a retry is the same 404 rather
  than a second try.

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

The spec's `tags` are the modules' names, which is what lets each module take
`{ tag: 'users' }` and be bounded to its own operations.

Two rules are set in `redocly.yaml`, and both are worth reading: the actor is
declared as a `securityScheme` rather than a header parameter, because it is
the credential; and `operation-4xx-response` is off, because the generator
declares the 400 of a refused request itself, on every operation that takes
an input.

For the docs site — `redocly preview` and `redocly build-docs` — add
`@redocly/cli`; the generator needs only `@redocly/openapi-core`, which is
here.

## Traps this example was written to avoid

- **One module reads the environment.** `Bun.env` appears in `src/env.ts`
  and nowhere else, so nothing downstream can read a variable that was never
  declared, never parsed and never defaulted.
- **The parsed port is the port that binds.** Bun reads `PORT` on its own if
  `serve()` is not given one, which would make the schema's default a
  decoration; `port: env.PORT` is what keeps `PORT=abc` a startup error.
- **The kit is opened once**, not per request. A kit per request would open a
  client per request; `as` is what a request costs.
- **A handler never sees the root kit.** It cannot write as another user, and
  `close()` on a derived kit throws.
- **A module exports its app; it is not handed one.** `api` is a module of
  its own, so a route file is the whole of what its module serves, and
  `app.ts` only mounts. `tag` is what keeps it honest: registering
  `/articles` from the users module does not compile, which
  `test/types/routes.ts` measures.
- **Registering is not mounting.** A module registers its routes as it is
  imported, so `api.assertComplete()` passes the moment the file is loaded —
  even under a wrong prefix, or with nothing mounted at all. `assertServed`
  reads the assembled app for that. Mount order is what decides between two
  modules that could match one path, and `src/modules/index.ts` is an object
  literal precisely so that order is the one it is written in.
- **The transaction body may run twice.** The driver retries it, so the
  article count is read *inside* the transaction, never from something the
  handler kept.
- **`autoSync` is not what a deployment does.** It syncs once per collection
  and per process, so the specs call `kit.sync()` after they drop the
  database; production runs `bun run sync`.
- **The stored document is not the API document.** `_id` is an `ObjectId`
  and the stamps are `Date`s; the mapping to what the spec declares is the
  controller's, written once per collection.
- **A patch names the fields it moves, and the collection stamps the rest.**
  `PATCH /users/{id}` takes `UserPatch`, whose properties are the ones the API
  offers; `updatedAt` and `updatedBy` are written by `@nxgt/mongo` from the
  kit's actor, so no handler and no service spells them, and `createdAt` never
  moves. A body that names no field is allowed and changes only `updatedAt` —
  the spec says `minProperties: 1` nowhere, because the generator does not
  enforce it and a README that claimed it would be wrong.
- **A path id goes to the collection as the string it arrived as.**
  `@nxgt/mongo` reads its schema and converts it, so nothing in a handler
  parses an id; one that is no id matches nothing, which is the same 404 as
  a document that is not there. The header is the exception: `tryObjectId`
  checks `x-user-id` in the middleware, because an actor nobody can name is
  a 401 and not an empty result.
- **A service holds the kit it was built on, and nothing else.** Its only
  state is that constructor argument, so `buildServices(kit)` is one `new`
  per module per request and a service is as callable from a script or a
  test as from a handler — `new ArticleService(kit)` is the whole setup.
  A field on the class that is not the kit is state a request would leak
  into the next one.
- **A service takes the API's types, not the collection's.** `create` and
  `write` accept `NewUser` and `NewArticle`, the bodies the spec declares
  and the router has already validated. That is what stops a handler
  smuggling `articles` or `createdBy` into a write: those are the
  collection's default and the kit's stamp, and neither is anybody's to
  pass. `test/types/routes.ts` pins all four refusals.
- **A service that announces a promise rejects**, never throws at the call
  site: `ArticleService.write` is `async` for that reason alone, and its
  spec measures it.
- **The guards are bound once, not per request.** Unlike a service, a guard
  holds no user — it is keyed by one on each call — and binding sends
  nothing to Redis, so `bindGuards(redis)` runs in `buildApp` and every
  request shares the result.
- **Headers are delays in whole seconds, rounded up.** `@nxgt/redis-guard`
  answers in milliseconds; `Retry-After: 11` for 11 001 ms would tell a
  client to come back a millisecond early, so `seconds(ms)` is a
  `Math.ceil`. None is a date: the client counts from when it read the reply,
  and no two clocks have to agree.
- **A 409's `Retry-After` is when the first run's lease lapses unless
  renewed**, 10 s here — a live run renews it, so a client that retries then
  may get another 409. The 2 s `wait` is what answers most repeats with the
  replay instead.

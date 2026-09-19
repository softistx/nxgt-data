# A Hono API on `@nxgt/mongo-kit`

A small blog — users and articles — written to show what the kit wires in a
real application: one configuration, a **kit per request** carrying the
author, services that take that kit, and the collections typed on the
driver's own `Db`.

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

`MONGO_URI`, `PORT` and `NODE_ENV` all have defaults, so it starts with none
of them set; each is declared in `bun.d.ts` and parsed in `src/env.ts`.

```sh
curl -X POST localhost:3000/users -H 'x-user-id: 68ca1f0f2b1c4d5e6f7a8b90' \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
```

`bun run --filter hono-api-example test` needs no server of its own: the spec
starts a mongod in memory, as the packages' specs do.

## The layout

```
bun.d.ts            the names this app reads from the environment
src/
  env.ts            the only file that reads `Bun.env`, parsed with zod
  db.ts             the configuration, and the `Kit` type read from it
  collections.ts    where the modules' models meet the kit
  api.ts            the spec's registry, shared by every module
  context.ts        what a request carries: the modules' services, composed
  app.ts            the middlewares, and the modules mounted
  middlewares/      what every request goes through, one file per concern
  modules/
    index.ts        the one list of mounted modules
    users/          users.model.ts · users.service.ts · users.route.ts (+ .spec.ts)
    articles/       articles.model.ts · articles.service.ts · articles.route.ts (+ .spec.ts)
test/
  kit.ts            a mongod and a kit per spec file
  api.ts            the same, plus the built app
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
| `src/modules/<name>/<name>.service.ts` | the work, as a **class whose constructor takes the kit**, so the same service is built from a request, a script or a test. Its writes take the **validated body** (`NewUser`, `NewArticle`), never the stored document. `paginate`, a **transaction** across two collections, a soft delete |
| `src/modules/<name>/<name>.route.ts` | the controllers, on the module's **own** `Hono`, exported as `router`: validated input in, a reply the spec declares out, and the boundary between the stored document and the API document |
| `src/modules/<name>/index.ts` | what the module offers the rest of the app, its `router` included |
| `src/modules/index.ts` | the one list of mounted modules. Adding a module is a line here, and forgetting it is a **startup** error, not a 404 |
| `src/middlewares/` | what every request goes through, one file per concern — `provideServices(kit)` is the only one today |
| `src/api.ts` | one registry for the spec, imported by each module — `tag: 'users'` bounds a module to its own operations, and `api.assertComplete()` refuses to start with one nobody serves |
| `src/context.ts` | `Env`, and `buildServices(kit)` — it only **composes** the slices each module declares, so a new module is one line here and nothing else |
| `src/app.ts` | the middlewares, then every module in `src/modules/index.ts` mounted. It holds no middleware and no route of its own. `assertServed` reads the assembled app, so a module left out of that list is a startup error |
| `src/index.ts` | the kit opened **once** for the process, closed on `SIGINT`/`SIGTERM` |
| `src/sync.ts` | `kit.sync()` as a deployment step, with `--dry-run` |
| `src/modules/<name>/<name>.service.spec.ts` | the module's services with no HTTP at all — that is what the layer buys |
| `src/modules/<name>/<name>.route.spec.ts` | the module's routes over HTTP, called as a client would, over a mongod in memory |
| `src/app.spec.ts` | what is left over: the middleware every request goes through, and that the mounted modules serve the whole spec |
| `test/kit.ts` | one mongod and one kit per spec file, the database emptied and synced before each test |
| `test/api.ts` | the same, plus the built app: `call(path, { as })` and a user to send requests as |
| `test/types/routes.ts` | one `@ts-expect-error`: the users module cannot register `/articles`. Nothing imports it — `tsc --noEmit` reading it is the test |

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

routes.post('/articles', async (c) => {
	// The transaction is the service's; the controller decides what
	// `undefined` means over HTTP.
	const written = await c.get('services').articles.write(c.req.valid('json'));
	if (!written) return c.json({ message: 'errors.no-such-author' }, 404);
	return c.json(toArticle(written), 201);
});

// src/middlewares/services.ts — one kit per request, bound into the services
export const provideServices = (kit: Kit) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		await next();
	});

// src/modules/index.ts — the one list of what is mounted
export const routes = { articles, users };

// src/app.ts — the middlewares, then every module in that list
app.use(provideServices(kit));
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
	}
}

// src/env.ts — the values, parsed
const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.coerce.number().default(3000),
	MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/blog'),
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
});
```

The map is explicit rather than `Bun.env` as a whole, and typed by the
schema's own keys, so the two ways it can rot are compile errors:

```
Property 'MONGO_URI' is missing … but required in type
  'Record<"NODE_ENV" | "PORT" | "MONGO_URI", string | undefined>'
Object literal may only specify known properties, and 'LOG_LEVEL' does not
  exist in type 'Record<"NODE_ENV" | "PORT" | "MONGO_URI", string | undefined>'
```

`PORT=abc bun src/index.ts` stops before it opens a connection:

```
❌ Invalid environment variables:
✖ Invalid input: expected number, received NaN
  → at PORT
```

## The server

`src/index.ts` opens the kit, hands the app to `Bun.serve`, and gives the
clients back on a signal:

```ts
const kit = await createKit(config);

const server = serve({
	fetch: buildApp(kit).fetch,
	port: env.PORT,
	hostname: '0.0.0.0',
	development: env.NODE_ENV !== 'production' && { hmr: true, console: true },
});

console.log(`🚀 Server running at ${server.url} ${env.NODE_ENV}`);
```

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

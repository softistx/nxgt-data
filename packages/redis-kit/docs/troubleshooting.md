# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut, and the
instance names are written as the examples name them — `default` for a single
Redis, `cache` and `pubsub` for two.

**This package has no error class of its own.** Everything it refuses is a
bare `TypeError` with a sentence that names the instance and what to do, and
every one of them is raised at **wiring time**: `defineConfig`, `connectKit`,
or the read of a kit member that cannot decide which Redis is meant. No
request produces one.

What a *call* throws is
[`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis)'s `RedisError`,
unchanged — `INVALID` for a value or a payload a schema refuses, `LOCK_HELD`
and `LOCK_LOST` for a lock, `CONNECTION` and `PING_TIMEOUT` for the client.
Its own
[`docs/troubleshooting.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/redis/docs/troubleshooting.md)
covers those in full; what is below is what the kit adds to them — the
wiring, and the prefix that is in the key the message names.

`kit.ping()` is the one that never throws: it answers `{ ok: false, error }`,
and that `error` is the same `RedisError` — `code: 'PING_TIMEOUT'`, message
`ping: no answer in 2000ms` — whether the kit opened the client or the
configuration handed one in, so a health route branches on the code and not on
where its client came from.

```ts
import { RedisError } from '@nxgt/redis';

try {
	await kit.lock('import', importEverything);
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') return;
	throw error;
}
```

| Area | Entries |
| --- | --- |
| [Install and import](#install-and-import) | [TS2307](#error-ts2307-cannot-find-module-bun-or-its-corresponding-type-declarations) · [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) |
| [Types](#types) | [a field with a `.default()`](#property-seats-is-missing-in-type--id-string-email-string--but-required-in-type--id-string-email-string-seats-number-) · [`kit.cache` with several instances](#property-users-does-not-exist-on-type-never) · [a cache on a channel-only instance](#property-users-does-not-exist-on-type-cachescoperecordnever-never) |
| [Configuration](#configuration) | [neither uri nor client](#defineconfig-instance-default-has-neither-uri-nor-client-give-it-one) · [both](#defineconfig-instance-default-has-both-uri-and-client-pass-the-uri-to-connect-to-or-the-client-you-already-opened) · [clientOptions beside a client](#defineconfig-instance-default-has-clientoptions-beside-a-client-the-client-was-opened-with-its-own-pass-a-uri-or-drop-the-options) · [an empty prefix](#defineconfig-instance-default-has-an-empty-prefix-leave-it-out-or-give-it-a-name) · [nothing wired](#defineconfig-instance-default-wires-no-cache-and-no-channel-pass-the-module-that-exports-them-or-drop-the-instance) · [one definition, two keys](#defineconfig-instance-default-wires-the-cache-named-user-twice-under-users-and-people-they-would-share-every-key-in-redis-export-one-of-them-or-give-it-a-name-of-its-own) · [no instances](#defineconfig-instances-is-empty-give-it-one-or-write-the-single-instance-as-the-configuration-itself) |
| [Connecting](#connecting) | [a config built by hand](#connectkit-instance-main-has-neither-uri-nor-client-give-it-one) · [a connect that hangs](#connectkit-hangs-for-about-half-a-minute-on-a-uri-nothing-listens-on) · [one URI, two option sets](#connectredis-this-uri-is-already-connected-with-other-options-pass-the-same-options-everywhere-or-close-the-first-connection) |
| [Runtime](#runtime) | [`kit.cache` with several instances](#kitcache-this-kit-holds-2-redis-instances-and-this-call-lives-on-one-name-it-as--on-cache-) · [an instance the kit does not have](#kitlock-this-kit-has-no-instance-named-events-it-wires-cache-pubsub) · [a value the schema refuses](#this-value-does-not-match-the-schema-myappproduser-stores) · [a lock somebody else holds](#the-lock-myappimport-is-held-by-somebody-else-and-this-call-did-not-wait-for-it--pass-wait-to-keep-trying) · [a wait that ran out](#the-lock-myappimport-is-held-by-somebody-else-and-5000ms-was-not-long-enough-to-wait-for-it) · [a message a subscriber cannot read](#a-message-on-myappprodusercreated-does-not-match-its-schema) · [a lock that expired](#the-lock-myappimport-expired-before-its-work-finished-it-ran-longer-than-the-30000ms-ttl-so-it-may-have-run-beside-another-holder) · [a key that is not where you look](#a-key-a-channel-or-a-lock-is-not-where-you-expect-it-in-redis-cli) |
| [Closing](#closing) | [the process does not settle](#the-process-does-not-exit-or-the-connection-count-climbs) · [a client of yours stays open](#a-client-the-configuration-handed-in-is-still-open-after-kitclose) |

## Install and import

### `error TS2307: Cannot find module 'bun' or its corresponding type declarations.`

**When:** the first `tsc`, on a file that imports `@nxgt/redis-kit`.
**Why:** the shipped declarations name Bun's `RedisClient` — `kit.clients.<name>`
and `kit.instances.<name>.client` are that client — so your project needs
Bun's types. They are not a dependency of this package.
**Fix:**

```sh
bun add -d @types/bun
```

The same import under Node fails at run time instead, with
`Cannot find package 'bun'`: the client is Bun's, so this package and its
sibling run on Bun 1.4 or later, and nowhere else.

### `npm error ERESOLVE unable to resolve dependency tree`

```
npm error Found: @nxgt/redis@0.1.0
npm error Could not resolve dependency:
npm error peer @nxgt/redis@"^0.2.0" from @nxgt/redis-kit@0.1.0
```

**When:** `npm install`, before anything is downloaded.

**Why:** `@nxgt/redis` is a **required peer** on a caret over a 0.x version,
so it accepts one minor only. The caches, the channels and the lock are its;
this package only wires them, and the two have to be the same copy. Nothing
checks that at run time — a definition is recognised **by shape**, precisely
so that two copies in a tree do not fail an identity test — so a mismatch is
not an error but a `bindCache` that behaves like the minor it came from.
`zod` (`>=4.6.5 <5`) and `typescript` (`^6.0.3`) are peers on the same terms.

**Fix:**

```sh
bun add @nxgt/redis-kit @nxgt/redis zod
```

Raise the sibling rather than install past the conflict: `--force` and
`--legacy-peer-deps` leave two copies in the tree. Under bun the same
mismatch is only a line of output — `warn: incorrect peer dependency
"@nxgt/redis@0.1.0"` — and the install carries on; treat it as an error, and
`bun pm ls` shows what was resolved.

## Types

### `Property 'seats' is missing in type '{ id: string; email: string; }' but required in type '{ id: string; email: string; seats: number; }'`

The whole line is a `TS2345`:

```
error TS2345: Argument of type '{ id: string; email: string; }' is not assignable to parameter of type '{ id: string; email: string; seats: number; }'.
  Property 'seats' is missing in type '{ id: string; email: string; }' but required in type '{ id: string; email: string; seats: number; }'.
```

**When:** compiling a `set`, or a `remember` loader, for a cache whose schema
gives a field a `.default()`:

```ts
export const userSchema = z.object({
	id: z.string(),
	email: z.string(),
	seats: z.number().default(1),       // optional in, always there out
});
```

**Why:** a bound cache is typed by the schema's **output**, and
`.default()` is exactly the case where the input and the output differ:
`seats` is optional on the way in and always present on the way out, so
`set(params, value)` asks for it. At run time the schema would fill it in —
`set` parses what it is given — but the parameter type is the output type, so
the compiler asks for it anyway. It belongs to `@nxgt/redis`'s `BoundCache`,
not to the wiring; [the roadmap](roadmap.md) records it.

**Fix:** pass the defaulted field, or drop the default and make it required:

```ts
await kit.cache.users.set('ada', { id: 'ada', email: 'ada@example.com', seats: 1 });
```

The same holds for `remember`: its loader returns the value as the schema
outputs it, and what a later `get` gives back is what `set` stored, not what
the loader handed over.

### `Property 'users' does not exist on type 'never'.`

**When:** compiling `kit.cache.users` — or `kit.channels.created` — on a kit
whose configuration names more than one instance. The whole line is a
`TS2339`.
**Why:** `kit.cache` and `kit.channels` are the shortcut to the **sole**
instance, and a kit that holds several has no sole one: their type is
`never`, measured both ways in this package's type tests, so every key read
off them is this error. It is the compile-time half of
[the refusal below](#kitcache-this-kit-holds-2-redis-instances-and-this-call-lives-on-one-name-it-as--on-cache-),
which is what a JavaScript call site gets instead.
**Fix:** say which Redis:

```ts
await kit.instances.cache.cache.users.get(id);
await kit.instances.pubsub.channels.created.publish(user);
```

### `Property 'users' does not exist on type 'CacheScope<Record<never, never>>'.`

**When:** compiling a cache read off an instance that wires **only channels**
— `kit.instances.pubsub.cache.users`. A channel read off a cache-only
instance is the mirror image, and reads
`Property 'created' does not exist on type 'ChannelScope<Record<never, never>>'.`
**Why:** every instance is typed by the modules *it* was given, so an
instance configured with `channels` alone has an empty cache scope —
`Record<never, never>` is that empty module — and no key on it. Usually the
wrong instance named, or a definition exported from the module the other
instance wires.
**Fix:** read it off the instance that wires it:

```ts
const config = defineConfig({
	instances: {
		cache: { uri, prefix: 'myapp', caches },
		pubsub: { uri, prefix: 'myapp', channels },
	},
});

await kit.instances.cache.cache.users.get(id);              // the caches live here
await kit.instances.pubsub.channels.created.publish(user);  // the channels there
```

`KitOf<typeof config>` is the type of that kit, for a function that takes it
as a parameter; it carries the same keys, so the two errors above are what it
refuses too.

## Configuration

Everything below is a bare `TypeError` from `defineConfig`, thrown where the
configuration is written — it connects to nothing, so a wrong URI is not one
of them.

The same checks run again in `connectKit`, on the same configuration: a config
is often built in one file and connected in another, and the second is where
the stack trace is useful. **The sentence names the call it came from**, so
the same mistake reads `defineConfig: instance "main" …` from one and
`connectKit: instance "main" …` from the other; every heading below has that
second form, word for word after the colon.

### `defineConfig: instance "default" has neither uri nor client. Give it one.`

**When:** calling `defineConfig`. A single instance names itself `default`;
with `instances: { … }` the name is the key you wrote.
**Why:** an instance says where its Redis is exactly once. This is nearly
always an environment variable that was not read — `process.env.REDIS_URL` is
`undefined`, so the property is absent.
**Fix:** read it where the application reads its other settings, and fail
there:

```ts
const uri = process.env.REDIS_URL;
if (!uri) throw new Error('REDIS_URL is not set');

export const config = defineConfig({ uri, prefix: 'myapp:prod', caches, channels });
```

### `defineConfig: instance "default" has both uri and client. Pass the URI to connect to, or the client you already opened.`

**When:** calling `defineConfig` with `uri` **and** `client`.
**Why:** the two differ in who closes what: with a `uri` the kit opens the
client and `close()` gives it back, with a `client` it uses yours and never
closes it. It will not guess which you meant.
**Fix:**

```ts
defineConfig({ client: connection.client, caches, channels });  // yours to close
```

### `defineConfig: instance "default" has clientOptions beside a client. The client was opened with its own; pass a uri, or drop the options.`

**When:** calling `defineConfig` with `client` and `clientOptions`.
**Why:** `clientOptions` is what the kit hands the driver **when it opens** a
client. A client that is already open cannot take them, so they would be
silently ignored.
**Fix:** give them where the client is made:

```ts
const connection = await connectRedis(uri, { autoReconnect: false });
defineConfig({ client: connection.client, caches, channels });
```

### `defineConfig: instance "default" has an empty prefix. Leave it out, or give it a name.`

**When:** calling `defineConfig` with `prefix: ''`, or a prefix of spaces —
usually a deployment name read from an environment variable that is unset.
**Why:** an empty prefix would write `:user:ada`, a keyspace that belongs to
no deployment and matches nobody's `SCAN`. No prefix at all is a supported
choice; an empty one is a mistake.
**Fix:**

```ts
defineConfig({ uri, prefix: process.env.REDIS_PREFIX ?? 'myapp:dev', caches });
```

### `defineConfig: instance "default" wires no cache and no channel. Pass the module that exports them, or drop the instance.`

**When:** calling `defineConfig` with no `caches` and no `channels`, or with
objects that hold no definition in them.
**Why:** definitions are recognised **by shape** — a cache has a `name`, a
`key` function, a numeric `ttl` and a `schema`; a channel has a `name` and a
`schema` and no `ttl`. An object that holds none of those is usually a module
of types only, a default export read as a namespace, or a barrel that
re-exports builders rather than definitions.
**Fix:** pass the module as it is:

```ts
// src/redis/caches.ts
export const users = defineCache({ name: 'user', key: (id: string) => id, ttl: 300, schema });

// src/redis/index.ts
import * as caches from './caches';
import * as channels from './channels';

export const config = defineConfig({ uri, caches, channels });
```

Anything else in those modules — a schema, a type, a constant — is skipped,
not refused.

### `defineConfig: instance "default" wires the cache named "user" twice, under "users" and "people". They would share every key in Redis. Export one of them, or give it a name of its own.`

**When:** calling `defineConfig`. The same sentence covers channels, as
`wires the channel named "user.created" twice`.
**Why:** two exports point at **one** definition, or at two definitions with
the same `name`. Both keys would write the same Redis keys, so one of them is
silently dead: `kit.cache.people.delete(id)` empties what
`kit.cache.users.set(id, value)` wrote. It is a copy-paste in the module that
exports them, and nothing downstream can see it.
**Fix:** one `name` per definition, and one export per definition:

```ts
export const users = defineCache({ name: 'user', key, ttl: 300, schema });
export const people = defineCache({ name: 'person', key, ttl: 300, schema });
```

The **export** name is what the application reads (`kit.cache.users`); the
definition's `name` is what Redis holds. Two definitions may share an export
name across two modules, but never a `name` on one instance.

### ``defineConfig: `instances` is empty. Give it one, or write the single instance as the configuration itself.``

**When:** calling `defineConfig({ instances: {} })` — typically an
`instances` object built at run time from environment variables that were not
set.
**Why:** the multi-instance shape was used and nothing came out of it. A kit
with no Redis has nothing to wire and nothing to close.
**Fix:**

```ts
defineConfig({ uri, caches, channels });                        // one Redis
defineConfig({ instances: { cache: { uri, caches } } });        // several
```

## Connecting

### `connectKit: instance "main" has neither uri nor client. Give it one.`

**When:** `await connectKit(config)`, on a `KitConfig` that did not come from
`defineConfig` — a configuration assembled by hand, or one cast through
`as never`.
**Why:** the checks run again where the clients are opened, so a
configuration built in one file and connected in another is refused at the
call a stack trace points at. **The sentence names the call that raised it**:
the same wiring mistake reads `defineConfig: …` from `defineConfig` and
`connectKit: …` from here, rather than always sending a reader to the wrong
file. Every `defineConfig: …` entry above has this second form.
**Fix:** build the configuration with `defineConfig`, which is where the
check belongs:

```ts
export const config = defineConfig({ uri, caches, channels });
export const kit = await connectKit(config);
```

### `connectKit` hangs for about half a minute on a URI nothing listens on

**When:** start-up, against a Redis that is not there — a port typed wrong, a
container that has not come up yet, a firewall.
**Why:** it is Bun's client retrying. `autoReconnect` is on by default, and a
**refused** connection is not bounded by `connectionTimeout`, so the failure
takes roughly 31 seconds to arrive; the sibling's page
[measures it](https://github.com/softistx/nxgt-data/blob/develop/packages/redis/docs/troubleshooting.md#a-connect-to-a-port-nothing-listens-on-takes-about-31-seconds).
Nothing is stranded meanwhile: an instance that fails to open closes the ones
already open before the error leaves.
**Fix:** where a fast failure is what you want — a test, a health check, a
start-up that should crash rather than hang — say so in `clientOptions`:

```ts
defineConfig({
	uri: process.env.REDIS_URL!,
	clientOptions: { autoReconnect: false },
	caches,
});
```

This package's own specs do exactly that to make the rollback case quick.

### `connectRedis: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`

**When:** `connectKit`, on a configuration with two instances on one URI and
different `clientOptions` — or a second kit in the same process opening that
URI with other options.
**Why:** the message is `@nxgt/redis`'s, not this package's: it shares **one
client per URI**, so two instances on one Redis are one socket
(`kit.clients.cache === kit.clients.pubsub`, measured in this package's
specs), and one socket has one set of options. The URI is deliberately left
out of the message — a connection string holds a password. An instance that
fails to open closes the ones already open before the error leaves, so no
connection is stranded.
**Fix:** the same options on that URI, and tell the instances apart by their
names and prefixes instead:

```ts
defineConfig({
	instances: {
		cache: { uri, clientOptions: { autoReconnect: false }, prefix: 'myapp', caches },
		pubsub: { uri, clientOptions: { autoReconnect: false }, prefix: 'myapp', channels },
	},
});
```

Sharing that one client is the point;
[the sibling's entry](https://github.com/softistx/nxgt-data/blob/develop/packages/redis/docs/troubleshooting.md#connectredis-this-uri-is-already-connected-with-other-options-pass-the-same-options-everywhere-or-close-the-first-connection)
has the rest.

## Runtime

### `kit.cache: this kit holds 2 Redis instances, and this call lives on one. Name it, as { on: 'cache' }.`

**When:** reading `kit.cache` on a kit built from `instances: { … }` with
more than one of them. `kit.channels` throws the same sentence under its own
name, and so does `kit.lock` when no `{ on }` was given.
**Why:** those three are the shortcut to the **sole** instance. With several
there is no sole one, and guessing is how a write lands on the wrong Redis —
so their type is already `never`, and this is what a JavaScript call site, or
one that went through an `any`, gets at run time.
**Fix:** name the instance:

```ts
await kit.instances.cache.cache.users.get(id);
await kit.instances.pubsub.channels.created.publish(user);
await kit.lock('import', importEverything, { on: 'cache' });
```

A single-instance kit is named `default`, so `kit.instances.default.cache`
and `kit.cache` are the same object.

### `kit.lock: this kit has no instance named "events". It wires "cache", "pubsub".`

**When:** `kit.lock(key, work, { on })` with a name the configuration does
not hold. It comes back as a **rejection**, not a synchronous throw, so one
`catch` covers it and whatever the work does.
**Why:** the names are the keys of `instances` in the configuration — not the
host, not the database number. `{ on: 'events' }` does not compile; this is the
run-time half of that, for a name that came from a variable or a cast.
**Fix:**

```ts
await kit.lock('import', importEverything, { on: 'cache' });  // a key of `instances`
```

Reading `kit.instances.<name>` for a name that is not there does not throw:
it does not compile, and gives `undefined` where the types were bypassed.

### `This value does not match the schema "myapp:prod:user" stores:`

**When:** `set`, or `remember` once its loader has returned — after the
expensive work has already been paid for. The schema's issues follow the
colon. Publishing has its twin,
`This message does not match the schema "myapp:prod:user.created" carries:`.
**Why:** a `RedisError` with `code: 'INVALID'`, from `@nxgt/redis`. What the
kit adds is the name in it: the definition is wired under the instance's
prefix, so the schema is named `myapp:prod:user` and not `user` — the same
string the key is built from. A value being *written* that does not match is
a bug, so it throws; a *stored* value that no longer matches is treated as a
miss, forgotten, and read as `undefined`.
**Fix:** check at the edge, where the shape comes from:

```ts
const user = await kit.cache.users.remember(id, async () => userSchema.parse(await loadUser(id)));
```

### ``The lock "myapp:import" is held by somebody else, and this call did not wait for it — pass `wait` to keep trying``

**When:** `kit.lock(key, work)` with no `wait` — the default — while another
process holds that lock. With a `wait` set it is
[the next entry](#the-lock-myappimport-is-held-by-somebody-else-and-5000ms-was-not-long-enough-to-wait-for-it)
instead.
**Why:** a `RedisError` with `code: 'LOCK_HELD'`, from `@nxgt/redis`.
**Nothing ran** — this is not a failure of the work. The key in the message
is the one the kit passed, prefix included; `error.key` is the Redis key,
`lock:myapp:import`.
**Fix:** a scheduled job that may skip a run catches it; one that must run
waits:

```ts
import { RedisError } from '@nxgt/redis';

try {
	await kit.lock('import', importEverything, { ttl: 60_000, wait: 5_000 });
} catch (error) {
	if (error instanceof RedisError && error.code === 'LOCK_HELD') return;
	throw error;
}
```

### `The lock "myapp:import" is held by somebody else, and 5000ms was not long enough to wait for it`

**When:** `kit.lock(key, work, { wait })`, when the lock was still held when
the wait ran out. The number in the message is the `wait` you passed.
**Why:** the same `LOCK_HELD` as above, after retrying until the deadline —
nothing ran, and the work is untouched. A kit lock is `@nxgt/redis`'s
`withLock` on the prefixed key, so the retry behaviour is its.
**Fix:** wait past the slowest holder, or catch it and let the run be skipped:

```ts
await kit.lock('import', importEverything, { ttl: 60_000, wait: 30_000 });
```

### `The lock "myapp:import" expired before its work finished: it ran longer than the 30000ms ttl, so it may have run beside another holder`

**When:** `kit.lock`, **after** the work returned: the release found the lock
was no longer this call's.
**Why:** a `RedisError` with `code: 'LOCK_LOST'`. The `ttl` is a deadline for
the work, not a hint — 30 s by default — and whatever ran past it was no
longer protected, so the result is not safe to trust.
**Fix:** a `ttl` above the slowest run this work has:

```ts
await kit.lock('import', importEverything, { ttl: 300_000 });
```

### `A message on "myapp:prod:user.created" does not match its schema:`

**When:** in a subscriber, on a message something else published — an older
deploy, or another service writing to that channel. The schema's issues
follow the colon. It does **not** reach your caller: a listener's throw has
nowhere to go, and Bun ends the process on an unhandled rejection, so it goes
to `onError` — and to `console.error` when you passed none, under
`subscribe("myapp:prod:user.created"): dropped a message`. It is usually met
as a log line, not as a stack.
**Why:** every message is parsed against the channel's schema before the
handler sees it. A `RedisError` with `code: 'INVALID'`, from `@nxgt/redis`;
the name in it is the **prefixed** channel, which is the channel Redis
carried it on. A handler of yours that throws takes the same path.
**Fix:** pass an `onError`, so it lands where you read your logs:

```ts
const running = await kit.channels.created.subscribe(
	(user) => console.log(user.email),
	{ onError: (error, raw) => console.warn('unreadable message', { raw }, error) },
);
```

An `onError` that throws is caught too, and reported as
`subscribe("myapp:prod:user.created"): onError threw`.

### A key, a channel or a lock is not where you expect it in `redis-cli`

**When:** looking for a value the application says it wrote, and getting
`(nil)`.
**Why:** the instance's prefix is in front of everything the kit writes, and a
cache's key is `<name>:<key>` — a cache wired as `users` with `name: 'user'`
under `prefix: 'myapp:prod'` writes `myapp:prod:user:ada`, and the channel
`user.created` is published on `myapp:prod:user.created`. The lock is the one
that surprises: `@nxgt/redis`'s `withLock` writes `` `lock:${key}` `` itself
and the kit hands it the already-prefixed key, so the prefix lands **inside**
`lock:` — `lock:myapp:prod:import`, never `myapp:prod:lock:import`. Both are
measured in this package's specs.
**Fix:** ask the kit for the string rather than spelling it by hand:

```ts
kit.cache.users.keyFor('ada');       // 'myapp:prod:user:ada'
kit.channels.created.name;           // 'myapp:prod:user.created'
kit.instances.default.prefix;        // 'myapp:prod'  — a lock is `lock:${prefix}:${key}`
```

A definition is never renamed in place: the prefix is applied to a copy, so
two kits may wire one definition under two prefixes, and a staging process
and a production one share the module without sharing a keyspace.

## Closing

### The process does not exit, or the connection count climbs

**When:** after the work is done — a script that hangs instead of exiting, or
a long-running process whose `CLIENT LIST` on the server keeps growing.
**Why:** every `subscribe` holds a **connection duplicated from the client**,
and one nobody closes is a socket nobody gives back. The kit records each
subscription it starts, so `kit.close()` closes the ones nobody did, then the
clients it opened — in that order, because unsubscribing on a closed client
is an error nobody asked for. A subscription started on a kit that is never
closed outlives everything.
**Fix:** close the subscription where it ends, and the kit where the process
does:

```ts
await using kit = await connectKit(config);

const running = await kit.channels.created.subscribe((user) => console.log(user.email));
await running.close();     // or hold it with `await using`, or leave it to `kit.close()`
```

`close()` is idempotent, on the subscription and on the kit, so an early
close and the kit's own close cannot collide.

### A client the configuration handed in is still open after `kit.close()`

**When:** `await kit.close()`, or the end of an `await using` block, on an
instance configured with `client:` rather than `uri:`.
**Why:** deliberate, and measured: the kit closes what it **opened**. A
client an application opened itself is usually shared with something else, so
taking it away at the kit's shutdown would break whatever holds it too. The
subscriptions the kit started on that client are still closed — those are
its.
**Fix:** close it where it was opened:

```ts
const connection = await connectRedis(process.env.REDIS_URL!);
const kit = await connectKit(defineConfig({ client: connection.client, caches, channels }));

await kit.close();          // subscriptions closed, the client untouched
await connection.close();   // yours, so yours to give back
```

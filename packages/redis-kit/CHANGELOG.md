# @nxgt/redis-kit

## 0.1.0

### Minor Changes

- [#79](https://github.com/softistx/nxgt-data/pull/79) [`79ef91a`](https://github.com/softistx/nxgt-data/commit/79ef91a0ec058ba3d2387ad727b1f8706d16fdb2) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: an application's Redis wiring in one object.
  
  `@nxgt/redis` gives one typed cache or one typed channel at a time, and an
  application recollects the rest itself — the client, which deployment's keys
  these are, which Redis each definition lives on, and every subscription it
  opened. `@nxgt/redis-kit` removes that collage: a configuration is written
  once, and what comes back is `kit.cache.users` and
  `kit.channels.created`, typed under the key each definition is exported as.
  
  ```ts
  import * as caches from './caches';
  import * as channels from './channels';
  import { connectKit, defineConfig } from '@nxgt/redis-kit';
  
  export const kit = await connectKit(
  	defineConfig({
  		uri: process.env.REDIS_URL!,
  		prefix: 'myapp:prod',
  		caches,
  		channels,
  	}),
  );
  
  await kit.cache.users.set('ada', { id: 'ada', email: 'ada@example.com' });
  await kit.channels.created.subscribe((user) => notify(user));
  ```
  
  `defineConfig` connects to nothing and reads no environment variable: the
  application writes `uri: process.env.REDIS_URL!` itself, so the one place a
  URL is read stays the application's. `connectKit` is what opens the clients —
  `connectKit`, not `createKit`, because `AGENTS.md` reserves `create*` for an
  assembly that does no I/O and says in as many words that `@nxgt/mongo-kit`'s
  `createKit` is the one exception and not a licence for a second.
  
  **Two scopes, not one augmented client.** A `RedisClient` is a hundred
  command methods, so a cache and a channel of the same name would fight over
  `kit.get`; `kit.cache.<key>` and `kit.channels.<key>` cannot. Neither is a
  Proxy over the driver, unlike `@nxgt/mongo-kit`'s scope over `Db`: nothing
  here has a driver member to fall through to, so a key that is wired nowhere
  is plainly `undefined`. Each scope is frozen, and builds a binding on the
  first read and keeps it.
  
  **The prefix belongs to the wiring, not the definition.** A definition says
  what a value *is*; a prefix says which deployment owns it. `prefix: 'myapp'`
  puts `myapp:` in front of every cache key and channel name, by copying the
  definition rather than renaming it — two kits can wire the same exported
  module under two prefixes, and a spec pins that the module is never mutated.
  On a lock it lands *inside* `lock:` — `lock:myapp:import` — because
  `@nxgt/redis`'s `withLock` writes `lock:${key}` itself and this package does
  not reach into a sibling to reorder it. Two deployments are still kept apart,
  which is the point; the measurement is a spec.
  
  **Subscriptions are tracked.** Each one holds a connection duplicated from
  the client, so one nobody closed costs a socket. `subscribe` hands back a
  `Subscription` built on `@nxgt/redis`'s own — `Object.create`, so a member the
  sibling adds later stays live — with a `close` the kit also hears, so a caller
  can close one early and `kit.close()` closes what is left. `await using kit =
  await connectKit(…)` works, on the kit and on a single subscription.
  
  **Several Redis instances**, when caches and pub/sub live apart:
  
  ```ts
  const kit = await connectKit(
  	defineConfig({
  		instances: {
  			cache: { uri: process.env.REDIS_URL!, caches },
  			pubsub: { uri: process.env.REDIS_PUBSUB_URL!, channels },
  		},
  	}),
  );
  
  await kit.instances.cache.cache.users.get('ada');
  await kit.lock('import', run, { on: 'pubsub' });
  ```
  
  `kit.cache` and `kit.channels` are `never` in the types with more than one
  instance — the type itself, which the type tests assign to `never` both ways,
  not a scope that merely has no key on it — and throw a sentence naming the
  instances at run time: the compiler refuses the guess before anything runs,
  and `kit.instances.<name>` is the way to say which. `kit.lock(key, work, { on })` and `kit.ping()` — which answers
  per instance, with a latency a health route can show — follow the same rule.
  
  Also: a client the configuration handed in is **never closed**, because what
  the kit did not open is not its to close; two instances on one URI share one
  socket, since `connectRedis` counts holders per URI.
  
  **No error class.** Every refusal here is a bare `TypeError` naming what was
  wrong, as in `@nxgt/mongo-search-kit`: they are wiring-time refusals, raised
  while an application starts, not decisions a request has to branch on. Each
  one names the call that raised it — the same mistake reads `defineConfig: …`
  from `defineConfig` and `connectKit: …` from `connectKit`, because the checks
  run in both and a message naming a function the application did not call
  sends a reader to the wrong file. What a
  caller catches at run time is `@nxgt/redis`'s own `RedisError` — `INVALID`
  for a payload or value its schema refuses, `LOCK_HELD`, `LOCK_LOST`.
  
  There is no `as(actor)` and no `withSession`: Redis has neither an actor to
  stamp nor a session to carry, so a kit is never derived.
  
  `KitOf<typeof config>` writes the kit's type from the configuration, for a
  service handed one rather than reading `typeof kit` off the constant, and
  `kit.ping()` answers the same `RedisError`/`PING_TIMEOUT` whether the kit
  opened the client or the configuration handed one in.
  
  55 tests over a real Redis, and 19 `@ts-expect-error` cases in
  `test/types/kit.ts` for what the types refuse — an unwired key, a key of the
  wrong shape, an unknown field in a cached value, an instance this kit does
  not have, `kit.cache` with more than one, and an option the configuration
  does not know.

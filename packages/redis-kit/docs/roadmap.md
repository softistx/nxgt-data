# Roadmap

Where `@nxgt/redis-kit` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

- **The refusal of an unknown option, in the message it was written for** —
  an option the configuration does not have is a compile error today, but
  TypeScript usually reports it as `is not assignable to type 'never'` on
  every property of the object, and only sometimes as the sentence the
  constraint carries, `"nope" is not an option here`. The intended message
  should be the one every case shows.

## Later

_Nothing queued._

## Not planned

- **An actor, or a session** — `@nxgt/mongo-kit` derives a kit with
  `as(actor)` and `withSession`, because MongoDB has something to stamp and
  something to carry. Redis has neither, so a kit is the same object for every
  request, is never derived, and `close()` always belongs to the one you hold.
- **Invalidating a cache by pattern** — `kit.cache.users.delete(pattern)`
  needs `SCAN` over the keyspace to find what to delete: O(N) in the number of
  keys, on a server that runs one command at a time, and racy — a key written
  while the scan is running is missed. Delete the keys you know
  (`delete(params)`), or let the `ttl` do it.
- **A queue** — pub/sub is fire-and-forget, and nothing is stored,
  acknowledged or replayed; `@nxgt/redis`'s own roadmap rules the same thing
  out for the same reason. A message that must not be lost wants a stream or a
  queue, not a channel.
- **One augmented client instead of two scopes** — `kit.cache.<key>` and
  `kit.channels.<key>` are two scopes rather than a client with names on it. A
  Redis client answers to a hundred commands, so a cache and a channel of the
  same name would fight over it, and nothing here needs to fall through to a
  driver member: `kit.instances.<name>.client` is the driver, untouched.
- **Closing a client the configuration handed over** — the kit gives back only
  what it opened, `await using` included. What it did not open is not its to
  close.
- **An error class** — every refusal this package makes is wiring-time, and
  there are few enough to tell apart by their sentence, each naming the
  instance and the call. A `RedisError` still reaches a caller from
  `@nxgt/redis`, with its `code`.

## Shipped

- **A cache value written as the schema *accepts* it** — `kit.cache.<key>.set`
  and a `remember` loader take the schema's input, so
  `set('ada', { id, email })` compiles where `seats` has a `.default()`, and
  the default is what every reader gets; it is
  [`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis) 0.3.0's
  `BoundCache`, typed through — 0.2.0.
- **First release** — `defineConfig` checking a configuration of one or
  several Redis instances and freezing it without connecting to anything, and
  `connectKit` opening the clients and giving back a kit whose `cache` and
  `channels` scopes carry every definition typed under the key it is exported
  as, with the deployment's `prefix` in front of every key, channel and lock;
  `lock`, `ping`, `clients`, and a `close()` that closes the subscriptions
  nobody closed before the clients it opened. `KitOf<typeof config>` writes
  the kit's type from the configuration, for a service that is handed one
  rather than reading `typeof kit` off the constant — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/redis-kit/CHANGELOG.md) — it is not in
the published package, only in the repository.

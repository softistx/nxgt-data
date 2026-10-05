# @nxgt/redis-guard

> **Deprecated.** This package moved into
> [`@nxgt/redis`](https://www.npmjs.com/package/@nxgt/redis), which now holds
> the whole API under the same names. `@nxgt/redis-guard` only re-exports it,
> with every name marked `@deprecated`, and will not grow.

## Moving over

Same names, same behaviour, same messages: import from `@nxgt/redis`.

```ts
// before
import { bindRateLimit, defineRateLimit, GuardError } from '@nxgt/redis-guard';
```

```ts
// after
import { bindRateLimit, defineRateLimit, GuardError } from '@nxgt/redis';
```

`defineRateLimit`, `bindRateLimit`, `defineIdempotency`, `bindIdempotency`,
`GuardError`, `GuardErrorCode` and the types (`RateLimitDefinition`,
`BoundRateLimit`, `LimitResult`, `IdempotencyDefinition`, `BoundIdempotency`,
`Idempotent`, `RunOptions`) are all there, and `GuardError` is still its own
class with its own codes. The identity holds: `GuardError` from either package
is one class, so an `instanceof` across the two works.

Both packages can stay installed during the move, since this one re-exports the
other.

What is new in `@nxgt/redis` is that it also wires them with the rest: the
guides, the troubleshooting entries and the roadmap are in
[`@nxgt/redis`](https://github.com/softistx/nxgt-data/tree/develop/packages/redis/docs).

## Install

Install `@nxgt/redis` instead; this package adds nothing to it:

```sh
bun add @nxgt/redis zod
```

An application that still imports `@nxgt/redis-guard` keeps working: it
re-exports `@nxgt/redis`, which is a required peer (and `zod` through it),
with `typescript`.

## License

MIT

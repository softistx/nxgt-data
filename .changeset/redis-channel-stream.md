---
"@nxgt/redis": minor
---

Add keyed async-iterator streams to wired channels. A `defineChannel` takes an optional `key(message)` selector, and `redis.channels.<name>.stream(key, { bufferSize? })` returns an `AsyncGenerator` of the messages with that key, usable directly as a GraphQL subscription `subscribe` result. The process opens one Redis subscription per channel, on the first read, fans it out in memory and closes it when the last iterator leaves. `return()`, `throw()` and `Symbol.asyncDispose` release an iterator at once, even while it is waiting. A slow reader loses its oldest messages past `bufferSize` (256). On a channel with streams open, a `publish` that Redis refuses reaches the local iterators instead of throwing, and a failed subscribe is retried by the next iterator. `channel.close()` stops every stream; `redis.close()` does too. `isChannel` now accepts a definition that carries a `key` function.

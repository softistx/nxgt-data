---
'@nxgt/redis': minor
---

The connection failures are a `RedisError` too, with a code.

`RedisErrorCode` gains two: `CONNECTION`, for a `connectRedis` the shared
client was closed under, and `PING_TIMEOUT`, which `ping` reports on its
result rather than throwing. Both used to be a bare `Error`, so one class and
one `code` now cover everything this package refuses; Redis's own failures
still come back as they are, from Bun's client.

```ts
if (error instanceof RedisError && error.code === 'CONNECTION') { … }
```

**Neither prints the URI.** `key` is the empty string for both — it names a
key or a channel, and these are about the connection, not one key. A
connection string holds the password, and a spec asserts the URI is absent
from the message.

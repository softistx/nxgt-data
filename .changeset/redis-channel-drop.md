---
'@nxgt/redis': minor
---

Add `onNoLocalReader: 'drop'` to `defineChannel` (with `fallback: 'local'`): when Redis is down and no `stream()` of the process reads the message's key, `publish` resolves with `0` instead of throwing, for fire-and-forget events nobody may be watching. The default, `'throw'`, is unchanged, and a message the schema refuses still throws.

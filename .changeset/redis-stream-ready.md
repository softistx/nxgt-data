---
'@nxgt/redis': minor
---

Keyed streams: `stream(key).ready()` starts the Redis subscription if no read has, and resolves once SUBSCRIBE is confirmed, so a message published after it is heard. It rejects with the subscribe failure.

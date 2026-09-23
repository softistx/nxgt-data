---
'@nxgt/mongo': patch
---

The roadmap records an audit journal as not planned. `actors` stamps and an `after` hook, which sees each write with its actor and its session, already let an application keep its own journal in the same transaction.

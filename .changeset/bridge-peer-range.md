---
"@nxgt/mongo-meilisearch": patch
---

Corrects the published peer range on `@nxgt/mongo`: 0.1.0 asked for `^0.10.0`, which has no `position` on a change subscription — the token this package records while a collection is quiet. It asks for `^0.11.0`, the version it is built against.

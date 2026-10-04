---
"@nxgt/mongo-backup": minor
---

`restoreCollections`: restore part of a backup, chain included. It restores some collections and views, under other names (`as`), whole or only the documents a filter takes (by `_id` or any query), merged into what is there with `existing: 'replace' | 'keep'`. The backup is rebuilt in a scratch database first, and that database is dropped afterwards. New error code `NOT_FOUND`.

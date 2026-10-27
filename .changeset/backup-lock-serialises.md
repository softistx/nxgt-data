---
'@nxgt/backup': patch
---

Document that the lock serialises writers without deduplicating them: two `create` calls started together can both store a backup, one after the other, when the first one's lock lands only after the second finished. No two writers ever write at once; the specs now check that instead of "at most one stored".

The earlier docs wording ("never both go on") implied the lock deduplicates runs started together; it now says they never write at once.

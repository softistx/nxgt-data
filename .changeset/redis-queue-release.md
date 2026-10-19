---
'@nxgt/redis': minor
---

A worker that closes gives back the jobs a claim still in flight took for it: they are `waiting` again at once, with their attempt and group slot returned, instead of waiting out a lease.

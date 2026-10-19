---
'@nxgt/redis': minor
---

A queue's jobs can be grouped. `defineQueue({ groups: {} })` gives each group fair turns, and `groups: { concurrency: n }` also caps the jobs of one group that run at once, across every worker. `add(data, { group })` and `addMany` items take the group name (no `:` or braces); jobs without one form a default group with no cap, and `get` shows `group` for a named one. A claim serves the groups in round-robin, the most urgent job first within a group, so one tenant cannot hold up the others, and workers do not spin while every ready job sits in a full group. `group` on a queue defined without `groups` is a `TypeError`.

Every queue now writes a marker, `queue:{<name>}:groups:mode`. A process whose definition disagrees with it on `groups` or on `concurrency` gets a `QueueError` with the new code `GROUPS_MISMATCH` and writes nothing. To change modes, drain the queue and `DEL` the marker.

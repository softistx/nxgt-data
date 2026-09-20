---
---

Test infrastructure only: nothing is published by this change.

`@nxgt/s3`'s test server stopped SeaweedFS with the default signal and waited
for it. Measured on SeaweedFS 4.47, `weed server` takes **20 seconds** to
exit on SIGTERM *or* SIGINT — 20078 / 20024 ms and 20015 / 20102 ms over two
runs each — and **11 ms** on SIGKILL. It is a fixed shutdown grace period,
not a flush, and the temp directory it writes into is removed on the next
line, so there is nothing to lose.

That was the whole of the suite's slowness. `packages/s3` ran in 24.9 / 29.9
/ 29.5 s and now runs in **5.2 / 4.9 / 4.9 s**, with the same 52 tests
passing. It also explains the phantom failure a run under the default 5 s
hook timeout reported — `(fail) (unnamed) [5000.32ms]`, naming no test,
because the hook that timed out was the `afterAll` stopping the server.

`@nxgt/meilisearch`'s server does **not** share the defect: measured, it
stops in 8 ms on SIGTERM. The signal is not to be copied across.

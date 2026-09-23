---
"@nxgt/redis-guard": patch
---

Documentation only. A new upgrading page says what to change from 0.1.0 (install `zod`) and from 0.2.0 (shorten `lease`, match on `code` rather than the `IN_PROGRESS` and `LEASE_LOST` messages, and how the two versions share keys in a rolling deploy). A new testing guide shows `bun test` specs against a real Redis, emptied between specs, and why moving the host's clock refills nothing. Troubleshooting gains `Cannot find module 'zod'` (the peer is for the types, so it shows only at `tsc`, and not under `skipLibCheck`), `Connection closed` (Redis's own errors pass through `run`, `consume` and `enforce` unwrapped, and what each means in `run`), and a Redis failure between `work` and storing its result as a cause of a request running twice. The guides show every option as a table and the bound types as signatures, the README's traps are one line each with a link, and the roadmap says why a lost lease does not interrupt `work`.

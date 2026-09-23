---
---

Specs only: nothing a consumer installs changes.

The migration specs no longer assert a refusal with `expect(promise).rejects`,
which on a loaded machine left Bun no longer reading the test mongod's output:
once that buffer filled, the server stopped answering and every hook after it
timed out. They hold the rejection with the shared `test/rejection.ts` helper
instead.

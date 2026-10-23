---
"@nxgt/mongo": minor
---

`paginateByCursor` takes an optional `scope` that binds a cursor to one list, so a cursor written for another scope, or for none, is refused with an `InvalidCursorError`.

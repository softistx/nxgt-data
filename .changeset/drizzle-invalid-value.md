---
'@nxgt/drizzle': minor
---

A value the column's type refuses is an `InvalidValueError`, not a database
error.

```ts
await users.findById(c.req.param('id')); // 'nope', from a URL
// InvalidValueError: invalid input syntax for type uuid: "nope"
//   code: 'INVALID_VALUE', sqlState: '22P02'
```

It used to come back as a plain `DataError` with `code: 'DATABASE'` — the
same code as a server that is down — so a handler mapping codes to statuses
answered 500 to what is a 400. `DataErrorCode` gains `INVALID_VALUE`, and
`InvalidValueError` is exported beside the other classes.

Its siblings are the same class: `22001` (longer than the column), `22003`
(out of the type's range), `22007` and `22008` (a date or a time that is not
one). A division by zero, `22012`, is deliberately **not** one of them — that
is the query rather than a value handed to it, and it stays a `DataError`.

Measured on PGlite 0.5.8, every one of these carries the database's sentence
and nothing else: no `table`, no `column`, no `detail`. So `table` is
`undefined` and `columns` is empty here, unlike on a constraint violation, and
the database's own sentence is kept rather than rewritten into one that says
less. That sentence can hold the value that was refused: log it, do not send
it to a client.

---
'@nxgt/mongo': minor
---

`putOnce` stores a file under the id its bytes decide, and two callers can no
longer both win.

The old rule elected the copy first in `(uploadDate, _id)` — a key that says
nothing about the order the documents become **visible**. Measured, by holding
one caller's `files` insert open: the call that finished last carried the
earliest key, so the calls that finished before it could not see it, each
found itself first, and the bucket kept two copies under two different ids
while all three callers were told their bytes were safe. It is what a loaded
CI machine produced on its own.

The election is now the server's. A file written by `putOnce` is stored under
the first twelve bytes of its sha256, so two callers storing the same bytes
collide on the unique `{ files_id, n }` index and then on `_id`. The caller
that loses has written nothing that survives, takes back only the chunks it
wrote itself, and is given the copy that won: **`putOnce` never deletes a
stored file.** A copy `put` wrote is still found and given back.

What changes for a caller:

- The `_id` of a deduplicated file is its content. The timestamp an
  `ObjectId` normally opens with is digest here, and means nothing;
  `uploadDate` is the date.
- `putOnce` takes no `id`, at the type level and at run time. Use `put` to
  choose one.
- `putOnce` creates the bucket's indexes once per process if they are not
  there, whatever `autoSync` says: the unique `{ files_id, n }` index is half
  of the election.
- A file stored under that id whose digest is not the one asked for is a
  `ConflictError` rather than the wrong bytes.
- The caller that loses waits for the winner's document, which is one round
  trip away. The wait is bounded at ten seconds, and what it runs out on is a
  write that claimed the id and never finished: a `ConflictError` naming it.
- Inside a transaction a collision is the transaction's to lose. Measured:
  the duplicate key aborts it on the server, so what comes back is the
  driver's abort rather than this package's `ConflictError`.
- A chunk an interrupted write left where this file's own would go is a
  `ConflictError` too, rather than a file stored short; one past its last
  chunk collides with nothing and is left alone.
- A claim that was let go is taken over rather than waited out, after asking
  once more whether those bytes have turned up meanwhile. An id claimed and
  let go twice under one call is a `ConflictError` asking for a retry.
- Files stored by 0.14.0's `putOnce` keep their own ids. They are still found
  by digest and given back, so nothing needs moving.

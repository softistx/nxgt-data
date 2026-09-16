---
'@nxgt/mongo': minor
---

`collection.onChange`: a typed subscription to a collection's changes

`users.onChange(handler, { events, filter, withDeleted, startAfter, onError,
retries })` listens until `close()` — or `await using` — and hands over
`create`, `update`, `delete` and `restore` changes typed by the schema. A soft
delete arrives as a `delete` with `hard: false`, and a restore as a
`restore`; updates to soft-deleted documents are left out unless
`withDeleted`. `filter` is a filter on the documents, keyed on the schema's
fields.

Changes are handed over one at a time, in order. The driver resumes on its
own after a dropped connection; when it gives up, the stream is reopened from
the last token it held, so nothing is missed while the process is up. A
change's `resumeToken`, passed back as `startAfter`, picks up after a restart.
The document is the exact post-image when the collection keeps them
(`options.changeStreamPreAndPostImages`), and `before` is the pre-image.

Errors go to `onError`; without it, the first one closes the subscription and
rejects `closed`.

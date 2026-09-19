---
'@nxgt/mongo': patch
'@nxgt/drizzle': patch
'@nxgt/mongo-meilisearch': patch
---

Three things these packages do that their documentation did not say, each one
measured, and recorded rather than changed.

- **`@nxgt/mongo`: a read is never checked against the schema.** `validate` is
  about writes, so a document written by `raw`, by a migration or before a
  field existed comes back typed as though the field were there. Parse what
  you read when it matters.
- **`@nxgt/drizzle`: `findById` with a value the column's type refuses throws.**
  On a `uuid` primary key, `findById('nope')` is a `DataError` with
  `code: 'DATABASE'`, not an empty read.
- **`@nxgt/mongo-meilisearch`: a reindex holds one id per live document in
  memory** and pages the whole index. It is a deployment step.

`@nxgt/drizzle`'s "`paginate` counts, then reads" was also corrected: the two
queries run together. Two queries are still not one snapshot.

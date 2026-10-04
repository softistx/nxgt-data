# Roadmap

Where `@nxgt/mongo-backup` is going. A direction, not a commitment: the
version an item shipped in is the only number on this page.

## Next

- **Granular restore** — restore part of a backup instead of the whole
  database: one collection on its own, only the documents chosen by `_id` or
  by a filter, and a collection restored under another name beside the one
  in place.

## Later

- **Time-series collections** — back up and restore a time-series collection
  with its options, where today it is refused with `UNSUPPORTED`.
- **Sharded clusters, tested** — the specs run against a replica set only:
  a backup tested across shards, and a restore that puts back how each
  collection is sharded.
- **Point-in-time restore inside an incremental** — stop applying an
  incremental's changes at a chosen moment, instead of only at the end of a
  backup.
- **Updates to dotted or numeric field names without post-images** — an
  update naming a field with a dot or a number in it carried in an
  incremental even when the collection does not keep post-images, where
  today it is refused with `UNSUPPORTED`.

## Not planned

- **Backing up `system.*` collections** — they belong to the server, not to
  the application: restoring them over another deployment's would corrupt
  it, so they are never read.
- **Users and roles** — they live in the `admin` database and belong to the
  deployment, not to the database being backed up; manage them with the
  server's own tools or your provisioning.

## Shipped

- **MongoDB as a source and a target for `@nxgt/backup`** — 0.1.0, the first
  release: a full backup of every collection read at one cluster time, with
  each collection's options and indexes, its documents as BSON with no
  number changing kind, views with their pipeline, and GridFS buckets;
  incremental and differential backups read from the change stream —
  document writes, updates and deletes, and collections created, modified,
  renamed or dropped, indexes created or dropped, and a database dropped;
  a restore in which each collection lands whole or not at all, into the
  same database or another one, refusing a collection already there unless
  `replace` is set.

The full history is in [CHANGELOG.md](../CHANGELOG.md).

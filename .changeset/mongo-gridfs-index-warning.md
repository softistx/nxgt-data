---
'@nxgt/mongo': minor
---

A bucket with no chunk index says so, once, instead of being quietly slow.

Nothing creates a bucket's indexes on its own: `GridFSBucket` takes no
session, so this package writes chunks itself, and the driver's habit of
creating `files_id_1_n_1` on the first upload went with it. Until
`syncIndexes()` has run, reading one file's bytes examines every chunk
document of the bucket — the cost grows with the bucket rather than with the
file, the read still works, and nothing said a word.

The first read of such a bucket now emits one `process` warning:

```
(node:1) [NxgtGridFSMissingIndex] Warning: Bucket "avatars" has no
files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, and
the cost grows with the bucket rather than with the file. Call syncIndexes()
at start-up, or bind with autoSync.
```

```ts
process.on('warning', (warning) => {
	if ((warning as { code?: string }).code === 'NxgtGridFSMissingIndex') {
		log.warn(warning.message);
	}
});
```

`process.emitWarning` rather than a logger or a `console.warn`: it is the one
channel every application already has, and it can be listened to or silenced
without this package taking an opinion on logging. It is emitted once per
database and bucket for the life of the process, costs one `indexes()` round
trip, never throws, and never delays the read — the probe runs beside it. A
bucket bound with `autoSync`, or an application that calls `syncIndexes()` at
start-up, never sees it.

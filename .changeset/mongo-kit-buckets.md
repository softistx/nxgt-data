---
'@nxgt/mongo-kit': minor
---

GridFS buckets on the kit. A database takes `buckets`, a module of `@nxgt/mongo/gridfs` bucket definitions as `import * as buckets` gives it, and `bucketOptions` for every one of them. Each bucket is reached on the scope beside the collections, as `kit.db.avatars`, typed with its metadata, and runs in the kit's session: inside `kit.transaction(fn)` a file write commits or rolls back with the documents written beside it.

```ts
import * as buckets from './files';

const config = defineConfig({ uri, collections, buckets });
const kit = await createKit(config);
await kit.syncBuckets();

await kit.transaction(async (tx) => {
	const user = await tx.db.users.create({ email: 'ada@example.com' });
	await tx.db.avatars.put(Bun.file('ada.png'), {
		metadata: { userId: user._id },
	});
});
```

`sync()` is unchanged and leaves buckets alone: `syncBuckets()` creates their indexes, reporting per database and per bucket key. `defineConfig` refuses a bucket key a collection already holds, two keys on one bucket, a `buckets` object with no bucket in it, and `session` or `autoSync` in `bucketOptions`; `createKit` refuses a bucket key the driver's `Db` answers to, with `COLLISION`, as it does for a collection.

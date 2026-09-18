// What this package refuses. Checked by `tsc --noEmit`, never run: a refusal
// that stops holding fails the typecheck on its unused directive.
import { bindBucket, defineBucket } from '../../src';
import { avatars, uploads } from '../fixtures';

const store = bindBucket(avatars);
const anything = bindBucket(uploads);

// The key's parameters are the definition's, and what comes back is typed.
const key: string = store.keyFor({ userId: 'u1' });
void key;
const found: Promise<Uint8Array | undefined> = store.bytes({ userId: 'u1' });
void found;
const asText: Promise<string | undefined> = store.text({ userId: 'u1' });
void asText;

// @ts-expect-error this bucket's key is built from a `userId`
store.keyFor({ id: 'u1' });

// @ts-expect-error `userId` is a string
store.keyFor({ userId: 1 });

// @ts-expect-error this bucket's key needs both parts
anything.keyFor({ folder: 'a' });

// The same parameters guard every operation, not only `keyFor`.

// @ts-expect-error a write is for an object this bucket can name
store.put({ id: 'u1' }, 'body');

store.put(
	{ userId: 'u1' },
	'body',
	// @ts-expect-error the write option is `type`
	{ contentType: 'image/png' },
);

// @ts-expect-error a read is for an object this bucket can name
void store.bytes({ id: 'u1' });

// @ts-expect-error a stat is for an object this bucket can name
void store.stat({ id: 'u1' });

// @ts-expect-error a delete is for an object this bucket can name
void store.delete({ id: 'u1' });

// @ts-expect-error a presigned PUT is for one object, so it needs its params
store.presignPut();

store.presignPut(
	{ userId: 'u1' },
	// @ts-expect-error a presigned PUT constrains no content type; it takes none
	{ type: 'image/png' },
);

// @ts-expect-error a bucket definition needs a bucket
defineBucket({ key: (id: string) => id });

// @ts-expect-error a bucket definition needs a key
defineBucket({ bucket: 'b' });

defineBucket({
	bucket: 'b',
	// @ts-expect-error a key is a string; an object key has no other kind
	key: (id: string) => id.length,
});

defineBucket({
	bucket: 'b',
	key: (id: string) => id,
	// @ts-expect-error `maxSize` is a number of bytes
	maxSize: '1mb',
});

defineBucket({
	bucket: 'b',
	key: (id: string) => id,
	// @ts-expect-error the option is `contentType`
	contentTypes: ['image/png'],
});

// @ts-expect-error a presigned URL is for one object, so it needs its params
store.presignGet();

store.presignGet(
	{ userId: 'u1' },
	// @ts-expect-error `expiresIn` is a number of seconds
	{ expiresIn: '1h' },
);

// @ts-expect-error a listing pages by cursor; there is no page number
void store.list({ page: 2 });

// The page is this repository's cursor shape.
void store.list({ prefix: 'a/', limit: 10, cursor: null }).then((page) => {
	const next: string | null = page.nextCursor;
	const first: string | undefined = page.items[0]?.key;
	void next;
	void first;
	// @ts-expect-error a listing says nothing about a total
	void page.total;
});

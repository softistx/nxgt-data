import { describe, expect, test } from 'bun:test';
import { avatars, bytes, reports, uploads, useS3 } from '../../test/fixtures';
import { S3Error } from '../errors/s3-error';
import { bindBucket } from './bind-bucket';

const servers = useS3();
const store = () => bindBucket(avatars, servers.s3.options);
const anything = () => bindBucket(uploads, servers.s3.options);
const csv = () => bindBucket(reports, servers.s3.options);

const png = bytes(64);

describe('a bound bucket', () => {
	test('keys with the definition’s own function', () => {
		expect(store().keyFor({ userId: 'u1' })).toBe('u1.png');
		expect(anything().keyFor({ folder: 'a', name: 'b.txt' })).toBe('a/b.txt');
	});

	test('writes and reads back', async () => {
		const bucket = store();
		await bucket.put({ userId: 'u1' }, png, { type: 'image/png' });
		expect(await bucket.bytes({ userId: 'u1' })).toEqual(png);
		expect(await bucket.exists({ userId: 'u1' })).toBe(true);
	});

	test('lets a failure that is not a missing object through', async () => {
		// `undefined` means "no such object" and nothing else: a wrong secret
		// has to reach the caller, not read as an empty bucket.
		const bucket = bindBucket(avatars, {
			...servers.s3.options,
			secretAccessKey: 'wrong-secret',
		});
		expect(bucket.bytes({ userId: 'u1' })).rejects.toThrow();
	});

	test('gives undefined for an object that is not there, rather than throwing', async () => {
		const bucket = store();
		expect(await bucket.exists({ userId: 'nobody' })).toBe(false);
		expect(await bucket.bytes({ userId: 'nobody' })).toBeUndefined();
		expect(await bucket.text({ userId: 'nobody' })).toBeUndefined();
		expect(await bucket.stat({ userId: 'nobody' })).toBeUndefined();
	});

	test('says what the service knows about an object', async () => {
		const bucket = store();
		await bucket.put({ userId: 'u1' }, png, { type: 'image/png' });
		const found = await bucket.stat({ userId: 'u1' });
		expect(found?.size).toBe(64);
		expect(found?.type).toContain('image/png');
	});

	test('removes it', async () => {
		const bucket = store();
		await bucket.put({ userId: 'u1' }, png, { type: 'image/png' });
		await bucket.delete({ userId: 'u1' });
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('takes text, and gives it back as text', async () => {
		const bucket = anything();
		await bucket.put({ folder: 'notes', name: 'a.txt' }, 'bonjour');
		expect(await bucket.text({ folder: 'notes', name: 'a.txt' })).toBe(
			'bonjour',
		);
	});

	test('hands over Bun’s own file handle for everything it does not wrap', async () => {
		const bucket = anything();
		await bucket.put({ folder: 'notes', name: 'a.txt' }, 'bonjour');
		const file = bucket.file({ folder: 'notes', name: 'a.txt' });
		// `slice` is Bun's, not this package's.
		expect(await file.slice(0, 3).text()).toBe('bon');
	});
});

describe('the write guards', () => {
	test('refuse a content type the bucket does not accept, before sending', async () => {
		const bucket = store();
		const error = (await bucket
			.put({ userId: 'u1' }, png, { type: 'application/pdf' })
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.key).toBe('u1.png');
		expect(error.message).toContain('application/pdf');
		// Nothing was sent: a refusal is not a half-write.
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('refuse a write that names no type when the bucket names some', async () => {
		const error = (await store()
			.put({ userId: 'u1' }, png)
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.message).toContain('Pass `type`');
	});

	test('read a Blob’s own type rather than asking for it again', async () => {
		const bucket = store();
		await bucket.put(
			{ userId: 'u1' },
			new Blob([png as BlobPart], { type: 'image/png' }),
		);
		// The type the guard approved is the type that was sent, not a default.
		expect((await bucket.stat({ userId: 'u1' }))?.type).toContain('image/png');
	});

	test('accept a type whose parameters or case differ from the definition’s', async () => {
		// `Bun.file('a.csv').type` is `text/csv;charset=utf-8` — measured on
		// bun 1.4.2 — and a definition names the bare type. Comparing the two
		// as written would refuse a file this bucket exists for.
		const bucket = csv();
		await bucket.put('q1', 'a,b\n', { type: 'text/csv;charset=utf-8' });
		await bucket.put('q2', 'a,b\n', { type: 'TEXT/CSV' });
		expect(await bucket.text('q1')).toBe('a,b\n');
		expect(await bucket.text('q2')).toBe('a,b\n');
	});

	test('refuse a body over maxSize, before sending', async () => {
		const bucket = store();
		const error = (await bucket
			.put({ userId: 'u1' }, bytes(2048), { type: 'image/png' })
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('TOO_LARGE');
		expect(error.message).toContain('1024 bytes at most');
		expect(error.message).toContain('2048');
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('measure a string in bytes, not in characters', async () => {
		// 700 characters that are two bytes each: 700 is under the 1024 the
		// bucket allows, 1400 is over it — and bytes are the only count that
		// matters.
		const bucket = bindBucket(
			{ ...avatars, contentType: undefined },
			servers.s3.options,
		);
		const error = (await bucket
			.put({ userId: 'u1' }, 'é'.repeat(700))
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('TOO_LARGE');
		expect(error.message).toContain('1024 bytes at most');
		expect(error.message).toContain('1400');
	});

	test('refuse a body whose size cannot be known, when maxSize is set', async () => {
		const bucket = store();
		// A `Response` is one of the bodies Bun takes and nothing can measure
		// until it has been read.
		const error = (await bucket
			.put({ userId: 'u1' }, new Response('x'), { type: 'image/png' })
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('UNMEASURABLE');
		expect(error.message).toContain('cannot be known before sending');
	});

	test('refuse another S3File, which is a Blob whose size is NaN', async () => {
		const bucket = store();
		// Bun's `S3File` extends `Blob`, and its `size` is `NaN` until the
		// service has been asked — measured on bun 1.4.2. Read naively, that
		// `NaN` passes every comparison a size guard makes.
		const elsewhere = anything().file({ folder: 'other', name: 'big.png' });
		expect(elsewhere).toBeInstanceOf(Blob);
		expect(Number.isNaN(elsewhere.size)).toBe(true);
		const error = (await bucket
			.put({ userId: 'u1' }, elsewhere, { type: 'image/png' })
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('UNMEASURABLE');
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('let anything through when the bucket guards nothing', async () => {
		const bucket = anything();
		// The same body a guarded bucket refuses.
		await bucket.put(
			{ folder: 'any', name: 'streamed' },
			new Response('streamed'),
		);
		expect(await bucket.text({ folder: 'any', name: 'streamed' })).toBe(
			'streamed',
		);
	});
});

describe('listing', () => {
	test('gives the repository’s cursor page, and pages with it', async () => {
		const bucket = anything();
		for (const name of ['a', 'b', 'c']) {
			await bucket.put({ folder: 'many', name }, name);
		}

		const first = await bucket.list({ prefix: 'many/', limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		expect(first.items[0]?.key).toBe('many/a');
		expect(first.items[0]?.size).toBe(1);
		expect(first.items[0]?.lastModified).toBeInstanceOf(Date);

		const second = await bucket.list({
			prefix: 'many/',
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.items.map((item) => item.key)).toEqual(['many/c']);
		// `null`, not a token that would page forever.
		expect(second.nextCursor).toBeNull();
	});

	test('gives an empty page rather than nothing for a prefix with no objects', async () => {
		const page = await anything().list({ prefix: 'nothing-here/' });
		expect(page.items).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});
});

describe('presigned URLs', () => {
	test('a signed GET really reads the object', async () => {
		const bucket = store();
		await bucket.put({ userId: 'u1' }, png, { type: 'image/png' });
		const url = bucket.presignGet({ userId: 'u1' }, { expiresIn: 60 });
		const answer = await fetch(url);
		expect(answer.status).toBe(200);
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(png);
	});

	test('a signed PUT really writes the object', async () => {
		const bucket = csv();
		const url = bucket.presignPut('q1', { expiresIn: 60 });
		const answer = await fetch(url, {
			method: 'PUT',
			body: 'a,b\n1,2\n',
			headers: { 'content-type': 'text/csv' },
		});
		expect(answer.status).toBe(200);
		expect(await bucket.text('q1')).toBe('a,b\n1,2\n');
	});

	test('a signed PUT constrains the key and the deadline, and nothing else', async () => {
		// This is the Trap, measured rather than asserted: the URL is signed
		// for a bucket that accepts `text/csv` only, and the holder uploads a
		// zip anyway. `X-Amz-SignedHeaders` is `host`, so no header is signed
		// and the service has nothing to check the body against.
		const bucket = csv();
		const url = bucket.presignPut('q1', { expiresIn: 60 });
		expect(url).toContain('X-Amz-SignedHeaders=host');
		expect(url).not.toContain('response-content-type');
		const answer = await fetch(url, {
			method: 'PUT',
			body: 'PK\u0003\u0004',
			headers: { 'content-type': 'application/zip' },
		});
		expect(answer.status).toBe(200);
		expect((await bucket.stat('q1'))?.type).toContain('application/zip');
	});

	test('a signed URL is for one key only', () => {
		const bucket = store();
		expect(bucket.presignGet({ userId: 'u1' })).toContain('u1.png');
		expect(bucket.presignGet({ userId: 'u2' })).toContain('u2.png');
	});

	test('the signature is there, and the method is what was asked for', () => {
		const bucket = store();
		const get = bucket.presignGet({ userId: 'u1' }, { expiresIn: 60 });
		expect(get).toContain('X-Amz-Signature=');
		expect(get).toContain('X-Amz-Expires=60');
		expect(bucket.presignPut({ userId: 'u1' }, { expiresIn: 60 })).toContain(
			'X-Amz-Signature=',
		);
	});
});

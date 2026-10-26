import { describe, expect, spyOn, test } from 'bun:test';
import { avatars, uploads, useS3 } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindBucket } from '../bind-bucket';

// Against SeaweedFS 4.47: what a put and a listing under a deadline store
// and answer, compared with what the same calls give without one.
const servers = useS3();
const limit = { timeoutMs: 5000 };

const headersOf = async (name: string, path: string) =>
	(
		await fetch(
			servers.s3.client.presign(path, {
				method: 'GET',
				expiresIn: 60,
				bucket: name,
			}),
		)
	).headers;

/** The URLs `fetch` is given while `run` goes. */
async function fetched(run: () => Promise<unknown>) {
	const spy = spyOn(globalThis, 'fetch');
	try {
		await run();
		return spy.mock.calls.map(([input, init]) => ({
			url: String(input),
			method: (init as RequestInit | undefined)?.method,
		}));
	} finally {
		spy.mockRestore();
	}
}

describe('a call with a deadline goes over fetch, on a signed URL', () => {
	test('a put is a PUT, a list a signed GET on the bucket, and neither without a deadline', async () => {
		const bucket = bindBucket(uploads, servers.s3.options);
		const where = { folder: 'a', name: 'b' };
		const [put] = await fetched(() => bucket.put(where, 'x', limit));
		expect(put?.method).toBe('PUT');
		expect(put?.url).toContain('/uploads/a/b?');
		expect(put?.url).toContain('X-Amz-Signature=');
		const [list] = await fetched(() => bucket.list({ prefix: 'a', ...limit }));
		expect(list?.method).toBe('GET');
		expect(list?.url).toContain('/uploads/?');
		expect(list?.url).toContain('list-type=2&');
		expect(list?.url).toContain('X-Amz-Signature=');
		expect(await fetched(() => bucket.put(where, 'x'))).toEqual([]);
		expect(await fetched(() => bucket.list())).toEqual([]);
	});
});

describe('a put under a deadline stores what a put without one stores', () => {
	test('the type, the disposition and the encoding, sent unsigned as headers', async () => {
		// Measured: a presigned PUT carrying Content-Type, Content-Disposition
		// and Content-Encoding as plain request headers, none of them signed
		// (`SignedHeaders=host`), is stored with all three and served back by
		// SeaweedFS on a GET and a HEAD.
		const bucket = bindBucket(uploads, servers.s3.options);
		const where = { folder: 'a', name: 'timed.txt' };
		await bucket.put(where, 'héllo', {
			type: 'text/plain',
			contentDisposition: 'attachment; filename="a.txt"',
			contentEncoding: 'identity',
			acl: 'private',
			storageClass: 'STANDARD_IA',
			...limit,
		});
		const stat = await bucket.stat(where);
		expect(stat?.type).toBe('text/plain;charset=utf-8');
		expect(stat?.size).toBe(Buffer.byteLength('héllo'));
		expect(await bucket.text(where)).toBe('héllo');
		const served = await headersOf('uploads', 'a/timed.txt');
		expect(served.get('content-disposition')).toBe(
			'attachment; filename="a.txt"',
		);
		expect(served.get('content-encoding')).toBe('identity');
		await bucket.put({ folder: 'a', name: 'plain.txt' }, 'héllo', {
			type: 'text/plain',
			contentDisposition: 'attachment; filename="a.txt"',
			contentEncoding: 'identity',
			acl: 'private',
			storageClass: 'STANDARD_IA',
		});
		const plain = await headersOf('uploads', 'a/plain.txt');
		for (const name of [
			'content-type',
			'content-disposition',
			'content-encoding',
			'content-length',
		]) {
			expect(served.get(name)).toBe(plain.get(name) as string);
		}
	});

	test('with no type named, the type Bun stores, whatever the body', async () => {
		// Measured on Bun 1.4.3: `write` stores `application/octet-stream` for a
		// string, bytes and a `Blob` alike, where `fetch` alone would guess
		// `text/plain; charset=utf-8` for a string.
		const bucket = bindBucket(uploads, servers.s3.options);
		const bodies = {
			string: 'abc',
			bytes: new Uint8Array([1, 2, 3]),
			blob: new Blob(['abc']),
		};
		for (const [name, body] of Object.entries(bodies)) {
			const timed = { folder: 't', name };
			const plain = { folder: 'p', name };
			await bucket.put(timed, body, limit);
			await bucket.put(plain, body);
			expect((await bucket.stat(timed))?.type).toBe('application/octet-stream');
			expect((await bucket.stat(timed))?.type).toBe(
				(await bucket.stat(plain))?.type as string,
			);
			expect(await bucket.bytes(timed)).toEqual(
				(await bucket.bytes(plain)) as Uint8Array,
			);
		}
	});

	test('the stored type is Bun’s, over several types', async () => {
		// Bun stores the type as `new Blob([], { type }).type` gives it: lower
		// case, and `;charset=utf-8` on a text type.
		const bucket = bindBucket(uploads, servers.s3.options);
		for (const type of [
			'text/plain',
			'application/json',
			'application/javascript',
			'TEXT/PLAIN',
			'image/webp',
			'text/html; charset=iso-8859-1',
		]) {
			const timed = { folder: 't', name: 'x' };
			const plain = { folder: 'p', name: 'x' };
			await bucket.put(timed, 'abc', { type, ...limit });
			await bucket.put(plain, 'abc', { type });
			expect((await bucket.stat(timed))?.type).toBe(
				(await bucket.stat(plain))?.type as string,
			);
		}
	});

	test('a type the body carries is the type that is stored, as without one', async () => {
		const bucket = bindBucket(uploads, servers.s3.options);
		const body = new Blob(['abc'], { type: 'text/x-foo' });
		await bucket.put({ folder: 't', name: 'x' }, body, limit);
		await bucket.put({ folder: 'p', name: 'x' }, body);
		expect((await bucket.stat({ folder: 't', name: 'x' }))?.type).toBe(
			'text/x-foo',
		);
		expect((await bucket.stat({ folder: 'p', name: 'x' }))?.type).toBe(
			'text/x-foo',
		);
	});

	test('a stream, a Response and an S3File are read first and stored whole', async () => {
		const bucket = bindBucket(uploads, servers.s3.options);
		const source = { folder: 's', name: 'source' };
		await bucket.put(source, 'from the bucket', { type: 'text/plain' });
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('in '));
				controller.enqueue(new TextEncoder().encode('chunks'));
				controller.close();
			},
		});
		const bodies = {
			response: new Response('a response'),
			stream: new Response(stream),
			file: bucket.file(source),
		};
		const want = {
			response: 'a response',
			stream: 'in chunks',
			file: 'from the bucket',
		};
		for (const [name, body] of Object.entries(bodies)) {
			await bucket.put({ folder: 'd', name }, body, {
				type: 'text/plain',
				...limit,
			});
			expect(await bucket.text({ folder: 'd', name })).toBe(
				want[name as keyof typeof want],
			);
		}
	});

	test('a bucket with a maxSize refuses a stream before a byte is read', async () => {
		const bucket = bindBucket(avatars, { ...servers.s3.options, ...limit });
		const stream = new Response(new ReadableStream());
		const error = (await rejection(
			bucket.put({ userId: 'u1' }, stream, { type: 'image/png' }),
		)) as { code: string };
		expect(error.code).toBe('UNMEASURABLE');
		expect(stream.bodyUsed).toBe(false);
	});

	test('a service refusal is Bun’s own kind of error', async () => {
		const bucket = bindBucket(uploads, {
			...servers.s3.options,
			secretAccessKey: 'wrong-secret',
		});
		const error = (await rejection(
			bucket.put({ folder: 'a', name: 'b' }, 'x', limit),
		)) as Error & { code?: string; path?: string };
		expect(error.name).toBe('S3Error');
		expect(error.code).toBe('SignatureDoesNotMatch');
		expect(error.path).toBe('a/b');
		expect(error.message).not.toContain('wrong-secret');
	});
});

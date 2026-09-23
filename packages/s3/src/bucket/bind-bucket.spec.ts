import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { avatars, bytes, reports, uploads, useS3 } from '../../test/fixtures';
import { S3Error } from '../errors/s3-error';
import { bindBucket } from './bind-bucket';
import type { PresignOptions } from './operations/presign';
import type { PutOptions } from './types';

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
		// The accepted list, and never the caller's own value.
		expect(error.message).toBe(
			'"avatars" accepts image/png, image/jpeg, not the type given ' +
				'(put on "avatars")',
		);
		// Nothing was sent: a refusal is not a half-write.
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('refuse a write that names no type when the bucket names some', async () => {
		const error = (await store()
			.put({ userId: 'u1' }, png)
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.message).toBe(
			'"avatars" accepts image/png, image/jpeg, and no content type was ' +
				'named. Pass `type` (put on "avatars")',
		);
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

	test('the types `Bun.file` reports, which the README rests on', async () => {
		// The essence comparison exists because these differ. Asserted rather
		// than left in a comment: a bun release that changes one has to fail
		// here, or the README goes stale exactly as it did once already.
		const dir = `${tmpdir()}/nxgt-s3-${Bun.randomUUIDv7()}`;
		await Bun.write(`${dir}/a.csv`, 'a,b\n');
		await Bun.write(`${dir}/a.txt`, 'x');
		await Bun.write(`${dir}/a.json`, '{}');
		expect(Bun.file(`${dir}/a.csv`).type).toBe('text/csv');
		expect(Bun.file(`${dir}/a.txt`).type).toBe('text/plain;charset=utf-8');
		expect(Bun.file(`${dir}/a.json`).type).toBe(
			'application/json;charset=utf-8',
		);
		await rm(dir, { recursive: true, force: true });
	});

	test('accept a type whose parameters or case differ from the definition’s', async () => {
		// Measured on bun 1.4.2: `Bun.file` puts a charset on some types and
		// not others — `.txt` is `text/plain;charset=utf-8` and `.json` is
		// `application/json;charset=utf-8`, while `.csv` is the bare
		// `text/csv`. A definition names the bare type, so comparing the two
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

	test('refuse a storageClass the service would not take', async () => {
		const bucket = anything();
		// Bun checks this too, and throws a `TypeError` whose `name` is also
		// "S3Error" — measured. Refusing it here makes every guard on one `put`
		// one class with one code.
		const error = (await bucket
			.put({ folder: 'a', name: 'b.txt' }, 'a,b\n', {
				storageClass: 'CHEAP' as never,
			})
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toContain('storageClass must be one of');
		// Its shape, never the value: an option can come off a request.
		expect(error.message).toEndWith('; got another string (put on "uploads")');
		expect(error.message).not.toContain('CHEAP');
		expect(error.key).toBe('a/b.txt');
		expect(await bucket.exists({ folder: 'a', name: 'b.txt' })).toBe(false);
	});

	test('refuse an acl the service would not take', async () => {
		const bucket = anything();
		const error = (await bucket
			.put({ folder: 'a', name: 'b.txt' }, 'a,b\n', {
				acl: 'everyone' as never,
			})
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toContain('acl must be one of');
		expect(await bucket.exists({ folder: 'a', name: 'b.txt' })).toBe(false);
	});

	test('a presign is held to the same allowlist as a put', async () => {
		const bucket = anything();
		// `presign` forwards `acl` too, and used to forward it unchecked: the
		// same wrong value was an `S3Error` on `put` and Bun's own `TypeError`
		// here, for one mistake. Both go through `checkOption` now.
		const error = (() => {
			try {
				bucket.presignPut(
					{ folder: 'a', name: 'b.txt' },
					{ acl: 'everyone' as never },
				);
			} catch (reason: unknown) {
				return reason as S3Error;
			}
			throw new Error('it signed a URL, and should not have');
		})();
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.key).toBe('a/b.txt');
		// The call it came from is named; the value is not quoted.
		expect(error.message).toEndWith(
			'; got another string (presignPut on "uploads")',
		);
		expect(error.message).not.toContain('everyone');
		// The ACL a bucket does accept still signs.
		expect(
			bucket.presignGet({ folder: 'a', name: 'b.txt' }, { acl: 'private' }),
		).toContain('a/b.txt');
	});

	test('refuses an expiresIn the service would reject at use time', () => {
		const bucket = anything();
		const refused = (seconds: unknown): S3Error => {
			try {
				bucket.presignGet(
					{ folder: 'a', name: 'b.txt' },
					{ expiresIn: seconds as number },
				);
			} catch (reason: unknown) {
				return reason as S3Error;
			}
			throw new Error(`it signed a URL for ${String(seconds)}`);
		};
		// Measured on bun 1.4.2: the client refuses 0 and below itself, with a
		// `TypeError`; it *signs* 1e12 happily, and S3 caps a presigned URL at
		// seven days, so that URL fails at use time — after this package said
		// yes. Both are a `WRONG_OPTION` here, before anything is signed.
		const shapes: [unknown, string][] = [
			[0, 'zero'],
			[-1, 'a negative number'],
			[1e12, 'a number above that'],
			[Number.NaN, 'NaN'],
			['3600', 'a string'],
		];
		for (const [bad, shape] of shapes) {
			const error = refused(bad);
			expect(error).toBeInstanceOf(S3Error);
			expect(error.code).toBe('WRONG_OPTION');
			expect(error.key).toBe('a/b.txt');
			expect(error.message).toEndWith(
				`; got ${shape} (presignGet on "uploads")`,
			);
		}
		expect(refused(1e12).message).not.toContain('1000000000000');
		// Seven days exactly is the limit, and passes.
		expect(
			bucket.presignGet({ folder: 'a', name: 'b.txt' }, { expiresIn: 604_800 }),
		).toContain('a/b.txt');
	});

	test('take the values the service does accept', async () => {
		const bucket = anything();
		await bucket.put({ folder: 'a', name: 'ok.txt' }, 'a,b\n', {
			acl: 'private',
			storageClass: 'STANDARD',
		});
		expect(await bucket.text({ folder: 'a', name: 'ok.txt' })).toBe('a,b\n');
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

describe('the type a source carries by itself', () => {
	test('is read off a `Bun.file`, guarded, and stored — with no option', async () => {
		const dir = `${tmpdir()}/nxgt-s3-${Bun.randomUUIDv7()}`;
		const path = `${dir}/q1.csv`;
		await Bun.write(path, 'a,b\n1,2\n');
		// Measured on bun 1.4.2: `Bun.file('…​.csv').type` is `text/csv`. The
		// bucket accepts `text/csv` and nothing else, so this write passing at
		// all is the guard reading the file's own type — and the stored object
		// carrying it is the same type reaching the service.
		expect(Bun.file(path).type).toBe('text/csv');
		const bucket = csv();
		await bucket.put('q1', Bun.file(path));
		expect(await bucket.text('q1')).toBe('a,b\n1,2\n');
		expect((await bucket.stat('q1'))?.type).toContain('text/csv');
		await rm(dir, { recursive: true, force: true });
	});

	test('is refused when the file is not what the bucket accepts', async () => {
		const dir = `${tmpdir()}/nxgt-s3-${Bun.randomUUIDv7()}`;
		const path = `${dir}/note.txt`;
		await Bun.write(path, 'not a csv');
		const bucket = csv();
		// `text/plain;charset=utf-8` against a bucket that accepts `text/csv`:
		// refused before anything is sent, on a type nobody typed out.
		expect(bucket.put('q1', Bun.file(path))).rejects.toBeInstanceOf(S3Error);
		expect(await bucket.text('q1')).toBeUndefined();
		await rm(dir, { recursive: true, force: true });
	});
});

describe('what a single write may say about the object', () => {
	test('carries `contentDisposition` and `contentEncoding` back to a reader', async () => {
		const bucket = anything();
		await bucket.put({ folder: 'a', name: 'report.csv' }, 'a,b\n', {
			type: 'text/csv',
			contentDisposition: 'attachment; filename="report.csv"',
			contentEncoding: 'identity',
		});
		const answer = await fetch(
			bucket.presignGet({ folder: 'a', name: 'report.csv' }),
		);
		expect(answer.headers.get('content-disposition')).toBe(
			'attachment; filename="report.csv"',
		);
		expect(answer.headers.get('content-encoding')).toBe('identity');
	});

	test('carries a storage class', async () => {
		const bucket = anything();
		await bucket.put({ folder: 'a', name: 'cold.txt' }, 'x', {
			type: 'text/plain',
			storageClass: 'STANDARD_IA',
		});
		const answer = await fetch(
			bucket.presignGet({ folder: 'a', name: 'cold.txt' }),
		);
		expect(answer.headers.get('x-amz-storage-class')).toBe('STANDARD_IA');
	});

	test('takes an acl without refusing the write', async () => {
		// What the service *does* with an ACL is the service's business — this
		// pins only that the option reaches it and the object is still stored.
		const bucket = anything();
		await bucket.put({ folder: 'a', name: 'open.txt' }, 'x', {
			type: 'text/plain',
			acl: 'public-read',
		});
		expect(await bucket.text({ folder: 'a', name: 'open.txt' })).toBe('x');
	});

	test('does not let an option through that would change the bucket', async () => {
		// The credentials, the endpoint and the bucket belong to the bound
		// bucket. Measured: spreading the caller's options straight through
		// let a `bucket` key redirect the write — the object landed in
		// `somewhere-else` and the call reported success. The type refuses it,
		// and options that arrive from a request body are not typed.
		const bucket = anything();
		// The types refuse these — `test/types/s3.ts` holds those cases. This
		// is the other half: a bag that never met the types, as one off a
		// request body has not.
		const smuggled = {
			type: 'text/plain',
			bucket: 'somewhere-else',
			accessKeyId: 'someone-else',
			endpoint: 'http://127.0.0.1:1',
		} as PutOptions;
		await bucket.put({ folder: 'a', name: 'b.txt' }, 'x', smuggled);
		expect(await bucket.text({ folder: 'a', name: 'b.txt' })).toBe('x');
	});

	test('refuses an option’s own value itself, rather than leaving it to Bun', async () => {
		// It used to reach Bun, which refused it with a `TypeError` — a second
		// class to catch for one `put`, and one this package could not even
		// tell apart by name, because Bun calls its errors `S3Error` too.
		// `contentDisposition` and `contentEncoding` have no union, so there is
		// nothing there to refuse and they are still forwarded as they come.
		const bucket = anything();
		// `as unknown` because the types do refuse this one outright, where a
		// bag with an extra `bucket` key still overlaps `PutOptions`.
		const bad = {
			type: 'text/plain',
			storageClass: 'NOPE',
		} as unknown as PutOptions;
		const error = (await bucket
			.put({ folder: 'a', name: 'bad.txt' }, 'x', bad)
			.catch((reason: unknown) => reason)) as S3Error;
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_OPTION');
		expect(await bucket.exists({ folder: 'a', name: 'bad.txt' })).toBe(false);
	});

	test('still guards the type when other options are given', async () => {
		const bucket = store();
		expect(
			bucket.put({ userId: 'u1' }, bytes(8), {
				type: 'application/pdf',
				storageClass: 'STANDARD_IA',
			}),
		).rejects.toBeInstanceOf(S3Error);
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
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

	test('is signed for the bound bucket, whatever the options bag carries', async () => {
		const bucket = anything();
		const honest = bucket.presignGet(
			{ folder: 'a', name: 'b.txt' },
			{
				expiresIn: 60,
			},
		);
		// The types refuse these; `test/types/s3.ts` holds that half. A bag off
		// a request body never met the types, which is what this measures.
		const bag = {
			expiresIn: 60,
			bucket: 'somewhere-else',
			accessKeyId: 'someone-else',
		} as PresignOptions;
		const smuggled = bucket.presignGet({ folder: 'a', name: 'b.txt' }, bag);
		// Measured before the filter: the bag redirected the URL — `bucket`
		// signed it for another bucket, a credential signed it against another
		// endpoint. `presignPut` is a write, so the same promise has to hold.
		expect(smuggled).toContain('/uploads/a/b.txt');
		expect(smuggled).not.toContain('somewhere-else');
		expect(smuggled).not.toContain('someone-else');
		expect(new URL(smuggled).host).toBe(new URL(honest).host);
	});

	test('a signed PUT is for the bound bucket too', async () => {
		const bucket = csv();
		const url = bucket.presignPut('q1', {
			expiresIn: 60,
			bucket: 'somewhere-else',
		} as PresignOptions);
		const answer = await fetch(url, {
			method: 'PUT',
			body: 'a,b\n',
			headers: { 'content-type': 'text/csv' },
		});
		expect(answer.status).toBe(200);
		expect(await bucket.text('q1')).toBe('a,b\n');
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

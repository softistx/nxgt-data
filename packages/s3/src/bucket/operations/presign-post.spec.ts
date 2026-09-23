import { describe, expect, test } from 'bun:test';
import { S3Client } from 'bun';
import {
	avatars,
	bytes,
	reports,
	uploads,
	useS3,
} from '../../../test/fixtures';
import { S3Error } from '../../errors/s3-error';
import { bindBucket } from '../bind-bucket';
import { bucketContext } from '../context';
import type { PresignedPost, PresignPostOptions } from './presign-post';
import { presignPostForm } from './presign-post';

const servers = useS3();
const store = () => bindBucket(avatars, servers.s3.options);
const anything = () => bindBucket(uploads, servers.s3.options);
const csv = () => bindBucket(reports, servers.s3.options);

/**
 * What a browser does with the form: every field, then the file, last. The
 * service's answer is XML; its `<Code>` and `<Message>` are what is asserted,
 * as measured against SeaweedFS 4.47. `change` replaces a field, adds one,
 * or — given `undefined` — leaves one out.
 */
async function upload(
	form: PresignedPost,
	body: Blob,
	change: Record<string, string | undefined> = {},
) {
	const data = new FormData();
	for (const [name, value] of Object.entries({ ...form.fields, ...change })) {
		if (value !== undefined) data.append(name, value);
	}
	data.append('file', body);
	const response = await fetch(form.url, { method: 'POST', body: data });
	const text = await response.text();
	return {
		status: response.status,
		code: text.match(/<Code>(.*?)<\/Code>/)?.[1],
		message: text.match(/<Message>(.*?)<\/Message>/)?.[1],
	};
}

const blob = (length: number) => new Blob([bytes(length)]);

describe('a presigned POST, against the service', () => {
	test('uploads a file from a plain form, and the object is there', async () => {
		const bucket = store();
		const form = bucket.presignPost({ userId: 'u1' }, { type: 'image/png' });
		expect(await upload(form, blob(64))).toMatchObject({ status: 204 });
		const stat = await bucket.stat({ userId: 'u1' });
		expect(stat?.size).toBe(64);
		expect(stat?.type).toBe('image/png');
	});

	test('takes the bucket’s single content type when none is given', async () => {
		const bucket = csv();
		const form = bucket.presignPost('r1', { maxSize: 100 });
		expect(form.fields['Content-Type']).toBe('text/csv');
		expect(await upload(form, new Blob(['a,b\n']))).toMatchObject({
			status: 204,
		});
		expect((await bucket.stat('r1'))?.type).toBe('text/csv');
	});

	test('is refused by the service over the bucket’s maxSize', async () => {
		const bucket = store();
		const form = bucket.presignPost({ userId: 'u1' }, { type: 'image/png' });
		expect(await upload(form, blob(1025))).toEqual({
			status: 400,
			code: 'EntityTooLarge',
			message: 'Your proposed upload exceeds the maximum allowed object size.',
		});
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
		// The bound is inclusive: exactly maxSize goes through.
		expect(await upload(form, blob(1024))).toMatchObject({ status: 204 });
	});

	test('holds a smaller maxSize, and a minSize, too', async () => {
		const form = store().presignPost(
			{ userId: 'u1' },
			{ type: 'image/png', maxSize: 100, minSize: 10 },
		);
		expect(await upload(form, blob(101))).toMatchObject({
			status: 400,
			code: 'EntityTooLarge',
		});
		expect(await upload(form, blob(9))).toEqual({
			status: 400,
			code: 'EntityTooSmall',
			message:
				'Your proposed upload is smaller than the minimum allowed object size.',
		});
	});

	test('is refused by the service for another content type', async () => {
		const bucket = store();
		const form = bucket.presignPost({ userId: 'u1' }, { type: 'image/png' });
		const denied = {
			status: 403,
			code: 'AccessDenied',
			message: 'Invalid according to Policy: Policy Condition failed',
		};
		expect(
			await upload(form, blob(10), { 'Content-Type': 'application/zip' }),
		).toEqual(denied);
		// `eq` is exact: another case or a parameter is another type.
		expect(
			await upload(form, blob(10), { 'Content-Type': 'IMAGE/PNG' }),
		).toEqual(denied);
		expect(
			await upload(form, blob(10), {
				'Content-Type': 'image/png;charset=utf-8',
			}),
		).toEqual(denied);
		// Leaving the field out is not leaving the condition out.
		expect(await upload(form, blob(10), { 'Content-Type': undefined })).toEqual(
			denied,
		);
		expect(await bucket.exists({ userId: 'u1' })).toBe(false);
	});

	test('is refused by the service for another acl', async () => {
		const form = store().presignPost(
			{ userId: 'u1' },
			{ type: 'image/png', acl: 'private' },
		);
		expect(await upload(form, blob(10), { acl: 'public-read' })).toMatchObject({
			status: 403,
			code: 'AccessDenied',
			message: 'Invalid according to Policy: Policy Condition failed',
		});
	});

	test('is refused by the service for a field the policy does not name', async () => {
		const form = store().presignPost({ userId: 'u1' }, { type: 'image/png' });
		expect(await upload(form, blob(10), { 'x-amz-meta-foo': 'bar' })).toEqual({
			status: 403,
			code: 'AccessDenied',
			message:
				'Invalid according to Policy: Extra input fields: X-Amz-Meta-Foo',
		});
	});

	test('works exactly as the README posts it, on a bucket that names no type', async () => {
		// `fields`, then the file — nothing appended. The policy's
		// `starts-with $Content-Type ""` does not require the field: measured,
		// 204. The file part's own type is **not** what is stored.
		const bucket = anything();
		const params = { folder: 'f', name: 'readme' };
		const form = bucket.presignPost(params, { maxSize: 100 });
		expect(form.fields['Content-Type']).toBeUndefined();
		const body = new FormData();
		for (const [name, value] of Object.entries(form.fields)) {
			body.append(name, value);
		}
		body.append('file', new Blob(['0123456789'], { type: 'image/png' }));
		const response = await fetch(form.url, { method: 'POST', body });
		expect(response.status).toBe(204);
		expect((await bucket.stat(params))?.type).toBe('application/octet-stream');
	});

	test('is refused by the service for another key', async () => {
		const form = store().presignPost({ userId: 'u1' }, { type: 'image/png' });
		expect(await upload(form, blob(10), { key: 'u2.png' })).toMatchObject({
			status: 403,
			code: 'AccessDenied',
		});
	});

	test('holds a type prefix, with the type set by the browser', async () => {
		const bucket = anything();
		const params = { folder: 'f', name: 'a' };
		const form = bucket.presignPost(params, {
			maxSize: 100,
			type: { startsWith: 'image/' },
		});
		expect(form.fields['Content-Type']).toBeUndefined();
		expect(
			await upload(form, blob(10), { 'Content-Type': 'text/plain' }),
		).toMatchObject({ status: 403, code: 'AccessDenied' });
		// A prefix other than "" needs the field: without it, refused.
		expect(
			await upload(form, new Blob([bytes(10)], { type: 'image/png' })),
		).toMatchObject({ status: 403, code: 'AccessDenied' });
		expect(
			await upload(form, blob(10), { 'Content-Type': 'image/gif' }),
		).toMatchObject({ status: 204 });
		expect((await bucket.stat(params))?.type).toBe('image/gif');
	});

	test('lets the browser name any type when the bucket guards none', async () => {
		const bucket = anything();
		const params = { folder: 'f', name: 'b' };
		const form = bucket.presignPost(params, { maxSize: 100 });
		expect(
			await upload(form, blob(10), { 'Content-Type': 'application/zip' }),
		).toMatchObject({ status: 204 });
		expect((await bucket.stat(params))?.type).toBe('application/zip');
	});

	test('fixes an acl, which the service takes', async () => {
		const form = store().presignPost(
			{ userId: 'u1' },
			{ type: 'image/png', acl: 'public-read' },
		);
		expect(form.fields.acl).toBe('public-read');
		expect(await upload(form, blob(10))).toMatchObject({ status: 204 });
	});

	test('is refused by the service once it has expired', async () => {
		const form = store().presignPost(
			{ userId: 'u1' },
			{ type: 'image/png', expiresIn: 1 },
		);
		await Bun.sleep(2_100);
		expect(await upload(form, blob(10))).toEqual({
			status: 403,
			code: 'AccessDenied',
			message: 'Invalid according to Policy: Policy expired',
		});
	});

	test('is for the bound bucket, whatever the options bag carries', () => {
		// An options bag off a request body, with keys the types refuse.
		const smuggled = {
			type: 'image/png',
			bucket: 'somewhere-else',
			endpoint: 'http://127.0.0.1:1',
		} as PresignPostOptions;
		const form = store().presignPost({ userId: 'u1' }, smuggled);
		expect(form.url).toBe(`${servers.s3.endpoint}/avatars/`);
	});
});

describe('a presigned POST, refused before it is signed', () => {
	const refusal = (sign: () => unknown) => {
		try {
			sign();
		} catch (error) {
			return error as S3Error;
		}
		throw new Error('it was signed');
	};

	test('for a bucket with no maxSize, when none is given', () => {
		const error = refusal(() =>
			anything().presignPost({ folder: 'f', name: 'a' }),
		);
		expect(error).toBeInstanceOf(S3Error);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toContain('Pass `maxSize`');
	});

	test('for a maxSize above the bucket’s own', () => {
		const error = refusal(() =>
			store().presignPost(
				{ userId: 'u1' },
				{ type: 'image/png', maxSize: 2048 },
			),
		);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toContain("above the bucket's own 1024 bytes");
		expect(error.message).not.toContain('2048');
	});

	test.each([
		['maxSize', '1mb', 'a string'],
		['maxSize', 0, 'zero'],
		['maxSize', 1.5, 'a fraction'],
		['minSize', -1, 'a negative number'],
		['maxSize', Number.NaN, 'NaN'],
	] as const)(
		'for a %s that is not a number of bytes (%p)',
		(name, value, shape) => {
			const error = refusal(() =>
				store().presignPost({ userId: 'u1' }, {
					type: 'image/png',
					[name]: value,
				} as PresignPostOptions),
			);
			expect(error.code).toBe('WRONG_OPTION');
			expect(error.message).toContain(`presignPost on "avatars": ${name}`);
			expect(error.message).toContain(`got ${shape}`);
		},
	);

	test('for a minSize above the maxSize', () => {
		const error = refusal(() =>
			store().presignPost(
				{ userId: 'u1' },
				{ type: 'image/png', minSize: 20, maxSize: 10 },
			),
		);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toContain('minSize is above maxSize');
	});

	test('for no type, when the bucket accepts several', () => {
		const error = refusal(() => store().presignPost({ userId: 'u1' }));
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.message).toBe(
			'"avatars" accepts image/png, image/jpeg, and no content type was ' +
				'named. Pass `type` (presignPost on "avatars")',
		);
	});

	test('for a type the bucket does not accept', () => {
		const error = refusal(() =>
			store().presignPost({ userId: 'u1' }, { type: 'application/zip' }),
		);
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.message).toBe(
			'"avatars" accepts image/png, image/jpeg, not the type given ' +
				'(presignPost on "avatars")',
		);
	});

	test('for a type prefix, when the bucket names its types', () => {
		const error = refusal(() =>
			store().presignPost({ userId: 'u1' }, { type: { startsWith: 'image/' } }),
		);
		expect(error.code).toBe('WRONG_TYPE');
		expect(error.message).toContain('a prefix would let another type through');
	});

	test.each([
		[42, 'a number'],
		[{}, 'an object'],
		['', 'an empty string'],
	] as const)(
		'for a type that is neither a type nor a prefix (%p)',
		(type, shape) => {
			const error = refusal(() =>
				anything().presignPost({ folder: 'f', name: 'a' }, {
					maxSize: 10,
					type,
				} as unknown as PresignPostOptions),
			);
			expect(error.code).toBe('WRONG_OPTION');
			expect(error.message).toContain(`got ${shape}`);
		},
	);

	test('for an expiresIn outside S3’s range, as the other presigned calls', () => {
		for (const expiresIn of [0, 604_801]) {
			const error = refusal(() =>
				store().presignPost({ userId: 'u1' }, { type: 'image/png', expiresIn }),
			);
			expect(error.code).toBe('WRONG_OPTION');
			expect(error.message).toEndWith('(presignPost on "avatars")');
		}
	});

	test('for an acl the service would not take', () => {
		const error = refusal(() =>
			store().presignPost({ userId: 'u1' }, {
				type: 'image/png',
				acl: 'everyone',
			} as unknown as PresignPostOptions),
		);
		expect(error.code).toBe('WRONG_OPTION');
		expect(error.message).toEndWith(
			'; got another string (presignPost on "avatars")',
		);
		expect(error.message).not.toContain('everyone');
	});
});

describe('a presigned POST, on a clock of its own', () => {
	test('expires `expiresIn` seconds after it is signed, a day by default', () => {
		const client = new S3Client({ ...servers.s3.options, bucket: 'avatars' });
		const context = bucketContext(
			client,
			avatars,
			servers.s3.options.secretAccessKey,
		);
		const now = new Date('2026-01-01T00:00:00.000Z');
		const expiry = (options?: PresignPostOptions) => {
			const form = presignPostForm(
				context,
				{ userId: 'u1' },
				{ type: 'image/png', ...options },
				now,
			);
			return JSON.parse(
				Buffer.from(form.fields.policy ?? '', 'base64').toString(),
			).expiration;
		};
		expect(expiry({ expiresIn: 60 })).toBe('2026-01-01T00:01:00.000Z');
		expect(expiry()).toBe('2026-01-02T00:00:00.000Z');
	});
});

describe('a presigned POST with no secret to sign with', () => {
	// The environment could supply one; these hold only where it does not.
	const unset = !Bun.env.S3_SECRET_ACCESS_KEY && !Bun.env.AWS_SECRET_ACCESS_KEY;

	test.if(unset)('is Bun’s own error, as for the other presigned calls', () => {
		const bucket = bindBucket(avatars, {
			endpoint: servers.s3.endpoint,
			accessKeyId: 'a-key',
		});
		let caught: unknown;
		try {
			bucket.presignPost({ userId: 'u1' }, { type: 'image/png' });
		} catch (error) {
			caught = error;
		}
		expect(caught).not.toBeInstanceOf(S3Error);
		expect((caught as { code?: string }).code).toBe(
			'ERR_S3_MISSING_CREDENTIALS',
		);
	});
});

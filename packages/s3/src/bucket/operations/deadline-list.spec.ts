import { describe, expect, test } from 'bun:test';
import { uploads, useS3 } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindBucket } from '../bind-bucket';

// Against SeaweedFS 4.47: a listing under a deadline, signed by this package,
// compared with Bun's own `list` on the same bucket.
const servers = useS3();
const limit = { timeoutMs: 5000 };

describe('a list under a deadline gives the page a list without one gives', () => {
	const fill = async () => {
		const bucket = bindBucket(uploads, servers.s3.options);
		for (const name of [
			'a b/1',
			'a b/2',
			'a+b/1',
			'a/b/1',
			'é/1',
			'a&b/1',
			"q'(x)*!/1",
			'plain',
		]) {
			await bucket.put({ folder: '', name }, name, { type: 'text/plain' });
		}
		return bucket;
	};

	test('the same items, field for field, whole and by prefix', async () => {
		const bucket = await fill();
		expect(await bucket.list(limit)).toEqual(await bucket.list());
		expect((await bucket.list(limit)).items.length).toBe(8);
		for (const prefix of [
			'a b/',
			'a+b/',
			'a/',
			'é/',
			'a&b/',
			"q'(x)*!/",
			'a',
		]) {
			const timed = await bucket.list({ prefix, ...limit });
			expect(timed).toEqual(await bucket.list({ prefix }));
			expect(timed.items.length).toBeGreaterThan(0);
			for (const item of timed.items) expect(item.key).toStartWith(prefix);
		}
		expect((await bucket.list({ prefix: 'none', ...limit })).items).toEqual([]);
	});

	test('a cursor across pages, and the bucket’s own default', async () => {
		await fill();
		const bucket = bindBucket(uploads, { ...servers.s3.options, ...limit });
		const keys: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = await bucket.list({ limit: 3, cursor });
			expect(page).toEqual(
				await bindBucket(uploads, servers.s3.options).list({
					limit: 3,
					cursor,
				}),
			);
			keys.push(...page.items.map((item) => item.key));
			cursor = page.nextCursor;
			pages++;
		} while (cursor);
		expect(pages).toBe(3);
		expect(keys.length).toBe(8);
		expect(new Set(keys).size).toBe(8);
	});

	test('a service refusal is Bun’s own kind of error', async () => {
		const bucket = bindBucket(uploads, {
			...servers.s3.options,
			secretAccessKey: 'wrong-secret',
		});
		const error = (await rejection(bucket.list(limit))) as Error & {
			code?: string;
		};
		expect(error.name).toBe('S3Error');
		expect(error.code).toBe('SignatureDoesNotMatch');
		expect(error.message).not.toContain('wrong-secret');
	});
});

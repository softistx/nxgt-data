import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { type BoundBucket, bindBucket, defineBucket, S3Error } from '@nxgt/s3';
import { startTestS3, type TestS3 } from '@nxgt/s3/testing';
import { writePng } from '../../test/images';
import { rejection } from '../../test/rejection';
import { scene } from '../../test/scene';
import { ImageError } from '../errors/image-error';
import { defineImageSet } from '../set/define-image-set';
import { bindImageStore } from './bind-image-store';

type Params = { imageId: string; size: number };

const SEAWEEDFS_CACHE = new URL('../../../../.cache/seaweedfs', import.meta.url)
	.pathname;
const images = defineBucket({
	bucket: 'images',
	key: ({ imageId, size }: Params) => `avatars/${imageId}/${size}.webp`,
});
const set = defineImageSet({ sizes: [64, 32] });
const picture = writePng(scene());
const other = writePng(scene(2, 2));

let server: TestS3;
let bucket: BoundBucket<Params>;

beforeAll(async () => {
	server = await startTestS3({ cacheDir: SEAWEEDFS_CACHE });
	await server.createBucket('images');
	bucket = bindBucket(images, server.options);
}, 120_000);
afterAll(() => server.stop());
beforeEach(() => server.reset('images'));

const exists = (imageId: string) =>
	Promise.all(set.sizes.map((size) => bucket.exists({ imageId, size })));

describe('bindImageStore', () => {
	test('replace writes every size, and the stored bytes are the variants', async () => {
		const store = bindImageStore(set, bucket);
		const stored = await store.replace({ imageId: 'a' }, picture);
		const processed = await set.process(picture);

		expect(stored.variants.map((v) => v.size)).toEqual([64, 32]);
		for (const [index, variant] of stored.variants.entries()) {
			const source = processed.variants[index];
			expect(variant).toEqual({
				size: variant.size,
				key: `avatars/a/${variant.size}.webp`,
				width: variant.size,
				height: variant.size,
				contentType: 'image/webp',
				byteLength: source?.bytes.byteLength as number,
			});
			expect(await store.bytes({ imageId: 'a' }, variant.size)).toEqual(
				source?.bytes,
			);
		}
	});

	test('the version is stable for one input and differs for another', async () => {
		const store = bindImageStore(set, bucket);
		const first = await store.replace({ imageId: 'a' }, picture);
		const again = await store.replace({ imageId: 'a' }, picture);
		const different = await store.replace({ imageId: 'a' }, other);
		expect(first.version).toMatch(/^[0-9a-f]{16}$/);
		expect(again.version).toBe(first.version);
		expect(different.version).not.toBe(first.version);
	});

	test('remove deletes every size, and a second remove is fine', async () => {
		const store = bindImageStore(set, bucket);
		await store.replace({ imageId: 'a' }, picture);
		expect(await exists('a')).toEqual([true, true]);
		await store.remove({ imageId: 'a' });
		expect(await exists('a')).toEqual([false, false]);
		await store.remove({ imageId: 'a' });
	});

	test('presignGet gives a URL that fetches the object', async () => {
		const store = bindImageStore(set, bucket);
		await store.replace({ imageId: 'a' }, picture);
		const response = await fetch(store.presignGet({ imageId: 'a' }, 32));
		expect(response.status).toBe(200);
		const fetched = Buffer.from(await response.arrayBuffer());
		const stored = await store.bytes({ imageId: 'a' }, 32);
		expect(fetched.equals(Buffer.from(stored ?? []))).toBe(true);
		expect(fetched.byteLength).toBeGreaterThan(0);
	});

	test('bytes of a missing object is undefined', async () => {
		const store = bindImageStore(set, bucket);
		expect(await store.bytes({ imageId: 'none' }, 64)).toBeUndefined();
	});

	test('a size outside the set is a RangeError', () => {
		const store = bindImageStore(set, bucket);
		expect(() => store.presignGet({ imageId: 'a' }, 100)).toThrow(RangeError);
		expect(() => store.keyFor({ imageId: 'a' }, 100)).toThrow(RangeError);
		return rejection(store.bytes({ imageId: 'a' }, 100)).then((error) =>
			expect(error).toBeInstanceOf(RangeError),
		);
	});

	test('keyFor gives the key of a size', () => {
		const store = bindImageStore(set, bucket);
		expect(store.keyFor({ imageId: 'a' }, 64)).toBe('avatars/a/64.webp');
	});

	test('a put passes exactly { type: "image/webp" }, never an acl', async () => {
		const calls: unknown[] = [];
		const spied: BoundBucket<Params> = {
			...bucket,
			put: (params, body, options) => {
				calls.push(options);
				return bucket.put(params, body, options);
			},
		};
		await bindImageStore(set, spied).replace({ imageId: 'a' }, picture);
		expect(calls).toEqual([{ type: 'image/webp' }, { type: 'image/webp' }]);
	});

	test('a failed put cleans up every size and rethrows the first error', async () => {
		const boom = new S3Error('TIMEOUT', 'avatars/a/32.webp', 'injected');
		const failing: BoundBucket<Params> = {
			...bucket,
			put: (params, body, options) =>
				params.size === 32
					? Promise.reject(boom)
					: bucket.put(params, body, options),
		};
		const store = bindImageStore(set, failing);
		const error = await rejection(store.replace({ imageId: 'a' }, picture));
		expect(error).toBe(boom);
		expect(await exists('a')).toEqual([false, false]);
	});

	test('a processing refusal writes nothing', async () => {
		let puts = 0;
		const counting: BoundBucket<Params> = {
			...bucket,
			put: (params, body, options) => {
				puts++;
				return bucket.put(params, body, options);
			},
		};
		const store = bindImageStore(set, counting);
		expect(
			await rejection(store.replace({ imageId: 'a' }, new Uint8Array(8))),
		).toBeInstanceOf(ImageError);
		expect(
			await rejection(
				store.replace({ imageId: 'a' }, picture, {
					crop: { x: 0, y: 0, size: 5000 },
				}),
			),
		).toBeInstanceOf(RangeError);
		expect(puts).toBe(0);
		expect(await exists('a')).toEqual([false, false]);
	});

	test('the fresh-id flow keeps the new image and drops the former', async () => {
		const store = bindImageStore(set, bucket);
		const a = crypto.randomUUID();
		const b = crypto.randomUUID();
		await store.replace({ imageId: a }, picture);
		await store.replace({ imageId: b }, other);
		await store.remove({ imageId: a });
		expect(await exists(a)).toEqual([false, false]);
		expect(await exists(b)).toEqual([true, true]);
	});
});

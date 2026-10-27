import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { ImageError } from '../errors/image-error';
import type { ProcessOptions } from '../set/types';
import type { ImageStore, StoredImage } from './types';
import { uploadImage } from './upload-image';

type Params = { ownerId: string; imageId: string };
const stored: StoredImage = { version: 'abc', variants: [] };

function fakeStore() {
	const calls: {
		params: Params;
		input: unknown;
		options?: ProcessOptions | undefined;
	}[] = [];
	const store: Pick<ImageStore<Params>, 'replace'> = {
		async replace(params, input, options) {
			calls.push({ params, input, options });
			return stored;
		},
	};
	return { store, calls };
}

const put = (url: string, type: string | null, body: BodyInit = 'bytes') =>
	new Request(url, {
		method: 'PUT',
		body,
		headers: type === null ? {} : { 'content-type': type },
	});

describe('uploadImage', () => {
	test('stores the body under a fresh id and returns id, version and variants', async () => {
		const { store, calls } = fakeStore();
		const first = await uploadImage(
			store,
			{ ownerId: 'u1' },
			put('http://x/images', 'image/png'),
		);
		const second = await uploadImage(
			store,
			{ ownerId: 'u1' },
			put('http://x/images', 'image/png'),
		);
		expect(first).toEqual({
			id: calls[0]?.params.imageId as string,
			...stored,
		});
		expect(calls[0]?.params.ownerId).toBe('u1');
		expect(calls[0]?.input).toBeInstanceOf(ReadableStream);
		expect(second.id).not.toBe(first.id);
		expect(calls[0]?.options?.crop).toBeUndefined();
	});

	test('reads the crop from the query', async () => {
		const { store, calls } = fakeStore();
		await uploadImage(
			store,
			{ ownerId: 'u1' },
			put('http://x/images?x=1&y=2&size=3', 'image/webp'),
		);
		expect(calls[0]?.options?.crop).toEqual({ x: 1, y: 2, size: 3 });
	});

	test('a blank crop value reaches the store as NaN', async () => {
		const { store, calls } = fakeStore();
		await uploadImage(
			store,
			{ ownerId: 'u1' },
			put('http://x/images?x=&y=2&size=3', 'image/png'),
		);
		expect(calls[0]?.options?.crop?.x).toBeNaN();
	});

	test('accepts a content type with parameters and any case', async () => {
		const { store } = fakeStore();
		await uploadImage(
			store,
			{ ownerId: 'u1' },
			put('http://x/images', 'Image/JPEG; charset=binary'),
		);
	});

	test('refuses a non-image or missing content type before reading the body', async () => {
		for (const type of ['text/plain', 'application/octet-stream', null]) {
			const { store, calls } = fakeStore();
			const error = await rejection(
				uploadImage(
					store,
					{ ownerId: 'u1' },
					put('http://x/images', type, new Uint8Array([1])),
				),
			);
			expect(error).toBeInstanceOf(ImageError);
			expect((error as ImageError).code).toBe('UNSUPPORTED_TYPE');
			expect((error as ImageError).reason).toBe('format');
			expect(calls).toHaveLength(0);
		}
	});

	test('an ImageError of the store comes out unchanged', async () => {
		const refusal = new ImageError('INVALID_CROP', 'crop');
		const store: Pick<ImageStore<Params>, 'replace'> = {
			replace: async () => {
				throw refusal;
			},
		};
		expect(
			await rejection(
				uploadImage(
					store,
					{ ownerId: 'u1' },
					put('http://x/images?size=', 'image/png'),
				),
			),
		).toBe(refusal);
	});

	test('a request without a body reaches the store as empty bytes', async () => {
		const { store, calls } = fakeStore();
		await uploadImage(
			store,
			{ ownerId: 'u1' },
			new Request('http://x/images', {
				method: 'PUT',
				headers: { 'content-type': 'image/png' },
			}),
		);
		expect((calls[0]?.input as Uint8Array | undefined)?.byteLength).toBe(0);
	});
});

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { objectId } from '../definition/fields';
import { defineBucket } from './define-bucket';

describe('defineBucket', () => {
	test('names the two collections GridFS keeps', () => {
		const bucket = defineBucket({ name: 'avatars' });
		expect(bucket.collections).toEqual({
			files: 'avatars.files',
			chunks: 'avatars.chunks',
		});
		expect(bucket.chunkSize).toBeUndefined();
	});

	test('refuses a name GridFS could not build its collections from', () => {
		expect(() => defineBucket({ name: '' })).toThrow(/not a bucket name/);
		expect(() => defineBucket({ name: 'a.b' })).toThrow(/not a bucket name/);
		expect(() => defineBucket({ name: 'a$b' })).toThrow(/not a bucket name/);
	});

	test('refuses a chunk size that is not a count of bytes', () => {
		expect(() => defineBucket({ name: 'a', chunkSize: 0 })).toThrow(
			/chunkSize/,
		);
		expect(() => defineBucket({ name: 'a', chunkSize: 1.5 })).toThrow(
			/chunkSize/,
		);
		expect(defineBucket({ name: 'a', chunkSize: 1024 }).chunkSize).toBe(1024);
	});

	test('refuses a metadata field this package keeps for itself', () => {
		// GridFS stores no content type of its own — measured, the driver drops
		// the option — so those two names are where this package puts them.
		expect(() =>
			defineBucket({
				name: 'a',
				metadata: z.object({ contentType: z.string() }),
			}),
		).toThrow(/keeps the file's own content type/);
		expect(() =>
			defineBucket({ name: 'a', metadata: z.object({ sha256: z.string() }) }),
		).toThrow(/keeps the file's own content type/);
	});

	test('is frozen, definition and collections both', () => {
		const bucket = defineBucket({
			name: 'a',
			metadata: z.object({ userId: objectId() }),
		});
		expect(Object.isFrozen(bucket)).toBe(true);
		expect(Object.isFrozen(bucket.collections)).toBe(true);
	});
});

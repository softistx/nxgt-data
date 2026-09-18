import { describe, expect, test } from 'bun:test';
import { avatars } from '../../test/fixtures';
import { defineBucket } from './define-bucket';

describe('defineBucket', () => {
	test('refuses a definition with no bucket', () => {
		expect(() => defineBucket({ bucket: '', key: (id: string) => id })).toThrow(
			'needs a bucket',
		);
	});

	test('refuses a maxSize that is not a positive number of bytes', () => {
		for (const maxSize of [0, -1, Number.NaN]) {
			expect(() =>
				defineBucket({ bucket: 'b', key: (id: string) => id, maxSize }),
			).toThrow('number of bytes');
		}
	});

	test('refuses an empty list of content types, which accepts nothing', () => {
		expect(() =>
			defineBucket({ bucket: 'b', key: (id: string) => id, contentType: [] }),
		).toThrow('nothing could ever be written');
	});

	test('is frozen, so a definition cannot drift after it is shared', () => {
		expect(Object.isFrozen(avatars)).toBe(true);
	});

	test('talks to nothing: no credentials are needed to describe a bucket', () => {
		// It is the definition that is shared between a server and a worker;
		// only `bindBucket` needs a key.
		expect(
			defineBucket({ bucket: 'b', key: (id: string) => `${id}.txt` }).key('x'),
		).toBe('x.txt');
	});
});

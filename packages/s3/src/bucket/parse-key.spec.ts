import { describe, expect, test } from 'bun:test';
import { bindBucket } from './bind-bucket';
import { defineBucket } from './define-bucket';

const options = {
	endpoint: 'http://127.0.0.1:1',
	accessKeyId: 'k',
	secretAccessKey: 's',
};

const items = defineBucket({
	bucket: 'files',
	key: (p: { id: string }) => `items/${p.id}`,
	parseKey: (key) => {
		const id = /^items\/([0-9a-f-]+)$/.exec(key)?.[1];
		return id === undefined ? undefined : { id };
	},
});

describe('parseKey', () => {
	test('maps a stored key back to its params', () => {
		const store = bindBucket(items, options);
		expect(store.parseKey(store.keyFor({ id: 'abc' }))).toEqual({ id: 'abc' });
	});

	test('answers undefined for a key that is not the bucket’s', () => {
		const store = bindBucket(items, options);
		expect(store.parseKey('other/abc')).toBeUndefined();
		expect(store.parseKey('items/ZZ')).toBeUndefined();
	});

	test('answers undefined when the parse does not rebuild the key', () => {
		const loose = defineBucket({
			bucket: 'files',
			key: (p: { id: string }) => `items/${p.id}`,
			parseKey: (key) => ({ id: key.slice(6) }),
		});
		expect(bindBucket(loose, options).parseKey('nope/abc')).toBeUndefined();
	});

	test('throws a TypeError when the definition has no parseKey', () => {
		const bare = defineBucket({
			bucket: 'files',
			key: (p: { id: string }) => p.id,
		});
		expect(() => bindBucket(bare, options).parseKey('a')).toThrow(TypeError);
	});
});

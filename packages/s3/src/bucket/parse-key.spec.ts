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

	test('round-trips a multi-field P with a slash in the key', () => {
		const files = defineBucket({
			bucket: 'files',
			key: (p: { folder: string; name: string }) => `${p.folder}/${p.name}`,
			parseKey: (key) => {
				const i = key.indexOf('/');
				return i < 0
					? undefined
					: { folder: key.slice(0, i), name: key.slice(i + 1) };
			},
		});
		const store = bindBucket(files, options);
		const params = { folder: 'a', name: 'b/c.txt' };
		expect(store.parseKey(store.keyFor(params))).toEqual(params);
	});

	test('round-trips a primitive P', () => {
		const plain = defineBucket({
			bucket: 'files',
			key: (p: string) => p,
			parseKey: (p) => p,
		});
		const store = bindBucket(plain, options);
		expect(store.parseKey(store.keyFor('abc'))).toBe('abc');
	});

	test('round-trips an empty-string param', () => {
		const plain = defineBucket({
			bucket: 'files',
			key: (p: { id: string }) => `items/${p.id}`,
			parseKey: (key) =>
				key.startsWith('items/') ? { id: key.slice(6) } : undefined,
		});
		const store = bindBucket(plain, options);
		expect(store.parseKey(store.keyFor({ id: '' }))).toEqual({ id: '' });
	});

	test('propagates a throw from the definition’s parseKey', () => {
		const boom = defineBucket({
			bucket: 'files',
			key: (p: string) => p,
			parseKey: () => {
				throw new RangeError('boom');
			},
		});
		expect(() => bindBucket(boom, options).parseKey('a')).toThrow(RangeError);
	});

	test('throws a TypeError when the definition has no parseKey', () => {
		const bare = defineBucket({
			bucket: 'files',
			key: (p: { id: string }) => p.id,
		});
		expect(() => bindBucket(bare, options).parseKey('a')).toThrow(TypeError);
	});
});

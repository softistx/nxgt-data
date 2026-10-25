import { describe, expect, test } from 'bun:test';
import { assertBunImage } from './runtime';

const message = '@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists';

describe('assertBunImage', () => {
	test('accepts a Bun with Image', () => {
		expect(() => assertBunImage({ Image: class {} })).not.toThrow();
	});

	test.each([
		['no Bun global', undefined],
		['a null Bun', null],
		['a Bun without Image', {}],
		['a Bun whose Image is not a function', { Image: 1 }],
	])('refuses %s with a TypeError', (_name, bun) => {
		expect(() => assertBunImage(bun)).toThrow(TypeError);
		expect(() => assertBunImage(bun)).toThrow(message);
	});
});

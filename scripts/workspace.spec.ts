import { describe, expect, test } from 'bun:test';
import { waves } from './workspace';

describe('waves', () => {
	test('a package runs after every sibling it names', () => {
		const order = waves([
			{ name: 'client', dir: '', needs: ['core', 'zod'] },
			{ name: 'core', dir: '', needs: [] },
			{ name: 'docs', dir: '', needs: ['client'] },
		]).map((wave) => wave.map((node) => node.name));
		expect(order).toEqual([['core'], ['client'], ['docs']]);
	});

	test('refuses a cycle', () => {
		expect(() =>
			waves([
				{ name: 'a', dir: '', needs: ['b'] },
				{ name: 'b', dir: '', needs: ['a'] },
			]),
		).toThrow('cycle');
	});
});

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineChannel } from './define-channel';

describe("defineChannel's onNoLocalReader", () => {
	const base = { name: 'a', schema: z.object({}) };
	test("'drop' needs fallback: 'local'", () => {
		expect(() => defineChannel({ ...base, onNoLocalReader: 'drop' })).toThrow(
			TypeError,
		);
		expect(
			defineChannel({ ...base, fallback: 'local', onNoLocalReader: 'drop' })
				.onNoLocalReader,
		).toBe('drop');
	});
	test('another value is refused, and none is the default', () => {
		expect(() =>
			defineChannel({ ...base, onNoLocalReader: 'skip' as never }),
		).toThrow(TypeError);
		expect(defineChannel(base).onNoLocalReader).toBeUndefined();
	});
});

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { QueueError } from '../../../errors/queue-error';
import { checkStepName, decodeStep, encodeStep } from './step-codec';

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe('checkStepName', () => {
	test('accepts 1 to 128 characters', () => {
		expect(checkStepName('q', 'step', 'a')).toBe('a');
		expect(checkStepName('q', 'key', 'x'.repeat(128))).toHaveLength(128);
	});

	test.each([
		['empty', ''],
		['too long', 'x'.repeat(129)],
		['a colon', 'a:b'],
		['a number', 1],
		['undefined', undefined],
	])('refuses %s', (_label, name) => {
		const error = thrown(() => checkStepName('q', 'step', name));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'step on "q": name is a string of 1 to 128 characters without ":"',
		);
	});

	test('names the call', () => {
		const error = thrown(() => checkStepName('q', 'key', ''));
		expect((error as Error).message).toStartWith('key on "q": name is');
	});
});

describe('encodeStep and decodeStep', () => {
	test('undefined is the empty string and reads back undefined', () => {
		expect(encodeStep('q', 's', undefined)).toBe('');
		expect(decodeStep('')).toEqual({ ok: true, value: undefined });
	});

	test('undefined needs a schema that accepts it', () => {
		expect(encodeStep('q', 's', undefined, z.string().optional())).toBe('');
		const error = thrown(() => encodeStep('q', 's', undefined, z.string()));
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('INVALID');
	});

	test('an object round trips', () => {
		const json = encodeStep('q', 's', { a: [1, 'x'], b: null });
		expect(decodeStep(json)).toEqual({
			ok: true,
			value: { a: [1, 'x'], b: null },
		});
	});

	test('[] stays []', () => {
		const json = encodeStep('q', 's', []);
		expect(json).toBe('[]');
		expect(decodeStep(json)).toEqual({ ok: true, value: [] });
	});

	test('a Date has no JSON form without a schema', () => {
		const error = thrown(() => encodeStep('q', 'mail', new Date(0)));
		expect(error).toBeInstanceOf(QueueError);
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).message).toBe(
			'step on "q": step "mail" returned a value that has no JSON form',
		);
	});

	test('a Date a schema transforms is accepted', () => {
		const schema = z.coerce.date().transform((date) => date.toISOString());
		const json = encodeStep('q', 's', new Date(0), schema);
		expect(json).toBe('"1970-01-01T00:00:00.000Z"');
		expect(decodeStep(json, schema)).toEqual({
			ok: true,
			value: '1970-01-01T00:00:00.000Z',
		});
	});

	test('a schema whose output is undefined is refused unless it accepts undefined', () => {
		const schema = z.string().transform(() => undefined);
		const error = thrown(() => encodeStep('q', 's', 'x', schema));
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).message).toBe(
			'step on "q": step "s" returned a value that has no JSON form',
		);
	});

	test('{ a: undefined } is refused without a schema and stored by one that accepts it', () => {
		const error = thrown(() => encodeStep('q', 's', { a: undefined }));
		expect((error as QueueError).code).toBe('INVALID');
		const schema = z.object({ a: z.string().optional() });
		expect(encodeStep('q', 's', { a: undefined }, schema)).toBe('{}');
	});

	test('a refused value names the issue codes, not the value', () => {
		const error = thrown(() =>
			encodeStep('q', 's', 'secret-value', z.number()),
		);
		const message = (error as QueueError).message;
		expect((error as QueueError).code).toBe('INVALID');
		expect(message).toContain('invalid_type');
		expect(message).not.toContain('secret-value');
	});

	test('a throwing schema is INVALID', () => {
		const schema = z.string().refine(() => {
			throw new Error('boom secret');
		});
		const error = thrown(() => encodeStep('q', 's', 'x', schema));
		expect((error as QueueError).code).toBe('INVALID');
		expect((error as QueueError).message).not.toContain('boom');
	});

	test('a decode the schema refuses is not ok', () => {
		expect(decodeStep('"x"', z.number())).toEqual({ ok: false });
		expect(decodeStep('{not json')).toEqual({ ok: false });
		expect(decodeStep('', z.string())).toEqual({ ok: false });
	});
});

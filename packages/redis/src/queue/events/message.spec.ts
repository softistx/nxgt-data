import { describe, expect, test } from 'bun:test';
import { parseEvent } from './message';

describe('parseEvent', () => {
	test('reads each type the scripts publish', () => {
		expect(
			parseEvent('{"type":"completed","id":"a","result":{"n":1}}'),
		).toEqual({ type: 'completed', id: 'a', result: { n: 1 } });
		expect(
			parseEvent(
				'{"type":"failed","id":"a","error":{"name":"E","message":"m"}}',
			),
		).toEqual({ type: 'failed', id: 'a', error: { name: 'E', message: 'm' } });
		expect(parseEvent('{"type":"canceled","id":"a","token":"t"}')).toEqual({
			type: 'canceled',
			id: 'a',
			token: 't',
		});
	});

	test('leaves out the fields a message does not carry', () => {
		expect(
			Object.keys(parseEvent('{"type":"canceled","id":"a"}') ?? {}),
		).toEqual(['type', 'id']);
	});

	test('a malformed text is undefined', () => {
		expect(parseEvent('{"type":')).toBeUndefined();
		expect(parseEvent('')).toBeUndefined();
	});

	test('null and other non-objects are undefined', () => {
		expect(parseEvent('null')).toBeUndefined();
		expect(parseEvent('"canceled"')).toBeUndefined();
		expect(parseEvent('42')).toBeUndefined();
	});

	test('a type the scripts never publish is undefined', () => {
		expect(parseEvent('{"type":"removed","id":"a"}')).toBeUndefined();
		expect(parseEvent('{"id":"a"}')).toBeUndefined();
	});

	test('an id that is not a string is undefined', () => {
		expect(parseEvent('{"type":"canceled","id":7}')).toBeUndefined();
		expect(parseEvent('{"type":"canceled"}')).toBeUndefined();
	});

	test('a token that is not a string is left out', () => {
		expect(parseEvent('{"type":"canceled","id":"a","token":5}')).toEqual({
			type: 'canceled',
			id: 'a',
		});
	});
});

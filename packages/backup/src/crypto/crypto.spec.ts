import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bytes, folder, keyPair, streamOf } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { checkRecipients, decrypterFor } from './keys';
import { openFile, sealToFile } from './seal';

let tmp: Awaited<ReturnType<typeof folder>>;
beforeEach(async () => {
	tmp = await folder();
});
afterEach(() => tmp.remove());

describe('keys', () => {
	test('a bad recipient is a TypeError naming its position, with no cause', () => {
		const secret = 'age1SHOULDNOTAPPEAR';
		let error: unknown;
		try {
			checkRecipients([secret], 'bindBackup');
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'bindBackup: recipient 0 is not an age public key (age1… or age1pq1…)',
		);
		expect((error as Error).cause).toBeUndefined();
	});

	test('a bad identity never reaches the message, nor the cause', () => {
		// Measured on age-encryption 0.3.1: age's own message quotes it whole.
		const secret = 'AGE-SECRET-KEY-1SHOULDNOTAPPEARQQQQ';
		let error: unknown;
		try {
			decrypterFor([secret], 'restore');
		} catch (caught) {
			error = caught;
		}
		expect((error as Error).message).toBe(
			'restore: identity 0 is not an age secret key (AGE-SECRET-KEY-…)',
		);
		expect((error as Error).cause).toBeUndefined();
		expect(
			JSON.stringify(error, Object.getOwnPropertyNames(error)),
		).not.toContain('SHOULDNOT');
	});

	test('no recipient, or no identity, is refused', () => {
		expect(() => checkRecipients([], 'bindBackup')).toThrow('at least one');
		expect(() => decrypterFor([], 'verify')).toThrow('at least one');
	});
});

describe('seal and open', () => {
	test('zstd before age: repetitive bytes shrink, and come back whole', async () => {
		const keys = await keyPair();
		const path = join(tmp.path, 'x.age');
		const plain = new Uint8Array(1_000_000).fill(7);
		const sealed = await sealToFile(streamOf(plain), [keys.recipient], path);
		expect(sealed.plain.size).toBe(1_000_000);
		expect(sealed.stored.size).toBeLessThan(10_000);
		const opened = await openFile(
			path,
			decrypterFor([keys.identity], 'test'),
			sealed.plain,
			() => new Error('mismatch'),
		);
		expect(new Uint8Array(await new Response(opened).arrayBuffer())).toEqual(
			plain,
		);
	});

	test('a digest that differs fails the stream at its end', async () => {
		const keys = await keyPair();
		const path = join(tmp.path, 'x.age');
		const sealed = await sealToFile(
			streamOf(bytes(5000)),
			[keys.recipient],
			path,
		);
		const opened = await openFile(
			path,
			decrypterFor([keys.identity], 'test'),
			{ ...sealed.plain, sha256: '0'.repeat(64) },
			() => new Error('mismatch'),
		);
		expect(await rejection(new Response(opened).arrayBuffer())).toHaveProperty(
			'message',
			'mismatch',
		);
	});
});

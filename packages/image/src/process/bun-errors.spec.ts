import { describe, expect, test } from 'bun:test';
import { ImageError } from '../errors/image-error';
import { mapBunError } from './bun-errors';

function mapped(code: string, format: 'jpeg' | 'heic' = 'jpeg') {
	const bun = Object.assign(new Error('bun'), { code });
	const error = mapBunError(bun, format) as ImageError;
	expect(error).toBeInstanceOf(ImageError);
	expect(error.cause).toBe(bun);
	return [error.code, error.reason];
}

describe('mapBunError', () => {
	test('maps each Bun.Image code, its error kept as the cause', () => {
		expect(mapped('ERR_IMAGE_TOO_MANY_PIXELS')).toEqual([
			'TOO_LARGE',
			'pixels',
		]);
		expect(mapped('ERR_IMAGE_DECODE_FAILED')).toEqual([
			'UNDECODABLE',
			'decode',
		]);
		// Bun answers this for bytes it cannot place at all, which the sniff
		// rarely lets through (a sniffed file is a decode failure in practice).
		expect(mapped('ERR_IMAGE_UNKNOWN_FORMAT')).toEqual([
			'UNDECODABLE',
			'decode',
		]);
	});

	test('an unsupported format is `heic-unavailable` for HEIC, `format` for the rest', () => {
		expect(mapped('ERR_IMAGE_FORMAT_UNSUPPORTED', 'heic')).toEqual([
			'UNSUPPORTED_TYPE',
			'heic-unavailable',
		]);
		expect(mapped('ERR_IMAGE_FORMAT_UNSUPPORTED', 'jpeg')).toEqual([
			'UNSUPPORTED_TYPE',
			'format',
		]);
	});

	test('any other error comes back untouched', () => {
		const other = new Error('out of memory');
		expect(mapBunError(other, 'png')).toBe(other);
		expect(mapBunError(undefined, 'png')).toBeUndefined();
	});
});

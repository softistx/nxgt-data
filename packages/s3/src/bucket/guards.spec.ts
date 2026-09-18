import { describe, expect, test } from 'bun:test';
import { effectiveType, essenceOf, sizeOf } from './guards';

describe('essenceOf', () => {
	test('drops the parameters and the case', () => {
		expect(essenceOf('text/csv;charset=utf-8')).toBe('text/csv');
		expect(essenceOf('TEXT/CSV')).toBe('text/csv');
		expect(essenceOf(' text/csv ; charset=utf-8')).toBe('text/csv');
	});
});

describe('effectiveType', () => {
	test('prefers what the caller named', () => {
		expect(
			effectiveType(new Blob(['a'], { type: 'text/plain' }), 'text/csv'),
		).toBe('text/csv');
	});

	test('falls back to what a Blob knows about itself', () => {
		// A text `Blob` adds the charset itself — measured on bun 1.4.2 — so
		// what a body reports is not what a definition names. That is the
		// whole reason `essenceOf` exists.
		expect(
			effectiveType(new Blob(['a'], { type: 'text/plain' }), undefined),
		).toBe('text/plain;charset=utf-8');
	});

	test('is undefined when nothing knows, including a typeless Blob', () => {
		// A `Blob` with no type reports `''`, which is not a content type.
		expect(effectiveType(new Blob(['a']), undefined)).toBeUndefined();
		expect(effectiveType('a string', undefined)).toBeUndefined();
	});
});

describe('sizeOf', () => {
	test('measures a string in UTF-8 bytes, not in characters', () => {
		expect(sizeOf('é'.repeat(700))).toBe(1400);
	});

	test('measures the bodies whose length is already known', () => {
		expect(sizeOf(new Uint8Array(64))).toBe(64);
		expect(sizeOf(new ArrayBuffer(32))).toBe(32);
		expect(sizeOf(new Blob(['abc']))).toBe(3);
	});

	test('is undefined for a body nothing can measure before sending', () => {
		expect(sizeOf(new Response('x'))).toBeUndefined();
		expect(
			sizeOf(new Request('http://x/', { method: 'POST', body: 'x' })),
		).toBeUndefined();
	});
});

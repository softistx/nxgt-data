import { describe, expect, test } from 'bun:test';
import { defineMongo, openMongo, WiringError } from '@nxgt/mongo';
import { createKit, defineConfig, KitError } from './index';

describe('the deprecated names', () => {
	test('createKit is openMongo', () => {
		expect(createKit).toBe(openMongo);
	});

	test('defineConfig is defineMongo', () => {
		expect(defineConfig).toBe(defineMongo);
	});

	test('KitError is WiringError', () => {
		expect(KitError).toBe(WiringError);
		const error = new KitError('CONFIG', 'x');
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toBeInstanceOf(TypeError);
	});
});

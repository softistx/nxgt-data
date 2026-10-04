import { describe, expect, test } from 'bun:test';
import { defineRedis, openRedis } from '@nxgt/redis';
import { connectKit, defineConfig } from './index';

describe('the deprecated names', () => {
	test('connectKit is openRedis', () => {
		expect(connectKit).toBe(openRedis);
	});

	test('defineConfig is defineRedis', () => {
		expect(defineConfig).toBe(defineRedis);
	});
});

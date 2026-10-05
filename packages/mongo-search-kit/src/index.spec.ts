import { describe, expect, test } from 'bun:test';
import { createSearchSyncs } from '@nxgt/mongo-meilisearch';
import { createSearchKit } from './index';

describe('the deprecated names', () => {
	test('createSearchKit is createSearchSyncs', () => {
		expect(createSearchKit).toBe(createSearchSyncs);
	});
});

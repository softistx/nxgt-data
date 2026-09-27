import { describe, expect, test } from 'bun:test';
import { licenseProblems } from './tarball';

describe('licenseProblems', () => {
	test('wants MIT and a LICENSE in the tarball itself', () => {
		expect(
			licenseProblems({ name: 'x', license: 'MIT' }, ['package/LICENSE']),
		).toEqual([]);
		expect(licenseProblems({ name: 'x', license: 'ISC' }, [])).toEqual([
			'x: license is ISC, not MIT',
			'x: the tarball has no LICENSE',
		]);
	});
});

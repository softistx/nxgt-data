import { describe, expect, test } from 'bun:test';
import { hasValidator, validationMatches } from './validator-diff';

const jsonSchema = {
	$jsonSchema: {
		type: 'object',
		properties: { email: { type: 'string' }, age: { bsonType: 'date' } },
		required: ['email'],
	},
};

describe('hasValidator', () => {
	test('an empty validator is no validator', () => {
		expect(hasValidator({})).toBe(false);
		expect(hasValidator({ validator: {} })).toBe(false);
		expect(hasValidator({ validator: jsonSchema })).toBe(true);
	});
});

describe('validationMatches', () => {
	const wanted = {
		validator: jsonSchema,
		level: 'strict' as const,
		action: 'error' as const,
	};

	test('matches the validator it wrote, whatever the key order', () => {
		expect(
			validationMatches(wanted, {
				validator: {
					$jsonSchema: {
						required: ['email'],
						properties: {
							age: { bsonType: 'date' },
							email: { type: 'string' },
						},
						type: 'object',
					},
				},
				validationLevel: 'strict',
				validationAction: 'error',
			}),
		).toBe(true);
	});

	test('a collection created with a validator reports no level: strict, error', () => {
		// `options` comes back without them when they were never set.
		expect(validationMatches(wanted, { validator: jsonSchema })).toBe(true);
		expect(
			validationMatches(
				{ ...wanted, level: 'moderate' },
				{ validator: jsonSchema },
			),
		).toBe(false);
	});

	test('a changed schema, level or action does not match', () => {
		expect(
			validationMatches(wanted, {
				validator: { $jsonSchema: { type: 'object' } },
			}),
		).toBe(false);
		expect(
			validationMatches(wanted, {
				validator: jsonSchema,
				validationAction: 'warn',
			}),
		).toBe(false);
	});

	test('level off wants no validator at all', () => {
		const off = {
			validator: undefined,
			level: 'off' as const,
			action: 'error' as const,
		};
		// A collection created with none reports `options: {}`; one whose
		// validator was removed keeps its level and loses the key.
		expect(validationMatches(off, {})).toBe(true);
		expect(
			validationMatches(off, {
				validationLevel: 'strict',
				validationAction: 'error',
			}),
		).toBe(true);
		expect(validationMatches(off, { validator: jsonSchema })).toBe(false);
	});
});

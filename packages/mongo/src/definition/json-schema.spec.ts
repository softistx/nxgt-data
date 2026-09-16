import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { deletedAtField, id, objectId, timestampField } from './fields';
import { toMongoJsonSchema } from './json-schema';

describe('toMongoJsonSchema', () => {
	test('declares Date and ObjectId with bsonType, which JSON Schema has not', () => {
		const schema = toMongoJsonSchema(
			z.object({
				_id: id(),
				createdAt: timestampField(),
				updatedAt: timestampField(),
				deletedAt: deletedAtField(),
			}),
		);
		expect(schema).toMatchObject({
			type: 'object',
			properties: {
				_id: { bsonType: 'objectId' },
				createdAt: { bsonType: 'date' },
				deletedAt: { anyOf: [{ bsonType: 'date' }, { type: 'null' }] },
			},
		});
	});

	test('takes a bsonType from the schema’s metadata', () => {
		const schema = toMongoJsonSchema(
			z.object({
				_id: objectId(),
				amount: z.number().meta({ bsonType: 'decimal' }),
			}),
		);
		expect(schema.properties).toMatchObject({
			amount: { bsonType: 'decimal' },
		});
	});

	test('maps integer, which MongoDB has no type for', () => {
		const schema = toMongoJsonSchema(
			z.object({ _id: objectId(), count: z.int().min(0) }),
		);
		const count = (schema.properties as Record<string, Record<string, unknown>>)
			.count as Record<string, unknown>;
		// A whole number reaches BSON as an int, or a double past 32 bits;
		// `multipleOf` is what then refuses a fractional one.
		expect(count.bsonType).toEqual(['int', 'long', 'double']);
		expect(count.multipleOf).toBe(1);
		expect(count.type).toBeUndefined();
		expect(count.minimum).toBe(0);
	});

	test('keeps a nullable integer nullable', () => {
		const schema = toMongoJsonSchema(
			z.object({ _id: objectId(), count: z.int().nullable() }),
		);
		const count = (schema.properties as Record<string, Record<string, unknown>>)
			.count as Record<string, unknown>;
		const nullable =
			count.bsonType ??
			(count.anyOf as Record<string, unknown>[] | undefined)?.flatMap(
				(one) => one.bsonType ?? one.type,
			);
		expect(JSON.stringify(nullable)).toContain('null');
	});

	test('drops every keyword MongoDB would refuse', () => {
		const schema = toMongoJsonSchema(
			z.object({ _id: objectId(), email: z.email() }),
		);
		const json = JSON.stringify(schema);
		// `format` and `$schema` are in what zod emits, and MongoDB rejects a
		// keyword it does not know rather than ignoring it.
		expect(json).not.toContain('$schema');
		expect(json).not.toContain('"format"');
		expect(json).not.toContain('"id"');
		// The pattern zod emits alongside `format` is kept: it is a keyword.
		expect(json).toContain('pattern');
	});

	test('inlines a schema used twice, since $jsonSchema has no $ref', () => {
		const address = z.object({ city: z.string() }).meta({ id: 'Address' });
		const schema = toMongoJsonSchema(
			z.object({ _id: objectId(), home: address, work: address }),
		);
		expect(schema.definitions).toBeUndefined();
		expect(JSON.stringify(schema)).not.toContain('$ref');
		const properties = schema.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(properties.home).toEqual(properties.work as never);
		expect(properties.home).toMatchObject({
			type: 'object',
			properties: { city: { type: 'string' } },
		});
	});

	test('refuses a schema that refers to itself', () => {
		const node: z.ZodType = z.object({
			name: z.string(),
			get child() {
				return node.optional();
			},
		});
		expect(() =>
			toMongoJsonSchema(z.object({ _id: objectId(), root: node })),
		).toThrow(/refers to itself/);
	});

	test('keeps the object’s own keywords', () => {
		const schema = toMongoJsonSchema(
			z.object({
				_id: objectId(),
				tags: z.array(z.string()).max(3),
				role: z.enum(['admin', 'user']),
				bio: z.string().max(10).optional(),
			}),
		);
		expect(schema).toMatchObject({
			properties: {
				tags: { type: 'array', maxItems: 3, items: { type: 'string' } },
				role: { type: 'string', enum: ['admin', 'user'] },
				bio: { type: 'string', maxLength: 10 },
			},
			required: ['_id', 'tags', 'role'],
			additionalProperties: false,
		});
	});
});

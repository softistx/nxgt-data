import { z } from 'zod';

/**
 * Every keyword MongoDB's `$jsonSchema` knows. It **rejects** a document that
 * uses any other, rather than ignoring it, so anything not in here is dropped
 * on the way out.
 */
export const MONGO_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
	'additionalItems',
	'additionalProperties',
	'allOf',
	'anyOf',
	'bsonType',
	'dependencies',
	'description',
	'enum',
	'exclusiveMaximum',
	'exclusiveMinimum',
	'items',
	'maxItems',
	'maxLength',
	'maxProperties',
	'maximum',
	'minItems',
	'minLength',
	'minProperties',
	'minimum',
	'multipleOf',
	'not',
	'oneOf',
	'pattern',
	'patternProperties',
	'properties',
	'required',
	'title',
	'type',
	'uniqueItems',
]);

/** Keywords whose value is a map of names to schemas, not a schema. */
const SCHEMA_MAPS = new Set([
	'properties',
	'patternProperties',
	'dependencies',
]);

type Node = Record<string, unknown>;

function isRecord(value: unknown): value is Node {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A JavaScript number reaches BSON as an `int` when it is a whole number that
 * fits in 32 bits, and as a `double` otherwise — never as a `long`, unless the
 * caller wrapped it. `type: "integer"`, which MongoDB has no equivalent for,
 * therefore becomes the three types a whole number can arrive as, with
 * `multipleOf: 1` to refuse a fractional double.
 */
const INTEGER_BSON_TYPES = ['int', 'long', 'double'];

function convertIntegerType(node: Node): void {
	const type = node.type;
	if (type === 'integer') {
		delete node.type;
		node.bsonType = [...INTEGER_BSON_TYPES];
		node.multipleOf ??= 1;
		return;
	}
	if (Array.isArray(type) && type.includes('integer')) {
		delete node.type;
		node.bsonType = [
			...type.filter((one) => one !== 'integer'),
			...INTEGER_BSON_TYPES,
		];
		node.multipleOf ??= 1;
	}
}

function refName(ref: string): string {
	return ref.replace(/^#\/(definitions|\$defs)\//, '');
}

function inline(value: unknown, defs: Node, stack: string[]): unknown {
	if (Array.isArray(value)) {
		return value.map((one) => inline(one, defs, stack));
	}
	if (!isRecord(value)) return value;

	if (typeof value.$ref === 'string') {
		const name = refName(value.$ref);
		if (stack.includes(name)) {
			throw new TypeError(
				`toMongoJsonSchema: "${name}" refers to itself. MongoDB's $jsonSchema ` +
					'has no $ref, so a recursive schema cannot be a validator. Give the ' +
					'collection no validator, or model the field as an object with no ' +
					'schema of its own.',
			);
		}
		const target = defs[name];
		if (!isRecord(target)) {
			throw new TypeError(
				`toMongoJsonSchema: cannot resolve ${value.$ref}, which zod emitted`,
			);
		}
		const { $ref: _ref, ...siblings } = value;
		return {
			...(inline(target, defs, [...stack, name]) as Node),
			...(inline(siblings, defs, stack) as Node),
		};
	}

	const out: Node = {};
	for (const [key, inner] of Object.entries(value)) {
		if (!MONGO_JSON_SCHEMA_KEYWORDS.has(key)) continue;
		if (SCHEMA_MAPS.has(key) && isRecord(inner)) {
			const mapped: Node = {};
			for (const [name, schema] of Object.entries(inner)) {
				mapped[name] = inline(schema, defs, stack);
			}
			out[key] = mapped;
			continue;
		}
		out[key] = inline(inner, defs, stack);
	}
	convertIntegerType(out);
	return out;
}

/**
 * A Zod schema as a MongoDB `$jsonSchema`, ready for a collection's validator.
 *
 * `z.toJSONSchema` alone is not one: MongoDB rejects `$schema`, `$ref`,
 * `definitions`, `default`, `format` and `id`, has no `integer` type, and
 * treats a keyword it does not know as an error rather than ignoring it. This
 * resolves every `$ref` by inlining it, keeps only the keywords MongoDB
 * knows, and maps `integer`.
 *
 * `Date` and `ObjectId` have no JSON Schema type: they are declared with
 * `bsonType`, which `date()` and `objectId()` already carry in their metadata.
 * Any schema can do the same with `.meta({ bsonType: 'decimal' })`.
 *
 * ```ts
 * toMongoJsonSchema(z.object({ _id: objectId(), email: z.string() }));
 * // { type: 'object', properties: { … }, required: ['_id', 'email'], … }
 * ```
 */
export function toMongoJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, {
		target: 'draft-4',
		io: 'output',
		// A `Date` is unrepresentable in JSON Schema; the override below gives
		// it a bsonType instead, and `{}` is what it starts from.
		unrepresentable: 'any',
		override: (ctx) => {
			const type = (ctx.zodSchema as { _zod: { def: { type: string } } })._zod
				.def.type;
			if (type === 'date' && ctx.jsonSchema.bsonType === undefined) {
				ctx.jsonSchema.bsonType = 'date';
			}
		},
	}) as Node;

	const definitions = isRecord(json.definitions)
		? json.definitions
		: isRecord(json.$defs)
			? json.$defs
			: {};
	return inline(json, definitions, []) as Record<string, unknown>;
}

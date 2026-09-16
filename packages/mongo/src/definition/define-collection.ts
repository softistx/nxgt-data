import type { IndexDescription, ObjectId } from 'mongodb';
import type { z } from 'zod';

/** What MongoDB does with a document that fails the validator. */
export type ValidationAction = 'error' | 'warn';

/**
 * Which documents the validator applies to. `off` writes no validator at all;
 * `moderate` exempts documents that were already invalid from updates.
 */
export type ValidationLevel = 'off' | 'moderate' | 'strict';

export interface ValidationConfig {
	/** Default `'strict'`. */
	level?: ValidationLevel;
	/** Default `'error'`. `'warn'` logs and lets the write through. */
	action?: ValidationAction;
}

/** What `defineCollection` takes. */
export interface CollectionConfig<Schema extends z.ZodObject> {
	/** The collection's name on the server. */
	name: string;
	/**
	 * The documents, as they are stored: `z.output` is what a read gives back,
	 * `z.input` what a write takes. It must have an `_id`.
	 */
	schema: Schema;
	/** The indexes `sync` creates, as the driver describes them. */
	indexes?: readonly IndexDescription[];
	/** The `$jsonSchema` validator `sync` writes from the schema. */
	validation?: ValidationConfig;
}

/** A collection, as `defineCollection` returns it: frozen, with its defaults. */
export interface CollectionDefinition<Schema extends z.ZodObject = z.ZodObject>
	extends Readonly<CollectionConfig<Schema>> {
	readonly indexes: readonly IndexDescription[];
	readonly validation: Required<ValidationConfig>;
}

/** Any definition, whatever its documents. */
export type AnyCollectionDefinition = CollectionDefinition<any>;

/** The documents of a definition, as they are read back. */
export type DocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? z.output<Schema>
		: never
	: never;

/** What a write takes: the documents before their defaults are filled. */
export type NewDocumentOf<Def> = Def extends { schema: infer Schema }
	? Schema extends z.ZodType
		? z.input<Schema>
		: never
	: never;

/** The type of `_id`. */
export type IdOf<Def> =
	DocumentOf<Def> extends { _id: infer Id } ? Id : ObjectId;

/** A field of the documents, as a top-level key. */
export type FieldOf<Def> = keyof DocumentOf<Def> & string;

/**
 * Defines a collection: its name, the Zod schema of its documents, its
 * indexes, and how its validator is applied.
 *
 * The schema is the one source: it types every read and write, and `sync`
 * derives the collection's `$jsonSchema` validator from it.
 *
 * ```ts
 * export const users = defineCollection({
 * 	name: 'users',
 * 	schema: z.object({
 * 		_id: id(),
 * 		email: z.email(),
 * 		...timestamps(),
 * 		...softDelete(),
 * 	}),
 * 	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
 * });
 * ```
 */
export function defineCollection<Schema extends z.ZodObject>(
	config: CollectionConfig<Schema>,
): CollectionDefinition<Schema> {
	if (!('_id' in config.schema.shape)) {
		throw new TypeError(
			`defineCollection: "${config.name}"'s schema has no _id. Add ` +
				'`_id: id()`, which fills a new ObjectId on create, or declare the ' +
				'key your documents use.',
		);
	}
	return Object.freeze({
		...config,
		indexes: Object.freeze([...(config.indexes ?? [])]),
		validation: Object.freeze({
			level: config.validation?.level ?? 'strict',
			action: config.validation?.action ?? 'error',
		}),
	}) as CollectionDefinition<Schema>;
}

/** Which of the fields the repository knows about a definition's schema has. */
export function stampsOf(definition: AnyCollectionDefinition): {
	createdAt: boolean;
	updatedAt: boolean;
	deletedAt: boolean;
	version: boolean;
	createdBy: boolean;
	updatedBy: boolean;
	deletedBy: boolean;
} {
	const shape = definition.schema.shape as Record<string, unknown>;
	const has = (name: string) => name in shape;
	return {
		createdAt: has('createdAt'),
		updatedAt: has('updatedAt'),
		deletedAt: has('deletedAt'),
		version: has('version'),
		createdBy: has('createdBy'),
		updatedBy: has('updatedBy'),
		deletedBy: has('deletedBy'),
	};
}

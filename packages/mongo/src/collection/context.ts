import type {
	ClientSession,
	Db,
	Collection as DriverCollection,
} from 'mongodb';
import type { z } from 'zod';
import {
	type AnyCollectionDefinition,
	stampsOf,
} from '../definition/define-collection';
import { NotFoundError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import { DEFAULT_MAX_PAGE_SIZE } from '../pagination/page';
import type { CollectionOptions } from './types';

/** Which of the fields the collection knows about a schema has. */
type Stamps = ReturnType<typeof stampsOf>;

/**
 * What every method of a collection works from, resolved once: the
 * definition, the driver's collection, and the options once they have been
 * read against the schema.
 *
 * It holds **data only**. The operations are plain functions that take it as
 * their first argument, in `filters.ts`, `documents.ts`, `reads.ts`,
 * `writes.ts` and `paginate.ts` — a context of closures would only be the
 * factory this package split up, one size down.
 *
 * `withSession` and `as` build another one, cheaply: they are the same
 * collection with a single option changed.
 */
export interface CollectionContext {
	readonly definition: AnyCollectionDefinition;
	readonly db: Db;
	/**
	 * The driver's collection, typed loosely on purpose: this layer works on
	 * any documents, and the public type is what callers see.
	 */
	readonly collection: DriverCollection<any>;
	readonly name: string;
	readonly shape: Record<string, z.ZodType>;
	readonly stamps: Stamps;
	/** Who is writing, stamped into the `*By` fields. */
	readonly actor: unknown;
	readonly session: ClientSession | undefined;
	/** `{ session }` when there is one, to spread into the driver's options. */
	readonly sessionOption: { session?: ClientSession };
	readonly maxPageSize: number;
	/**
	 * Whether the schema declares an `id` field of its own. Then `id` is that
	 * field's, and this package neither computes it nor drops it.
	 */
	readonly hasOwnId: boolean;
	/** Whether a write is checked against the schema, which fills its defaults. */
	readonly parses: boolean;
	/** Whether `delete` writes `deletedAt` rather than removing the document. */
	readonly softDeletes: boolean;
	/** Whether an update that does not set `updatedAt` gets it set. */
	readonly touches: boolean;
	/** Whether an update raises `version`. */
	readonly locks: boolean;
}

/**
 * Resolves a collection's options against its schema, and refuses the two
 * that cannot be honoured: a soft delete without `deletedAt`, and an
 * optimistic lock without `version`.
 */
export function createContext(
	db: Db,
	definition: AnyCollectionDefinition,
	options: CollectionOptions<never>,
): CollectionContext {
	const name = definition.name;
	const shape = definition.schema.shape as Record<string, z.ZodType>;
	const stamps = stampsOf(definition);
	const session = options.session;

	if (options.softDelete === true && !stamps.deletedAt) {
		throw new TypeError(
			`getCollection: softDelete needs a "deletedAt" field, and "${name}" has none`,
		);
	}
	if (options.optimisticLock === true && !stamps.version) {
		throw new TypeError(
			`getCollection: optimisticLock needs a "version" field, and "${name}" has none`,
		);
	}

	return {
		definition,
		db,
		collection: db.collection<any>(name),
		name,
		shape,
		stamps,
		actor: options.actor as unknown,
		session,
		sessionOption: session ? { session } : {},
		maxPageSize: options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
		hasOwnId: 'id' in shape,
		parses: (options.validate ?? 'parse') === 'parse',
		softDeletes: options.softDelete ?? stamps.deletedAt,
		touches: options.touchUpdatedAt ?? stamps.updatedAt,
		locks: options.optimisticLock ?? stamps.version,
	};
}

/** Runs an operation, turning a MongoDB error into a `DataError`. */
export async function run<T>(
	ctx: CollectionContext,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDataError(error, { collection: ctx.name });
	}
}

export function notFound(ctx: CollectionContext, id: unknown): NotFoundError {
	return new NotFoundError(
		`No document in "${ctx.name}" with _id ${String(id)}`,
		{ collection: ctx.name, id },
	);
}

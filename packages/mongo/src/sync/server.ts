import type {
	ClientSession,
	Db,
	Document,
	IndexDescriptionInfo,
} from 'mongodb';
import { DataError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';
import type { WantedValidation } from './validator-diff';

/** What sync reads from the server and sends to it. Nothing here decides. */

/** A MongoDB error's numeric code, when it has one. */
export function serverCode(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : undefined;
}

/**
 * A collection's options as the server holds them, or `undefined` when there
 * is no such collection.
 *
 * `nameOnly: false` is what types the answer as the whole entry: without it
 * the driver's overload gives back a name and a type alone.
 */
export async function liveOptions(
	db: Db,
	name: string,
	session: ClientSession | undefined,
): Promise<Document | undefined> {
	const [info] = await db
		.listCollections(
			{ name },
			{ ...(session ? { session } : {}), nameOnly: false },
		)
		.toArray();
	return info ? ((info.options ?? {}) as Document) : undefined;
}

/** The indexes of a collection, or none when it does not exist yet. */
export async function liveIndexes(
	db: Db,
	name: string,
	session: ClientSession | undefined,
): Promise<IndexDescriptionInfo[]> {
	try {
		return await db.collection(name).indexes({ session });
	} catch (error) {
		// NamespaceNotFound: nothing is there, so nothing is indexed.
		if (serverCode(error) === 26) return [];
		throw error;
	}
}

/** `collMod`, with the one error worth explaining rather than passing on. */
async function collMod(
	db: Db,
	name: string,
	fields: Document,
	session: ClientSession | undefined,
): Promise<void> {
	try {
		await db.command(
			{ collMod: name, ...fields },
			session ? { session } : undefined,
		);
	} catch (error) {
		if (serverCode(error) === 13) {
			throw new DataError(
				`sync: not allowed to run collMod on "${name}". Changing a validator ` +
					'or a collection option needs the `collMod` action, which ' +
					'`readWrite` does not grant and `dbAdmin` does: sync with a role ' +
					'that has it, not with the application’s own user.',
				{ collection: name, serverCode: 13, cause: error },
			);
		}
		throw toDataError(error, { collection: name });
	}
}

/** Writes the definition's validator onto an existing collection. */
export async function writeValidation(
	db: Db,
	name: string,
	wanted: WantedValidation,
	session: ClientSession | undefined,
): Promise<void> {
	await collMod(
		db,
		name,
		{
			// An empty validator is how one is removed: the key then goes away
			// entirely, and the level and the action stay behind.
			validator: wanted.validator ?? {},
			...(wanted.validator === undefined
				? {}
				: { validationLevel: wanted.level, validationAction: wanted.action }),
		},
		session,
	);
}

/** Changes the collection options `collMod` accepts. */
export async function writeOptions(
	db: Db,
	name: string,
	fields: Document,
	session: ClientSession | undefined,
): Promise<void> {
	await collMod(db, name, fields, session);
}

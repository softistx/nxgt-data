/**
 * Where backups are kept. Keys are relative, `/`-separated paths that this
 * package builds — `<backup>/<id>/manifest.json` — and a repository stores
 * the bytes it is given under them, as they are.
 *
 * Write one for a store this package does not ship: each method below says
 * what the rest of the package relies on.
 */
export interface Repository {
	/**
	 * How this repository is named in outcomes and errors: `local`, `s3`, or
	 * the name you give it. Never a credential or a URL that holds one.
	 */
	readonly name: string;
	/**
	 * Stores the local file at `file` under `key`, **whole or not at all**
	 * once it resolves: the bytes are all there, and as durable as the store
	 * makes them. One that rejects may leave part of an object under `key`
	 * for a moment — never a key a manifest names, since the manifest goes
	 * last and only to a repository that took everything. Overwrites.
	 */
	put(key: string, file: string): Promise<void>;
	/** The bytes under `key`, or `undefined` when there are none. */
	get(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
	/** Every key that starts with `prefix`, in any order. */
	list(prefix: string): AsyncIterable<string>;
	/** Removes `key`. Removing a key that is not there is not an error. */
	delete(key: string): Promise<void>;
}

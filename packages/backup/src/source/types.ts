/** One thing a source backs up: a file, a collection, a table. */
export interface SourceEntry {
	/**
	 * Its name, unique within the backup: a relative path, a collection's
	 * name. Not empty, at most 4096 characters, no NUL. It is encrypted with
	 * the data and never written in the clear.
	 */
	name: string;
	/** Its bytes, read when the backup gets to it, and only once. */
	open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
}

/** What a backup reads from. */
export interface BackupSource {
	/** What it is, recorded in the backup: `directory`, `mongo`. */
	readonly kind: string;
	/** Its entries, each opened in turn: never two at once. */
	entries(): AsyncIterable<SourceEntry>;
}

/** Where a restore writes to. */
export interface RestoreTarget {
	/**
	 * Takes one entry back. The stream fails at its end, rather than ending,
	 * when the bytes are not the ones the backup recorded: a target that
	 * cannot undo a write keeps it apart until the stream has ended. `write`
	 * resolves only once the stream has been read to its end: `restore`
	 * refuses one that resolves sooner, since nothing was checked yet.
	 */
	write(name: string, stream: ReadableStream<Uint8Array>): Promise<void>;
}

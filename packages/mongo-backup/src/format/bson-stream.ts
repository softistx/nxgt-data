import { MongoBackupError } from '../errors';

/**
 * The largest document read back: the server's 16 MiB, and room for the
 * fields a change record adds around one.
 */
export const DOCUMENT_MAX_BYTES = 17 * 1024 * 1024;

/**
 * The BSON documents of a stream of concatenated ones — each its own bytes,
 * length first, as `mongodump` writes them. Each is filled in place as the
 * chunks arrive, so a large one is copied once. A length that is not one,
 * or a stream that ends inside a document, is `MALFORMED`.
 */
export async function* bsonDocuments(
	stream: ReadableStream<Uint8Array>,
	where: string,
): AsyncGenerator<Uint8Array> {
	const malformed = () =>
		new MongoBackupError(
			`${where}: an entry is not a sequence of BSON documents`,
			'MALFORMED',
		);
	let carry = new Uint8Array(0);
	let document: Uint8Array | undefined;
	let filled = 0;
	for await (const chunk of stream) {
		const data = carry.length === 0 ? chunk : concat(carry, chunk);
		carry = new Uint8Array(0);
		let offset = 0;
		while (offset < data.length) {
			if (document) {
				const n = Math.min(document.length - filled, data.length - offset);
				document.set(data.subarray(offset, offset + n), filled);
				filled += n;
				offset += n;
				if (filled === document.length) {
					yield document;
					document = undefined;
				}
				continue;
			}
			if (data.length - offset < 4) {
				carry = data.slice(offset);
				break;
			}
			const length = new DataView(
				data.buffer,
				data.byteOffset + offset,
				4,
			).getInt32(0, true);
			if (length < 5 || length > DOCUMENT_MAX_BYTES) throw malformed();
			document = new Uint8Array(length);
			filled = 0;
		}
	}
	if (document || carry.length > 0) throw malformed();
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const joined = new Uint8Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}

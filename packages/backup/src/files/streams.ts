/**
 * At most `limit` bytes of `stream`, the rest cancelled: a repository is not
 * trusted with the size. Holds only what arrived, not `limit` up front.
 */
export async function upTo(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (length < limit) {
		const { done, value } = await reader.read();
		if (done) return Buffer.concat(chunks, length);
		const kept = value.subarray(0, limit - length);
		chunks.push(kept);
		length += kept.length;
	}
	await reader.cancel();
	return Buffer.concat(chunks, length);
}

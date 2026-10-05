import type { RedisClient } from 'bun';

/** A Lua script, and the SHA-1 Redis caches it under. */
export interface Script {
	readonly source: string;
	readonly sha: string;
}

/**
 * Describes a script once, at import: its SHA-1 is computed here, with Bun's
 * own hasher, so no call pays for it and none sends the source when the
 * server already holds it.
 */
export function defineScript(source: string): Script {
	const sha = new Bun.CryptoHasher('sha1').update(source).digest('hex');
	return Object.freeze({ source, sha });
}

/**
 * Whether Redis answered that it does not hold the script.
 *
 * Measured on bun 1.4.2 against Redis 7.4.1: after `SCRIPT FLUSH`,
 * `evalsha` rejects with an `Error` whose `name` is `'RedisError'` and whose
 * `code` is Bun's generic `'ERR_REDIS_SERVER_ERROR'` — the one every server
 * error carries. The only thing that tells `NOSCRIPT` apart is the server's
 * own reply, which is the message verbatim:
 * `NOSCRIPT No matching script. Please use EVAL.`
 */
function isNoScript(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/**
 * Runs a script by its SHA-1, and sends the source only when the server does
 * not hold it: after a restart, a failover or a `SCRIPT FLUSH`. `EVAL` caches
 * the script again, so the next call is an `EVALSHA` once more.
 */
export async function runScript(
	client: RedisClient,
	script: Script,
	keys: readonly string[],
	args: readonly (string | number)[],
): Promise<unknown> {
	try {
		return await client.evalsha(script.sha, keys.length, ...keys, ...args);
	} catch (error) {
		if (!isNoScript(error)) throw error;
		return await client.eval(script.source, keys.length, ...keys, ...args);
	}
}

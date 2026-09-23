import { beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import { ObjectId } from 'mongodb';
import { buildApp } from '../src/app';
import type { Env, GuardOptions } from '../src/context';
import { useKit } from './kit';
import { useRedis } from './redis';

/** Somebody who exists nowhere: the caller of a request that names no one real. */
export const stranger = new ObjectId().toHexString();

type Call = (
	path: string,
	init?: RequestInit & { as?: string | null },
) => Promise<Response>;

/** Requests to one app, as a client would send them. */
function caller(app: () => Hono<Env>): Call {
	/** A request, as a client would send it. `as: null` names no user at all. */
	return async (path, init = {}) => {
		const { as = stranger, ...rest } = init;
		// `app.request` may answer without awaiting anything, so this is
		// `async`: a helper that announces a promise always gives one.
		return app().request(path, {
			...rest,
			headers: {
				'content-type': 'application/json',
				...(as === null ? {} : { 'x-user-id': as }),
				...init.headers,
			},
		});
	};
}

/**
 * The application over a mongod and a Redis of its own, and the two things
 * every route spec does: send a request, and create a user to send it as. A
 * module's route spec calls only its own routes through it.
 */
export function useApi(database: string, options: GuardOptions = {}) {
	const state = useKit(database);
	const servers = useRedis();
	let app: Hono<Env>;

	beforeAll(() => {
		app = buildApp(state.kit, servers.redis.client, options);
	});

	const call = caller(() => app);

	/** A user to write as, created through the API like everything else. */
	async function newUser(email = 'ada@example.com'): Promise<string> {
		const created = await call('/users', {
			method: 'POST',
			body: JSON.stringify({ email }),
		});
		return ((await created.json()) as { id: string }).id;
	}

	/**
	 * A second app over the same servers, told something else — for a spec
	 * that compares two settings. Call it inside a test.
	 */
	function callWith(other: GuardOptions): Call {
		const built = buildApp(state.kit, servers.redis.client, other);
		return caller(() => built);
	}

	return { kit: state, redis: servers, call, callWith, newUser };
}

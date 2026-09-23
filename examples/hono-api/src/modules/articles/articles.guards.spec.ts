import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { bindRateLimit } from '@nxgt/redis-guard';
import { stranger, useApi } from '../../../test/api';
import type { NewArticle } from '../../generated/types';
import { articleWrites } from './articles.guards';
import { ArticleService } from './articles.service';

/**
 * The guards on `POST /articles`, over HTTP, against a real Redis emptied
 * before every test. `idempotencyWait: 0` answers a repeat of a running key
 * with 409 at once; the one spec about waiting builds a second app.
 */
const { call, callWith, newUser, redis } = useApi('blog-articles-guards', {
	idempotencyWait: 0,
});

const draft = JSON.stringify({ title: 'On wiring', body: 'One object.' });

/** The writes still in flight, which `afterEach` waits for. */
const inflight = new Set<Promise<Response>>();

/** A write as `user`, with an `Idempotency-Key` when one is given. */
function post(user: string, body = draft, key?: string, send = call) {
	const sent = send('/articles', {
		method: 'POST',
		as: user,
		body,
		headers: key === undefined ? {} : { 'Idempotency-Key': key },
	});
	inflight.add(sent);
	void sent.finally(() => inflight.delete(sent)).catch(() => undefined);
	return sent;
}

/** How many articles `user` has, as the API reports it. */
async function countOf(user: string): Promise<number> {
	const read = await call(`/users/${user}`, { as: user });
	return ((await read.json()) as { articles: number }).articles;
}

/**
 * Holds `ArticleService.write` until `release()` — a gate inside
 * the work, as `@nxgt/redis-guard`'s own specs hold theirs: `work` is called
 * only once `run` holds the key, so `started` is the moment a repeat finds
 * it running.
 */
function holdNextWrite() {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const original = ArticleService.prototype.write;
	const spy = spyOn(ArticleService.prototype, 'write').mockImplementation(
		async function (this: ArticleService, values: NewArticle) {
			started.resolve();
			await finish.promise;
			return original.call(this, values);
		},
	);
	releaseHeld = finish.resolve;
	return { started: started.promise, release: finish.resolve, spy };
}

/** The gate of the last `holdNextWrite`, for `afterEach` to open. */
let releaseHeld: (() => void) | undefined;

// However a test ended, a held write is let go — or a failed assertion would
// leave a request running, its lease renewed for ever — and every spy it
// made is undone.
afterEach(async () => {
	releaseHeld?.();
	releaseHeld = undefined;
	// And whatever it let go finishes here, not in the next test's database.
	await Promise.allSettled(inflight);
	mock.restore();
});

describe('the write limit', () => {
	test('counts down in the RateLimit headers, then answers 429', async () => {
		const user = await newUser();
		const resets: number[] = [];
		for (let i = 0; i < 5; i += 1) {
			const written = await post(user);
			expect(written.status).toBe(201);
			expect(written.headers.get('RateLimit-Limit')).toBe('5');
			expect(written.headers.get('RateLimit-Remaining')).toBe(String(4 - i));
			expect(written.headers.get('Retry-After')).toBeNull();
			resets.push(Number(written.headers.get('RateLimit-Reset')));
		}
		// A write is 12 s of refill, rounded up to the second: one from a
		// full bucket is exactly 12, and five are 60 less what the test took.
		expect(resets[0]).toBe(12);
		expect(resets[4]).toBeGreaterThanOrEqual(59);
		expect(resets[4]).toBeLessThanOrEqual(60);

		const denied = await post(user);
		expect(denied.status).toBe(429);
		expect(await denied.json()).toEqual({ message: 'errors.rate-limited' });
		expect(denied.headers.get('RateLimit-Remaining')).toBe('0');
		// The first write's 12 s, less what the test took since: whole
		// seconds, rounded up, never down.
		const retry = Number(denied.headers.get('Retry-After'));
		expect(retry).toBeGreaterThanOrEqual(11);
		expect(retry).toBeLessThanOrEqual(12);
		// Nothing past the fifth was written.
		expect(await countOf(user)).toBe(5);
	});

	test('keys the bucket on the user the request carries', async () => {
		const ada = await newUser('ada@example.com');
		const grace = await newUser('grace@example.com');
		for (let i = 0; i < 5; i += 1) await post(ada);
		expect((await post(ada)).status).toBe(429);

		const other = await post(grace);
		expect(other.status).toBe(201);
		expect(other.headers.get('RateLimit-Remaining')).toBe('4');
	});

	test('a denied write takes no Idempotency-Key', async () => {
		const user = await newUser();
		for (let i = 0; i < 5; i += 1) await post(user);
		expect((await post(user, draft, 'k-1')).status).toBe(429);

		// Refill this user's bucket, and only it: the key was never taken,
		// so the same request now writes rather than replaying.
		await bindRateLimit(redis.redis.client, articleWrites).reset({ user });
		const written = await post(user, draft, 'k-1');
		expect(written.status).toBe(201);
		expect(written.headers.get('Idempotent-Replayed')).toBeNull();
	});
});

describe('the Idempotency-Key', () => {
	test('writes once, and replays the first answer', async () => {
		const user = await newUser();
		const first = await post(user, draft, 'k-1');
		expect(first.status).toBe(201);
		expect(first.headers.get('Idempotent-Replayed')).toBeNull();
		const article = await first.json();

		const again = await post(user, draft, 'k-1');
		expect(again.status).toBe(201);
		expect(again.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await again.json()).toEqual(article);
		// One article, one count: the retry wrote nothing.
		expect(await countOf(user)).toBe(1);
	});

	test('without one, every request writes', async () => {
		const user = await newUser();
		await post(user);
		await post(user);
		expect(await countOf(user)).toBe(2);
	});

	test('replays a 404 as a 404', async () => {
		const first = await post(stranger, draft, 'k-1');
		expect(first.status).toBe(404);
		const again = await post(stranger, draft, 'k-1');
		expect(again.status).toBe(404);
		expect(again.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await again.json()).toEqual({ message: 'errors.no-such-author' });
	});

	test('refuses a key reused for another body with 422', async () => {
		const user = await newUser();
		await post(user, draft, 'k-1');

		const other = await post(
			user,
			JSON.stringify({ title: 'Another', body: 'b' }),
			'k-1',
		);
		expect(other.status).toBe(422);
		expect(await other.json()).toEqual({
			message: 'errors.idempotency-key-reused',
		});

		// The fingerprint is the raw body: the same fields in another order
		// are another request, as far as the key can tell.
		const reordered = await post(
			user,
			JSON.stringify({ body: 'One object.', title: 'On wiring' }),
			'k-1',
		);
		expect(reordered.status).toBe(422);

		// The same fields in the same order, only laid out differently: a
		// fingerprint of the parsed body would call it the same request.
		const spaced = await post(
			user,
			JSON.stringify(JSON.parse(draft), null, 2),
			'k-1',
		);
		expect(spaced.status).toBe(422);
		expect(await countOf(user)).toBe(1);
	});

	test('leaves a record it cannot trust to the 500', async () => {
		const user = await newUser();
		// A hash `run` could not have written — one field of three — under
		// this user's key: `INVALID`, which no status of the guide's answers.
		await redis.redis.client.send('HSET', [
			`articles.create:${user}/k-1`,
			'state',
			'done',
		]);
		const answer = await post(user, draft, 'k-1');
		expect(answer.status).toBe(500);
		expect(answer.headers.get('Idempotent-Replayed')).toBeNull();
		expect(await countOf(user)).toBe(0);
		// Kept as it was: `INVALID` never frees the key.
		expect(
			await redis.redis.client.send('HGETALL', [`articles.create:${user}/k-1`]),
		).toEqual({ state: 'done' });
	});

	test('maps no error that is not a GuardError, whatever its code', async () => {
		const user = await newUser();
		// A failure of the write carrying a `code` a guard also uses: only
		// `instanceof GuardError` tells the two apart, never the code.
		spyOn(ArticleService.prototype, 'write').mockRejectedValue(
			Object.assign(new Error('the write failed'), { code: 'MISMATCH' }),
		);
		const answer = await post(user, draft, 'k-1');
		expect(answer.status).toBe(500);
		expect(await countOf(user)).toBe(0);
	});

	test('scopes the key to the user', async () => {
		const ada = await newUser('ada@example.com');
		const grace = await newUser('grace@example.com');
		const mine = await post(ada, draft, 'k-1');
		const theirs = await post(grace, draft, 'k-1');
		expect(theirs.status).toBe(201);
		expect(theirs.headers.get('Idempotent-Replayed')).toBeNull();
		expect(((await theirs.json()) as { id: string }).id).not.toBe(
			((await mine.json()) as { id: string }).id,
		);
	});

	test('answers 409 to a repeat while the first still runs', async () => {
		const user = await newUser();
		const held = holdNextWrite();
		const first = post(user, draft, 'k-1');
		await held.started;

		const repeat = await post(user, draft, 'k-1');
		expect(repeat.status).toBe(409);
		expect(await repeat.json()).toEqual({
			message: 'errors.idempotency-in-progress',
		});
		// When the first run's lease lapses unless renewed: 10 s.
		expect(repeat.headers.get('Retry-After')).toBe('10');

		held.release();
		expect((await first).status).toBe(201);
		expect(held.spy).toHaveBeenCalledTimes(1);
		const after = await post(user, draft, 'k-1');
		expect(after.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await countOf(user)).toBe(1);
	});

	test('with a wait, the repeat gets the replay instead', async () => {
		const user = await newUser();
		const patient = callWith({ idempotencyWait: 2_000 });
		const held = holdNextWrite();
		const first = post(user, draft, 'k-1');
		await held.started;

		// Count the scripts the repeat sends on this key. Its first `BEGIN`
		// finds the key running; a second is a poll, which only a repeat that
		// waits sends — so the first is let go only then, however loaded the
		// machine. A repeat that does not wait answers first, and fails below.
		const key = `articles.create:${user}/k-1`;
		const scripts = spyOn(redis.redis.client, 'evalsha');
		const onKey = () =>
			scripts.mock.calls.filter((call) => call.includes(key)).length;
		let answered = false;
		const repeat = post(user, draft, 'k-1', patient).finally(() => {
			answered = true;
		});
		while (onKey() < 2 && !answered) await Bun.sleep(5);
		held.release();

		const [a, b] = await Promise.all([first, repeat]);
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		expect(b.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await b.json()).toEqual(await a.json());
		expect(held.spy).toHaveBeenCalledTimes(1);
	});
});

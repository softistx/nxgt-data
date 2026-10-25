/**
 * A copy of `@nxgt/mongo`'s `test/rejection.ts`: a package reaches no
 * sibling's tests. The measurements below were made there, against mongod;
 * the rule they gave holds for any server a spec waits on, Redis included.
 */

/**
 * The reason this promise rejects, taken up where the promise is made.
 *
 * A promise that can reject before the line awaiting it is reached has to be
 * held from the start: a rejection nothing is yet waiting for is an unhandled
 * one, and the spec then fails with the very error it came to assert.
 * Measured: a 500 ms gap before the assertion made the unfixed subscription
 * spec fail every time, and a loaded CI runner was gap enough.
 *
 * Resolving is a failure too, and named: an assertion on the rejection would
 * otherwise read `Received: undefined` and say nothing about what happened.
 *
 * **Not `expect(promise).rejects`**, which on bun 1.4.2 goes wrong two ways,
 * both measured:
 *
 * - held across an `await` and finished later, it never returns: the file
 *   runs out of time instead of failing, and the per-test timeout never fires;
 * - awaited at once on a promise still doing I/O, on a loaded machine, it
 *   leaves Bun no longer reading the test mongod's stdout. mongod logs every
 *   DDL there — about 9 KB per migration test — and once the unread socket
 *   buffer fills, its logger blocks with the log lock held and the whole
 *   server stops answering. Every hook after that times out at 5000 ms, and
 *   Bun then kills the mongod. The migration specs on 2 CPUs beside six busy
 *   loops failed 12 runs out of 12 that way, Bun having drained 58–68 KB;
 *   with this helper, 0 out of 6, draining ~150 KB each.
 */
export function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		(value) => {
			throw new Error(`it resolved, with ${String(value)}`);
		},
		(error: unknown) => error,
	);
}

/** The message of the `Error` this promise rejects with. */
export async function rejectionMessage(
	promise: Promise<unknown>,
): Promise<string> {
	const error = await rejection(promise);
	if (!(error instanceof Error)) {
		throw new Error(`it rejected with a non-Error: ${String(error)}`);
	}
	return error.message;
}

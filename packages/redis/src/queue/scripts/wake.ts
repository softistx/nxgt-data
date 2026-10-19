/**
 * The Lua every script that touches `wake` shares, as one body.
 *
 * `wake` holds at most one token, and a token means only "ready has work, or
 * a delayed job is due sooner than a blocked worker thinks". A worker woken
 * by it claims, and the claim passes the baton (`CLAIM_FN` pushes one back
 * while `ready` is not empty, deletes the list once it is). One token, not
 * one per job: a busy worker would otherwise leave a token per job behind,
 * and an idle one would spend a claim script on each.
 *
 * - `wake(key)` pushes a token unless one is already there;
 * - `is_head(delayedKey, runAt)` says whether a job about to be added to
 *   `delayed` at `runAt` becomes its first, so the wait sized to the old
 *   first is too long. Call it before the `ZADD`.
 */
export const WAKE_FN = `
local function wake(key)
	if redis.call('LLEN', key) == 0 then redis.call('LPUSH', key, 1) end
end
local function is_head(delayedKey, runAt)
	local first = redis.call('ZRANGE', delayedKey, 0, 0, 'WITHSCORES')
	return first[2] == nil or runAt < tonumber(first[2])
end
`;

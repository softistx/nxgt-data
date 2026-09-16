/** Waits until `check` holds, or fails after a while. */
export async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

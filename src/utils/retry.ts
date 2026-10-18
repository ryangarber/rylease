/** Waits; replaceable in tests. */
export const clock = {
	sleep: (ms: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RetryOptions {
	/** Tries in all, the first included. */
	attempts: number;
	/** The wait before retry `n` (1-based); defaults to `n` seconds. */
	delayMs?: (retry: number) => number;
	/** Whether an error is worth another try; defaults to every error. */
	retryIf?: (error: unknown) => boolean;
}

/** Calls `run` until it resolves, waiting longer before each retry. */
export async function retry<T>(
	run: (attempt: number) => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	const delayMs = options.delayMs ?? ((retry) => retry * 1000);
	for (let attempt = 1; ; attempt++) {
		try {
			return await run(attempt);
		} catch (error) {
			if (attempt >= options.attempts || !(options.retryIf?.(error) ?? true)) {
				throw error;
			}
			await clock.sleep(delayMs(attempt));
		}
	}
}

/**
 * Polls `check` until it resolves with a value, e.g. until something another
 * job created becomes visible; resolves with `undefined` if it never does.
 */
export async function waitFor<T>(
	check: () => Promise<T | undefined>,
	options: Omit<RetryOptions, "retryIf">,
): Promise<T | undefined> {
	try {
		return await retry(
			async () => {
				const value = await check();
				if (value === undefined) throw new NotYet();
				return value;
			},
			{ ...options, retryIf: (error) => error instanceof NotYet },
		);
	} catch (error) {
		if (error instanceof NotYet) return undefined;
		throw error;
	}
}

class NotYet extends Error {}

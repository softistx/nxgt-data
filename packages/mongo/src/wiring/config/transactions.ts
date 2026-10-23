import { WiringError } from '../../errors/wiring-error';

/**
 * What the Mongo does by default for the transactions it starts: the config's
 * `transactions`.
 */
export interface TransactionsConfig {
	/**
	 * The default of a transaction's `retryTransient`, for every transaction
	 * this Mongo starts. A call's own `retryTransient` outranks it; with
	 * neither, the body is retried (`true`). A transaction that joins an outer
	 * one has no choice to make: it is the outer one's.
	 */
	retryTransient?: boolean;
}

/**
 * Makes a `transactions` written inside one database of `databases`
 * unassignable, and says where it belongs: it is the Mongo's, beside
 * `databases`.
 */
export type NoTransactionsInDatabase<D> = D extends { transactions: unknown }
	? {
			transactions: 'transactions belong beside databases, not in one database';
		}
	: unknown;

const TRANSACTION_KEYS = ['retryTransient'] as const;

/** The `transactions` of a config, refused when it is not what it says it is. */
export function checkTransactions(transactions: unknown): void {
	if (transactions === undefined) return;
	if (
		typeof transactions !== 'object' ||
		transactions === null ||
		Array.isArray(transactions)
	) {
		throw new WiringError(
			'CONFIG',
			'defineMongo: transactions must be an object, as ' +
				'`{ transactions: { retryTransient: false } }`',
		);
	}
	for (const key of Object.keys(transactions)) {
		if (!(TRANSACTION_KEYS as readonly string[]).includes(key)) {
			throw new WiringError(
				'CONFIG',
				`defineMongo: transactions has "${key}", which it does not take. ` +
					`It takes ${TRANSACTION_KEYS.map((k) => `"${k}"`).join(', ')}.`,
				{ key },
			);
		}
	}
	const { retryTransient } = transactions as { retryTransient?: unknown };
	if (retryTransient !== undefined && typeof retryTransient !== 'boolean') {
		throw new WiringError(
			'CONFIG',
			'defineMongo: transactions.retryTransient must be a boolean',
			{ key: 'retryTransient' },
		);
	}
}

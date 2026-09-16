/** What MongoDB does with a document that fails the validator. */
export type ValidationAction = 'error' | 'warn';

/**
 * Which documents the validator applies to. `off` writes no validator at all;
 * `moderate` exempts documents that were already invalid from updates.
 */
export type ValidationLevel = 'off' | 'moderate' | 'strict';

export interface ValidationConfig {
	/** Default `'strict'`, and `'off'` on a time-series collection. */
	level?: ValidationLevel;
	/** Default `'error'`. `'warn'` logs and lets the write through. */
	action?: ValidationAction;
}

/**
 * The validation a definition ends up with.
 *
 * A time-series collection cannot have a validator at all: MongoDB refuses
 * the creation with "'timeseries' is not allowed with 'validator'", and a
 * later `collMod` with "option not supported on a time-series collection".
 * The default turns itself off there rather than build a definition that can
 * only fail at deploy time, and asking for one anyway is refused here, where
 * the definition is written, instead of hours later against a server.
 */
export function resolveValidation(
	name: string,
	config: ValidationConfig | undefined,
	timeseries: boolean,
): Required<ValidationConfig> {
	const level = config?.level ?? (timeseries ? 'off' : 'strict');
	if (timeseries && level !== 'off') {
		throw new TypeError(
			`defineCollection: "${name}" is a time-series collection, and MongoDB ` +
				`refuses to give one a validator: validation.level is "${level}". ` +
				'Leave the validation out — it defaults to "off" on a time series — ' +
				'or drop the `timeseries` option.',
		);
	}
	return { level, action: config?.action ?? 'error' };
}

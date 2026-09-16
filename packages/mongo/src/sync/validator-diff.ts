import type {
	ValidationAction,
	ValidationLevel,
} from '../definition/validation';
import { canonical } from './canonical';

/** A collection's validation, as `listCollections` reports it in `options`. */
export interface LiveValidation {
	validator?: Record<string, unknown>;
	validationLevel?: string;
	validationAction?: string;
}

/** The validation a definition asks for. `validator` is absent for `off`. */
export interface WantedValidation {
	validator: Record<string, unknown> | undefined;
	level: ValidationLevel;
	action: ValidationAction;
}

/** Has a collection a validator at all? An empty one is no validator. */
export function hasValidator(live: LiveValidation): boolean {
	return live.validator !== undefined && Object.keys(live.validator).length > 0;
}

/**
 * Does the collection already validate the way the definition says?
 *
 * MongoDB reads a `$jsonSchema` back exactly as it was sent, so the two are
 * compared whole. What it does not read back is a validator that was removed:
 * `collMod` with `validator: {}` leaves **no `validator` key at all**, while
 * `validationLevel` and `validationAction` stay behind. And a collection
 * created without one reports `options: {}`, where the level is `strict` and
 * the action `error` by default.
 */
export function validationMatches(
	wanted: WantedValidation,
	live: LiveValidation,
): boolean {
	if (wanted.validator === undefined) return !hasValidator(live);
	if (!hasValidator(live)) return false;
	return (
		canonical(live.validator) === canonical(wanted.validator) &&
		(live.validationLevel ?? 'strict') === wanted.level &&
		(live.validationAction ?? 'error') === wanted.action
	);
}

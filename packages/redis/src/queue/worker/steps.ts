import type { z } from 'zod';
import { QueueError } from '../../errors/queue-error';
import type { ClaimedJob } from '../scripts/replies';
import { stepBegin, stepCommit } from '../scripts/step';
import { checkStepName, decodeStep, encodeStep } from '../step-codec';
import { abortRun } from './abort';
import type { WorkerContext } from './context';
import type { JobContext, StepOptions } from './types';

/**
 * The `step` and `key` of one attempt's context. Steps are fenced by token
 * and lease in the scripts: a refusal aborts this run with `LEASE_LOST` and
 * rejects with that error, so a stale attempt never runs `fn` nor writes.
 *
 * The names used are kept per attempt: a repeat is a `TypeError` before any
 * round trip.
 */
export function stepsOf<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	signal: AbortSignal,
): Pick<JobContext<S>, 'step' | 'key'> {
	const queue = context.definition.name;
	const ran = new Set<string>();

	const lost = (): QueueError => {
		abortRun(context, 'LEASE_LOST', job.id, job.token);
		return signal.reason as QueueError;
	};
	const invalid = (what: string, name: string) =>
		new QueueError(
			'INVALID',
			queue,
			`step on "${queue}": step "${name}" ${what}`,
			job.id,
		);

	async function step(
		name: string,
		fn: () => unknown,
		options?: StepOptions<z.ZodType>,
	): Promise<unknown> {
		checkStepName(queue, 'step', name);
		if (ran.has(name)) {
			throw new TypeError(
				`step on "${queue}": step "${name}" already ran in this attempt`,
			);
		}
		ran.add(name);
		if (signal.aborted) throw signal.reason;
		const schema = options?.schema;
		const begun = await stepBegin(
			context.client,
			context.keys,
			job.id,
			job.token,
			name,
			context.definition.lease,
		);
		if ('lost' in begun) throw lost();
		if (begun.stored) {
			const decoded = decodeStep(begun.json, schema);
			if (!decoded.ok) {
				throw invalid('holds a value the schema refuses', name);
			}
			return decoded.value;
		}
		const encoded = encodeStep(queue, name, await fn(), schema);
		const committed = await stepCommit(
			context.client,
			context.keys,
			job.id,
			job.token,
			name,
			encoded,
		);
		if (!committed) throw lost();
		const decoded = decodeStep(encoded, schema);
		if (!decoded.ok) throw invalid('holds a value the schema refuses', name);
		return decoded.value;
	}

	return {
		step: step as JobContext<S>['step'],
		key(name) {
			return `${queue}:${job.id}:${checkStepName(queue, 'key', name)}`;
		},
	};
}

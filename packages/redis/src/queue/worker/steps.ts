import type { z } from 'zod';
import { QueueError } from '../../errors/queue-error';
import type { ClaimedJob } from '../scripts/replies';
import { stepBegin, stepCommit } from '../scripts/step';
import { checkStepName, decodeStep, encodeStep } from '../step-codec';
import { abortRun } from './abort';
import type { WorkerContext } from './context';
import { markStepRefusal } from './step-refusal';
import type { JobContext, StepOptions } from './types';

/** What one attempt's steps share: data only, the functions below take it. */
type StepScope<S extends z.ZodType> = {
	context: WorkerContext<S>;
	job: ClaimedJob;
	signal: AbortSignal;
	queue: string;
	/** The names used in this attempt: a repeat is a `TypeError` before any round trip. */
	ran: Set<string>;
};

// The run's abort reason; a bare `abort()` carries a DOMException, never surfaced from `step`.
function reasonOf<S extends z.ZodType>(scope: StepScope<S>): QueueError {
	const { signal, queue, job } = scope;
	if (signal.reason instanceof QueueError) return signal.reason;
	return new QueueError(
		'LEASE_LOST',
		queue,
		`run on "${queue}": job "${job.id}" lost its lease`,
		job.id,
	);
}

function lost<S extends z.ZodType>(scope: StepScope<S>): QueueError {
	abortRun(scope.context, 'LEASE_LOST', scope.job.id, scope.job.token);
	// The run already ended (a step fired after the handler returned): no reason was set.
	return reasonOf(scope);
}

function invalid<S extends z.ZodType>(
	scope: StepScope<S>,
	what: string,
	name: string,
): QueueError {
	const { queue, job } = scope;
	return markStepRefusal(
		new QueueError(
			'INVALID',
			queue,
			`step on "${queue}": step "${name}" ${what}`,
			job.id,
		),
	);
}

/** The text `fn`'s value is stored as; a refusal is marked as the step's own. */
function encodeOf<S extends z.ZodType>(
	scope: StepScope<S>,
	name: string,
	value: unknown,
	schema: z.ZodType | undefined,
): string {
	try {
		return encodeStep(scope.queue, name, value, schema, scope.job.id);
	} catch (error) {
		if (error instanceof QueueError) markStepRefusal(error);
		throw error;
	}
}

/** The value of a step already stored, or a refusal when its schema no longer accepts it. */
function readStored<S extends z.ZodType>(
	scope: StepScope<S>,
	name: string,
	json: string,
	schema: z.ZodType | undefined,
): unknown {
	const decoded = decodeStep(json, schema);
	if (!decoded.ok) {
		throw invalid(scope, 'holds a value the schema refuses', name);
	}
	return decoded.value;
}

async function runStep<S extends z.ZodType>(
	scope: StepScope<S>,
	name: string,
	fn: () => unknown,
	options?: StepOptions<z.ZodType>,
): Promise<unknown> {
	const { context, job, signal, queue, ran } = scope;
	checkStepName(queue, 'step', name);
	if (ran.has(name)) {
		throw new TypeError(
			`step on "${queue}": step "${name}" already ran in this attempt`,
		);
	}
	ran.add(name);
	if (signal.aborted) throw reasonOf(scope);
	const schema = options?.schema;
	const begun = await stepBegin(
		context.client,
		context.keys,
		job.id,
		job.token,
		name,
		context.definition.lease,
	);
	if ('lost' in begun) throw lost(scope);
	// Aborted while BEGIN was in flight: the run is over, `fn` must not start.
	if (signal.aborted) throw reasonOf(scope);
	if (begun.stored) return readStored(scope, name, begun.json, schema);
	const value = await fn();
	const encoded = encodeOf(scope, name, value, schema);
	// No abort check here: COMMIT is the fence, and a value that ran is stored either way.
	const committed = await stepCommit(
		context.client,
		context.keys,
		job.id,
		job.token,
		name,
		encoded,
	);
	if (!committed) throw lost(scope);
	// Committed, but the run ended meanwhile: the value is stored, the step still rejects.
	if (signal.aborted) throw reasonOf(scope);
	return readStored(scope, name, encoded, schema);
}

function stepKey<S extends z.ZodType>(
	scope: StepScope<S>,
	name: string,
): string {
	const { queue, job } = scope;
	return `${queue}:${job.id}:${checkStepName(queue, 'key', name)}`;
}

/**
 * The `step` and `key` of one attempt's context. Steps are fenced by token
 * and lease in the scripts: a refusal aborts this run with `LEASE_LOST` and
 * rejects with that error, so a stale attempt never writes.
 *
 * The names used are kept per attempt: a repeat is a `TypeError` before any
 * round trip.
 */
export function stepsOf<S extends z.ZodType>(
	context: WorkerContext<S>,
	job: ClaimedJob,
	signal: AbortSignal,
): Pick<JobContext<S>, 'step' | 'key'> {
	const scope: StepScope<S> = {
		context,
		job,
		signal,
		queue: context.definition.name,
		ran: new Set(),
	};
	return {
		step: ((name, fn, options) =>
			runStep(scope, name, fn, options)) as JobContext<S>['step'],
		key: (name) => stepKey(scope, name),
	};
}

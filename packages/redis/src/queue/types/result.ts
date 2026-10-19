import type { z } from 'zod';

/** What a handler of a queue with result schema `R` returns: the schema's input. Without a result schema the handler may return anything; the value is ignored and never stored. */
export type ResultInputOf<R> = R extends z.ZodType ? z.input<R> : unknown;

/** What a finished job of a queue with result schema `R` holds: the schema's output, or `undefined`. */
export type ResultOf<R> = R extends z.ZodType ? z.output<R> : undefined;

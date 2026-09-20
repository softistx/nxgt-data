import { id, softDelete, timestamps } from '@nxgt/drizzle/pg';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';

/** Soft-deleted, stamped, and with a flag the transform keeps out on. */
export const articles = pgTable('articles', {
	id: id(),
	title: text('title').notNull(),
	draft: boolean('draft').notNull().default(false),
	...timestamps(),
	...softDelete(),
});

/** The DDL for the table above. */
export const DDL = `
create table articles (
	id uuid primary key default gen_random_uuid(),
	title text not null,
	draft boolean not null default false,
	created_at timestamptz(3) not null default now(),
	updated_at timestamptz(3) not null default now(),
	deleted_at timestamptz(3)
);
`;

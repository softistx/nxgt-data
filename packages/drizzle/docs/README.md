# @nxgt/drizzle documentation

The [README](../README.md) is the short version: what the package is, and one
example per area. These pages are the long one.

| Page | Read it when |
| --- | --- |
| [guide/schema.md](guide/schema.md) | you are declaring a table, and want the `id`, `createdAt`/`updatedAt` and `deletedAt` columns the repository knows about |
| [guide/repository.md](guide/repository.md) | you are reading or writing the rows of one table: by id, by `where`, in bulk, with soft delete |
| [guide/pagination.md](guide/pagination.md) | an endpoint returns a page: offset pages with a total, cursor pages for an infinite list, or a page of a join |
| [guide/transactions.md](guide/transactions.md) | two writes must succeed together, or a repository must run inside a transaction |
| [guide/errors.md](guide/errors.md) | you want a unique violation to become a 409, and a missing row a 404 |
| [troubleshooting.md](troubleshooting.md) | you have an error message and want the fix |
| [roadmap.md](roadmap.md) | you are wondering what is planned, shipped, or deliberately left out |

Every example is TypeScript, imports from `@nxgt/drizzle` or
`@nxgt/drizzle/pg`, and runs against PostgreSQL through any Drizzle driver.

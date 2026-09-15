# nxgt-data

Data access for TypeScript apps: the code written around every table, once.

| Package | | |
| --- | --- | --- |
| [`@nxgt/drizzle`](packages/drizzle) | typed repositories over Drizzle ORM tables, offset and cursor pagination, transactions, database errors you can `instanceof`, and the columns every table has. PostgreSQL first | [npm](https://www.npmjs.com/package/@nxgt/drizzle) |

Each package's README, its npm page, shows how to use it, then documents
every function, class and type it exports in its **API** section.

## Development

Bun 1.4.2.

```sh
bun install
bun run build        # first: exports point at dist/
bun run typecheck
bun run test         # against PostgreSQL in process, with PGlite: no Docker
bun run verify:artifacts
./node_modules/.bin/biome check --write
```

A change under `packages/` needs a changeset (`bun changeset`). Merging to
`develop` opens a "Version packages" PR, and merging that PR publishes.
[AGENTS.md](AGENTS.md) explains why each of these steps exists.

## License

[MIT](LICENSE), for every package.

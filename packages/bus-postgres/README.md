# @node-ts/bus-postgres

A Postgres based persistence for workflow storage in [@node-ts/bus](https://bus.node-ts.com)

🔥 View our docs at [https://bus.node-ts.com](https://bus.node-ts.com) 🔥

🤔 Have a question? [Join our Discord](https://discord.gg/Gg7v4xt82X) 🤔

## Installation

Install all packages and their dependencies

```bash
npm install @node-ts/bus-postgres
```

Configure a new Postgres persistence and register it with `Bus`:

```typescript
import { Bus } from '@node-ts/bus-core'
import { PostgresPersistence, PostgresConfiguration } from '@node-ts/bus-postgres'

const configuration: PostgresConfiguration = {
  connection: {
    connectionString: 'postgres://postgres:password@localhost:5432/postgres'
  },
  schemaName: 'workflows'
}
const postgresPersistence = new PostgresPersistence(configuration)

// Configure bus to use postgres as a persistence
const run = async () => {
  await Bus
    .configure()
    .withPersistence(postgresPersistence)
    .initialize()
}
run.then(() => void)
```

## Configuration Options

The Postgres persistence has the following configuration:

*  **connection** *(required)* Connection pool settings for the application to connect to the postgres instance
*  **schemaName** *(required)* The schema name to create workflow tables under. This can be the 'public' default from postgres, but it's recommended to use 'workflows' or something similar to group all workflow concerns in the one place. This schema will be created if it doesn't already exist.

## Development

Local development can be done with the aid of docker to run the required infrastructure. To do so, run:

```bash
docker run --name bus-postgres -e POSTGRES_PASSWORD=password -p 6432:5432 -d postgres
```

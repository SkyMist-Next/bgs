# Repository Guidelines

This repository is a Battle.net Game Service (BGS) implementation in Node.js. High availability and performance are core engineering requirements.

## Project Structure & Module Organization

Entry points: `frontend.js` (client TCP connections), `rest.js` (web authentication), and `server.js` (workers). RPC implementations live in `services/`, with WoW realm handling in `services/wow/`. Use `listeners/` for client callbacks, `messaging/` for RabbitMQ transport, `models/` for Sequelize models, `migrations/` for schema changes, and `seeders/` for sample data. Protocol definitions and helpers live in `proto/` and `utils/`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies.
- `npm run frontend`: start TCP frontend on port 1119.
- `npm run rest`: start web authentication; development HTTPS uses port 443.
- `npm run service -- authentication`: run the authentication worker; substitute other service modules as needed.
- `npx --no-install eslint .`: lint JavaScript.
- `node --check services/authentication.js`: check syntax; substitute the changed file.

No build script exists. Verify dependency compatibility before using the legacy Node 10 Dockerfile.

## Coding Style & Naming Conventions

Use CommonJS, strict mode, four-space indentation, semicolons, and single quotes. Preserve surrounding line endings. Use PascalCase classes, camelCase helpers, and protocol-defined RPC names. Name migrations like `20180904090839-add-billing.js`. ESLint extends recommended JavaScript and Node rules and requires `module.exports`.

## High Availability & Performance

Design changes to support multiple instances, explicit connection-state ownership, and safe shared state. Use bounded timeouts and retries with backoff; prevent duplicate side effects. Provide dependency-aware readiness and graceful shutdown that drains in-flight work. Keep request handlers nonblocking; bound concurrency, queues, and buffers, and respect transport backpressure. For critical-path changes, compare latency, throughput, error rates, and resource usage under representative load. These are requirements, not claims of existing guarantees.

## Testing Guidelines

No test framework, coverage threshold, or `npm test` script is configured. Run lint, syntax checks, and affected flows. Check `/alive`, `/ready`, and authentication for REST changes. Validate worker restarts, dependency interruptions, and concurrent requests where relevant.

## Commit & Pull Request Guidelines

Use concise imperative commit subjects; historical conventions are unverified. PRs should describe behavior changes, link relevant issues, document configuration/schema changes, and provide validation commands, results, performance comparisons where relevant, and explicit gaps.

## Configuration & Secrets

Startup requires MySQL, RabbitMQ, etcd, `config/database.json`, and `config/winston.json`. Set `ETCD_HOST`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and `RABBITMQ_SERVICE_NAME`. Development TLS uses `certs/tls.key` and `certs/tls.crt`. Keep credentials and private keys uncommitted; configuration and certificate directories are ignored.

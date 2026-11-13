# Repository Guidelines

This repository is a Battle.net Game Service (BGS) implementation in Node.js. High availability and performance are core engineering requirements.

## Project Structure & Module Organization

Entry points: `frontend.js` (client TCP connections), `rest.js` (web authentication), and `server.js` (workers). RPC implementations live in `services/`, with WoW realm handling in `services/wow/`. Use `listeners/` for client callbacks, `messaging/` for RabbitMQ transport, `models/` for Sequelize models, `migrations/` for schema changes, and `seeders/` for sample data. Protocol definitions and helpers live in `proto/` and `utils/`.

## Build, Test, and Development Commands

- `nvm use`: select Node.js 26.13.0 from `.nvmrc` (engine range `>=26.13.0 <27`).
- `npm ci`: install locked dependencies with the runtime's bundled npm 11.20.0.
- `npm run frontend`: start TCP frontend on port 1119.
- `npm run rest`: start web authentication; development HTTPS uses port 443.
- `npm run service -- authentication`: run the authentication worker; substitute other service modules as needed.
- `npm run lint`: lint active JavaScript with ESLint flat configuration.
- `npm test`: run focused tests with Node's built-in runner and controlled dependencies.
- `npm run test:redis`: run the opt-in isolated Docker Sentinel integration and storage measurements (Linux bridge networking).
- `skaffold run --kube-context minikube`: build locally and upgrade the sibling chart's existing `bgs-test` release.
- `npm run local:dev`: run Skaffold with release cleanup disabled; preserve the database and PVCs.
- `npm run test:local`: check the deployed stack and full RPC/HTTPS login with a retained local fixture account.
- `npm run local:forward` / `npm run local:credentials`: forward the frontend and REST Deployments on loopback ports 1119/8443 or explicitly display the local fixture credentials.
- `npm run check:runtime`: load production dependencies and exercise native addons.
- `node scripts/benchmark-auth.js`: compare synchronous and asynchronous password checks with local HTTP and dependency substitutes.
- `node --check services/authentication.js`: check syntax; substitute the changed file.

No application build script exists. The Dockerfile uses `node:26.13.0-trixie-slim`, builds production dependencies in a separate stage, and uses Tini in the runtime stage. Supply the startup command and configuration/certificate mounts externally. See `README.md` for validation and audit findings.

## Coding Style & Naming Conventions

Use CommonJS, strict mode, four-space indentation, semicolons, and single quotes. Preserve surrounding line endings. Use PascalCase classes, camelCase helpers, and protocol-defined RPC names. Name migrations like `20180904090839-add-billing.js`. ESLint uses `eslint.config.js`, recommended JavaScript and `eslint-plugin-n` rules, and requires `module.exports`. The unused, incomplete `services/wow/realmlist.js` stub is explicitly excluded from the active-code lint gate and must remain unchanged during this migration.

## High Availability & Performance

Design changes to support multiple instances, explicit connection-state ownership, and safe shared state. Use bounded timeouts and retries with backoff; prevent duplicate side effects. Provide dependency-aware readiness and graceful shutdown that drains in-flight work. Keep request handlers nonblocking; bound concurrency, queues, and buffers, and respect transport backpressure. For critical-path changes, compare latency, throughput, error rates, and resource usage under representative load. These are requirements, not claims of existing guarantees.

## Testing Guidelines

Use Node's built-in test runner (`npm test`); no coverage threshold is configured. `npm run test:local` separately exercises the persistent Minikube stack and requires its installed operators and TLS Secret. Tests cover model associations, 64-bit identifiers, fixed protobuf fixtures and service hashes, timestamps, REST/RPC authentication, asynchronous password verification, dependency rejection, logging, Redis configuration and storage boundaries, realm operations, readiness, and worker draining. Run lint, syntax checks, and affected flows. Check `/alive`, `/ready`, and authentication for REST changes. Live worker restarts, dependency interruptions, failover, and production performance require separate integration acceptance.

## Commit & Pull Request Guidelines

Always merge pull requests using **Rebase and merge** (`gh pr merge --rebase`).

Use concise imperative commit subjects; historical conventions are unverified. PRs should describe behavior changes, link relevant issues, document configuration/schema changes, and provide validation commands, results, performance comparisons where relevant, and explicit gaps.

## Configuration & Secrets

Startup requires MySQL, RabbitMQ, Redis with Sentinel, `config/database.json`, and `config/winston.json`. Set `REDIS_SENTINELS` (JSON host/port array), `REDIS_MASTER_NAME`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and `RABBITMQ_SERVICE_NAME`. Redis/Sentinel credentials and TLS options are documented in README.md. Login and realm-list tickets expire after five minutes; realm-join tickets expire after 60 seconds. Development TLS uses `certs/tls.key` and `certs/tls.crt`. Keep credentials and private keys uncommitted; configuration and certificate directories are ignored.

## Agent skills

### Issue tracker

Issues and specs live in this repository's GitHub Issues. Before tracker operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triage or label changes, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring the domain, read `docs/agents/domain.md`.

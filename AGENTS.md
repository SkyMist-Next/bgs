# Repository Guidelines

## Project Structure & Module Organization

This repository implements Battle.net services in Node.js. Root entry points are `frontend.js` (client TCP connections), `rest.js` (web authentication), and `server.js` (service workers). RPC implementations live in `services/`, including WoW realm handling in `services/wow/`. Client callbacks belong in `listeners/`; RabbitMQ transport code belongs in `messaging/`. Sequelize models, schema changes, and sample data live in `models/`, `migrations/`, and `seeders/`. Protocol definitions are under `proto/`; shared helpers are in `utils/`. There is no dedicated asset or test directory.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from `package-lock.json`.
- `npm run frontend`: start the client connection frontend on port 1119.
- `npm run rest`: start the authentication HTTP endpoint; development mode uses HTTPS on port 443.
- `npm run service -- authentication`: start the worker implemented by `services/authentication.js`; substitute another service module as needed.
- `npx --no-install eslint .`: run the configured ESLint checks after installing development dependencies.
- `node --check services/authentication.js`: check a changed JavaScript file for syntax errors.

There is no compilation step or build script. The Dockerfile packages the application but uses a legacy Node 10 base; verify dependency compatibility before relying on it.

## Coding Style & Naming Conventions

Use CommonJS `require` and `module.exports`, strict mode, four-space indentation, semicolons, and single-quoted JavaScript strings. Follow adjacent code for spacing and line endings. Use PascalCase for classes and camelCase for variables and helpers. Preserve protocol-defined RPC method names, such as `Logon`. Name migrations with a timestamp and descriptive kebab-case suffix, for example `20180904090839-add-billing.js`. ESLint extends the recommended JavaScript and Node rules.

## Testing Guidelines

No automated test framework, coverage threshold, or `npm test` script is configured. Run lint and syntax checks, then exercise affected flows against configured dependencies. For REST changes, check `/alive`, `/ready`, and the relevant authentication path. Record exact commands, results, and any untested behavior in the pull request.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so existing commit conventions cannot be verified. Use concise imperative subjects describing one focused change. Pull requests should explain the behavior change, link relevant issues, document configuration or schema changes, and include validation results.

## Configuration & Secrets

Local startup requires MySQL, RabbitMQ, etcd, `config/database.json`, and `config/winston.json`. Supply `ETCD_HOST`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, and `RABBITMQ_SERVICE_NAME`. Development TLS requires `certs/tls.key` and `certs/tls.crt`. Keep credentials and private keys out of commits; configuration and certificate directories are ignored.

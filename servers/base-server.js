'use strict';

const { deadline } = require('../utils/deadline');
const { dependencyProbe } = require('../utils/dependency-probe');

class BaseServer {
    constructor({ config = {}, logger, factories = {}, requiresAmqp = true, process: processObject = process } = {}) {
        this.config = config;
        this.logger = logger;
        this.factories = factories;
        this.requiresAmqp = requiresAmqp;
        this.process = processObject;
        this.state = 'created';
        this.dependencies = { logger };
        this.controller = new AbortController();
        this.resources = new Set();
        this.pending = new Set();
        this.errors = [];
        this.unhealthySince = new Map();
        this.sqlHealthy = false;
        this.brokerOpen = false;
        this.brokerBlocked = false;
        this.startupTimeout = config.startupTimeout ?? 60000;
        this.shutdownTimeout = config.shutdownTimeout ?? 10000;
        this.forceTimeout = config.forceTimeout ?? 1000;
        this.recoveryTimeout = config.recoveryTimeout ?? 60000;
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    }

    transition(state) {
        this.state = state;
        this.logger?.info('Server lifecycle: ' + state);
    }

    track(promise) {
        this.pending.add(promise);
        promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
        return promise;
    }

    record(error, label) {
        this.errors.push(error instanceof Error ? error : new Error(label));
        // Dependency errors can contain connection URLs and credentials.
        this.logger?.error(label);
    }

    async attempt(label, operation) {
        try { return await operation(); }
        catch (error) { this.record(error, label); }
    }

    own(value, close, force = close) {
        const resource = { value, close, force };
        this.resources.add(resource);
        return resource;
    }

    closeResource(resource, force = false) {
        const key = force ? 'forceTask' : 'closeTask';
        resource[key] ??= this.attempt(force ? 'Forced dependency cleanup failed' : 'Dependency cleanup failed',
            () => resource[force ? 'force' : 'close'](resource.value));
        return resource[key];
    }

    async acquire(factory, close, force) {
        const value = await factory();
        const resource = this.own(value, close, force);
        if (this.controller.signal.aborted) {
            await deadline(this.closeResource(resource), this.forceTimeout, 'Late dependency cleanup timed out')
                .catch(() => this.closeResource(resource, true));
            this.controller.signal.throwIfAborted();
        }
        return resource;
    }

    start() {
        if (this.state === 'starting' || this.state === 'running') { return this.startTask; }
        if (this.state !== 'created') { return Promise.reject(new Error('A stopped server cannot restart')); }
        this.transition('starting');
        this.installHandlers();
        this.startTask = this.startServer();
        return this.startTask;
    }

    async startServer() {
        try {
            if (this.config.healthPort) {
                const health = require('node:http').createServer((req, res) => {
                    const known = ['/alive', '/ready'].includes(req.url);
                    res.statusCode = !known ? 404 : req.url === '/ready' && !this.isServing() ? 503 : 200;
                    res.end();
                });
                this.own(health, server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
                    server => { server.closeAllConnections(); server.close(); });
                await new Promise((resolve, reject) => {
                    health.once('error', reject);
                    health.listen(this.config.healthPort, '0.0.0.0', resolve);
                });
            }
            const startup = this.track(Promise.resolve().then(() => this.initialize()));
            await deadline(startup, this.startupTimeout, 'Server startup timed out', this.controller.signal);
            this.controller.signal.throwIfAborted();
            this.transition('running');
            this.monitor();
            return this;
        }
        catch (error) {
            if (!this.controller.signal.aborted) { await this.stop(error); }
            else { await this.closed; }
            throw error;
        }
    }

    async initialize() {
        const { config, logger, factories } = this;
        const env = config.env || process.env;
        if (config.database?.syncOnStart !== undefined && typeof config.database.syncOnStart !== 'boolean') {
            throw new Error('database.syncOnStart must be boolean');
        }
        if (config.database?.syncOnStart && (config.environment || env.NODE_ENV || 'development') !== 'development') {
            throw new Error('database.syncOnStart is allowed only in development');
        }
        this.controller.signal.throwIfAborted();
        const options = { config, logger, env, signal: this.controller.signal, onFatal: error => this.stop(error) };
        const database = this.track((async () => {
            const resource = await this.acquire(() => factories.database
                ? factories.database(options)
                : require('../models')(config.database, logger, env),
            models => models.sequelize.close(), models => factories.forceDatabase
                ? factories.forceDatabase(models) : (models.forceClose ? models.forceClose() : models.sequelize.connectionManager?.pool?.destroyAllNow()));
            this.dependencies.models = resource.value;
            const sql = resource.value.sequelize;
            await sql.authenticate();
            this.controller.signal.throwIfAborted();
            if (config.database?.syncOnStart) { await sql.sync(); }
            this.sqlHealthy = true;
            this.sqlProbe = dependencyProbe(() => this.track(Promise.resolve().then(() => sql.authenticate())), { timeout: config.probeTimeout, cacheTime: config.probeCacheTime });
        })());
        const redis = this.track((async () => {
            const resource = await this.acquire(() => factories.store
                ? factories.store(options) : new (require('../utils/redis-store').RedisStore)(options),
            store => store.close(), store => store.destroy());
            this.dependencies.store = resource.value;
            await resource.value.connect();
            if (this.controller.signal.aborted) {
                await this.closeResource(resource, true);
                this.controller.signal.throwIfAborted();
            }
            this.redisProbe = dependencyProbe(() => this.track(Promise.resolve().then(() => resource.value.probe ? resource.value.probe() : resource.value.ping())), { timeout: config.probeTimeout, cacheTime: config.probeCacheTime });
        })());
        const connections = [database, redis];
        if (this.requiresAmqp) {
            connections.push(this.track((async () => {
                const resource = await this.acquire(() => factories.amqp
                    ? factories.amqp(options)
                    : require('amqplib').connect(config.amqpUrl, { timeout: 5000 }),
                connection => connection.close(), connection => connection.connection?.stream.destroy());
                const connection = resource.value;
                this.dependencies.amqpConnection = connection;
                this.brokerOpen = true;
                connection.on('error', () => this.brokerFailure());
                connection.on('close', () => this.brokerFailure());
                connection.on('blocked', () => { this.brokerBlocked = true; this.health('RabbitMQ', false); });
                connection.on('unblocked', () => { this.brokerBlocked = false; this.health('RabbitMQ', true); });
            })()));
        }
        await Promise.all(connections);
        this.controller.signal.throwIfAborted();
        await this.onStart(this.dependencies, this.controller.signal);
    }

    brokerFailure() {
        this.brokerOpen = false;
        if (!this.controller.signal.aborted) { void this.stop(new Error('RabbitMQ connection lost')); }
    }

    isAccepting() {
        return Boolean(this.state === 'running' && this.sqlHealthy && this.dependencies.store?.healthy &&
            (!this.requiresAmqp || (this.brokerOpen && !this.brokerBlocked)));
    }

    isServing() { return this.isAccepting(); }

    async isReady() {
        if (this.state !== 'running') { return false; }
        await this.checkDependencies();
        return Boolean(this.isServing());
    }

    health(name, healthy) {
        if (healthy) {
            if (this.unhealthySince.delete(name)) { this.logger?.info(name + ' dependency recovered'); }
            return;
        }
        if (!this.unhealthySince.has(name)) {
            this.unhealthySince.set(name, Date.now());
            this.logger?.error(name + ' dependency unavailable');
        }
        if (Date.now() - this.unhealthySince.get(name) >= this.recoveryTimeout) {
            void this.stop(new Error(name + ' recovery deadline exceeded'));
        }
    }

    checkDependencies() {
        if (this.probeTask) { return this.probeTask; }
        this.probeTask = (async () => {
            const [redis, sql] = await Promise.all([this.redisProbe(), this.sqlProbe()]);
            if (this.state !== 'running') { return; }
            this.sqlHealthy = sql;
            // RedisStore also maintains its own primary health/recovery monitor.
            if (!redis) { this.dependencies.store.healthy = false; }
            this.health('MySQL', sql);
            this.health('Redis', redis && this.dependencies.store.healthy);
            if (this.requiresAmqp) { this.health('RabbitMQ', this.brokerOpen && !this.brokerBlocked); }
        })().finally(() => { this.probeTask = undefined; });
        return this.probeTask;
    }

    monitor() {
        if (this.state !== 'running') { return; }
        this.monitorTimer = setTimeout(async () => {
            await this.checkDependencies();
            this.monitor();
        }, this.config.monitorInterval ?? 1000);
        this.monitorTimer.unref();
    }

    installHandlers() {
        this.handlers = {
            SIGINT: () => { void this.stop('SIGINT'); },
            SIGTERM: () => { void this.stop('SIGTERM'); },
            unhandledRejection: () => { void this.stop(new Error('Unhandled rejection')); }
        };
        for (const [event, handler] of Object.entries(this.handlers)) { this.process.on(event, handler); }
    }

    stop(reason) {
        if (reason instanceof Error && this.state !== 'stopped' && !this.errors.includes(reason)) {
            this.record(reason, 'Server failure; shutting down');
        }
        if (this.stopTask) { return this.stopTask; }
        this.stopTask = this.closed;
        this.transition('stopping');
        this.controller.abort(new Error('Server stopping'));
        clearTimeout(this.monitorTimer);
        // Admission is disabled synchronously, before awaiting any work.
        const admission = this.attempt('Stopping admission failed', () => this.onStopAccepting());
        void this.finishStop(admission);
        return this.stopTask;
    }

    async finishStop(admission) {
        let forced = false;
        const graceful = (async () => {
            await admission;
            await this.attempt('Workload drain failed', () => this.onDrain());
            await Promise.all([...this.resources].map(resource => this.closeResource(resource)));
            // Acquisitions keep ownership even when the startup waiter has timed out.
            await Promise.allSettled([...this.pending]);
        })();
        try { await deadline(graceful, this.shutdownTimeout, 'Graceful shutdown timed out'); }
        catch (error) { forced = true; this.record(error, 'Graceful shutdown timed out; forcing cleanup'); }
        if (forced || this.errors.length) {
            this.logger?.info('Server forced cleanup');
            forced = true;
            const cleanup = Promise.all([
                this.attempt('Forced workload cleanup failed', () => this.onForceClose()),
                ...[...this.resources].map(resource => this.closeResource(resource)),
                ...[...this.resources].map(resource => this.closeResource(resource, true))
            ]);
            try { await deadline(cleanup, this.forceTimeout, 'Forced cleanup timed out'); }
            catch (error) { this.record(error, 'Forced cleanup timed out'); }
        }
        for (const [event, handler] of Object.entries(this.handlers || {})) { this.process.removeListener(event, handler); }
        this.transition('stopped');
        this.resolveClosed({ exitCode: this.errors.length ? 1 : 0, forced, errors: [...this.errors] });
    }

    async onStart() {}
    onStopAccepting() {}
    async onDrain() {}
    async onForceClose() {}
}

module.exports = BaseServer;

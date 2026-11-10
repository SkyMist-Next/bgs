'use strict';

const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { createSentinel } = require('redis');
const { deadline: withDeadline } = require('./deadline');
const { watched } = require('./redis-transaction');

const METADATA = '/aurora/metadata';
const LOGIN_PREFIX = '/aurora/services/AuthenticationService/loginTickets/';

function tlsOptions(env, prefix) {
    const enabled = env[prefix + '_TLS'];
    if (enabled !== undefined && !['true', 'false'].includes(enabled)) {
        throw new Error(prefix + '_TLS must be true or false');
    }
    if (enabled !== 'true') { return {}; }
    const socket = { tls: true, rejectUnauthorized: true };
    for (const [suffix, property] of [['CA_FILE', 'ca'], ['CERT_FILE', 'cert'], ['KEY_FILE', 'key']]) {
        if (env[prefix + '_' + suffix]) { socket[property] = fs.readFileSync(env[prefix + '_' + suffix]); }
    }
    if (Boolean(socket.cert) !== Boolean(socket.key)) { throw new Error(prefix + ' TLS requires both certificate and key'); }
    if (env[prefix + '_SERVERNAME']) { socket.servername = env[prefix + '_SERVERNAME']; }
    return socket;
}

function configuration(env = process.env) {
    let nodes;
    try { nodes = JSON.parse(env.REDIS_SENTINELS); }
    catch { throw new Error('REDIS_SENTINELS must be a JSON array of host/port objects'); }
    if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => !node ||
        typeof node.host !== 'string' || !node.host.trim() || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535)) {
        throw new Error('Invalid REDIS_SENTINELS host/port objects');
    }
    if (!env.REDIS_MASTER_NAME?.trim()) { throw new Error('REDIS_MASTER_NAME is required'); }
    const database = env.REDIS_DB === undefined ? 0 : Number(env.REDIS_DB);
    if (!Number.isInteger(database) || database < 0 || env.REDIS_DB === '') { throw new Error('Invalid REDIS_DB'); }
    const socket = {
        connectTimeout: 5000,
        reconnectStrategy: retries => Math.min(100 * 2 ** Math.min(retries, 5) + Math.floor(Math.random() * 100), 2000)
    };
    const common = { disableOfflineQueue: true, commandsQueueMaxLength: 1024, commandOptions: { timeout: 2000 } };
    return {
        name: env.REDIS_MASTER_NAME,
        sentinelRootNodes: nodes.map(({ host, port }) => ({ host, port })),
        masterPoolSize: 5, replicaPoolSize: 0, reserveClient: true,
        maxCommandRediscovers: 0, scanInterval: 30000, passthroughClientErrorEvents: true,
        commandOptions: { timeout: 2000 },
        nodeClientOptions: { ...common, database, username: env.REDIS_USERNAME, password: env.REDIS_PASSWORD,
            socket: { ...socket, ...tlsOptions(env, 'REDIS') } },
        sentinelClientOptions: { ...common, username: env.REDIS_SENTINEL_USERNAME, password: env.REDIS_SENTINEL_PASSWORD,
            socket: { ...socket, ...tlsOptions(env, 'REDIS_SENTINEL') } }
    };
}

class RedisStore {
    constructor({ env, logger, onFatal = () => {}, client, operationTimeout = 2000, recoveryTimeout = 60000,
        maxRecords = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
        this.client = client || createSentinel(configuration(env));
        this.logger = logger;
        this.onFatal = onFatal;
        this.operationTimeout = operationTimeout;
        this.recoveryTimeout = recoveryTimeout;
        this.maxRecords = maxRecords;
        this.maxBytes = maxBytes;
        this.pending = 0;
        this.generation = 0;
        this.healthy = false;
        this.closing = false;
        this.transactionClients = [];
        this.transactionWaiters = [];
        // Sentinel seed failures do not establish primary failure; PING owns health.
        // An error listener is still required, and must never log connection credentials.
        this.client.on('error', () => {});
        this.client.on('reconnecting', () => { this.healthy = false; this.generation++; });
        this.client.on('topology-change', () => { this.generation++; });
        this.client.on('end', () => { this.healthy = false; this.generation++; });
    }

    connect() {
        this.connectTask ??= this.connectClient();
        return this.connectTask;
    }

    async connectClient() {
        const deadline = Date.now() + this.recoveryTimeout;
        let attempt = 0;
        while (!this.closing && Date.now() < deadline) {
            let timer;
            try {
                // Retain unfinished connection ownership after the waiter times out.
                const connecting = Promise.resolve().then(() => {
                    if (this.closing) { throw new Error('Redis startup cancelled'); }
                    return this.client.connect();
                });
                void connecting.then(() => {
                    if (this.closing) { return this.client.destroy(); }
                }).catch(() => {});
                await Promise.race([
                    connecting,
                    new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Redis startup timed out')), deadline - Date.now());
                    })
                ]);
                if (this.closing) { throw new Error('Redis startup cancelled'); }
                await this.probe();
                if (this.closing) { throw new Error('Redis startup cancelled'); }
                this.healthy = true;
                this.monitor();
                return;
            }
            catch {
                await withDeadline(this.client.destroy(), 1000, 'Redis startup cleanup timed out')
                    .catch(() => { this.closing = true; });
                if (this.closing || Date.now() >= deadline) { break; }
                await delay(Math.min(100 * 2 ** Math.min(attempt++, 5), 2000, deadline - Date.now()));
            }
            finally { clearTimeout(timer); }
        }
        this.closing = true;
        throw new Error('Redis unavailable during startup');
    }

    monitor() {
        if (this.closing) { return; }
        this.monitorTimer = setTimeout(async () => {
            try {
                await this.probe();
                if (this.closing) { return; }
                if (!this.healthy) { this.logger?.info('Redis primary available'); }
                this.healthy = true;
                this.unhealthySince = undefined;
            }
            catch {
                if (this.closing) { return; }
                this.healthy = false;
                this.unhealthySince ??= Date.now();
                if (Date.now() - this.unhealthySince >= this.recoveryTimeout) {
                    this.onFatal(new Error('Redis recovery deadline exceeded'));
                    return;
                }
            }
            this.monitor();
        }, 1000);
        this.monitorTimer.unref();
    }

    run(operation) {
        if (this.closing || !this.client.isReady || !this.client.getMasterNode()) {
            this.healthy = false;
            return Promise.reject(new Error('Redis primary unavailable'));
        }
        if (this.pending >= 1024) { return Promise.reject(new Error('Redis operation limit exceeded')); }
        this.pending++;
        const controller = new AbortController();
        let timer;
        const command = Promise.resolve().then(() => operation(this.client.withCommandOptions({
            abortSignal: controller.signal, timeout: this.operationTimeout
        })));
        // Keep timed-out operations counted until they really settle. Abort also prevents a
        // command waiting for Sentinel discovery from being submitted after its caller failed.
        command.then(() => { this.pending--; }, () => { this.pending--; this.healthy = false; });
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                this.healthy = false;
                reject(new Error('Redis operation timed out'));
            }, this.operationTimeout);
        });
        return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
    }

    ping() { return this.run(client => client.ping()); }
    probe() {
        if (this.probeTask) { return this.probeTask; }
        let underlying;
        const task = this.run(client => {
            underlying = Promise.resolve(client.ping());
            return underlying;
        });
        this.probeTask = task;
        // Keep a timed-out primary probe coalesced until the actual command ends.
        void task.catch(() => {}).then(async () => {
            await underlying?.catch(() => {});
            this.probeTask = undefined;
        });
        return task;
    }
    getMetadata(path) { return this.run(client => client.hGet(METADATA, path)); }
    setMetadata(path, value) { return this.run(client => client.hSet(METADATA, path, String(value))); }
    async getMetadataJSON(path) {
        const value = await this.getMetadata(path);
        if (value === null) { throw new Error('Missing realm metadata'); }
        return JSON.parse(value);
    }
    async listMetadata(prefix) {
        const generation = this.generation;
        return this.run(async client => {
            const entries = new Map();
            let bytes = 0;
            let records = 0;
            let cursor = '0';
            const deadline = Date.now() + this.operationTimeout;
            // Scan metadata only, including nonmatching fields in the work limit.
            do {
                if (Date.now() >= deadline || generation !== this.generation) { throw new Error('Metadata scan interrupted'); }
                const page = await client.hScan(METADATA, cursor, { COUNT: 256 });
                cursor = page.cursor;
                for (const { field, value } of page.entries) {
                    records++;
                    bytes += Buffer.byteLength(field) + Buffer.byteLength(value);
                    if (records > this.maxRecords || bytes > this.maxBytes) { throw new Error('Metadata scan limit exceeded'); }
                    if (field.startsWith(prefix)) { entries.set(field, value); }
                }
            } while (cursor !== '0');
            if (generation !== this.generation) { throw new Error('Metadata scan interrupted'); }
            return Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        });
    }
    async listMetadataJSON(prefix) {
        const entries = await this.listMetadata(prefix);
        return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.parse(value)]));
    }
    async getJSON(path) {
        const value = await this.run(client => client.get(path));
        if (value === null) { throw new Error('Missing realm ticket'); }
        return JSON.parse(value);
    }
    setJSON(path, value) { return this.run(client => client.set(path, JSON.stringify(value))); }
    transaction(keys, decide) {
        const deadline = Date.now() + this.operationTimeout;
        return this.run(sentinel => this.transactionClient(sentinel.commandOptions, client => watched(client, keys, decide, deadline)));
    }
    async initializeTransactionClients() {
        const leases = [];
        try {
            // Acquire once: constructing the Sentinel command facade for every
            // transaction is expensive. These four connections stay exclusive.
            for (let i = 0; i < 4; i++) { leases.push(await this.client.acquire()); }
            if (this.closing) { throw new Error('Redis store closing'); }
            this.transactionClients.push(...leases);
            return leases;
        } catch (error) {
            await Promise.allSettled(leases.map(client => client.release()));
            throw error;
        }
    }
    async transactionClient(options, operation) {
        if (!this.transactionPoolTask) {
            const task = this.initializeTransactionClients();
            this.transactionPoolTask = task;
            void task.catch(() => { if (this.transactionPoolTask === task) { this.transactionPoolTask = undefined; } });
        }
        const task = this.transactionPoolTask;
        await task;
        const client = this.transactionClients.shift() || await new Promise(resolve => this.transactionWaiters.push(resolve));
        try {
            if (this.closing) { throw new Error('Redis store closing'); }
            options?.abortSignal?.throwIfAborted();
            return await operation(client.withCommandOptions(options));
        } finally {
            const waiter = this.transactionWaiters.shift();
            if (waiter) { waiter(client); }
            else { this.transactionClients.push(client); }
        }
    }
    async releaseTransactionClients() {
        if (!this.transactionPoolTask) { return; }
        const clients = await this.transactionPoolTask.catch(() => []);
        this.transactionPoolTask = undefined;
        await Promise.allSettled(clients.map(client => client.release()));
    }
    setConnectionIdentity(id, value) {
        return this.run(client => client.set('/aurora/connections/' + id, JSON.stringify(value), { EX: 300 }));
    }
    async getConnectionIdentity(id) {
        const value = await this.run(client => client.getEx('/aurora/connections/' + id, { EX: 300 }));
        return value ? JSON.parse(value) : null;
    }
    async createLoginTicket(ticket, program, identity = {}) {
        const key = LOGIN_PREFIX + ticket;
        await this.transaction([key], async client => {
            if (await client.exists(key)) { throw new Error('Login ticket already exists'); }
            return { commands: [
                ['HSET', key, 'ticket', ticket, 'program', program, 'connectionId', identity.connectionId || '', 'address', identity.address || '', 'applicationVersion', String(identity.applicationVersion || '')],
                ['EXPIRE', key, '300']
            ] };
        });
    }
    async getLoginTicket(ticket) {
        const fields = await this.run(client => client.hGetAll(LOGIN_PREFIX + ticket));
        return fields.ticket && fields.program ? fields : null;
    }
    async beginAuthenticator(ticket, accountId, metadata, now = Date.now()) {
        const key = LOGIN_PREFIX + ticket;
        const pending = { accountId: String(accountId), ...metadata, expiresAt: Math.floor(now / 1000) + 120,
            challenge: require('node:crypto').randomBytes(20).toString('hex') };
        await this.transaction([key], async client => {
            if (await client.pTTL(key) <= 0) { throw new Error('Expired login ticket'); }
            const account = await client.hGet(key, 'accountId');
            if (account && account !== String(accountId)) { throw new Error('Conflicting login ticket'); }
            return { commands: [['HDEL', key, 'accountId', 'credentialVersion', 'authenticatorGeneration', 'authenticatorVerifiedAt'],
                ['HSET', key, 'authenticatorPending', JSON.stringify(pending)]] };
        });
        return pending;
    }
    async authorizeLoginTicket(ticket, accountId, proof = {}, challenge) {
        const key = LOGIN_PREFIX + ticket;
        await this.transaction([key], async client => {
            if (await client.pTTL(key) <= 0) { throw new Error('Expired or conflicting login ticket'); }
            const account = await client.hGet(key, 'accountId');
            if (account && account !== String(accountId)) { throw new Error('Expired or conflicting login ticket'); }
            const raw = await client.hGet(key, 'authenticatorPending');
            if (raw) {
                const pending = JSON.parse(raw);
                if (pending.challenge !== challenge || pending.accountId !== String(accountId) ||
                    pending.expiresAt * 1000 <= Date.now()) { throw new Error('Expired or conflicting authenticator'); }
            } else if (challenge) { throw new Error('Authenticator already consumed'); }
            return { commands: [['HSET', key, 'accountId', String(accountId),
                'credentialVersion', String(proof.credentialVersion ?? 1),
                'authenticatorGeneration', String(proof.authenticatorGeneration ?? 0),
                'authenticatorVerifiedAt', String(proof.authenticatorVerifiedAt ?? 0)],
            ['HDEL', key, 'authenticatorPending']] };
        });
    }
    async close() {
        this.closing = true;
        this.healthy = false;
        clearTimeout(this.monitorTimer);
        await this.client.close();
        await this.releaseTransactionClients();
    }
    async destroy() {
        this.closing = true;
        this.healthy = false;
        clearTimeout(this.monitorTimer);
        await this.client.destroy();
        await this.releaseTransactionClients();
    }
}

module.exports = { RedisStore, configuration, METADATA, LOGIN_PREFIX };

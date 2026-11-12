'use strict';

// Opt-in against existing disposable services. This script never starts containers.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Sequelize, DataTypes } = require('sequelize');
const { createClient } = require('redis');
const amqp = require('amqplib');
const Runtime = require('../social/runtime');
const SocialRealm = require('../social/realm');
const WorldPresence = require('../social/world-presence');
const ServiceReceiver = require('../messaging/receiver');
const RealmReceiver = require('../realm/receiver');
const { validate } = require('../realm/contract');
const { owner: validateOwner } = require('../realm/sessions');
const { watched } = require('../utils/redis-transaction');
const wire = require('../social/wire');
const friendsWire = require('../social/friends-wire');
const presenceWire = require('../social/presence-wire');
const Header = wire.type('rpc_types', 'bgs.protocol.Header');
const OBJECT = '18446744073709551615';
const SERVICES = { friends: require('../services/friends'), presence: require('../services/presence'),
    notification: require('../services/notification') };
const LISTENERS = [['friends_service', 'FriendsListener'], ['channel_service', 'ChannelListener'],
    ['notification_service', 'NotificationListener']];
const HELP = `Usage: node scripts/social-integration.js [--check | --help]

No arguments: run the opt-in, serial three-client integration against existing
loopback fixtures. All four ports are required; no services are launched.
  BGS_SOCIAL_TEST_PORT             MariaDB (e.g. 33317; REALM_TEST_DB_PORT fallback)
  BGS_SOCIAL_TEST_REDIS_PORT       Redis (REALM_TEST_REDIS_PORT fallback)
  BGS_SOCIAL_TEST_AMQP_PORT        RabbitMQ AMQP (REALM_TEST_AMQP_PORT fallback)
  BGS_SOCIAL_TEST_MANAGEMENT_PORT  RabbitMQ HTTP API (REALM_TEST_MANAGEMENT_PORT fallback)
Optional: BGS_SOCIAL_TEST_DB_USER=root, BGS_SOCIAL_TEST_DB_PASSWORD='',
  BGS_SOCIAL_TEST_BROKER_USER=fixture,
  BGS_SOCIAL_TEST_BROKER_PASSWORD=local-validation-only,
  BGS_SOCIAL_TEST_REDIS_USERNAME, BGS_SOCIAL_TEST_REDIS_PASSWORD,
  BGS_SOCIAL_TEST_REDIS_DB=0.
--check validates fixture protobufs, ownership envelopes and configuration offline.
See docs/social-integration.md for scope, isolation, cleanup and acceptance limits.`;

function config(env = process.env) {
    const port = (name, fallback) => {
        const value = Number(env[name] || env[fallback]);
        assert(Number.isInteger(value) && value > 1024 && value <= 65535, 'Set isolated fixture port ' + name);
        return value;
    };
    const database = Number(env.BGS_SOCIAL_TEST_REDIS_DB || 0);
    assert(Number.isInteger(database) && database >= 0 && database <= 15, 'Invalid Redis fixture database');
    return { sqlPort: port('BGS_SOCIAL_TEST_PORT', 'REALM_TEST_DB_PORT'),
        redisPort: port('BGS_SOCIAL_TEST_REDIS_PORT', 'REALM_TEST_REDIS_PORT'),
        amqpPort: port('BGS_SOCIAL_TEST_AMQP_PORT', 'REALM_TEST_AMQP_PORT'),
        managementPort: port('BGS_SOCIAL_TEST_MANAGEMENT_PORT', 'REALM_TEST_MANAGEMENT_PORT'), database,
        sqlUser: env.BGS_SOCIAL_TEST_DB_USER || 'root', sqlPassword: env.BGS_SOCIAL_TEST_DB_PASSWORD || '',
        brokerUser: env.BGS_SOCIAL_TEST_BROKER_USER || 'fixture',
        brokerPassword: env.BGS_SOCIAL_TEST_BROKER_PASSWORD || 'local-validation-only',
        redisUsername: env.BGS_SOCIAL_TEST_REDIS_USERNAME, redisPassword: env.BGS_SOCIAL_TEST_REDIS_PASSWORD };
}

function fixtures() {
    const run = randomBytes(6).toString('hex');
    const base = 9007199254740993n + BigInt('0x' + randomBytes(6).toString('hex')) * 16n;
    const clients = [15595, 26972, 15595].map((build, index) => {
        const realm = { namespace: 'social-integration', realm_uid: randomUUID(), pod_uid: randomUUID(), instance_id: randomUUID() };
        const accountId = String(base + BigInt(index)), gameId = String(base + 8n + BigInt(index));
        return { name: ['Alice', 'Bob', 'Cara'][index], accountId, gameId, build, connectionId: randomUUID(),
            realm, routeEpoch: '1', battleTag: ['Alice#1001', 'Bob#1002', 'Cara#1003'][index],
            owner: { ...realm, version: 1, account_id: accountId, game_account_id: gameId, session_id: randomUUID(),
                generation: '1', build, expansion: build === 15595 ? 3 : 6, address: '127.0.0.1',
                credential_version: '1', authenticator_generation: '0', authenticator_verified_at: 0 },
            events: [], pending: new Map() };
    });
    return { run, clients, database: 'social_integration_' + run, vhosts: ['social-test-' + run + '-client', 'social-test-' + run + '-realm'] };
}

function method(service, name, data) {
    const descriptor = service.methods.find(value => value.name === name);
    assert(descriptor, 'Unknown RPC ' + name);
    const request = service.rootNamespace.lookupType(descriptor.requestType), value = request.fromObject(data);
    assert.equal(request.verify(value), null, name + ' fixture is invalid');
    return { id: descriptor.getOption('(bgs.protocol.method_options).id'),
        worldHash: wire.hash(service.rootNamespace.lookupService(service.name).fullName.slice(1)),
        response: service.rootNamespace.lookupType(descriptor.responseType), payload: Buffer.from(request.encode(value).finish()) };
}

function envelope(client, operation, args) {
    return { version: 1, request_id: randomUUID(), deadline: new Date(Date.now() + 15000).toISOString(),
        realm: client.realm, game_account_id: client.gameId, session_id: client.owner.session_id,
        generation: client.owner.generation, operation, arguments: args };
}

function callback(message, world = false) {
    let header = message.properties.headers, payload = message.content;
    if (world) {
        const value = JSON.parse(payload);
        header = { serviceHash: value.service_hash, methodId: value.method_id, objectId: value.object_id };
        payload = Buffer.from(value.payload, 'base64');
    }
    for (const [file, name] of LISTENERS) {
        const root = wire.root(file), service = root.lookupService(name);
        const hash = wire.hash(world ? service.fullName.slice(1) : service.getOption('(bgs.protocol.service_options).descriptor_name'));
        if (hash !== header.serviceHash) { continue; }
        const descriptor = service.methodsArray.find(value => value.getOption('(bgs.protocol.method_options).id') === header.methodId);
        assert(descriptor, 'Unknown callback method');
        return { listener: name, method: descriptor.name, objectId: String(header.objectId),
            data: root.lookupType(descriptor.requestType).decode(payload) };
    }
    assert.fail('Unexpected callback service');
}

function invitation(target) {
    return { targetId: { high: '0', low: '0' }, params: { invitationMessage: 'Integration invitation',
        [friendsWire.PARAMS]: { targetBattleTag: target.battleTag, role: [1] } } };
}

function whisper(sender, recipient, text) {
    return { type: 'WHISPER', senderAccountId: wire.account(sender.accountId), targetAccountId: wire.account(recipient.accountId),
        targetId: { high: '144115188075855872', low: '0' }, attribute: [wire.textAttribute('whisper', text)] };
}

function defineModels(sql) {
    return { sequelize: sql, ipBansEnabled: false,
        Account: require('../models/account')(sql, DataTypes), GameAccount: require('../models/gameaccount')(sql, DataTypes),
        GameAccountPrivilege: require('../models/gameaccountprivilege')(sql, DataTypes),
        ...require('../models/realmgameplay')(sql, DataTypes), ...require('../models/socialgraph')(sql, DataTypes),
        ...require('../models/socialruntime')(sql, DataTypes), ...require('../models/socialpresence')(sql, DataTypes) };
}

function socialMigrations() {
    const names = readdirSync(path.join(__dirname, '../migrations')).filter(name => /^2026111200000[1-7]-[a-z-]+\.js$/.test(name)).sort();
    assert.deepEqual(names.map(name => name.slice(0, 14)), Array.from({ length: 7 }, (_, index) => '2026111200000' + (index + 1)),
        'The harness requires social migrations 01 through 07');
    return names;
}

function offlineCheck() {
    const env = { BGS_SOCIAL_TEST_PORT: '33317', BGS_SOCIAL_TEST_REDIS_PORT: '36379',
        BGS_SOCIAL_TEST_AMQP_PORT: '35672', BGS_SOCIAL_TEST_MANAGEMENT_PORT: '35673' };
    assert.equal(config(env).sqlPassword, '');
    for (const name of Object.keys(env)) { assert.throws(() => config({ ...env, [name]: '' })); }
    assert.throws(() => config({ ...env, BGS_SOCIAL_TEST_REDIS_DB: '-1' }));
    const { clients } = fixtures();
    const sql = new Sequelize('offline', 'root', '', { dialect: 'mysql', logging: false });
    const models = defineModels(sql), runtime = new Runtime({ models });
    const services = Object.fromEntries(Object.entries(SERVICES).map(([key, Service]) => [key, new Service({ models, runtime, logger: {} })]));
    for (const client of clients) { validateOwner(client.owner); }
    const calls = [method(services.friends, 'Subscribe', { objectId: OBJECT }),
        method(services.friends, 'SendInvitation', invitation(clients[1])),
        method(services.friends, 'AcceptInvitation', { invitationId: '9007199254740993' }),
        method(services.presence, 'Subscribe', { entityId: wire.account(clients[1].accountId), objectId: OBJECT }),
        method(services.notification, 'SendNotification', whisper(clients[0], clients[1], 'wire check'))];
    for (const call of calls) {
        const request = envelope(clients[1], 'social.call', { service_hash: call.worldHash, method_id: call.id,
            object_id: OBJECT, payload: call.payload.toString('base64') });
        validate(Buffer.from(JSON.stringify(request)), { correlationId: request.request_id, contentType: 'application/json',
            userId: 'realm-' + clients[1].realm.realm_uid, replyTo: 'realm.reply.' + clients[1].realm.realm_uid + '.' + randomUUID() });
    }
    const decoded = services.friends.rootNamespace.lookupType('bgs.protocol.friends.v1.SubscribeRequest')
        .decode(calls[0].payload);
    assert.equal(decoded.objectId.toString(), OBJECT);
    for (const name of socialMigrations()) { assert.equal(typeof require('../migrations/' + name).up, 'function'); }
    console.log('Offline fixture checks passed; no database, Redis or broker connections opened.');
}

async function main() {
    const c = config(), f = fixtures(); // Validate all ports before acquiring any dependencies.
    const ownedKeys = new Set(), cleanup = [], connections = [];
    let fatal, worker, failure, token = 0;
    const cleanupErrors = [];
    const fail = error => { fatal ||= error; };
    const logger = { info() {}, debug() {}, warn: message => console.error(message), error: fail };
    const defer = (name, action) => cleanup.push({ name, action });
    async function bounded(label, promise, milliseconds = 5000) {
        let timer;
        try { return await Promise.race([promise, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
        })]); } finally { clearTimeout(timer); }
    }
    async function until(label, check) {
        const deadline = Date.now() + 10000;
        do {
            if (fatal) { throw fatal; }
            const value = await check();
            if (value) { return value; }
            await delay(25);
        } while (Date.now() < deadline);
        throw new Error(label + ' timed out');
    }
    const management = async (verb, resource, body) => {
        const response = await fetch('http://127.0.0.1:' + c.managementPort + '/api/' + resource, {
            method: verb, headers: { authorization: 'Basic ' + Buffer.from(c.brokerUser + ':' + c.brokerPassword).toString('base64'),
                'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        assert(response.ok || verb === 'DELETE' && response.status === 404, 'Broker fixture ' + verb + ' failed: ' + response.status);
    };
    async function provision(resource, body) {
        // Only cryptographically unique names owned by this invocation are ever deleted.
        defer(resource, () => management('DELETE', resource));
        await management('PUT', resource, body);
    }
    async function connect(user, password, vhost) {
        const connection = await amqp.connect({ protocol: 'amqp', hostname: '127.0.0.1', port: c.amqpPort,
            username: user, password, vhost, heartbeat: 5 }, { timeout: 3000 });
        connections.push(connection); connection.on('error', fail);
        defer('AMQP connection', () => connection.close());
        return connection;
    }
    console.log(JSON.stringify({ fixture: f.run, database: f.database, vhosts: f.vhosts, clients: f.clients.map(client => ({
        name: client.name, account: client.accountId, game: client.gameId, realm: client.realm.realm_uid, connection: client.connectionId
    })) }));
    const sqlOptions = { dialect: 'mysql', host: '127.0.0.1', port: c.sqlPort, logging: false,
        dialectOptions: { supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, connectTimeout: 3000 },
        pool: { min: 0, max: 3, acquire: 5000 }, retry: { max: 0 } };
    const admin = new Sequelize('', c.sqlUser, c.sqlPassword, { ...sqlOptions, pool: { max: 1 } });
    defer('SQL admin connection', () => admin.close());
    try {
        await admin.query('CREATE DATABASE `' + f.database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
        defer('fixture database ' + f.database, () => admin.query('DROP DATABASE `' + f.database + '`'));
        const sql = new Sequelize(f.database, c.sqlUser, c.sqlPassword, sqlOptions);
        defer('SQL model connection', () => sql.close());
        const models = defineModels(sql);
        for (const name of ['Account', 'GameAccount', 'GameAccountPrivilege', 'RealmProcessOwner']) { await models[name].sync(); }
        // Baseline account/license/realm tables use the production models. Social tables use real migrations only.
        for (const name of socialMigrations()) { await require('../migrations/' + name).up(sql.getQueryInterface(), DataTypes); }
        console.log('Applied social migrations: ' + socialMigrations().join(', '));
        const redis = createClient({ socket: { host: '127.0.0.1', port: c.redisPort, connectTimeout: 3000, reconnectStrategy: false },
            database: c.database, username: c.redisUsername, password: c.redisPassword, disableOfflineQueue: true });
        redis.on('error', fail);
        defer('Redis connection', async () => { if (redis.isOpen) { await redis.close(); } });
        await redis.connect();
        defer('owned Redis keys', async () => { if (ownedKeys.size) { await redis.del([...ownedKeys]); } });
        async function set(key, value) {
            ownedKeys.add(key); await redis.set(key, JSON.stringify(value), { EX: 300 });
        }
        let transactions = 0;
        const store = { healthy: true, run: action => action(redis),
            setMetadata: (key, value) => set('/social-integration/' + f.run + '/metadata' + key, value),
            transaction: async (keys, decide) => {
                keys.forEach(key => ownedKeys.add(key)); transactions++;
                const connection = redis.duplicate(); connection.on('error', fail);
                try { await connection.connect(); return await watched(connection, keys, decide); }
                finally { if (connection.isOpen) { await connection.close(); } }
            }
        };
        for (const client of f.clients) {
            await models.Account.create({ id: client.accountId, email: client.name + '@integration.invalid', hash: 'fixture-only',
                battleTag: client.battleTag });
            client.game = await sql.transaction(transaction => models.GameAccount.create({ id: client.gameId, accountId: client.accountId,
                displayName: client.name, program: 'WoW', region: 1, expansion: client.owner.expansion }, { transaction }));
            await models.RealmProcessOwner.create({ realm_uid: client.realm.realm_uid, instance_id: client.realm.instance_id });
            await set('/aurora/connections/' + client.connectionId, { accountId: client.accountId, address: '127.0.0.1',
                applicationVersion: client.build, credentialVersion: '1', authenticatorGeneration: '0' });
            await set('/skymist/v1/sessions/' + client.gameId, client.owner);
        }
        const realms = f.clients.map(client => ({ ...client.realm, available: true, build: client.build,
            expansion: client.owner.expansion, region: 1, security_level: 0 }));
        const realmDirectory = { rows: async () => realms }; // Only operator discovery is controlled, not authorization.
        for (const vhost of f.vhosts) { await provision('vhosts/' + vhost, {}); }
        const workerUser = 'social-worker-' + f.run, password = randomBytes(24).toString('hex');
        await provision('users/' + workerUser, { password, tags: '' });
        for (const vhost of f.vhosts) {
            await management('PUT', 'permissions/' + vhost + '/' + workerUser, { configure: '.*', write: '.*', read: '.*' });
        }
        const clientBroker = await connect(workerUser, password, f.vhosts[0]);
        const realmBroker = await connect(workerUser, password, f.vhosts[1]);
        async function startWorker() {
            const dependencies = { models, store, logger, amqpConnection: clientBroker, realmDirectory };
            const runtime = new Runtime(dependencies), worldPresence = new WorldPresence(store, models);
            const services = Object.fromEntries(Object.entries(SERVICES).map(([name, Service]) =>
                [name, new Service({ ...dependencies, runtime, worldPresence })]));
            const receivers = Object.values(services).map(service => new ServiceReceiver(service, { ...dependencies, onFatal: fail }));
            const map = new Map(Object.values(services).map(service =>
                [wire.hash(service.rootNamespace.lookupService(service.name).fullName.slice(1)), service]));
            receivers.push(new RealmReceiver(new SocialRealm(dependencies, runtime, map, worldPresence), {
                amqpConnection: realmBroker, isAccepting: () => true, onFatal: fail,
                queue: 'skymist.realm.social.v1.requests', routingKey: 'social' }));
            const result = { runtime, services, receivers, stop: async () => {
                for (const receiver of receivers) { await receiver.drain(); }
                await runtime.stop();
            } };
            worker = result; // Retain partial startup ownership for cleanup.
            for (const receiver of receivers) { await receiver.start(); }
            await runtime.start(realmBroker);
            return result;
        }
        defer('social worker', async () => { if (worker) { await worker.stop(); } });
        await startWorker();
        async function openClient(client) {
            const world = client.build === 26972;
            let connection = clientBroker;
            if (world) {
                const user = 'realm-' + client.realm.realm_uid;
                await provision('users/' + user, { password, tags: '' });
                const replyPattern = '^realm\\.reply\\.' + client.realm.realm_uid + '\\.[a-f0-9-]{36}$';
                await management('PUT', 'permissions/' + f.vhosts[1] + '/' + user, {
                    configure: replyPattern, write: '^skymist\\.realm\\.rpc\\.v1$', read: replyPattern });
                connection = await connect(user, password, f.vhosts[1]);
                client.user = user;
            }
            const channel = client.channel = await connection.createConfirmChannel(); channel.on('error', fail);
            client.queue = world ? 'realm.reply.' + client.realm.realm_uid + '.' + randomUUID() : 'social.client.' + randomUUID();
            await channel.assertQueue(client.queue, { durable: false, exclusive: true, autoDelete: true });
            await channel.consume(client.queue, message => {
                if (!message) { fail(new Error('Client consumer cancelled')); return; }
                try {
                    if (message.properties.type === 'response') {
                        if (world) {
                            client.pending.get(message.properties.correlationId)?.(JSON.parse(message.content));
                        } else {
                            const length = message.content.readUInt16BE(0);
                            const header = Header.decode(message.content.subarray(2, length + 2));
                            client.pending.get(header.token)?.({ status: header.status, payload: message.content.subarray(length + 2) });
                        }
                    } else {
                        if (world) {
                            const value = JSON.parse(message.content);
                            assert.equal(message.properties.type, 'social.notification');
                            assert.equal(value.game_account_id, client.gameId);
                            assert.equal(value.session_id, client.owner.session_id);
                            assert.equal(value.generation, client.owner.generation);
                        } else { assert.equal(message.properties.type, 'request'); }
                        client.events.push(callback(message, world));
                    }
                } catch (error) { fail(error); }
            }, { noAck: true });
        }
        for (const client of f.clients) { await openClient(client); }
        async function exchange(client, key, publish) {
            const reply = new Promise(resolve => client.pending.set(key, resolve));
            try {
                const confirm = new Promise((resolve, reject) => publish(error => error ? reject(error) : resolve()));
                const [result] = await bounded('RPC reply and confirmation', Promise.all([reply, confirm]));
                if (fatal) { throw fatal; }
                return result;
            } finally { client.pending.delete(key); }
        }
        async function realmCall(client, request) {
            const properties = { contentType: 'application/json', correlationId: request.request_id,
                userId: client.user, replyTo: client.queue, persistent: true,
                headers: { social_route_epoch: client.routeEpoch } };
            const payload = Buffer.from(JSON.stringify(request)); validate(payload, properties);
            return exchange(client, request.request_id, done => client.channel.publish('skymist.realm.rpc.v1', 'social', payload, properties, done));
        }
        async function rpc(client, serviceName, name, data) {
            const service = worker.services[serviceName], call = method(service, name, data);
            let result;
            if (client.build === 26972) {
                const response = await realmCall(client, envelope(client, 'social.call', { service_hash: call.worldHash,
                    method_id: call.id, object_id: OBJECT, payload: call.payload.toString('base64') }));
                assert.equal(response.status, 'success', JSON.stringify(response));
                result = { status: response.result.status, payload: Buffer.from(response.result.payload, 'base64') };
            } else {
                const currentToken = ++token;
                result = await exchange(client, currentToken, done => client.channel.publish('battlenet_aurora_bus',
                    String(service.getServiceHash()), call.payload, { replyTo: client.queue, headers: {
                        identity: { connectionId: client.connectionId, address: '127.0.0.1' }, serviceId: 0,
                        serviceHash: service.getServiceHash(), methodId: call.id, token: currentToken, objectId: OBJECT
                    } }, done));
            }
            assert.equal(result.status, 0, client.name + ' ' + name + ' status=0x' + result.status.toString(16));
            return call.response.decode(result.payload);
        }
        async function event(client, listener, name, predicate = () => true, after = 0) {
            return until(client.name + ' ' + name, () => client.events.slice(after).find(value =>
                value.listener === listener && value.method === name && predicate(value)));
        }
        const [alice, bob, cara] = f.clients;
        for (const client of f.clients) {
            const response = await rpc(client, 'friends', 'Subscribe', { objectId: OBJECT, agentId: wire.account(client.accountId) });
            assert.equal(response.friends.length, 0);
            await rpc(client, 'presence', 'Subscribe', { entityId: client.game.entityId, objectId: OBJECT });
        }
        await until('all friends subscriptions ready after broker reply', async () =>
            await models.SocialSubscription.count({ where: { kind: 'friends', ready: true } }) === 3);
        for (const client of [alice, cara]) {
            assert.equal(JSON.parse(await redis.get('/aurora/connections/' + client.connectionId)).gameAccountId, client.gameId,
                'Own-game subscription must bind the selected license using Redis WATCH/EXEC');
        }
        console.log('PASS direct 15595 and authenticated realm 26972 subscriptions');
        for (const [sender, recipient] of [[alice, bob], [bob, cara]]) {
            await rpc(sender, 'friends', 'SendInvitation', invitation(recipient));
            const received = await event(recipient, 'FriendsListener', 'OnReceivedInvitationAdded', value =>
                value.data.invitation.inviterIdentity.accountId.low.toString() === sender.accountId);
            assert.equal(received.objectId, OBJECT);
            await rpc(recipient, 'friends', 'AcceptInvitation', { invitationId: received.data.invitation.id.toString() });
            for (const [client, peer] of [[sender, recipient], [recipient, sender]]) {
                const added = await event(client, 'FriendsListener', 'OnFriendAdded', value => value.data.target.accountId.low.toString() === peer.accountId);
                assert.equal(added.objectId, OBJECT);
                assert((await rpc(client, 'friends', 'GetFriendList', {})).friends.some(value => value.accountId.low.toString() === peer.accountId));
            }
        }
        console.log('PASS invitations, acceptance and bilateral snapshots across three accounts');
        await rpc(alice, 'presence', 'Subscribe', { entityId: bob.game.entityId, objectId: '77' });
        const beforePresence = alice.events.length;
        const character = { guid: '9007199254741999', name: 'FixtureBob', realm_address: 0x01010001, realm_name: 'Fixture',
            level: 110, class: 8, race: 1, zone: 1519, faction: 0 };
        const published = await realmCall(bob, envelope(bob, 'social.presence', { sequence: '1', active: true, character }));
        assert.equal(published.status, 'success'); assert.equal(published.result.sequence, '1');
        await until('character callback through real broker', () => alice.events.slice(beforePresence).find(value => {
            const state = (value.data.channelState || value.data.stateChange)?.[presenceWire.EXTENSION];
            return value.listener === 'ChannelListener' && value.objectId === '77' && state?.fieldOperation.some(operation =>
                operation.field.key.program === presenceWire.WOW && operation.field.key.field === 10 && operation.field.value.stringValue === character.name);
        }));
        const queried = await rpc(alice, 'presence', 'Query', { entityId: bob.game.entityId });
        assert(queried.field.some(field => field.key.program === presenceWire.WOW && field.key.field === 12 && field.value.uintValue.toString() === character.guid));
        console.log('PASS authenticated character publication and friend presence callback/query');
        async function sendWhisper(sender, recipient, text) {
            const after = recipient.events.length;
            await rpc(sender, 'notification', 'SendNotification', whisper(sender, recipient, text));
            const received = await event(recipient, 'NotificationListener', 'OnNotification', value =>
                value.data.attribute.some(attribute => attribute.name === 'whisper' && attribute.value.stringValue === text), after);
            assert.equal(received.objectId, '0');
            assert.equal(received.data.senderAccountId.low.toString(), sender.accountId);
            assert.equal(received.data.senderId.low.toString(), sender.gameId);
            assert.equal(received.data.targetAccountId.low.toString(), recipient.accountId);
        }
        for (const [sender, recipient] of [[alice, bob], [bob, alice], [bob, cara], [cara, bob]]) {
            await sendWhisper(sender, recipient, sender.name + ' to ' + recipient.name);
        }
        assert(transactions >= 7, 'Session, presence and whisper mutations must use real watched transactions');
        console.log('PASS both-way cross-build whispers and real Redis watched transactions');
        await until('initial outbox drained', async () => (await worker.runtime.graph.pendingOutbox(20)).length === 0);
        const subscriptions = (await models.SocialSubscription.findAll({ attributes: ['id'], raw: true })).map(row => row.id).sort();
        const old = worker; await old.stop(); worker = null;
        const afterRestart = alice.events.length;
        // A committed producer mutation during dispatcher downtime leaves real SQL work to recover.
        await old.runtime.graph.setNote({ actorId: alice.accountId, targetId: bob.accountId,
            operationId: randomBytes(32).toString('hex'), note: 'persisted during worker outage' });
        assert((await old.runtime.graph.pendingOutbox(20)).length > 0);
        await startWorker();
        await event(alice, 'FriendsListener', 'OnUpdateFriendState', value => value.data.changedFriend.attribute.some(attribute =>
            attribute.name === 'friend_note' && attribute.value.stringValue === 'persisted during worker outage'), afterRestart);
        await until('recovered outbox acknowledged', async () => (await worker.runtime.graph.pendingOutbox(20)).length === 0);
        assert.deepEqual((await models.SocialSubscription.findAll({ attributes: ['id'], raw: true })).map(row => row.id).sort(), subscriptions,
            'Recovery must reuse persisted subscriptions without another client Subscribe');
        await sendWhisper(bob, alice, 'after runtime restart');
        console.log('PASS runtime restart, persisted subscriptions and pending outbox recovery');
        await set('/skymist/v1/sessions/' + bob.gameId, { ...bob.owner, generation: '2' });
        const stale = await realmCall(bob, envelope(bob, 'social.presence', { sequence: '2', active: true, character }));
        assert.equal(stale.status, 'rejected'); assert.equal(stale.error.code, 'STALE_SESSION');
        const call = method(worker.services.friends, 'GetFriendList', {});
        const staleCall = await realmCall(bob, envelope(bob, 'social.call', { service_hash: call.worldHash, method_id: call.id,
            object_id: OBJECT, payload: call.payload.toString('base64') }));
        assert.equal(staleCall.status, 'rejected'); assert.equal(staleCall.error.code, 'STALE_SESSION');
        await until('stale world subscriptions removed', async () =>
            await models.SocialSubscription.count({ where: { sessionKey: 'w:' + bob.owner.session_id + ':1' } }) === 0);
        if (fatal) { throw fatal; }
        console.log('PASS stale generation rejected for presence and social RPC; old subscriptions retired');
    } catch (error) { failure = error; }
    finally {
        // Worker must stop before client connections and fixture broker identities disappear.
        if (worker) { try { await bounded('worker shutdown', worker.stop()); worker = null; } catch (error) { cleanupErrors.push(error); } }
        for (const { name, action } of cleanup.reverse()) {
            try { await bounded('cleanup ' + name, Promise.resolve().then(action)); }
            catch (error) { cleanupErrors.push(new Error('Cleanup failed: ' + name, { cause: error })); }
        }
        for (const connection of connections) { connection.connection?.stream?.destroy(); }
    }
    if (cleanupErrors.length) { throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
        'Fixture cleanup incomplete; inspect the printed owned resource names'); }
    if (failure) { throw failure; }
    console.log('Social integration passed; owned SQL, Redis and RabbitMQ resources removed. Native clients were not exercised.');
}

if (require.main === module) {
    Promise.resolve().then(() => {
        if (process.argv.length === 3 && process.argv[2] === '--help') { console.log(HELP); return; }
        if (process.argv.length === 3 && process.argv[2] === '--check') { offlineCheck(); return; }
        assert.equal(process.argv.length, 2, HELP);
        return main();
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { config, fixtures, offlineCheck, main };

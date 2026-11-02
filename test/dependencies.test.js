'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const AuthenticationService = require('../services/authentication');
const AccountService = require('../services/account');
const ConnectionService = require('../services/connection');
const Connection = require('../connection');
const Receiver = require('../messaging/receiver');
const loadProto = require('../utils/protobuf');
const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');

test('importing service and model modules neither reads configuration nor constructs a database', () => {
    execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const { registerHooks } = require('node:module');
        const sequelizeUrl = require('node:url').pathToFileURL(require.resolve('sequelize')).href;
        const hooks = registerHooks({
            resolve(specifier, context, next) {
                assert.ok(!specifier.includes('config/'), 'operator configuration imported: ' + specifier);
                return next(specifier, context);
            },
            load(url, context, next) {
                if (url === sequelizeUrl) {
                    return { format: 'commonjs', shortCircuit: true,
                        source: 'module.exports = class { constructor() { throw new Error("Database constructed on import"); } };' };
                }
                return next(url, context);
            }
        });
        for (const name of ['service', 'authentication', 'account', 'connection', 'game_utilities']) {
            assert.equal(typeof require('./services/' + name), 'function');
        }
        const createDatabase = require('./models');
        assert.equal(typeof createDatabase, 'function');
        assert.throws(() => createDatabase({}, { debug() {} }), /Database constructed on import/);
        hooks.deregister();
    `], { cwd: path.resolve(__dirname, '..'), timeout: 5000 });
});

function group(id) {
    const logs = [];
    const tickets = [];
    const queries = [];
    const registrations = [];
    const channels = [];
    const logger = Object.fromEntries(['info', 'debug', 'error'].map(level => [level, value => logs.push([level, value])]));
    const store = {
        healthy: true,
        setMetadata: async (...args) => registrations.push(args),
        getMetadata: async () => `https://${id}.test/login/`,
        createLoginTicket: async (...args) => tickets.push(args),
        getLoginTicket: async ticket => { assert.equal(ticket, id); return { accountId: id, program: 'WoW' }; },
        listMetadata: async () => ({})
    };
    const entity = { high: 0, low: id };
    const models = {
        Account: { findOne: async query => {
            assert.equal(query.where.id, id);
            assert.equal(query.include[0].model, models.GameAccount);
            queries.push(query.where.id);
            return { entityId: entity, battleTag: id, gameAccounts: [{ program: 'WoW', entityId: entity }] };
        } },
        GameAccount: { findByPk: async key => { queries.push(key); return { displayName: id }; } }
    };
    const amqpConnection = { createChannel: async () => {
        const channel = Object.assign(new EventEmitter(), {
            sent: [], closed: 0, cancelled: [], acknowledged: [],
            assertExchange: async () => {}, prefetch: async () => {},
            assertQueue: async () => ({ queue: id }), bindQueue: async () => {},
            consume: async (queue, callback) => { channel.deliver = callback; return { consumerTag: id }; },
            sendToQueue: (...args) => { channel.sent.push(args); return true; },
            ack: message => channel.acknowledged.push(message),
            cancel: async tag => channel.cancelled.push(tag), close: async () => { channel.closed++; }
        });
        channels.push(channel);
        return channel;
    } };
    return { id, logger, store, models, amqpConnection, logs, tickets, queries, registrations, channels };
}

test('two authentication workers isolate stores, models, callbacks, logs, and draining', async t => {
    const groups = [group('101'), group('202')];
    for (const state of groups) {
        state.service = new AuthenticationService(state);
        state.receiver = new Receiver(state.service, state);
        t.after(() => state.receiver.closeChannel());
    }
    await Promise.all(groups.map(state => state.receiver.start()));
    const deliver = async (state, methodName, request) => {
        const method = state.service.methods.find(item => item.name === methodName);
        const type = state.service.rootNamespace.lookupType(method.requestType);
        state.channels[0].deliver({ properties: { replyTo: state.id, headers: {
            methodId: method.getOption('(bgs.protocol.method_options).id'), token: 1
        } }, content: type.encode(type.fromObject(request)).finish() });
        await Promise.all([...state.receiver.pending]);
    };
    await Promise.all(groups.map(state => deliver(state, 'Logon', { program: 'WoW', platform: 'Win' })));
    await Promise.all(groups.map(state => deliver(state, 'VerifyWebCredentials', { webCredentials: Buffer.from(state.id) })));
    const challengeType = loadProto('proto/bgs/low/pb/client/challenge_service.proto')
        .lookupType('bgs.protocol.challenge.v1.ChallengeExternalRequest');
    const resultType = loadProto('proto/bgs/low/pb/client/authentication_service.proto')
        .lookupType('bgs.protocol.authentication.v1.LogonResult');
    for (const state of groups) {
        assert.deepEqual(state.queries, [state.id]);
        assert.equal(state.registrations.length, 1);
        assert.equal(state.tickets.length, 1);
        assert.equal(state.channels[0].acknowledged.length, 2);
        assert.equal(challengeType.decode(state.channels[1].sent[0][1]).payload.toString(),
            `https://${state.id}.test/login/` + state.tickets[0][0]);
        assert.equal(resultType.decode(state.channels[2].sent[0][1]).accountId.low.toString(), state.id);
        for (const channel of state.channels) {
            assert.ok(channel.sent.every(([queue]) => queue === state.id));
        }
        assert.deepEqual(state.channels.map(channel => channel.closed), [0, 1, 1]);
    }
    const [first, second] = groups;
    const fault = new Error('first store rejected');
    first.store.getMetadata = async () => { throw fault; };
    await deliver(first, 'Logon', { program: 'WoW' });
    assert.ok(first.logs.some(([, value]) => value === fault));
    assert.ok(!second.logs.some(([level]) => level === 'error'));
    const otherLogs = second.logs.length;
    await first.receiver.closeChannel();
    assert.equal(first.channels[0].closed, 1);
    assert.deepEqual(first.channels[0].cancelled, [first.id]);
    assert.equal(second.channels[0].closed, 0);
    assert.equal(second.logs.length, otherLogs);
    await deliver(second, 'Logon', { program: 'WoW', platform: 'Win' });
    assert.equal(second.tickets.length, 2);
});

test('account services use only their own model and logger', async () => {
    const groups = [group('101'), group('202')];
    const services = groups.map(state => new AccountService(state));
    await Promise.all(services.map((service, index) => service.GetGameAccountStatus({
        request: { gameAccountId: { low: groups[index].id }, options: {} }, response: {}
    })));
    for (const state of groups) {
        assert.deepEqual(state.queries, [state.id]);
        assert.match(state.logs[0][1], new RegExp(state.id + '$'));
    }
});

function socket() {
    return Object.assign(new EventEmitter(), {
        destroyed: false, bytesRead: 0, writableLength: 0, writes: [],
        setTimeout() {}, pause() {},
        write(buffer, callback) { this.writes.push(buffer); callback?.(); return true; },
        destroy() { this.destroyed = true; this.emit('close'); }
    });
}

test('TCP callbacks and connection draining stay with the owning service', async () => {
    const groups = [group('101'), group('202')];
    const services = groups.map(state => new ConnectionService(state));
    const sockets = groups.map(() => socket());
    const calls = [[], []];
    services.forEach((service, index) => {
        service.handleCall = async context => { calls[index].push(context); return Buffer.from(groups[index].id); };
        service.onNewConnection(sockets[index]);
    });
    const header = Header.encode(Header.fromObject({ serviceId: 0, methodId: 5, token: 1, size: 0 })).finish();
    const frame = Buffer.alloc(2 + header.length);
    frame.writeUInt16BE(header.length);
    header.copy(frame, 2);
    sockets.forEach(client => { client.bytesRead = frame.length; client.emit('data', frame); });
    await Promise.all(services.flatMap(service => [...service.pending]));
    for (let index = 0; index < 2; index++) {
        assert.equal(calls[index].length, 1);
        assert.equal(calls[index][0].connection, services[index].connections[0]);
        assert.equal(sockets[index].writes[0].toString(), groups[index].id);
        assert.ok(groups[index].logs.some(([, value]) => value.includes('Received request')));
    }
    await services[0].drain();
    assert.equal(sockets[0].destroyed, true);
    assert.equal(sockets[1].destroyed, false);
    sockets[1].emit('data', frame);
    await Promise.all([...services[1].pending]);
    assert.equal(calls[1].length, 2);
    await services[1].drain();
});

test('a client channel opened after disconnect is closed with its owning logger', async () => {
    const errors = [];
    const connection = new Connection(socket(), { logger: { error: error => errors.push(error) },
        serviceHash: 123, serviceName: 'Test', onMessage() {} });
    connection.disconnect();
    const fault = new Error('late channel close failed');
    connection.setAmqpChannel({ close: async () => { throw fault; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [fault]);
    assert.equal(connection.amqpChannel, undefined);
});


test('forced Connection cleanup cancels drain polling even when a local handler never settles', async () => {
    const service = new ConnectionService(group('303'));
    service.pending.add(new Promise(() => {}));
    const draining = service.drain();
    await service.forceClose();
    await draining;
    assert.equal(service.forced, true);
});

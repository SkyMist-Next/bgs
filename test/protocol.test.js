'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadProto = require('../utils/protobuf');
const Service = require('../services/service');
const ConnectionService = require('../services/connection');
const Listener = require('../listeners/listener');
function mockGlobal(t, name, { value }) {
    const previous = global[name];
    global[name] = value;
    t.after(() => { global[name] = previous; });
}

const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');

test('BGS service hashes and active method IDs remain fixed', () => {
    for (const [name, file, hash, methods] of [
        ['ConnectionService', 'connection', 0x65446991, { Connect: 1, KeepAlive: 5, RequestDisconnect: 7 }],
        ['AuthenticationService', 'authentication', 0x0decfc01, { Logon: 1, VerifyWebCredentials: 7 }],
        ['AccountService', 'account', 0x62da0891, { GetAccountState: 30, GetGameAccountState: 31 }],
        ['GameUtilitiesService', 'game_utilities', 0x3fc1274d, { ProcessClientRequest: 1, GetAllValuesForAttribute: 10 }],
        ['AuthenticationListener', 'authentication', 0x71240e35, { OnLogonComplete: 5 }],
        ['ChallengeListener', 'challenge', 0xbbda171f, { OnExternalChallenge: 3 }]
    ]) {
        const service = new Service(name, `proto/bgs/low/pb/client/${file}_service.proto`);
        assert.equal(service.getServiceHash(), hash);
        for (const [methodName, id] of Object.entries(methods)) {
            assert.equal(service.methods.find(method => method.name === methodName).getOption('(.bgs.protocol.method_options).id'), id);
        }
    }
});

test('header fixture preserves uint64 IDs, fixed32 hashes, and exact bytes', () => {
    const fixture = Buffer.from('080010011807208180808080808010280030005d91694465', 'hex');
    const header = Header.decode(fixture);
    assert.equal(header.objectId.toString(), '9007199254740993');
    assert.equal(header.serviceHash, 0x65446991);
    assert.equal(header.methodId, 1);
    assert.deepEqual(Header.encode(header).finish(), fixture);
});

test('RPC framing preserves fixed64 payloads and handles synchronous/rejected errors', async t => {
    mockGlobal(t, 'logger', { value: { error() {} } });
    const service = new Service('ConnectionService', 'proto/bgs/low/pb/client/connection_service.proto');
    service.registerHandler('Echo', async context => {
        context.response.time = context.request.time;
        return 0;
    });
    const context = () => ({ header: { serviceId: 0, methodId: 3, token: 7 } });
    const payload = Buffer.from('090100000000002000', 'hex');
    const result = await service.handleCall(context(), payload);
    assert.equal(result.toString('hex'), '000b08fe011003180728093000090100000000002000');
    for (const handler of [() => { throw new Error('sync'); }, async () => { throw 0xBC5; }]) {
        service.registerHandler('Echo', handler);
        const reply = await service.handleCall(context(), payload);
        const header = Header.decode(reply.subarray(2));
        assert.ok([1, 0xBC5].includes(header.status));
        assert.equal(header.serviceId, 0xFE);
        assert.equal(header.size, 0);
    }
    const malformed = await service.handleCall(context(), Buffer.from('09', 'hex'));
    assert.equal(Header.decode(malformed.subarray(2)).status, 0xBC5);
});

test('Connect returns epoch microseconds from the native addon', async t => {
    mockGlobal(t, 'amqpConnection', { value: {
        createChannel: async () => ({ assertQueue: async () => ({ queue: 'client' }) })
    } });
    mockGlobal(t, 'etcd3', { value: { getAll: () => ({ prefix: () => ({ keys: async () => [] }) }) } });
    mockGlobal(t, 'logger', { value: { error() {} } });
    const service = new ConnectionService();
    const responseType = service.rootNamespace.lookupType('bgs.protocol.connection.v1.ConnectResponse');
    const context = {
        request: { clientId: null, useBindlessRpc: true }, response: responseType.create(),
        connection: {
            setAmqpChannel() {}, setAmqpQueueName() {}, setupConsumer: async () => {},
            setBindlessRPC() {}, getBindlessRPC: () => true
        }
    };
    const before = Date.now() * 1000;
    assert.equal(await service.Connect(context), 0);
    assert.ok(context.response.serverTime >= before);
    assert.ok(context.response.serverTime <= (Date.now() + 1) * 1000);
    const decoded = responseType.decode(responseType.encode(context.response).finish());
    assert.equal(decoded.serverTime.toString(), String(context.response.serverTime));
});

test('listener waits for AMQP channel creation and preserves callback IDs', async t => {
    let open;
    const sent = [];
    mockGlobal(t, 'amqpConnection', { value: { createChannel: () => new Promise(resolve => { open = resolve; }) } });
    const listener = new Listener('ChallengeListener', 'proto/bgs/low/pb/client/challenge_service.proto');
    listener.setClientQueueName('client');
    const call = listener.call('OnExternalChallenge', request => {
        request.payloadType = 'web_auth_url';
        request.payload = Buffer.from('https://example.test/ticket');
    });
    assert.equal(sent.length, 0);
    open({ sendToQueue: (...args) => sent.push(args), close: async () => {} });
    await call;
    assert.equal(sent[0][0], 'client');
    assert.equal(sent[0][2].headers.methodId, 3);
    assert.equal(sent[0][2].headers.serviceHash, 0xbbda171f);
    await listener.destroy();
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Connection = require('../connection');
const Header = require('../utils/protobuf')('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
function frame(payload, size = payload.length) {
    const h = Header.encode(Header.fromObject({ serviceId: 0, token: 7, methodId: 1, size })).finish();
    const prefix = Buffer.alloc(2); prefix.writeUInt16BE(h.length);
    return Buffer.concat([prefix, h, payload]);
}
function fixture() {
    const socket = new EventEmitter();
    Object.assign(socket, { remoteAddress: '127.0.0.1', setTimeout() {}, destroy() { this.destroyed = true; } });
    const received = [];
    const c = new Connection(socket, { serviceHash: 42, serviceName: 'fixture',
        logger: { debug() {}, error() {} }, onMessage: (header, payload) => received.push({ header, payload }) });
    return { socket, c, received };
}
test('RPC framing retains every split prefix, header and payload byte', () => {
    const { socket, received } = fixture(), payload = Buffer.from('fragmented request');
    for (const byte of frame(payload)) { socket.emit('data', Buffer.from([byte])); }
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].payload, payload);
    assert.equal(received[0].header.token, 7);
});
test('RPC framing separates coalesced frames and retains an incomplete successor', () => {
    const { socket, received } = fixture(), first = frame(Buffer.from('one')), second = frame(Buffer.from('two'));
    socket.emit('data', Buffer.concat([first, second.subarray(0, 3)]));
    assert.equal(received.length, 1);
    assert.equal(received[0].payload.toString(), 'one');
    socket.emit('data', Buffer.concat([second.subarray(3), frame(Buffer.alloc(0))]));
    assert.deepEqual(received.map(r => r.payload.toString()), ['one', 'two', '']);
});
test('RPC framing rejects oversized advertisements before allocating their payload', () => {
    for (const data of [Buffer.from([0, 0]), Buffer.from([4, 1]), frame(Buffer.alloc(0), 1024 * 1024)]) {
        const { socket, received } = fixture();
        socket.emit('data', data);
        assert.equal(socket.destroyed, true);
        assert.equal(received.length, 0);
    }
});

function boundFixture() {
    const socket = new EventEmitter(), writes = [], published = [], acked = [];
    Object.assign(socket, { remoteAddress: '127.0.0.1', writableLength: 0, setTimeout() {}, destroy() { this.destroyed = true; },
        write(buffer, callback) { writes.push(buffer); callback(); } });
    const received = [];
    const c = new Connection(socket, { serviceHash: 42, serviceName: 'fixture',
        logger: { debug() {}, error() {} }, onMessage: (header, payload) => received.push({ header, payload }) });
    c.amqpChannel = { publish: (...args) => { published.push(args); return true; }, ack: message => acked.push(message) };
    return { socket, c, writes, published, acked, received };
}
function decodeFrame(buffer) {
    const length = buffer.readUInt16BE(0);
    return { header: Header.decode(buffer.subarray(2, 2 + length)), payload: buffer.subarray(2 + length) };
}
function clientFrame(header, payload = Buffer.alloc(0)) {
    const h = Header.encode(Header.fromObject({ ...header, size: payload.length })).finish();
    const prefix = Buffer.alloc(2); prefix.writeUInt16BE(h.length);
    return Buffer.concat([prefix, h, payload]);
}
const serverRequest = (serviceHash, correlationId) => ({ content: Buffer.from('call'),
    properties: { type: 'request', correlationId, headers: { serviceHash, methodId: 1 } } });

test('non-bindless binding routes requests both ways and responses by the recorded service hash', async () => {
    const { socket, c, writes, published } = boundFixture();
    const assigned = c.bind({ importedService: [{ hash: 0x11, id: 3 }], deprecatedImportedServiceHash: [0x22, 42],
        exportedService: [{ hash: 0x33, id: 5 }], deprecatedExportedService: [{ hash: 0x44, id: 6 }] }, new Set([0x11, 0x22, 42]));
    assert.deepEqual(assigned, [4, 0]);

    socket.emit('data', clientFrame({ serviceId: 3, methodId: 2, token: 9 }, Buffer.from('request')));
    assert.equal(published[0][1], String(0x11));
    assert.equal(published[0][3].headers.serviceHash, 0x11);

    await c.receive(serverRequest(0x33, 'callback-1'));
    const sent = decodeFrame(writes[0]);
    assert.equal(sent.header.serviceId, 5);
    assert.equal(c.requests.size, 1);
    socket.emit('data', clientFrame({ serviceId: 0xFE, methodId: 1, token: sent.header.token }, Buffer.from('reply')));
    assert.equal(published[1][1], String(0x33));
    assert.equal(published[1][3].requestId, 'callback-1');
    assert.equal(c.requests.size, 0);
    assert.notEqual(socket.destroyed, true);
});

test('non-bindless binding rejects invalid, unknown, conflicting or excessive bindings without partial effects', () => {
    const registered = new Set([0x11, 0x22]);
    for (const request of [
        { importedService: [{ hash: 0x99, id: 3 }] },
        { importedService: [{ hash: 0x11, id: 0 }] },
        { importedService: [{ hash: 0x11, id: 0xFE }] },
        { importedService: [{ hash: 0x11, id: 3 }, { hash: 0x22, id: 3 }] },
        { deprecatedImportedServiceHash: [0x99] },
        { exportedService: [{ hash: -1, id: 2 }] },
        { exportedService: [{ hash: 0x33, id: 0x100 }] },
        { exportedService: Array.from({ length: 257 }, (_, i) => ({ hash: i, id: 1 })) }
    ]) {
        const { c } = boundFixture();
        const before = [[...c.exportedServices], { ...c.importedServices }];
        assert.throws(() => c.bind({ exportedService: [{ hash: 0x55, id: 7 }], ...request }, registered));
        assert.deepEqual([c.exportedServices, c.importedServices], before);
    }
});

test('unbound services are rejected and unknown responses are dropped without disconnecting', async () => {
    const { socket, c, writes, published, acked } = boundFixture();
    c.bind({}, new Set());
    socket.emit('data', clientFrame({ serviceId: 9, methodId: 1, token: 4 }));
    const rejected = decodeFrame(writes[0]).header;
    assert.equal(rejected.serviceId, 0xFE); assert.equal(rejected.status, 0xBC6); assert.equal(rejected.token, 4);

    socket.emit('data', clientFrame({ serviceId: 0xFE, methodId: 1, token: 77 }));
    assert.equal(published.length, 0);
    assert.notEqual(socket.destroyed, true);

    const message = serverRequest(0x33);
    await c.receive(message);
    assert.equal(writes.length, 1);
    assert.deepEqual(acked, [message]);
});

test('pending server-to-client requests stay bounded when clients never reply', async () => {
    const { c } = boundFixture();
    c.bindless = true;
    for (let i = 0; i < 1100; i++) { await c.receive(serverRequest(0x33)); }
    assert.equal(c.requests.size, 1024);
    assert.equal(c.requests.has(0), false);
    assert.equal(c.requests.has(1099), true);
});

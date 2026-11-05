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

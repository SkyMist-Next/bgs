'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { FrameReader, encodeFrame, method } = require('../scripts/local-rpc');
const loadProto = require('../utils/protobuf');

test('local RPC reader handles fragmented prefixes, headers, payloads and coalesced callbacks', () => {
    const first = encodeFrame({ serviceId: 0xFE, token: 0 }, Buffer.from('response'));
    const second = encodeFrame({ serviceId: 0, token: 1, serviceHash: 123, methodId: 3 }, Buffer.from('callback'));
    const stream = Buffer.concat([first, second]);
    for (let split = 1; split < stream.length; split++) {
        const reader = new FrameReader();
        const frames = [...reader.push(stream.subarray(0, split)), ...reader.push(stream.subarray(split))];
        assert.equal(frames.length, 2);
        assert.equal(frames[0].header.serviceId, 0xFE);
        assert.equal(frames[0].payload.toString(), 'response');
        assert.equal(frames[1].payload.toString(), 'callback');
        assert.equal(reader.buffer.length, 0);
    }
    const reader = new FrameReader();
    assert.equal([...stream].flatMap(byte => reader.push(Buffer.from([byte]))).length, 2);
});

test('local RPC reader rejects oversized declared payloads before buffering them', () => {
    const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
    const header = Header.encode(Header.fromObject({ serviceId: 0, token: 1, size: 2 ** 20 })).finish();
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(header.length);
    assert.throws(() => new FrameReader().push(Buffer.concat([prefix, header])), /exceeds limit/);
    assert.throws(() => new FrameReader().push(Buffer.from([0, 0])), /Empty RPC header/);
});

test('local login client uses the recovered service and method contracts', () => {
    const connect = method('connection', 'ConnectionService', 'Connect');
    assert.equal(connect.hash, 0x65446991);
    assert.equal(connect.id, 1);
    const verify = method('authentication', 'AuthenticationService', 'VerifyWebCredentials');
    assert.equal(verify.hash, 0x0decfc01);
    assert.equal(verify.id, 7);
    assert.equal(verify.request.name, 'VerifyWebCredentialsRequest');
});

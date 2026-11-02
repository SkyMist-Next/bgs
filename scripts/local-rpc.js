'use strict';

const tls = require('node:tls');
const { once } = require('node:events');
const loadProto = require('../utils/protobuf');
const { FNV } = require('fnv');
const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');
const MAX_FRAME = 1024 * 1024;

function encodeFrame(header, payload = Buffer.alloc(0)) {
    const encoded = Header.encode(Header.fromObject({ ...header, size: payload.length })).finish();
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(encoded.length);
    return Buffer.concat([prefix, encoded, payload]);
}

class FrameReader {
    constructor() { this.buffer = Buffer.alloc(0); }
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames = [];
        while (this.buffer.length >= 2) {
            const headerSize = this.buffer.readUInt16BE(0);
            if (!headerSize) { throw new Error('Empty RPC header'); }
            if (this.buffer.length < 2 + headerSize) { break; }
            const header = Header.decode(this.buffer.subarray(2, 2 + headerSize));
            const size = 2 + headerSize + header.size;
            if (size > MAX_FRAME) { throw new Error('RPC frame exceeds limit'); }
            if (this.buffer.length < size) { break; }
            frames.push({ header, payload: this.buffer.subarray(2 + headerSize, size) });
            this.buffer = this.buffer.subarray(size);
            if (frames.length > 128) { throw new Error('Too many RPC frames'); }
        }
        if (this.buffer.length > MAX_FRAME) { throw new Error('RPC buffer exceeds limit'); }
        return frames;
    }
}

function method(file, serviceName, methodName) {
    const service = loadProto('proto/bgs/low/pb/client/' + file + '_service.proto').lookupService(serviceName);
    const descriptor = service.methods[methodName].resolve();
    const hash = new FNV();
    hash.update(service.getOption('(bgs.protocol.service_options).descriptor_name'));
    return { hash: parseInt(hash.digest('hex'), 16), id: descriptor.getOption('(bgs.protocol.method_options).id'),
        request: descriptor.resolvedRequestType, response: descriptor.resolvedResponseType };
}

class RpcClient {
    constructor(socket) {
        this.socket = socket;
        this.reader = new FrameReader();
        this.frames = [];
        this.token = 0;
        socket.on('data', chunk => {
            try {
                this.frames.push(...this.reader.push(chunk));
                if (this.frames.length > 128) { throw new Error('RPC queue exceeds limit'); }
                this.notify?.();
            }
            catch (error) { this.fail(error); }
        });
        socket.on('error', () => this.fail(new Error('Frontend TLS connection failed')));
        socket.on('close', () => this.fail(new Error('Frontend connection closed')));
    }
    fail(error) { this.error = error; this.notify?.(); this.socket.destroy(); }
    async wait(predicate) {
        if (this.notify) { throw new Error('Overlapping RPC waits'); }
        return new Promise((resolve, reject) => {
            const finish = () => { clearTimeout(timer); this.notify = null; };
            const timer = setTimeout(() => { finish(); reject(new Error('RPC response timeout')); }, 10000);
            this.notify = () => {
                const index = this.frames.findIndex(predicate);
                if (index >= 0) { const [frame] = this.frames.splice(index, 1); finish(); resolve(frame); }
                else if (this.error) { finish(); reject(this.error); }
            };
            this.notify();
        });
    }
    async call(descriptor, request) {
        const token = this.token++;
        this.socket.write(encodeFrame({ serviceId: 0, serviceHash: descriptor.hash, methodId: descriptor.id, token },
            descriptor.request.encode(descriptor.request.fromObject(request)).finish()));
        const frame = await this.wait(item => item.header.serviceId === 0xFE && item.header.token === token);
        if (frame.header.status) { throw new Error('RPC returned status ' + frame.header.status); }
        return descriptor.response.decode(frame.payload);
    }
    async callback(descriptor) {
        const frame = await this.wait(item => item.header.serviceId === 0 &&
            item.header.serviceHash === descriptor.hash && item.header.methodId === descriptor.id);
        return descriptor.request.decode(frame.payload);
    }
    close() { this.socket.destroy(); }
}

async function connect(ca) {
    const socket = tls.connect({ host: '127.0.0.1', port: 1119, servername: 'bgs.local', ca, rejectUnauthorized: true });
    const client = new RpcClient(socket);
    const timer = setTimeout(() => socket.destroy(new Error('TLS connection timeout')), 10000);
    try { await once(socket, 'secureConnect'); return client; }
    catch { client.close(); throw new Error('Frontend TLS certificate or connection failed'); }
    finally { clearTimeout(timer); }
}

module.exports = { FrameReader, encodeFrame, method, connect };

'use strict';

const Long = require('long');
const { FNV } = require('fnv');
const loadProto = require('../utils/protobuf');
const ACCOUNT_HIGH = '72057594037927936';
const MAX_ID = 9223372036854775807n;
const roots = new Map();

function hash(name) {
    const value = new FNV(); value.update(name);
    return parseInt(value.digest('hex'), 16);
}
function id(value, allowZero = false) {
    const text = typeof value === 'string' ? value : Long.isLong(value) ? value.toString() : '';
    if (!/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > MAX_ID || (!allowZero && text === '0')) { throw 0xBC5; }
    return text;
}
function uint64(value) {
    const text = typeof value === 'string' ? value : Long.isLong(value) ? value.toString() : '';
    if (!/^(0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) > 18446744073709551615n) { throw 0xBC5; }
    return text;
}
function account(value) { return { high: Long.fromString(ACCOUNT_HIGH, true), low: Long.fromString(id(value), true) }; }
function accountId(entity, allowZero = false) {
    if (!entity || entity.high?.toString() !== ACCOUNT_HIGH) { throw 0xBC5; }
    return id(entity.low, allowZero);
}
function actor(request, owner) {
    if (Object.hasOwn(request, 'agentId') && accountId(request.agentId) !== owner.accountId) { throw 0xA; }
    if (request.agentIdentity?.accountId && accountId(request.agentIdentity.accountId) !== owner.accountId) { throw 0xA; }
}
function root(file) {
    if (!roots.has(file)) { roots.set(file, loadProto('proto/bgs/low/pb/client/' + file + '.proto')); }
    return roots.get(file);
}
function type(file, name) { return root(file).lookupType(name); }
function notification(file, serviceName, methodName, objectId, data) {
    const service = root(file).lookupService(serviceName);
    const method = service.methods[methodName];
    if (!method) { throw new Error('Unknown social callback'); }
    const message = root(file).lookupType(method.requestType);
    const value = message.fromObject(data);
    const error = message.verify(value);
    if (error) { throw new Error('Invalid social callback: ' + error); }
    return { serviceHash: hash(service.getOption('(bgs.protocol.service_options).descriptor_name')),
        worldHash: hash(service.fullName.slice(1)), methodId: method.getOption('(bgs.protocol.method_options).id'),
        objectId: uint64(objectId), payload: Buffer.from(message.encode(value).finish()) };
}
function textAttribute(name, value) { return { name, value: { stringValue: value } }; }
function text(value, limit) {
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > limit) { throw 0xBC5; }
    return value;
}
module.exports = { hash, id, uint64, account, accountId, actor, root, type, notification, textAttribute, text, ACCOUNT_HIGH };

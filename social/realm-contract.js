'use strict';

const { Failure } = require('../realm/contract');
function invalid() { throw new Failure('INVALID_ARGUMENTS'); }
function exact(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) { invalid(); }
}
function decimal(value, maximum, zero = false) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > maximum || (!zero && value === '0')) { invalid(); }
}
function validatePresence(args) {
    exact(args, ['sequence', 'active', 'character']);
    decimal(args.sequence, 18446744073709551615n);
    if (typeof args.active !== 'boolean') { invalid(); }
    if (!args.active) { if (args.character !== null) { invalid(); } return; }
    const character = args.character;
    exact(character, ['guid', 'name', 'realm_address', 'realm_name', 'level', 'class', 'race', 'zone', 'faction']);
    decimal(character.guid, 340282366920938463463374607431768211455n);
    for (const [field, maximum] of [['name', 64], ['realm_name', 128]]) {
        if (typeof character[field] !== 'string' || !character[field].trim() || character[field].includes('\0') ||
            !character[field].isWellFormed() || Buffer.byteLength(character[field]) > maximum) { invalid(); }
    }
    for (const field of ['realm_address', 'level', 'class', 'race', 'zone', 'faction']) {
        if (!Number.isInteger(character[field]) || character[field] < 0 || character[field] > 4294967295) { invalid(); }
    }
    if (!character.realm_address || character.level > 255 || character.class > 255 || character.race > 255 || character.faction > 2) { invalid(); }
}
function validateCall(args) {
    exact(args, ['service_hash', 'method_id', 'object_id', 'payload']);
    for (const field of ['service_hash', 'method_id']) {
        if (!Number.isInteger(args[field]) || args[field] < 1 || args[field] > 4294967295) { invalid(); }
    }
    decimal(args.object_id, 18446744073709551615n, true);
    if (typeof args.payload !== 'string' || args.payload.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.payload) ||
        Buffer.from(args.payload, 'base64').toString('base64') !== args.payload ||
        Buffer.from(args.payload, 'base64').length > 65536) { invalid(); }
}
module.exports = { validatePresence, validateCall };

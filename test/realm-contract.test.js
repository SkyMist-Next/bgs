'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, fingerprint, id } = require('../realm/contract');
const uid = '11111111-1111-4111-8111-111111111111';
function fixture() {
    const request = { version: 1, request_id: uid, operation: 'session.open', deadline: new Date(Date.now() + 10000).toISOString(),
        realm: { namespace: 'test', realm_uid: uid, pod_uid: uid, instance_id: uid },
        game_account_id: '9007199254740993', session_id: uid, generation: '0', arguments: {} };
    return { request, properties: { contentType: 'application/json', correlationId: uid, userId: 'realm-' + uid, replyTo: 'realm.reply.' + uid + '.' + uid } };
}
test('JSON realm RPC preserves 64-bit identifiers and checks broker identity', () => {
    const { request, properties } = fixture();
    assert.equal(validate(Buffer.from(JSON.stringify(request)), properties).game_account_id, request.game_account_id);
    assert.throws(() => validate(Buffer.from(JSON.stringify(request)), { ...properties, userId: 'frontend' }));
    assert.throws(() => validate(Buffer.from(JSON.stringify(request)), { ...properties, replyTo: 'another-queue' }));
    for (const value of [Number('9007199254740993'), '01', '-1', '9223372036854775808']) { assert.throws(() => id(value)); }
});
test('retry deadlines do not change mutation identity but arguments do', () => {
    const { request } = fixture();
    const hash = fingerprint(request);
    assert.equal(fingerprint({ ...request, deadline: new Date().toISOString() }), hash);
    assert.notEqual(fingerprint({ ...request, arguments: { changed: true } }), hash);
});
test('character summaries are bounded and scoped to the calling realm inside a save', () => {
    const { request, properties } = fixture();
    request.operation = 'state.prepare'; request.generation = '1';
    const summary = { domain: 'characters', key: uid, revision: '0', value: { count: 1, last_character: '9007199254740993' } };
    const check = change => validate(Buffer.from(JSON.stringify({ ...request, arguments: { changes: [change] } })), properties);
    check(summary);
    for (const change of [{ ...summary, key: '22222222-2222-4222-8222-222222222222' },
        { ...summary, value: { count: 256, last_character: null } },
        { ...summary, value: { count: 1, last_character: Number('9007199254740993') } },
        { ...summary, value: { count: 1, last_character: null, extra: true } }]) { assert.throws(() => check(change)); }
});
test('malformed envelopes and unsupported operations fail before dispatch', () => {
    const { request, properties } = fixture();
    for (const variant of [{ ...request, extra: true }, { ...request, operation: 'sql.execute' },
        { ...request, generation: 1 }, { ...request, arguments: { extra: true } }]) {
        assert.throws(() => validate(Buffer.from(JSON.stringify(variant)), properties));
    }
    assert.throws(() => validate(Buffer.from([0xff]), properties));
});
test('policy reads require the canonical actual peer address', () => {
    const { request, properties } = fixture();
    request.operation = 'account.policy';
    request.generation = '1';
    request.arguments = { address: '127.0.0.1' };
    assert.equal(validate(Buffer.from(JSON.stringify(request)), properties).arguments.address, '127.0.0.1');
    for (const address of ['not-an-ip', '::ffff:127.0.0.1', '127.0.0.1\n', null]) {
        request.arguments = { address };
        assert.throws(() => validate(Buffer.from(JSON.stringify(request)), properties));
    }
    request.arguments = {};
    assert.throws(() => validate(Buffer.from(JSON.stringify(request)), properties));
});
test('staged reservations bound the complete save and each chunk', () => {
    const { request, properties } = fixture();
    request.generation = '1';
    const check = (operation, args) => validate(Buffer.from(JSON.stringify({ ...request, operation, arguments: args })), properties);
    check('state.begin', { change_count: 4096, chunk_count: 512 });
    for (const args of [{ change_count: 4097, chunk_count: 512 }, { change_count: 17, chunk_count: 1 },
        { change_count: 1, chunk_count: 2 }, { change_count: 1, chunk_count: 0 }]) { assert.throws(() => check('state.begin', args)); }
    const change = { domain: 'toys', key: 'one', revision: '0', value: true };
    check('state.append', { reservation_id: uid, index: 0, changes: [change] });
    for (const index of [-1, 512, '0']) { assert.throws(() => check('state.append', { reservation_id: uid, index, changes: [change] })); }
    assert.throws(() => check('state.append', { reservation_id: uid, index: 0, changes: Array(17).fill(change) }));
    check('state.seal', { reservation_id: uid });
    assert.throws(() => check('state.seal', { reservation_id: 'invalid' }));
});
test('process permission binds version, revision and SQL epochs without a GameAccount', () => {
    const { request, properties } = fixture();
    const args = { revision: 'a'.repeat(64), build: 22900, expansion: 6, previous_epoch: '', epoch: uid };
    const check = value => validate(Buffer.from(JSON.stringify({ ...request, game_account_id: '0', operation: 'process.claim', arguments: value })), properties);
    assert.equal(check(args).arguments.epoch, uid);
    for (const value of [{ ...args, revision: 'x' }, { ...args, expansion: 128 }, { ...args, epoch: 'bad' }, { ...args, previous_epoch: 'bad' }]) {
        assert.throws(() => check(value));
    }
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const RealmReceiver = require('../realm/receiver');
const Receiver = require('../messaging/receiver');
const { Failure } = require('../realm/contract');

const uid = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
const timeouts = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

function setup(kind, operation = 'social.call') {
    const events = [], state = { consume: null, confirm: null, reply: null, afterFailure: false, executionError: null };
    const request = { version: 1, request_id: uid, operation, deadline: new Date(Date.now() + 10000).toISOString(),
        realm: { namespace: 'test', realm_uid: uid, pod_uid: uid, instance_id: uid },
        game_account_id: '9007199254740993', session_id: uid, generation: operation === 'session.open' ? '0' : '1',
        arguments: operation === 'social.call' ? { service_hash: 0x53C8C253, method_id: 1, object_id: '0', payload: '' } :
            operation === 'social.presence' ? { sequence: '1', active: false, character: null } : {} };
    const message = { content: Buffer.from(JSON.stringify(request)), properties: { contentType: 'application/json',
        correlationId: uid, userId: 'realm-' + uid, replyTo: 'realm.reply.' + uid + '.' + uid, headers: {} } };
    const afterReply = async () => {
        events.push('afterReply');
        if (state.afterFailure) { throw new Error('Subscription activation failed'); }
    };
    const execute = async () => {
        events.push('execute');
        if (state.executionError) { throw state.executionError; }
    };
    const service = {
        confirmReplies: true,
        getServiceHash: () => 123, getServiceName: () => 'TestSocial',
        handleCall: async context => { await execute(); context.afterReply = afterReply; return Buffer.from('reply'); },
        execute: async () => {
            await execute();
            const response = { version: 1, request_id: uid, status: 'success', result: {} };
            Object.defineProperty(response, 'afterReply', { value: afterReply });
            return response;
        }
    };
    const channel = Object.assign(new EventEmitter(), {
        assertExchange: async () => {}, assertQueue: async () => ({ queue: 'worker' }), bindQueue: async () => {},
        prefetch: async count => assert.equal(count, 16),
        consume: async (queue, consume) => { state.consume = consume; return { consumerTag: 'tag' }; },
        sendToQueue: (queue, payload, options, confirm) => {
            events.push('publish'); state.reply = { queue, payload, options }; state.confirm = confirm;
            return false; // Publisher confirmation, not write-buffer drain, gates afterReply.
        },
        ack: actual => { assert.equal(actual, message); events.push('ack'); },
        nack: (actual, all, requeue) => { assert.equal(actual, message); assert.equal(all, false); events.push(requeue ? 'requeue' : 'discard'); },
        cancel: async () => events.push('cancel'), close: async () => events.push('close')
    });
    const dependencies = { amqpConnection: { createConfirmChannel: async () => channel },
        isAccepting: () => true, onFatal: () => events.push('fatal'), logger: { info() {} },
        store: { healthy: true, setMetadata: async () => {} } };
    const receiver = kind === 'realm' ? new RealmReceiver(service, dependencies) : new Receiver(service, dependencies);
    return { receiver, channel, service, events, state, message };
}

for (const kind of ['realm', 'worker']) {
    test(`${kind}: afterReply and acknowledgment wait for successful publisher confirmation`, async () => {
        const f = setup(kind); await f.receiver.start();
        const before = timeouts(), pending = f.receiver.receive(f.message);
        await tick(); assert.deepEqual(f.events, ['execute', 'publish']);
        assert.equal(f.state.reply.queue, f.message.properties.replyTo);
        f.channel.emit('drain'); await tick();
        assert.deepEqual(f.events, ['execute', 'publish']);
        f.state.confirm(null); await pending;
        assert.deepEqual(f.events, ['execute', 'publish', 'afterReply', 'ack']);
        assert.equal(timeouts(), before, 'confirmation cancels its deadline timer');
        f.state.confirm(null); await tick();
        assert.equal(f.events.filter(event => event === 'afterReply').length, 1);
        if (kind === 'realm') {
            assert.equal(f.state.reply.options.correlationId, uid);
            assert.equal(JSON.parse(f.state.reply.payload).request_id, uid);
            assert.equal(f.state.reply.payload.includes('afterReply'), false);
        }
    });

    test(`${kind}: lost confirmation rejects at two seconds, acknowledges executed social work and ignores a late confirm`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = setup(kind); await f.receiver.start();
        const pending = f.receiver.receive(f.message), rejected = assert.rejects(pending, /reply confirmation timed out/);
        await tick();
        t.mock.timers.tick(1999); await tick();
        assert.deepEqual(f.events, ['execute', 'publish']);
        t.mock.timers.tick(1); await rejected;
        assert.deepEqual(f.events, ['execute', 'publish', 'ack']);
        f.state.confirm(null); t.mock.timers.tick(10000); await tick();
        assert.deepEqual(f.events, ['execute', 'publish', 'ack'], 'no late activation or internal replay');
    });

    test(`${kind}: synchronous publish failure clears its timer and cannot activate or replay a mutation`, async () => {
        const f = setup(kind); await f.receiver.start();
        f.channel.sendToQueue = () => { f.events.push('publish'); throw new Error('Channel already closed'); };
        const before = timeouts();
        await assert.rejects(f.receiver.receive(f.message), /Channel already closed/);
        assert.equal(timeouts(), before, 'failed synchronous publish must not leave a live two-second timer');
        assert.deepEqual(f.events, ['execute', 'publish', 'ack']);
    });

    test(`${kind}: broker nack skips activation, clears its deadline and acknowledges social work only once`, async () => {
        const f = setup(kind); await f.receiver.start();
        const before = timeouts(), pending = f.receiver.receive(f.message), rejected = assert.rejects(pending, /Broker nack/);
        await tick(); f.state.confirm(new Error('Broker nack')); await rejected;
        assert.equal(timeouts(), before);
        assert.deepEqual(f.events, ['execute', 'publish', 'ack']);
        f.state.confirm(null); await tick();
        assert.equal(f.events.filter(event => event === 'ack').length, 1);
    });

    test(`${kind}: graceful drain completes when a publisher never confirms`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = setup(kind); await f.receiver.start();
        f.state.consume(f.message); await tick();
        const draining = f.receiver.drain(); await tick();
        assert.deepEqual(f.events, ['execute', 'publish', 'cancel']);
        t.mock.timers.tick(2000); await draining;
        assert.deepEqual(f.events, ['execute', 'publish', 'cancel', 'ack', 'close']);
        assert.equal(f.receiver.pending.size, 0);
        f.state.confirm(null); await tick();
        assert.equal(f.events.includes('afterReply'), false);
        assert.equal(f.events.filter(event => event === 'execute').length, 1);
    });

    test(`${kind}: a failed post-confirmation activation cannot replay already executed social work`, async () => {
        const f = setup(kind); f.state.afterFailure = true; await f.receiver.start();
        const pending = f.receiver.receive(f.message), rejected = assert.rejects(pending, /Subscription activation failed/);
        await tick(); f.state.confirm(null); await rejected;
        assert.deepEqual(f.events, ['execute', 'publish', 'afterReply', 'ack']);
    });
}

test('realm: gameplay persistence failures retain fatal/unacknowledged recovery', async () => {
    const f = setup('realm', 'session.open'); f.state.executionError = new Error('SQL uncertain');
    await f.receiver.start();
    await assert.rejects(f.receiver.receive(f.message), error => /persistence unavailable/.test(error.message) && error.cause === f.state.executionError);
    assert.deepEqual(f.events, ['execute', 'fatal']);
});

test('realm: gameplay confirmation timeout remains unacknowledged and cannot activate after a late confirm', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = setup('realm', 'session.open'); await f.receiver.start();
    f.state.consume(f.message); await tick();
    assert.equal(f.receiver.pending.size, 1);
    t.mock.timers.tick(2000); await tick();
    assert.deepEqual(f.events, ['execute', 'publish', 'fatal']);
    assert.equal(f.receiver.pending.size, 0);
    f.state.confirm(null); await tick();
    assert.deepEqual(f.events, ['execute', 'publish', 'fatal']);
});

test('realm: admitted social.call and social.presence execution errors are acknowledged without changing gameplay policy', async () => {
    for (const operation of ['social.call', 'social.presence']) {
        const f = setup('realm', operation); f.state.executionError = new Error('Unknown outcome');
        await f.receiver.start();
        await assert.rejects(f.receiver.receive(f.message), /persistence unavailable/);
        assert.deepEqual(f.events, ['execute', 'fatal', 'ack']);
    }
});

test('realm: a retryable policy rejection still waits for confirmation and never calls afterReply', async () => {
    const f = setup('realm'); f.state.executionError = new Failure('SOCIAL_UNAVAILABLE', true);
    await f.receiver.start(); const pending = f.receiver.receive(f.message);
    await tick(); assert.deepEqual(f.events, ['execute', 'publish']);
    assert.deepEqual(JSON.parse(f.state.reply.payload).error, { code: 'SOCIAL_UNAVAILABLE', retryable: true });
    f.state.confirm(null); await pending;
    assert.deepEqual(f.events, ['execute', 'publish', 'ack']);
});

test('realm: unadmitted social work still requeues, malformed requests discard, and neither executes', async () => {
    const stopped = setup('realm'); await stopped.receiver.start(); stopped.receiver.stopping = true;
    await stopped.receiver.receive(stopped.message); assert.deepEqual(stopped.events, ['requeue']);
    const malformed = setup('realm'); await malformed.receiver.start(); malformed.message.content = Buffer.from('{');
    await malformed.receiver.receive(malformed.message); assert.deepEqual(malformed.events, ['discard']);
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Receiver = require('../messaging/receiver');

function setup(t) {
    const old = { logger: global.logger, store: global.store, amqpConnection: global.amqpConnection };
    t.after(() => Object.assign(global, old));
    const events = [];
    let consume;
    const channel = Object.assign(new EventEmitter(), {
        assertExchange: async () => {}, prefetch: async count => assert.equal(count, 16),
        assertQueue: async () => ({ queue: 'worker' }), bindQueue: async () => {},
        consume: async (queue, fn) => { events.push('consume'); consume = fn; return { consumerTag: 'tag' }; },
        sendToQueue: () => { events.push('reply'); return true; }, ack: () => events.push('ack'),
        cancel: async () => events.push('cancel'), close: async () => events.push('close')
    });
    global.logger = { info() {}, error() {} };
    global.amqpConnection = { createChannel: async () => channel };
    global.store = { healthy: true, setMetadata: async () => events.push('register') };
    const service = { getServiceName: () => 'TestService', getServiceHash: () => 123, handleCall: async () => Buffer.from('reply') };
    return { events, channel, service, receiver: new Receiver(service), deliver: () => consume({ properties: { replyTo: 'client', headers: {} }, content: Buffer.alloc(0) }) };
}

test('worker awaits registration and drains accepted calls before closing', async t => {
    const state = setup(t);
    let release;
    state.service.handleCall = () => new Promise(resolve => { release = resolve; });
    await state.receiver.start();
    assert.deepEqual(state.events, ['register', 'consume']);
    state.deliver();
    const stop = state.receiver.closeChannel();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(state.events, ['register', 'consume', 'cancel']);
    release(Buffer.from('reply'));
    await stop;
    assert.deepEqual(state.events, ['register', 'consume', 'cancel', 'reply', 'ack', 'close']);
});

test('worker does not consume after registration fails', async t => {
    const state = setup(t);
    global.store.setMetadata = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(state.receiver.start(), /Redis unavailable/);
    assert.deepEqual(state.events, []);
    await state.receiver.closeChannel();
});

test('worker respects AMQP reply backpressure before acknowledging work', async t => {
    const state = setup(t);
    state.channel.sendToQueue = () => false;
    await state.receiver.start();
    state.deliver();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!state.events.includes('ack'));
    state.channel.emit('drain');
    await state.receiver.closeChannel();
    assert.ok(state.events.includes('ack'));
});

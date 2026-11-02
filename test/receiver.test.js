'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Receiver = require('../messaging/receiver');

function setup() {
    const events = [];
    let consume;
    const channel = Object.assign(new EventEmitter(), {
        assertExchange: async () => {}, prefetch: async count => assert.equal(count, 16),
        assertQueue: async () => ({ queue: 'worker' }), bindQueue: async () => {},
        consume: async (queue, fn) => { events.push('consume'); consume = fn; return { consumerTag: 'tag' }; },
        sendToQueue: () => { events.push('reply'); return true; }, ack: () => events.push('ack'),
        cancel: async () => events.push('cancel'), close: async () => events.push('close')
    });
    const logger = { info() {}, error() {} };
    const amqpConnection = { createChannel: async () => channel };
    const store = { healthy: true, setMetadata: async () => events.push('register') };
    const service = { getServiceName: () => 'TestService', getServiceHash: () => 123, handleCall: async () => Buffer.from('reply') };
    return { events, channel, service, store, amqpConnection, receiver: new Receiver(service, { logger, store, amqpConnection }), deliver: () => consume({ properties: { replyTo: 'client', headers: {} }, content: Buffer.alloc(0) }) };
}

test('worker awaits registration and drains accepted calls before closing', async () => {
    const state = setup();
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

test('worker does not consume after registration fails', async () => {
    const state = setup();
    state.store.setMetadata = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(state.receiver.start(), /Redis unavailable/);
    assert.deepEqual(state.events, []);
    await state.receiver.closeChannel();
});

test('worker respects AMQP reply backpressure before acknowledging work', async () => {
    const state = setup();
    state.channel.sendToQueue = () => false;
    await state.receiver.start();
    state.deliver();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!state.events.includes('ack'));
    state.channel.emit('drain');
    await state.receiver.closeChannel();
    assert.ok(state.events.includes('ack'));
});

test('shutdown closes a channel that finishes opening after admission stops', async () => {
    const state = setup();
    let open;
    state.amqpConnection.createChannel = () => new Promise(resolve => { open = resolve; });
    const start = state.receiver.start();
    const stop = state.receiver.closeChannel();
    assert.equal(state.receiver.closeChannel(), stop);
    open(state.channel);
    await Promise.all([start, stop]);
    assert.deepEqual(state.events, ['close']);
    await state.receiver.start();
    assert.deepEqual(state.events, ['close']);
});

test('shutdown cancels a consumer that finishes registering during shutdown', async () => {
    const state = setup();
    let register;
    state.channel.consume = () => new Promise(resolve => { register = resolve; });
    const start = state.receiver.start();
    await new Promise(resolve => setImmediate(resolve));
    const stop = state.receiver.closeChannel();
    register({ consumerTag: 'tag' });
    await Promise.all([start, stop]);
    assert.deepEqual(state.events, ['register', 'cancel', 'close']);
});


test('consumer cancellation failure still drains admitted replies before closing the channel', async () => {
    const state = setup();
    let release;
    state.service.handleCall = () => new Promise(resolve => { release = resolve; });
    state.channel.cancel = async () => { throw new Error('cancel failed'); };
    await state.receiver.start();
    state.deliver();
    const stopping = state.receiver.closeChannel();
    const rejected = assert.rejects(stopping, /cancel failed/);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!state.events.includes('close'));
    release(Buffer.from('reply'));
    await rejected;
    assert.deepEqual(state.events.slice(-3), ['reply', 'ack', 'close']);
});

test('replicas share a durable quorum queue instead of broadcasting RPCs', async () => {
    const declarations = [];
    for (let replica = 0; replica < 2; replica++) {
        const state = setup();
        state.channel.assertQueue = async (name, options) => {
            declarations.push({ name, options });
            return { queue: name };
        };
        await state.receiver.start();
        await state.receiver.closeChannel();
    }
    assert.equal(declarations[0].name, 'bgs.rpc.123');
    assert.deepEqual(declarations[0], declarations[1]);
    assert.deepEqual(declarations[0].options, {
        durable: true, autoDelete: false, arguments: { 'x-queue-type': 'quorum' }
    });
});

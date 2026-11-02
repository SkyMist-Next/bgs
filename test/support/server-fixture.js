'use strict';

const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    const result = {};
    result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }));
    return result;
};

function fixture(config = {}) {
    const events = [];
    const processObject = new EventEmitter();
    const logger = { info() {}, debug() {}, error() {} };
    const store = { healthy: true,
        connect: async () => events.push('redis.connect'), ping: async () => {},
        close: async () => events.push('redis.close'), destroy: async () => events.push('redis.destroy'),
        setMetadata: async () => events.push('metadata'), listMetadata: async () => ({}),
        getLoginTicket: async () => ({ ticket: 'ticket', program: 'WoW' }),
        authorizeLoginTicket: async () => events.push('authorize') };
    const models = { sequelize: {
        authenticate: async () => events.push('sql.authenticate'), sync: async () => events.push('sql.sync'),
        close: async () => events.push('sql.close')
    }, Account: { findOne: async () => ({ id: '9007199254740993', hash: 'controlled' }) } };
    const channel = Object.assign(new EventEmitter(), {
        assertExchange: async () => {}, prefetch: async () => {}, assertQueue: async () => ({ queue: 'queue' }),
        bindQueue: async () => {}, consume: async (queue, callback) => { channel.deliver = callback; return { consumerTag: 'tag' }; },
        publish: () => { events.push('publish'); return true; }, sendToQueue: () => { events.push('reply'); return true; },
        ack: () => events.push('ack'), cancel: async () => events.push('cancel'), close: async () => events.push('channel.close')
    });
    const amqp = Object.assign(new EventEmitter(), { createChannel: async () => channel,
        close: async () => events.push('amqp.close'), connection: { stream: { destroy: () => events.push('amqp.destroy') } } });
    const options = { logger, process: processObject, config: { environment: 'test', port: 0, host: '127.0.0.1',
        shutdownTimeout: 100, forceTimeout: 20, ...config }, factories: {
        database: () => { events.push('sql.create'); return models; },
        store: () => { events.push('redis.create'); return store; },
        amqp: async () => { events.push('amqp.create'); return amqp; },
        compare: async () => true
    } };
    return { options, events, store, models, amqp, channel, process: processObject };
}

module.exports = { fixture, deferred, tick };

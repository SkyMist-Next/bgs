'use strict';

const { once } = require('node:events');

class Receiver {
    constructor(service) {
        this.service = service;
        this.pending = new Set();
        this.stopping = false;
    }

    async start() {
        const service = this.service;
        this.amqpChannel = await global.amqpConnection.createChannel();
        const channel = this.amqpChannel;
        await channel.assertExchange('battlenet_aurora_bus', 'direct');
        await channel.prefetch(16);
        const { queue } = await channel.assertQueue('', { autoDelete: true });
        await channel.bindQueue(queue, 'battlenet_aurora_bus', service.getServiceHash().toString());
        await global.store.setMetadata('/aurora/services/' + service.getServiceName() + '/hash', service.getServiceHash());
        if (this.stopping) { return; }
        const consumer = await channel.consume(queue, message => {
            if (!message) { return; }
            const call = this.receive(message);
            this.pending.add(call);
            call.then(() => this.pending.delete(call), error => {
                this.pending.delete(call);
                global.logger.error(error);
            });
        });
        this.consumerTag = consumer.consumerTag;
        if (this.stopping) { await channel.cancel(this.consumerTag); }
        global.logger.info(service.getServiceName() + ' listening');
    }

    async receive(message) {
        const channel = this.amqpChannel;
        const context = { queueName: message.properties.replyTo, header: message.properties.headers, request: null, response: null };
        try {
            const buffer = global.store.healthy
                ? await this.service.handleCall(context, message.content)
                : await this.service.sendError(context, 1);
            if (Buffer.isBuffer(buffer) && !channel.sendToQueue(message.properties.replyTo, buffer,
                { appId: this.service.getServiceName(), type: 'response' })) {
                await once(channel, 'drain');
            }
        }
        finally {
            // Retain at-most-once handling: failed publication must not replay ticket creation.
            channel.ack(message);
        }
    }

    async closeChannel() {
        this.stopping = true;
        if (this.consumerTag) { await this.amqpChannel.cancel(this.consumerTag); }
        await Promise.allSettled([...this.pending]);
        if (this.amqpChannel) { await this.amqpChannel.close(); }
    }
}

module.exports = Receiver;

'use strict';

const { waitForDrain } = require('../utils/backpressure');

class Receiver {
    constructor(service, { logger, store, amqpConnection, isAccepting = () => store.healthy, onFatal = () => {} }) {
        Object.assign(this, { logger, store, amqpConnection, service, isAccepting, onFatal });
        this.pending = new Set();
        this.stopping = false;
    }

    start() {
        if (this.stopping) { return Promise.resolve(); }
        this.startTask ??= this.openChannel();
        return this.startTask;
    }

    async openChannel() {
        const service = this.service;
        const channel = await this.amqpConnection.createChannel();
        this.amqpChannel = channel;
        channel.on('error', () => this.fail('Worker channel failed'));
        channel.on('close', () => this.fail('Worker channel closed'));
        if (this.stopping) { await this.closeOwnedChannel(); return; }
        await channel.assertExchange('battlenet_aurora_bus', 'direct');
        if (this.stopping) { return; }
        await channel.prefetch(16);
        if (this.stopping) { return; }
        const { queue } = await channel.assertQueue('bgs.rpc.' + service.getServiceHash(), { durable: true, autoDelete: false, arguments: { 'x-queue-type': 'quorum' } });
        if (this.stopping) { return; }
        await channel.bindQueue(queue, 'battlenet_aurora_bus', service.getServiceHash().toString());
        if (this.stopping) { return; }
        await this.store.setMetadata('/aurora/services/' + service.getServiceName() + '/hash', service.getServiceHash());
        if (this.stopping) { return; }
        const consumer = await channel.consume(queue, message => {
            if (!message) { this.fail('Worker consumer cancelled'); return; }
            const call = this.receive(message);
            this.pending.add(call);
            call.then(() => this.pending.delete(call), () => {
                this.pending.delete(call);
                this.fail('Worker reply failed');
            });
        });
        this.consumerTag = consumer.consumerTag;
        if (this.stopping) { await this.cancelConsumer(); return; }
        this.logger.info(service.getServiceName() + ' listening');
    }

    fail(message) {
        if (!this.stopping) { this.onFatal(new Error(message)); }
    }

    async receive(message) {
        const channel = this.amqpChannel;
        const context = { identity: message.properties.headers?.identity, queueName: message.properties.replyTo, header: message.properties.headers, request: null, response: null };
        try {
            const buffer = !this.stopping && this.isAccepting()
                ? await this.service.handleCall(context, message.content)
                : await this.service.sendError(context, 1);
            if (Buffer.isBuffer(buffer) && !channel.sendToQueue(message.properties.replyTo, buffer,
                { appId: this.service.getServiceName(), type: 'response' })) {
                await waitForDrain(channel);
            }
        }
        finally {
            // Retain at-most-once handling: a failed reply must not replay ticket creation.
            channel.ack(message);
        }
    }

    cancelConsumer() {
        if (!this.consumerTag || this.channelCloseTask) { return Promise.resolve(); }
        this.cancelTask ??= this.amqpChannel.cancel(this.consumerTag);
        return this.cancelTask;
    }

    stopAccepting() {
        this.stopping = true;
        this.admissionTask ??= (async () => {
            await this.startTask?.catch(() => {});
            await this.cancelConsumer();
        })();
        return this.admissionTask;
    }

    closeOwnedChannel() {
        if (!this.amqpChannel) { return Promise.resolve(); }
        this.channelCloseTask ??= this.amqpChannel.close();
        return this.channelCloseTask;
    }

    async drain() {
        let cancellationError;
        try {
            try { await this.stopAccepting(); }
            catch (error) { cancellationError = error; }
            while (this.pending.size) { await Promise.allSettled([...this.pending]); }
        }
        finally { await this.closeOwnedChannel(); }
        if (cancellationError) { throw cancellationError; }
    }

    forceClose() { this.stopping = true; return this.closeOwnedChannel(); }

    closeChannel() {
        this.closeTask ??= this.drain();
        return this.closeTask;
    }
}

module.exports = Receiver;

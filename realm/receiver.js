'use strict';
const { validate, Failure } = require('./contract');
const EXCHANGE = 'skymist.realm.rpc.v1';
const QUEUE = 'skymist.realm.rpc.v1.requests';

class RealmReceiver {
    constructor(service, { amqpConnection, isAccepting, onFatal }) {
        Object.assign(this, { service, amqpConnection, isAccepting, onFatal });
        this.pending = new Set(); this.stopping = false;
    }
    start() { this.startTask ??= this.open(); return this.startTask; }
    async open() {
        this.channel = await this.amqpConnection.createConfirmChannel();
        this.channel.on('error', () => this.fail());
        this.channel.on('close', () => this.fail());
        if (this.stopping) { return; }
        await this.channel.assertExchange(EXCHANGE, 'direct', { durable: true });
        await this.channel.assertQueue(QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-max-length': 4096, 'x-overflow': 'reject-publish' } });
        await this.channel.bindQueue(QUEUE, EXCHANGE, 'request');
        await this.channel.prefetch(16);
        if (this.stopping) { return; }
        const consumer = await this.channel.consume(QUEUE, message => {
            if (!message) { this.fail(); return; }
            const task = this.receive(message);
            this.pending.add(task);
            task.then(() => this.pending.delete(task), () => { this.pending.delete(task); this.fail(); });
        });
        this.consumerTag = consumer.consumerTag;
    }
    fail() { if (!this.stopping) { this.onFatal(new Error('Realm RPC channel unavailable')); } }
    async receive(message) {
        let request;
        try { request = validate(message.content, message.properties); }
        catch { this.channel.nack(message, false, false); return; }
        if (this.stopping || !this.isAccepting()) { this.channel.nack(message, false, true); return; }
        let response;
        try { response = await this.service.execute(request); }
        catch (error) {
            if (!(error instanceof Failure)) {
                // Closing the channel requeues unacknowledged calls. SQL outcomes
                // make recovery safe if the failure followed a commit.
                this.fail(); throw new Error('Realm RPC persistence unavailable', { cause: error });
            }
            response = { version: 1, request_id: request.request_id, status: 'rejected', error: { code: error.code, retryable: error.retryable } };
        }
        await new Promise((resolve, reject) => {
            this.channel.sendToQueue(message.properties.replyTo, Buffer.from(JSON.stringify(response)), {
                contentType: 'application/json', correlationId: request.request_id,
                type: 'response', expiration: '30000', persistent: false
            }, error => error ? reject(error) : resolve());
        });
        this.channel.ack(message);
    }
    async stopAccepting() {
        this.stopping = true;
        await this.startTask?.catch(() => {});
        if (this.consumerTag) { await this.channel.cancel(this.consumerTag); this.consumerTag = undefined; }
    }
    async drain() {
        await this.stopAccepting();
        while (this.pending.size) { await Promise.allSettled([...this.pending]); }
        await this.forceClose();
    }
    forceClose() {
        this.stopping = true;
        if (!this.channel) { return Promise.resolve(); }
        this.closeTask ??= this.channel.close();
        return this.closeTask;
    }
}
module.exports = RealmReceiver;

'use strict';
const loadProto = require('./utils/protobuf');
const { waitForDrain } = require('./utils/backpressure');

const rootNamespace = loadProto('proto/bgs/low/pb/client/rpc_types.proto');
const Header = rootNamespace.lookupType('bgs.protocol.Header');
const MAX_HEADER = 1024;
const MAX_FRAME = 1024 * 1024;

module.exports = class Connection {
    constructor(socket, { logger, serviceHash, serviceName, onMessage, isAccepting = () => true }){
        this.logger = logger;
        this.serviceHash = serviceHash;
        this.serviceName = serviceName;
        this.onMessage = onMessage;
        this.isAccepting = isAccepting;
        this.output = new Set();
        this.brokerOutput = new Set();
        this.channelClosures = new Set();
        this.disconnected = false;
        this.socket = socket;
        this.identity = { connectionId: require('node:crypto').randomUUID(), address: socket.verifiedAddress || socket.remoteAddress };
        this.bindless = false;
        this.requestToken = 0;
        this.requests = [];
        this.inFlight = 0;
        this.resetInput();
        this.importedServices = {};
        this.exportedServices = [];
        this.clientId = undefined;
        this.amqpChannel = undefined;
        this.queueName = undefined;

        this.exportedServices[0] = this.serviceHash;
        this.importedServices[this.serviceHash] = 0;

        this.onData = this.onData.bind(this);
        this.disconnect = this.disconnect.bind(this);

        this.socket.on('data', data => {
            try { this.onData(data); }
            catch { void this.disconnect(); }
        });
        this.socket.on('error', this.disconnect);

        this.socket.on('timeout', this.disconnect);

        this.socket.on('close', this.disconnect);

        this.socket.setTimeout(30000);
    }

    closeChannel(channel) {
        const closing = Promise.resolve().then(() => channel.close());
        this.channelClosures.add(closing);
        closing.then(() => this.channelClosures.delete(closing), error => {
            this.channelClosures.delete(closing);
            this.logger.error(error);
        });
        return closing;
    }

    setAmqpChannel(channel) {
        channel.on?.('error', this.disconnect);
        channel.on?.('close', this.disconnect);
        if (this.disconnected || !this.isAccepting() || this.amqpChannel) {
            void this.closeChannel(channel).catch(() => {});
            return false;
        }
        this.amqpChannel = channel;
        return true;
    }

    setAmqpQueueName(queueName) {
        this.queueName = queueName;
    }

    setClientId(clientId) {
        this.clientId = clientId;
    }

    setBindlessRPC(bindlessRpc) {
        this.bindless = bindlessRpc;
    }

    getBindlessRPC() {
        return this.bindless;
    }

    getExportedServiceId(importedServiceHash) {
        return this.exportedServices.findIndex((serviceHash) => {
            return serviceHash === importedServiceHash;
        });
    }

    getRemoteAddress() {
        return this.identity.address;
    }

    setupConsumer() {
        if (this.amqpChannel && this.queueName) {
            const channel = this.amqpChannel;
            return channel.consume(this.queueName, message => {
                if (!message) { void this.disconnect(); return; }
                const output = this.receive(message);
                output.catch(() => this.disconnect());
            }).then(async consumer => {
                this.consumerTag = consumer.consumerTag;
                if (this.disconnected || !this.isAccepting()) {
                    try { await channel.cancel(consumer.consumerTag); }
                    finally { await this.disconnect(); }
                    throw new Error('Client stopped during consumer startup');
                }
                return consumer;
            });
        }
        return Promise.reject(0x0);
    }

    async receive(message) {
        const channel = this.amqpChannel;
        try {
            if (message.properties.type === 'request') {
                let requestHeader = Header.fromObject(message.properties.headers);
                requestHeader.token = this.requestToken++;

                if (!this.bindless) {
                    requestHeader.serviceId = this.importedServices[requestHeader.serviceHash];
                }
                else {
                    requestHeader.serviceId = 0;
                }

                let requestBuffer = Buffer.from(message.content);
                requestHeader.size = requestBuffer.length;

                let headerBuffer = Header.encode(requestHeader).finish();
                let buffer = Buffer.alloc(2 + headerBuffer.length + requestHeader.size);
                buffer.writeUInt16BE(headerBuffer.length, 0);
                headerBuffer.copy(buffer, 2);
                requestBuffer.copy(buffer, 2 + headerBuffer.length);

                await this.writeBuffer(buffer);
            }
            else if (message.properties.type === 'response') {
                this.inFlight = Math.max(0, this.inFlight - 1);
                await this.writeBuffer(message.content);
            }

        }
        finally { channel?.ack(message); }
    }

    exportedServiceAdd(serviceId) {
        this.exportedServices.push(serviceId);
    }

    importedServiceAdd(boundService) {
        this.importedServices[boundService.hash] = boundService.id;
    }

    resetInput() {
        this.input = Buffer.allocUnsafe(2);
        this.inputOffset = 0;
        this.inputHeader = null;
        this.inputStage = 'prefix';
    }

    onData(data) {
        let offset = 0;
        while (offset < data.length && !this.disconnected) {
            const count = Math.min(data.length - offset, this.input.length - this.inputOffset);
            data.copy(this.input, this.inputOffset, offset, offset + count);
            offset += count;
            this.inputOffset += count;
            if (this.inputOffset < this.input.length) { return; }
            if (this.inputStage === 'prefix') {
                const size = this.input.readUInt16BE(0);
                if (!size || size > MAX_HEADER) { throw new Error('Invalid RPC header size'); }
                this.input = Buffer.allocUnsafe(size);
                this.inputOffset = 0;
                this.inputStage = 'header';
                continue;
            }
            if (this.inputStage === 'header') {
                const headerSize = this.input.length;
                this.inputHeader = Header.decode(this.input);
                const size = this.inputHeader.size;
                if (!Number.isInteger(size) || size < 0 || size > MAX_FRAME - 2 - headerSize) {
                    throw new Error('Invalid RPC payload size');
                }
                this.input = Buffer.allocUnsafe(size);
                this.inputOffset = 0;
                this.inputStage = 'payload';
                if (size) { continue; }
            }
            const header = this.inputHeader, payload = this.input;
            this.resetInput();
            this.handleFrame(header, payload);
        }
    }

    handleFrame(header, payload) {
        if (header.serviceId === 0xFE) {
            let responseHash = header.serviceHash;

            if (!this.bindless) {
                responseHash = this.importedServices[this.requests[header.token]];
            }

            this.logger.debug('Received response on service: '+responseHash+' with methodId: '+header.methodId);

            this.publish('battlenet_aurora_bus', responseHash.toString(), payload,
                {
                    headers: header,
                    requestId: this.requests[header.token],
                    type: 'response'
                });
        }
        else {
            this.logger.debug('Received request on service: '+header.serviceHash+' with methodId: '+header.methodId);

            let requestHash = header.serviceHash;

            if (!this.bindless) {
                requestHash = this.exportedServices[header.serviceId];
            }

            if (!this.isAccepting() || this.inFlight >= 128) {
                const response = Header.fromObject({ ...Header.toObject(header), serviceId: 0xFE, status: 1, size: 0 });
                const encoded = Header.encode(response).finish();
                const rejected = Buffer.alloc(2 + encoded.length);
                rejected.writeUInt16BE(encoded.length);
                encoded.copy(rejected, 2);
                void this.writeBuffer(rejected);
                return;
            }
            if (requestHash === this.serviceHash) {
                this.onMessage(header, payload, this);
            }
            else if (requestHash) {
                this.inFlight++;
                this.publish('battlenet_aurora_bus', requestHash.toString(), payload,
                    {
                        headers: { ...Header.toObject(header), identity: this.identity },
                        replyTo: this.queueName,
                        appId: this.serviceName,
                        type: 'request'
                    });
            }
            else {
                //send error ERROR_RPC_INVALID_SERVICE
            }
        }
    }

    publish(...args) {
        if (this.amqpChannel.publish(...args)) { return; }
        this.socket.pause();
        const output = waitForDrain(this.amqpChannel);
        this.brokerOutput.add(output);
        output.then(() => {
            this.brokerOutput.delete(output);
            if (!this.disconnected) { this.socket.resume(); }
        }, () => {
            this.brokerOutput.delete(output);
            void this.disconnect();
        });
    }

    writeBuffer(buffer) {
        if (this.socket.destroyed || !Buffer.isBuffer(buffer)) { return Promise.resolve(); }
        if (this.socket.writableLength + buffer.length > 1024 * 1024) {
            return this.disconnect();
        }
        const task = new Promise((resolve, reject) => {
            const closed = () => { cleanup(); resolve(); };
            const cleanup = () => this.socket.removeListener('close', closed);
            this.socket.once('close', closed);
            this.socket.write(buffer, error => {
                cleanup();
                if (error) { reject(error); }
                else { resolve(); }
            });
        });
        this.output.add(task);
        task.then(() => this.output.delete(task), () => {
            this.output.delete(task);
            void this.disconnect();
        });
        return task;
    }

    disconnect() {
        this.disconnected = true;
        if (this.amqpChannel) {
            const channel = this.amqpChannel;
            this.amqpChannel = null;
            void this.closeChannel(channel).catch(() => {});
        }
        if (!this.socket.destroyed) { this.socket.destroy(); }
        return Promise.allSettled([...this.channelClosures]);
    }
};

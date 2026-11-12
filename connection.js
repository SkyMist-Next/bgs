'use strict';
const loadProto = require('./utils/protobuf');
const { waitForDrain } = require('./utils/backpressure');

const rootNamespace = loadProto('proto/bgs/low/pb/client/rpc_types.proto');
const Header = rootNamespace.lookupType('bgs.protocol.Header');
const MAX_HEADER = 1024;
const MAX_FRAME = 1024 * 1024;
// Notification methods never reply, so pending server-to-client requests are capped.
const MAX_PENDING_REQUESTS = 1024;
// Bound service ids exclude 0xFE (response) and 0xFF; the connection service owns server id 0.
const MAX_SERVICE_ID = 0xFD;
const MAX_BINDINGS = 256;
const isHash = value => Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF;

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
        this.requests = new Map();
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

    // Applies a non-bindless BindRequest. Throws without partial effects on any invalid
    // binding; returns the server ids assigned to deprecated imported service hashes.
    bind(request, registered) {
        const imported = request?.importedService ?? [], deprecatedImported = request?.deprecatedImportedServiceHash ?? [];
        const exported = [...(request?.exportedService ?? []), ...(request?.deprecatedExportedService ?? [])];
        if (imported.length + deprecatedImported.length + exported.length > MAX_BINDINGS) { throw new Error('Too many service bindings'); }
        const exportedServices = [...this.exportedServices], importedServices = { ...this.importedServices }, assigned = [];
        for (const { hash, id } of imported) {
            if (!isHash(hash) || !registered.has(hash) || !Number.isInteger(id) || id < 1 || id > MAX_SERVICE_ID ||
                (exportedServices[id] !== undefined && exportedServices[id] !== hash)) { throw new Error('Invalid imported service binding'); }
            exportedServices[id] = hash;
        }
        for (const hash of deprecatedImported) {
            if (!isHash(hash) || !registered.has(hash)) { throw new Error('Invalid imported service hash'); }
            let id = exportedServices.indexOf(hash);
            if (id < 0) { id = exportedServices.length; exportedServices[id] = hash; }
            if (id > MAX_SERVICE_ID) { throw new Error('Too many imported services'); }
            assigned.push(id);
        }
        for (const { hash, id } of exported) {
            if (!isHash(hash) || !Number.isInteger(id) || id < 0 || id > MAX_SERVICE_ID) { throw new Error('Invalid exported service binding'); }
            importedServices[hash] = id;
        }
        this.exportedServices = exportedServices;
        this.importedServices = importedServices;
        return assigned;
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
                if (!this.bindless && !Number.isInteger(this.importedServices[requestHeader.serviceHash])) {
                    this.logger.debug('Dropped request for unbound client service: ' + requestHeader.serviceHash);
                    return;
                }
                requestHeader.token = this.requestToken;
                this.requestToken = (this.requestToken + 1) >>> 0;
                if (this.requests.size >= MAX_PENDING_REQUESTS) { this.requests.delete(this.requests.keys().next().value); }
                this.requests.set(requestHeader.token, { serviceHash: requestHeader.serviceHash, requestId: message.properties.correlationId });

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
            const pending = this.requests.get(header.token);
            this.requests.delete(header.token);
            const responseHash = this.bindless ? header.serviceHash : pending?.serviceHash;

            this.logger.debug('Received response on service: '+responseHash+' with methodId: '+header.methodId);
            if (!isHash(responseHash)) { return; }

            this.publish('battlenet_aurora_bus', responseHash.toString(), payload,
                {
                    headers: header,
                    requestId: pending?.requestId,
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
                this.reject(header, 1);
                return;
            }
            if (requestHash === this.serviceHash) {
                this.onMessage(header, payload, this);
            }
            else if (requestHash) {
                this.inFlight++;
                this.publish('battlenet_aurora_bus', requestHash.toString(), payload,
                    {
                        headers: { ...Header.toObject(header), serviceHash: requestHash, identity: this.identity },
                        replyTo: this.queueName,
                        appId: this.serviceName,
                        type: 'request'
                    });
            }
            else {
                this.reject(header, 0xBC6); // ERROR_RPC_INVALID_SERVICE
            }
        }
    }

    reject(header, status) {
        const response = Header.fromObject({ ...Header.toObject(header), serviceId: 0xFE, status, size: 0 });
        const encoded = Header.encode(response).finish();
        const rejected = Buffer.alloc(2 + encoded.length);
        rejected.writeUInt16BE(encoded.length);
        encoded.copy(rejected, 2);
        void this.writeBuffer(rejected);
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

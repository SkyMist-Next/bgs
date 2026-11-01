'use strict';
const protobuf = require('protobufjs');

const rootNamespace = protobuf.loadSync('proto/bgs/low/pb/client/rpc_types.proto');
const Header = rootNamespace.lookupType('bgs.protocol.Header');

module.exports = class Connection {
    constructor(socket){
        this.socket = socket;
        this.bindless = false;
        this.requestToken = 0;
        this.requests = [];
        this.importedServices = {};
        this.exportedServices = [];
        this.clientId = undefined;
        this.amqpChannel = undefined;
        this.queueName = undefined;

        this.exportedServices[0] = global.connectionService.getServiceHash();
        this.importedServices[global.connectionService.getServiceHash()] = 0;

        this.onData = this.onData.bind(this);
        this.disconnect = this.disconnect.bind(this);

        this.socket.on('data', this.onData);

        this.socket.on('timeout', this.disconnect);

        this.socket.on('close', this.disconnect);

        this.socket.setTimeout(30000);
    }

    setAmqpChannel(channel) {
        this.amqpChannel = channel;
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
        return this.socket.remoteAddress;
    }

    setupConsumer() {
        if (this.amqpChannel && this.queueName) {
            return this.amqpChannel.consume(this.queueName, (message) => {
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

                    this.writeBuffer(buffer);
                }
                else if (message.properties.type === 'response') {
                    this.writeBuffer(message.content);
                }

                this.amqpChannel.ack(message);
            });
        }
        else {
            return Promise.reject(0x0); //fill with error
        }
    }

    exportedServiceAdd(serviceId) {
        this.exportedServices.push(serviceId);
    }

    importedServiceAdd(boundService) {
        this.importedServices[boundService.hash] = boundService.id;
    }

    onData(data)  {
        let bytesRead = this.socket.bytesRead;

        if (bytesRead >= 2) {
            const headerSize = data.readUInt16BE(0);
            bytesRead -= 2;

            if (bytesRead >= headerSize) {
                const header = Header.decode(data.slice(2, 2+headerSize));

                if (header.serviceId === 0xFE) {
                    let responseHash = header.serviceHash;

                    if (!this.bindless) {
                        responseHash = this.importedServices[this.requests[header.token]];
                    }

                    global.logger.debug('Received response on service: '+responseHash+' with methodId: '+header.methodId);

                    this.amqpChannel.publish('battlenet_aurora_bus', responseHash.toString(), data.slice(2+headerSize),
                        {
                            headers: header,
                            requestId: this.requests[header.token],
                            type: 'response'
                        });
                }
                else {
                    global.logger.debug('Received request on service: '+header.serviceHash+' with methodId: '+header.methodId);

                    let requestHash = header.serviceHash;

                    if (!this.bindless) {
                        requestHash = this.exportedServices[header.serviceId];
                    }

                    if (requestHash === global.connectionService.getServiceHash()) {
                        global.connectionService.onMessage(header, data.slice(2+headerSize), this);
                    }
                    else if (requestHash) {
                        this.amqpChannel.publish('battlenet_aurora_bus', requestHash.toString(), data.slice(2+headerSize),
                            {
                                headers: Header.toObject(header),
                                replyTo: this.queueName,
                                appId: global.connectionService.getServiceName(),
                                type: 'request'
                            });
                    }
                    else {
                        //send error ERROR_RPC_INVALID_SERVICE
                    }
                }
            }
        }
    }

    writeBuffer(buffer) {
        if(!this.socket.destroyed && Buffer.isBuffer(buffer)) {
            this.socket.write(buffer);
        }
    }

    disconnect() {
        if (this.amqpChannel) {
            this.amqpChannel.close();
            this.amqpChannel = null;
        }

        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }
};
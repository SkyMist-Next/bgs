/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const FNV = require('fnv').FNV;
const loadProto = require('../utils/protobuf');

const Header = loadProto('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');

class Listener {
    constructor(name, file, amqpConnection) {
        this.amqpConnection = amqpConnection;
        this.hash = 0;
        this.name = name;
        this.amqpChannel = undefined;
        this.clientQueue = undefined;
        this.messageQueue = [];
        this.rootNamespace = loadProto(file);

        let service = this.rootNamespace.lookupService(this.name);
        this.methods = service.methodsArray;

        let hash = new FNV();
        hash.update(service.getOption('(bgs.protocol.service_options).descriptor_name'));
        this.hash = parseInt(hash.digest('hex'), 16);

        this.channelReady = this.amqpConnection.createChannel().
        then((channel) => {
            this.amqpChannel = channel;
        });
    }

    async destroy() {
        await this.channelReady;
        await this.amqpChannel.close();
    }

    setClientQueueName(queueName) {
        this.clientQueue = queueName;
    }

    async call(methodName, builder) {
        await this.channelReady;
        let method = this.methods.find((element) => {
            return element.name === methodName;
        });

        let requestType = this.rootNamespace.lookupType(method.requestType);
        let request = requestType.create();
        builder(request);
        let requestBuffer = requestType.encode(request).finish();
        let header = Header.create();
        header.serviceHash = this.hash;
        header.methodId = method.getOption('(bgs.protocol.method_options).id');
        header.size = requestBuffer.length;
        header.status = 0;

        this.amqpChannel.sendToQueue(this.clientQueue, requestBuffer, { headers: Header.toObject(header), type: 'request', appId: this.name });
    }
}

module.exports = Listener;
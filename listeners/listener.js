/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const FNV = require('fnv').FNV;
const protobuf = require('protobufjs');

const Header = protobuf.loadSync('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');

class Listener {
    constructor(name, file) {
        this.hash = 0;
        this.name = name;
        this.amqpChannel = undefined;
        this.clientQueue = undefined;
        this.messageQueue = [];
        this.rootNamespace = protobuf.loadSync(file);

        let service = this.rootNamespace.lookupService(this.name);
        this.methods = service.methodsArray;

        let hash = new FNV();
        hash.update(service.getOption('(.bgs.protocol.service_options).descriptor_name'));
        this.hash = parseInt(hash.digest('hex'), 16);

        global.amqpConnection.createChannel().
        then((channel) => {
            this.amqpChannel = channel;
        });
    }

    destroy () {
        this.amqpChannel.close();
    }

    setClientQueueName(queueName) {
        this.clientQueue = queueName;
    }

    call(methodName, builder) {
        let method = this.methods.find((element) => {
            return element.name === methodName;
        });

        let requestType = this.rootNamespace.lookupType(method.requestType);
        let request = requestType.create();
        builder(request);
        let requestBuffer = requestType.encode(request).finish();
        let header = Header.create();
        header.serviceHash = this.hash;
        header.methodId = method.getOption('(.bgs.protocol.method_options).id');
        header.size = requestBuffer.length;
        header.status = 0;

        this.amqpChannel.sendToQueue(this.clientQueue, requestBuffer, { headers: Header.toObject(header), type: 'request', appId: this.name });
    }
}

module.exports = Listener;
/**
 * Created by kaloyan on 8.7.2016 г..
 */
'use strict';

const microtime = require('microtime');
const loadProto = require('../utils/protobuf');
const Connection = require('../connection');
const Service = require('./service');

const rootNamespace = loadProto('proto/bgs/low/pb/client/rpc_types.proto');
const ProcessId = rootNamespace.lookupType('bgs.protocol.ProcessId');

class ConnectionService extends Service {
    constructor() {
        super('ConnectionService', 'proto/bgs/low/pb/client/connection_service.proto');

        this.connections = [];

        this.registerHandler('Connect', this.Connect.bind(this));
        this.registerHandler('KeepAlive', this.KeepAlive.bind(this));
        this.registerHandler('RequestDisconnect', this.RequestDisconnect.bind(this));
    }

    Connect(context) {
        return global.amqpConnection.createChannel().
        then((channel) => {
            context.connection.setAmqpChannel(channel);
            return Promise.resolve(channel);
        }).
        then((channel) => {
            return channel.assertQueue('', {autoDelete: true});
        }).
        then((result) => {
            context.connection.setAmqpQueueName(result.queue);
            return context.connection.setupConsumer();
        }).
        then(()=> {
            if(context.request.clientId !== null) {
                context.connection.setClientId(context.request.clientId);
                context.response.clientId = context.request.clientId;
            }

            if (context.response.useBindlessRpc !== null) {
                context.connection.setBindlessRPC(context.request.useBindlessRpc);
            }

            if (context.connection.getBindlessRPC()) {
                global.etcd3.getAll().prefix('/aurora/services/').keys().then((services) => {
                    services.forEach((serviceKey) => {
                        if (serviceKey.includes('hash')) {
                            global.etcd3.get(serviceKey).number().then((serviceHash) => {
                                context.connection.exportedServiceAdd(serviceHash);
                            });
                        }
                    });
                });
            }

            context.response.serverId = ProcessId.create();
            context.response.serverId.label = process.pid;
            context.response.serverId.epoch = Math.floor(Date.now());
            context.response.serverTime = microtime.now();
            context.response.useBindlessRpc = context.connection.getBindlessRPC();

            if (!context.connection.getBindlessRPC()) {
                for (let boundService in context.request.bindRequest.importedService) {
                    context.response.bindResponse.importedServiceId.push(context.connection.getExportedServiceId(boundService.hash));
                }

                for(let boundService in context.request.bindRequest.exportedService) {
                    context.connection.importedServiceAdd(boundService);
                }

                context.response.bindResult = 0;
            }

            return Promise.resolve(0);
        }).
        catch((error) => {
            if (Number.isInteger(error)) {
                return Promise.reject(error);
            }
            else {
                global.logger.error(error);
                return Promise.reject(0x1); //fill with error
            }
        });
    }

    KeepAlive() {
        global.logger.debug('Received KeepAlive on connection');

        return Promise.resolve(0);
    }

    RequestDisconnect(context) {
        global.logger.debug('Client requested disconnect with code: '+context.request.errorCode);
        context.connection.disconnect();

        return Promise.resolve(0);
    }

    closeAllConnections() {
        this.connections.forEach((connection) => {
            connection.disconnect();
        });
    }

    onNewConnection(socket) {
        global.logger.debug('Received new connection from: ' + socket.remoteAddress);

        let connection = new Connection(socket);

        this.connections.push(connection);
    }

    onMessage(header, payload, connection) {
        let context = {
            connection: connection,
            header: header,
            request: null,
            response: null
        };

        this.handleCall(context, payload).then((buffer)=> {
            connection.writeBuffer(buffer);
        });
    }
}

module.exports = ConnectionService;

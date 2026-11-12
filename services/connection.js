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
    constructor({ logger, store, amqpConnection, isAccepting = () => store.healthy }) {
        super('ConnectionService', 'proto/bgs/low/pb/client/connection_service.proto', { logger });
        this.store = store;
        this.amqpConnection = amqpConnection;
        this.isAccepting = isAccepting;
        this.closing = new Set();

        this.connections = [];
        this.pending = new Set();
        this.stopping = false;

        this.registerHandler('Connect', this.Connect.bind(this));
        this.registerHandler('KeepAlive', this.KeepAlive.bind(this));
        this.registerHandler('RequestDisconnect', this.RequestDisconnect.bind(this));
    }

    Connect(context) {
        return this.amqpConnection.createChannel().
        then(async (channel) => {
            if (context.connection.setAmqpChannel(channel) === false) {
                await context.connection.disconnect();
                throw new Error('Client disconnected during channel startup');
            }
            return Promise.resolve(channel);
        }).
        then((channel) => {
            if (this.stopping || context.connection.disconnected) { throw new Error('Client connection stopping'); }
            return channel.assertQueue('', {autoDelete: true, exclusive: true, durable: false});
        }).
        then((result) => {
            if (this.stopping || context.connection.disconnected) { throw new Error('Client connection stopping'); }
            context.connection.setAmqpQueueName(result.queue);
            return context.connection.setupConsumer();
        }).
        then(async ()=> {
            if (this.stopping || context.connection.disconnected) { throw new Error('Client connection stopping'); }
            if(context.request.clientId !== null) {
                context.connection.setClientId(context.request.clientId);
                context.response.clientId = context.request.clientId;
            }

            if (context.response.useBindlessRpc !== null) {
                context.connection.setBindlessRPC(context.request.useBindlessRpc);
            }

            if (context.connection.getBindlessRPC()) {
                const services = await this.store.listMetadata('/aurora/services/');
                for (const [path, value] of Object.entries(services)) {
                    if (/^\/aurora\/services\/[^/]+\/hash$/.test(path)) {
                        const hash = Number(value);
                        if (!Number.isInteger(hash) || hash < 0 || hash > 0xFFFFFFFF) {
                            throw new Error('Invalid registered service hash');
                        }
                        context.connection.exportedServiceAdd(hash);
                    }
                }
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
                this.logger.error(error);
                return Promise.reject(0x1); //fill with error
            }
        });
    }

    async KeepAlive(context) {
        this.logger.debug('Received KeepAlive on connection');
        if (context?.connection?.identity?.connectionId) {
            await this.store.getConnectionIdentity(context.connection.identity.connectionId);
        }
        return 0;
    }

    async RequestDisconnect(context) {
        this.logger.debug('Client requested disconnect with code: '+context.request.errorCode);
        await this.store.run(client => client.del('/aurora/connections/' + context.connection.identity.connectionId));
        context.connection.disconnect();

        return Promise.resolve(0);
    }

    stopAccepting() { this.stopping = true; }

    async drain() {
        this.stopAccepting();
        while (!this.forced && (this.pending.size || this.connections.some(connection =>
            !connection.disconnected && (connection.inFlight || connection.output.size || connection.brokerOutput.size || connection.socket.writableLength)))) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        await this.closeAllConnections();
        while (this.closing.size) { await Promise.allSettled([...this.closing]); }
    }

    forceClose() {
        this.forced = true;
        return this.closeAllConnections();
    }

    closeAllConnections() {
        return Promise.allSettled(this.connections.map(connection => connection.disconnect()));
    }

    onNewConnection(socket) {
        this.logger.debug('Received new connection from: ' + socket.remoteAddress);

        if (this.stopping || !this.isAccepting()) { socket.destroy(); return; }
        let connection = new Connection(socket, {
            logger: this.logger, serviceHash: this.getServiceHash(), serviceName: this.getServiceName(),
            onMessage: this.onMessage.bind(this), isAccepting: () => !this.stopping && this.isAccepting()
        });
        socket.once('close', () => {
            // Expiry remains the fallback during an unavailable Redis primary.
            void Promise.resolve().then(() => this.store.run(client =>
                client.del('/aurora/connections/' + connection.identity.connectionId))).catch(() => {});
            const closing = connection.disconnect();
            this.closing.add(closing);
            closing.finally(() => this.closing.delete(closing));
            this.connections = this.connections.filter(item => item !== connection);
        });

        this.connections.push(connection);
    }

    onMessage(header, payload, connection) {
        let context = {
            connection: connection,
            header: header,
            request: null,
            response: null
        };

        const operation = this.pending.size < 1024 && !this.stopping && this.isAccepting()
            ? this.handleCall(context, payload) : this.sendError(context, 1);
        const call = operation.then(buffer => connection.writeBuffer(buffer));
        this.pending.add(call);
        call.then(() => this.pending.delete(call), error => {
            this.pending.delete(call);
            this.logger.error(error);
            connection.disconnect();
        });
    }
}

module.exports = ConnectionService;

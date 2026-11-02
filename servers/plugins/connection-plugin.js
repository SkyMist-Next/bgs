'use strict';

const { tlsOptions } = require('../configuration');

class ConnectionPlugin {
    constructor(config = {}, factories = {}) {
        this.config = config;
        this.factories = factories;
        this.stopping = false;
    }

    async initialize(context) {
        context.signal.throwIfAborted();
        const ConnectionService = this.factories.ConnectionService || require('../../services/connection');
        this.service = new ConnectionService(context);
        const accept = socket => {
            if (this.stopping || !context.isAccepting()) { socket.destroy(); return; }
            this.service.onNewConnection(socket);
        };
        return this.config.environment === 'development'
            ? require('node:tls').createServer(tlsOptions(this.config), accept)
            : require('node:net').createServer(accept);
    }

    stopAccepting() { this.stopping = true; this.service?.stopAccepting(); }
    async drain() { await this.service?.drain(); }
    async forceClose() { await this.service?.forceClose(); }
}

module.exports = ConnectionPlugin;

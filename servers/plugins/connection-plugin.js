'use strict';


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
        const { checkIP, canonicalIP } = require('../../utils/admin-state');
        this.admissions = new Set();
        const accept = socket => {
            if (this.stopping || !context.isAccepting()) { socket.destroy(); return; }
            if (this.admissions.size >= 128) { socket.destroy(); return; }
            socket.pause();
            socket.verifiedAddress = canonicalIP(socket.verifiedAddress || socket._parent?.verifiedAddress || socket.remoteAddress);
            const task = checkIP(context.models, socket.verifiedAddress).then(() => {
                if (this.stopping || !context.isAccepting() || socket.destroyed) { socket.destroy(); return; }
                this.service.onNewConnection(socket);
                socket.resume();
            }, () => socket.destroy());
            this.admissions.add(task);
            void task.then(() => this.admissions.delete(task), () => { this.admissions.delete(task); socket.destroy(); });
        };
        if (this.config.proxyProtocol) {
            if (!context.tlsOptions) { throw new Error('PROXY mode requires frontend TLS'); }
            return require('../../utils/proxy-v2').proxyServer(context.tlsOptions, this.config.trustedProxyCIDRs, accept);
        }
        return (this.config.tlsEnabled ?? (this.config.environment === 'development'))
            ? require('node:tls').createServer(context.tlsOptions, accept)
            : require('node:net').createServer(accept);
    }

    stopAccepting() { this.stopping = true; this.service?.stopAccepting(); }
    async drain() { await Promise.allSettled(this.admissions || []); await this.service?.drain(); }
    async forceClose() { await this.service?.forceClose(); }
}

module.exports = ConnectionPlugin;

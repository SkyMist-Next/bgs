'use strict';

const BaseServer = require('./base-server');

class NetworkingServer extends BaseServer {
    constructor({ plugin, ...options } = {}) {
        // Validate before a single dependency is constructed or connected.
        for (const method of ['initialize', 'stopAccepting', 'drain', 'forceClose']) {
            if (typeof plugin?.[method] !== 'function') { throw new TypeError('Plugin requires ' + method + '()'); }
        }
        super(options);
        this.plugin = plugin;
        this.sockets = new Set();
    }

    async onStart(dependencies, signal) {
        this.initializing = Promise.resolve(this.plugin.initialize({
            ...dependencies, dependencies, signal,
            isReady: () => this.isReady(), isAccepting: () => this.isAccepting(),
            onFatal: error => this.stop(error)
        }));
        const listener = await this.initializing;
        this.listener = listener;
        listener.on('error', () => {
            if (!signal.aborted) { void this.stop(new Error('Network listener failed')); }
        });
        // 'connection' includes raw TCP sockets before a TLS handshake completes.
        listener.on('connection', socket => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            if (signal.aborted) { socket.destroy(); }
        });
        if (signal.aborted) {
            await Promise.allSettled([this.closeListener(), this.plugin.forceClose()]);
            signal.throwIfAborted();
        }
        await new Promise((resolve, reject) => {
            const clean = () => {
                listener.removeListener('listening', listening);
                listener.removeListener('error', failed);
                signal.removeEventListener('abort', aborted);
            };
            const listening = () => { clean(); resolve(); };
            const failed = error => { clean(); reject(error); };
            const aborted = () => { clean(); reject(signal.reason); };
            listener.once('listening', listening);
            listener.once('error', failed);
            signal.addEventListener('abort', aborted, { once: true });
            try { listener.listen({ port: this.config.port, host: this.config.host, signal }); }
            catch (error) { failed(error); }
        });
        this.logger?.info('Listening on port ' + listener.address().port);
    }

    closeListener() {
        if (!this.listener) { return Promise.resolve(); }
        this.listenerClose ??= new Promise((resolve, reject) => {
            this.listener.close(error => {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') { reject(error); }
                else { resolve(); }
            });
        });
        return this.listenerClose;
    }

    onStopAccepting() {
        // Start closing the listener, but drain handlers before waiting for sockets.
        void this.closeListener().catch(() => {});
        return this.plugin.stopAccepting();
    }

    async onDrain() {
        await this.plugin.drain();
        await this.closeListener();
    }

    async onForceClose() {
        for (const socket of this.sockets) { socket.destroy(); }
        await Promise.all([this.closeListener(), this.plugin.forceClose()]);
    }
}

module.exports = NetworkingServer;

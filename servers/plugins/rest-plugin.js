'use strict';

const createRestApp = require('../../utils/rest-app');

class RestPlugin {
    constructor(config = {}, factories = {}) {
        this.config = config;
        this.factories = factories;
        this.pending = new Set();
        this.accepting = true;
        const url = config.webAuthUrl;
        if (url && (!['http:', 'https:'].includes(new URL(url).protocol) || !url.endsWith('/'))) {
            throw new Error('Invalid WEB_AUTH_URL');
        }
    }

    track(operation) {
        if (this.pending.size >= 1024) { return Promise.reject(new Error('REST handler limit exceeded')); }
        const task = Promise.resolve().then(operation);
        this.pending.add(task);
        task.then(() => this.pending.delete(task), () => this.pending.delete(task));
        return task;
    }

    async initialize(context) {
        const { signal, store } = context;
        if (this.config.webAuthUrl) {
            await store.setMetadata('/aurora/services/AuthenticationService/WebAuthUrl', this.config.webAuthUrl);
        }
        signal.throwIfAborted();
        const { Authenticator, loadKey } = require('../../utils/authenticator');
        this.authenticator = new Authenticator(context.models, loadKey(this.config.env?.BGS_AUTHENTICATOR_KEY_FILE));
        this.app = createRestApp({ ...context, exposeHealth: !this.config.healthPort, trustedProxyCIDRs: this.config.trustedHttpProxyCIDRs || [], compare: this.factories.compare,
            authenticator: this.authenticator,
            isAccepting: () => this.accepting && context.isAccepting(), track: operation => this.track(operation) });
        this.server = (this.config.tlsEnabled ?? (this.config.environment === 'development'))
            ? require('node:https').createServer(context.tlsOptions, this.app)
            : require('node:http').createServer(this.app);
        return this.server;
    }

    stopAccepting() {
        this.accepting = false;
        this.server?.closeIdleConnections();
    }

    async drain() {
        while (this.pending.size) { await Promise.allSettled([...this.pending]); }
        this.server?.closeIdleConnections();
        this.authenticator?.key?.fill(0);
    }

    forceClose() { this.server?.closeAllConnections(); this.authenticator?.key?.fill(0); }
}

module.exports = RestPlugin;

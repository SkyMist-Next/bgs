'use strict';
const BaseServer = require('./base-server');
const RealmService = require('../realm/service');
const RealmReceiver = require('../realm/receiver');
const RealmDirectory = require('../utils/realm-directory');

class RealmServer extends BaseServer {
    constructor(options = {}) { super({ ...options, requiresAmqp: true }); }
    async onStart(dependencies, signal) {
        signal.throwIfAborted();
        const directory = new RealmDirectory(dependencies.models, this.config.realmDatabase);
        await directory.rows();
        this.receiver = new RealmReceiver(new RealmService({ ...dependencies, realmDirectory: directory }), {
            ...dependencies, isAccepting: () => this.isAccepting(), onFatal: error => this.stop(error)
        });
        await this.receiver.start();
    }
    onStopAccepting() { return this.receiver?.stopAccepting(); }
    onDrain() { return this.receiver?.drain(); }
    onForceClose() { return this.receiver?.forceClose(); }
}
module.exports = RealmServer;

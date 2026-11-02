'use strict';

const BaseServer = require('./base-server');
const ServiceReceiver = require('../messaging/receiver');

class ServiceServer extends BaseServer {
    constructor({ Service, ...options } = {}) {
        super({ ...options, requiresAmqp: true });
        this.Service = Service;
    }

    async onStart(dependencies, signal) {
        signal.throwIfAborted();
        const Service = this.Service || require('../services/' + this.config.service);
        this.service = new Service(dependencies);
        const options = { ...dependencies, signal, isAccepting: () => this.isAccepting(), onFatal: error => this.stop(error) };
        this.receiver = this.factories.receiver
            ? this.factories.receiver(this.service, options) : new ServiceReceiver(this.service, options);
        await this.receiver.start();
    }

    onStopAccepting() { return this.receiver?.stopAccepting(); }
    async onDrain() { await this.receiver?.drain(); }
    async onForceClose() { await this.receiver?.forceClose(); }
}

module.exports = ServiceServer;

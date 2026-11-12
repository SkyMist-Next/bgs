'use strict';

const BaseServer = require('./base-server');
const ServiceReceiver = require('../messaging/receiver');
const RealmReceiver = require('../realm/receiver');
const RealmDirectory = require('../utils/realm-directory');
const SocialRuntime = require('../social/runtime');
const { LegacyChat } = require('../social/legacy-chat');
const SocialRealm = require('../social/realm');
const WorldPresence = require('../social/world-presence');
const { hash } = require('../social/wire');

class SocialServer extends BaseServer {
    constructor(options = {}) { super({ ...options, requiresAmqp: true }); this.receivers = []; }
    async onStart(dependencies, signal) {
        signal.throwIfAborted();
        const realmDirectory = new RealmDirectory(dependencies.models, this.config.realmDatabase);
        await realmDirectory.rows();
        const url = new URL(this.config.amqpUrl); url.pathname = '/skymist-realms';
        const resource = await this.acquire(() => this.factories.realmAmqp ? this.factories.realmAmqp() :
            require('amqplib').connect(url.href, { timeout: 5000 }), connection => connection.close(), connection => connection.connection?.stream.destroy());
        const realmConnection = resource.value;
        realmConnection.on('error', () => this.stop(new Error('Social realm broker unavailable')));
        realmConnection.on('close', () => this.stop(new Error('Social realm broker closed')));
        realmConnection.on('blocked', () => { this.realmBlocked = true; });
        realmConnection.on('unblocked', () => { this.realmBlocked = false; });
        const worldPresence = new WorldPresence(dependencies.store, dependencies.models);
        const runtime = this.runtime = new SocialRuntime({ ...dependencies, worldPresence, onChannelFailure: error => this.stop(error) });
        const legacyChat = new LegacyChat(runtime, { worldPresence });
        const options = { ...dependencies, runtime, worldPresence, realmDirectory, legacyChat };
        const services = new Map();
        for (const name of ['friends', 'presence', 'notification', 'user_manager', 'report', 'legacy_chat']) {
            const Service = require('../services/' + name);
            const service = new Service(options);
            service.confirmReplies = true;
            const descriptor = service.rootNamespace.lookupService(service.getServiceName());
            services.set(hash(descriptor.fullName.slice(1)), service);
            const receiver = new ServiceReceiver(service, { ...dependencies, isAccepting: () => this.isAccepting(), onFatal: error => this.stop(error) });
            this.receivers.push(receiver);
            await receiver.start();
        }
        const realmReceiver = new RealmReceiver(new SocialRealm({ ...dependencies, realmDirectory }, runtime, services, worldPresence), {
            ...dependencies, amqpConnection: realmConnection, queue: 'skymist.realm.social.v1.requests', routingKey: 'social',
            isAccepting: () => this.isAccepting(), onFatal: error => this.stop(error)
        });
        this.receivers.push(realmReceiver);
        await realmReceiver.start();
        await runtime.start(realmConnection);
    }
    isAccepting() { return super.isAccepting() && !this.realmBlocked && !this.runtime?.channelFailed; }
    async onStopAccepting() { await Promise.all(this.receivers.map(receiver => receiver.stopAccepting())); }
    async onDrain() { await Promise.all(this.receivers.map(receiver => receiver.drain())); await this.runtime?.stop(); }
    async onForceClose() { await Promise.all(this.receivers.map(receiver => receiver.forceClose())); await this.runtime?.stop(); }
}
module.exports = SocialServer;

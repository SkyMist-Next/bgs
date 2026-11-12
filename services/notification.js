'use strict';

const Service = require('./service');
const { gameAccount } = require('../utils/admin-state');
const { SocialError } = require('../social/errors');
const { account, accountId, notification, textAttribute, id } = require('../social/wire');

const SYSTEM_HIGH = '144115188075855872'; // 2 << 56, system whisper destination.
const RATE_WINDOW = 10000;
const RATE_LIMIT = 10;

class NotificationService extends Service {
    constructor(dependencies) {
        super('NotificationService', 'proto/bgs/low/pb/client/notification_service.proto', dependencies);
        Object.assign(this, { runtime: dependencies.runtime, models: dependencies.models });
        this.confirmReplies = true;
        this.registerHandler('SendNotification', this.send.bind(this));
    }
    async rateLimit(accountId) {
        const key = '/skymist/social/whispers/rate/' + accountId;
        const allowed = await this.runtime.store.transaction([key], async client => {
            // Shared primary time and WATCH/EXEC serialize all licenses, connections
            // and workers for this parent. Only bounded timestamps are retained.
            const raw = await client.get(key);
            const [seconds, microseconds] = await client.sendCommand(['TIME']);
            const now = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
            const previous = raw === null ? [] : JSON.parse(raw);
            if (!Number.isSafeInteger(now) || now < 0 || !Array.isArray(previous) || previous.length > RATE_LIMIT ||
                previous.some(value => !Number.isSafeInteger(value) || value < 0)) {
                throw new Error('Invalid whisper rate state');
            }
            const recent = previous.filter(value => value > now - RATE_WINDOW);
            if (recent.length >= RATE_LIMIT) { return { commands: [], result: false }; }
            recent.push(now);
            return { commands: [['SET', key, JSON.stringify(recent), 'PX', String(RATE_WINDOW)]], result: true };
        });
        if (!allowed) { throw 0xBBA; } // ERROR_RPC_TOO_MANY_REQUESTS
    }
    async send(context) {
        const owner = await this.runtime.owner(context), request = context.request;
        const parentId = id(owner.accountId);
        if (request.type !== 'WHISPER') { throw 0x6595; }
        if (request.targetId?.high?.toString() !== SYSTEM_HIGH || request.targetId?.low?.toString() !== '0') { throw 0xBC5; }
        if (request.senderAccountId && accountId(request.senderAccountId) !== parentId) { throw 0xA; }
        const targetId = accountId(request.targetAccountId);
        // Direct sessions bind their selection through own-game Presence/Legacy
        // Subscribe; authenticated world routes already carry their selected license.
        if (!owner.gameAccountId) { throw 0xA; }
        const selectedId = id(owner.gameAccountId);
        const sender = await gameAccount(this.models, owner, selectedId);
        if (request.senderId) {
            if (id(request.senderId.low) !== selectedId ||
                sender.entityId.high.toString() !== request.senderId.high?.toString()) { throw 0xA; }
        }
        if (!Array.isArray(request.attribute) || request.attribute.length !== 1 || request.attribute[0]?.name !== 'whisper') { throw 0xBC5; }
        const variant = request.attribute[0].value;
        // Variant is not a protobuf oneof. Presence matters, including an explicitly
        // supplied false/zero alongside the string (native string Variant flag 8).
        if (!variant || Object.keys(variant).length !== 1 || !Object.hasOwn(variant, 'stringValue')) { throw 0xBC5; }
        const message = request.attribute[0].value.stringValue;
        if (typeof message !== 'string' || !message || message.includes('\0') || !message.isWellFormed()) { throw 0xBC5; }
        if (Buffer.byteLength(message) > 1020) { throw 0x1B59; }
        await this.rateLimit(parentId);
        if (await this.runtime.sessionBlocked(owner.sessionKey, targetId)) { throw 0x1B58; }
        try { await this.runtime.graph.assertAccess(parentId, targetId, 'whisper'); }
        catch (error) {
            if (error instanceof SocialError) { throw 0x1B58; }
            throw error;
        }
        const recipients = [], seen = new Set();
        for (const row of await this.runtime.recipients(targetId, 'friends')) {
            if (String(row.accountId) !== targetId) { continue; }
            const route = typeof row.route === 'string' ? JSON.parse(row.route) : row.route;
            const peer = await this.runtime.current(route, targetId);
            if (!peer || peer.accountId !== targetId) { continue; }
            if (!peer.sessionKey) { throw new Error('Whisper recipient has no authenticated session'); }
            // Friends can have several listener objects on one connection/session;
            // NotificationListener is global, so fan out only once to that route.
            if (seen.has(peer.sessionKey)) { continue; }
            seen.add(peer.sessionKey);
            if (!await this.runtime.sessionBlocked(peer.sessionKey, parentId)) { recipients.push(row); }
        }
        if (!recipients.length) { throw 0x1B58; }
        const profile = await this.models.Account.findByPk(parentId);
        if (!profile) { throw 0xA; }
        const frame = notification('notification_service', 'NotificationListener', 'OnNotification', '0', {
            senderId: sender.entityId, targetId: { high: SYSTEM_HIGH, low: '0' }, type: 'WHISPER',
            senderAccountId: account(parentId), targetAccountId: account(targetId),
            senderBattleTag: profile.battleTag, attribute: [textAttribute('whisper', message)]
        });
        // At-most-once consumer handling and no automatic RPC retry preserve the
        // live-only contract even when a sender cannot observe the reply.
        let sent = false;
        for (const recipient of recipients) { sent = await this.runtime.notify(recipient, [frame]) || sent; }
        if (!sent) { throw 0x1B58; }
        return 0;
    }
}
module.exports = NotificationService;

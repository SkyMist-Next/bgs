/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const crypto = require('crypto');
const { blocked, checkIP } = require('../utils/admin-state');

const Service = require('./service');
const ChallengeListener = require('../listeners/challenge');
const AuthenticationListener = require('../listeners/authentication');

class AuthenticationService extends Service {
    constructor({ logger, models, store, amqpConnection }) {
        super('AuthenticationService', 'proto/bgs/low/pb/client/authentication_service.proto', { logger });
        this.models = models;
        this.store = store;
        this.amqpConnection = amqpConnection;

        this.registerHandler('Logon', this.Logon.bind(this));

        this.registerHandler('VerifyWebCredentials', this.VerifyWebCredential.bind(this));
    }

    async Logon(context) {
        this.logger.debug('Logon Request for program ' + context.request.program + ' on ' + context.request.platform);
        const loginTicket = crypto.randomBytes(20).toString('hex');
        try {
            const webAuthUrl = await this.store.getMetadata('/aurora/services/' + this.getServiceName() + '/WebAuthUrl');
            if (!webAuthUrl) { throw new Error('Web authentication URL is not configured'); }
            if (!context.identity?.connectionId) { throw new Error('Missing connection identity'); }
            await checkIP(this.models, context.identity.address);
            await this.store.createLoginTicket(loginTicket, context.request.program, { ...context.identity, applicationVersion: context.request.applicationVersion });
            const listener = new ChallengeListener(context, this.amqpConnection);
            try {
                await listener.OnExternalChallenge(webAuthUrl + loginTicket);
            }
            finally {
                await listener.destroy();
            }
            return 0;
        }
        catch {
            this.logger.error('Authentication dependency failed');
            throw 0x00000001;
        }
    }

    async VerifyWebCredential(context) {
        const loginTicket = Buffer.from(context.request.webCredentials).toString();
        if (!loginTicket.length) {
            throw 0x00000001;
        }
        let status = 0;
        let account;
        let gameAccounts;
        let applicationVersion;
        try {
            const ticket = await this.store.getLoginTicket(loginTicket);
            await checkIP(this.models, context.identity?.address);
            if (!ticket || !ticket.connectionId || ticket.connectionId !== context.identity?.connectionId || ticket.address !== context.identity.address) {
                throw new Error('Login ticket belongs to another connection');
            }
            applicationVersion = Number(ticket?.applicationVersion) || undefined;
            const accountId = ticket && ticket.accountId;
            account = accountId && await this.models.Account.findOne({
                include: [{ model: this.models.GameAccount, as: 'gameAccounts' }], where: { id: accountId }
            });
            if (blocked(account)) {
                status = 0x0000000A; // ERROR_NO_AUTH
            }
            else {
                const program = ticket.program;
                gameAccounts = account.gameAccounts.filter(gameAccount => gameAccount.program === program && !blocked(gameAccount) &&
                    (applicationVersion !== 15595 || (gameAccount.program === 'WoW' && gameAccount.expansion === 3)));
                if (!gameAccounts.length) {
                    status = 0x0000000C; // ERROR_NO_GAME_ACCOUNT
                }
            }
        }
        catch {
            this.logger.error('Authentication dependency failed');
            status = 0x00000001; // ERROR_INTERNAL
        }
        if (status === 0) {
            try {
                await this.store.setConnectionIdentity(context.identity.connectionId, { accountId: String(account.id), address: context.identity.address, ...(applicationVersion ? { applicationVersion } : {}) });
            }
            catch { status = 1; }
        }
        const listener = new AuthenticationListener(context, this.amqpConnection);
        try {
            await listener.OnLogonComplete(status, status === 0 ? account : undefined, gameAccounts);
            return 0;
        }
        finally {
            await listener.destroy();
        }
    }
}

module.exports = AuthenticationService;

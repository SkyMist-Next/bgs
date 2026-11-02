/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const crypto = require('crypto');

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
            await this.store.createLoginTicket(loginTicket, context.request.program);
            const listener = new ChallengeListener(context, this.amqpConnection);
            try {
                await listener.OnExternalChallenge(webAuthUrl + loginTicket);
            }
            finally {
                await listener.destroy();
            }
            return 0;
        }
        catch (error) {
            this.logger.error(error);
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
        try {
            const ticket = await this.store.getLoginTicket(loginTicket);
            const accountId = ticket && ticket.accountId;
            account = accountId && await this.models.Account.findOne({
                include: [{ model: this.models.GameAccount, as: 'gameAccounts' }], where: { id: accountId }
            });
            if (!account) {
                status = 0x0000000A; // ERROR_NO_AUTH
            }
            else {
                const program = ticket.program;
                gameAccounts = account.gameAccounts.filter(gameAccount => gameAccount.program === program);
                if (!gameAccounts.length) {
                    status = 0x0000000C; // ERROR_NO_GAME_ACCOUNT
                }
            }
        }
        catch (error) {
            this.logger.error(error);
            status = 0x00000001; // ERROR_INTERNAL
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

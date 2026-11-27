/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const crypto = require('crypto');
const { blocked, checkIP } = require('../utils/admin-state');
const { requireProof } = require('../utils/authenticator');
const { ClientSessions, eligibleGame } = require('../utils/client-sessions');

const Service = require('./service');
const ChallengeListener = require('../listeners/challenge');
const AuthenticationListener = require('../listeners/authentication');

const CREDENTIAL_BYTES = 32;
function fourcc(value) {
    const number = Number(value) >>> 0;
    return String.fromCharCode(
        (number >>> 24) & 255,
        (number >>> 16) & 255,
        (number >>> 8) & 255,
        number & 255,
    ).replace(/^\0+/, '');
}

class AuthenticationService extends Service {
    constructor({ logger, models, store, amqpConnection }) {
        super(
            'AuthenticationService',
            'proto/bgs/low/pb/client/authentication_service.proto',
            { logger },
        );
        this.models = models;
        this.store = store;
        this.amqpConnection = amqpConnection;
        this.sessions = new ClientSessions(store, models);

        this.registerHandler('Logon', this.Logon.bind(this));

        this.registerHandler(
            'VerifyWebCredentials',
            this.VerifyWebCredential.bind(this),
        );
        this.registerHandler(
            'GenerateWebCredentials',
            this.GenerateWebCredentials.bind(this),
        );
    }

    async Logon(context) {
        this.logger.debug(
            'Logon Request for program ' +
        context.request.program +
        ' on ' +
        context.request.platform,
        );
        if (context.request.cachedWebCredentials?.length) {
            return this.reconnect(context);
        }
        const loginTicket = crypto.randomBytes(20).toString('hex');
        try {
            const webAuthUrl = await this.store.getMetadata(
                '/aurora/services/' + this.getServiceName() + '/WebAuthUrl',
            );
            if (!webAuthUrl) {
                throw new Error('Web authentication URL is not configured');
            }
            if (!context.identity?.connectionId) {
                throw new Error('Missing connection identity');
            }
            await checkIP(this.models, context.identity.address);
            await this.store.createLoginTicket(loginTicket, context.request.program, {
                ...context.identity,
                applicationVersion: context.request.applicationVersion,
            });
            const listener = new ChallengeListener(context, this.amqpConnection);
            try {
                const challengeUrl = webAuthUrl + loginTicket;
                await listener.OnExternalChallenge(challengeUrl);
                this.logger.debug('Sent OnExternalChallenge with URL ' + challengeUrl);
            } finally {
                await listener.destroy();
            }
            return 0;
        } catch {
            this.logger.error('Authentication dependency failed');
            throw 0x00000001;
        }
    }

    async VerifyWebCredential(context) {
        const loginTicket = Buffer.from(context.request.webCredentials).toString();
        if (!loginTicket.length) {
            throw 0x00000001;
        }
        let ticket;
        try {
            ticket = await this.store.getLoginTicket(loginTicket);
            if (
                !ticket ||
        !ticket.connectionId ||
        ticket.connectionId !== context.identity?.connectionId ||
        ticket.address !== context.identity.address
            ) {
                throw new Error('Login ticket belongs to another connection');
            }
        } catch {
            this.logger.error('Authentication dependency failed');
            return this.completeLogon(context, null, 0x00000001);
        }
        return this.completeLogon(context, {
            accountId: ticket.accountId,
            program: ticket.program,
            applicationVersion: Number(ticket.applicationVersion) || undefined,
            proof: {
                credentialVersion: String(ticket.credentialVersion ?? 1),
                authenticatorGeneration: String(ticket.authenticatorGeneration ?? 0),
                authenticatorVerifiedAt: Number(ticket.authenticatorVerifiedAt ?? 0),
            },
        });
    }

    // ADR-0002: a client that lost its connection logs on again with the
    // single-use credential it obtained from GenerateWebCredentials. Unknown,
    // expired, consumed or foreign credentials answer ERROR_NO_AUTH.
    async reconnect(context) {
        let grant = null;
        let status = 0;
        try {
            if (!context.identity?.connectionId) {
                throw new Error('Missing connection identity');
            }
            const credential = Buffer.from(context.request.cachedWebCredentials);
            const record =
                credential.length === CREDENTIAL_BYTES
                    ? await this.store.consumeReconnectCredential(credential)
                    : null;
            if (
                !record ||
        record.address !== context.identity.address ||
        record.program !== context.request.program ||
        Number(record.applicationVersion || 0) !==
          Number(context.request.applicationVersion || 0)
            ) {
                status = 0x0000000a; // ERROR_NO_AUTH
            } else {
                grant = record;
            }
        } catch {
            this.logger.error('Authentication dependency failed');
            status = 0x00000001;
        }
        return this.completeLogon(context, grant, status);
    }

    // Issues the reconnect credential of the calling, authenticated connection.
    async GenerateWebCredentials(context) {
        const session = await this.sessions.resolve(context);
        const program = fourcc(context.request.program);
        if (program !== 'WoW') {
            throw 0x00000001;
        }
        const credential = crypto.randomBytes(CREDENTIAL_BYTES);
        try {
            await this.store.createReconnectCredential(
                credential,
                session.connectionId,
                {
                    accountId: session.accountId,
                    address: session.address,
                    program,
                    applicationVersion: session.applicationVersion,
                    proof: {
                        credentialVersion: session.credentialVersion,
                        authenticatorGeneration: session.authenticatorGeneration,
                        authenticatorVerifiedAt: session.authenticatorVerifiedAt,
                    },
                },
            );
        } catch {
            this.logger.error('Authentication dependency failed');
            throw 0x00000001;
        }
        context.response.webCredentials = credential;
        return 0;
    }

    // Shared end of every logon: rechecks IP, account bans and the
    // authentication proof, opens the client session and sends exactly one
    // OnLogonComplete.
    async completeLogon(context, grant, status = 0) {
        let account;
        let gameAccounts;
        if (status === 0) {
            try {
                await checkIP(this.models, context.identity?.address);
                const accountId = grant && grant.accountId;
                account =
                    accountId &&
          (await this.models.Account.findOne({
              include: [{ model: this.models.GameAccount, as: 'gameAccounts' }],
              where: { id: accountId },
          }));
                if (blocked(account)) {
                    status = 0x0000000a; // ERROR_NO_AUTH
                } else {
                    requireProof(account, grant.proof);
                    gameAccounts = account.gameAccounts.filter(
                        (gameAccount) =>
                            gameAccount.program === grant.program &&
              eligibleGame(gameAccount, grant.applicationVersion),
                    );
                    if (!gameAccounts.length) {
                        status = 0x0000000c; // ERROR_NO_GAME_ACCOUNT
                    }
                }
            } catch {
                this.logger.error('Authentication dependency failed');
                status = 0x00000001; // ERROR_INTERNAL
            }
        }
        if (status === 0) {
            try {
                await this.sessions.open(context.identity, {
                    accountId: account.id,
                    proof: grant.proof,
                    applicationVersion: grant.applicationVersion,
                });
            } catch {
                status = 1;
            }
        }
        const listener = new AuthenticationListener(context, this.amqpConnection);
        try {
            await listener.OnLogonComplete(
                status,
                status === 0 ? account : undefined,
                gameAccounts,
            );
            return 0;
        } finally {
            await listener.destroy();
        }
    }
}

module.exports = AuthenticationService;

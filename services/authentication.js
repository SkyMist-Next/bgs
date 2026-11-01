/**
 * Created by kaloyan on 10.7.2016 г..
 */
'use strict';

const crypto = require('crypto');
const appRoot = require('app-root-path');

const Service = require(appRoot + '/services/service');
const ChallengeListener = require(appRoot + '/listeners/challenge');
const AuthenticationListener = require(appRoot + '/listeners/authentication');
const models = require(appRoot + '/models/');

class AuthenticationService extends Service {
    constructor() {
        super('AuthenticationService', 'proto/bgs/low/pb/client/authentication_service.proto');

        this.registerHandler('Logon', this.Logon.bind(this));

        this.registerHandler('VerifyWebCredentials', this.VerifyWebCredential.bind(this));
    }

    Logon(context) {
        global.logger.debug('Logon Request for program '+context.request.program+' on '+context.request.platform);

        let loginTicket = crypto.randomBytes(20).toString('hex');
        let loginTicketPath = '/aurora/services/' + this.getServiceName() + '/loginTickets/' + loginTicket;

        let challengeListener = new ChallengeListener(context);

        let loginTicketLease = global.etcd3.lease(30);

        return loginTicketLease.put(loginTicketPath).value(loginTicket).then(() => {
            return loginTicketLease.put(loginTicketPath + '/program').value(context.request.program).exec();
        }).then(() => {
            global.etcd3.get('/aurora/services/' + this.getServiceName() + '/WebAuthUrl').string().then((webAuthUrl) => {
                challengeListener.OnExternalChallenge(webAuthUrl + loginTicket);
            });
            return Promise.resolve(0);
        }).catch((error) => {
            global.logger.error(error);
            return Promise.reject(0x00000001);
        });
    }

    VerifyWebCredential(context) {
        let loginTicket = Buffer.from(context.request.webCredentials).toString();
        let authenticationListener = new AuthenticationListener(context);

        if (loginTicket.length) {
            global.logger.debug('Verifying credentials for loginTicket: ' + loginTicket);

            let loginTicketPath = '/aurora/services/' + this.getServiceName() + '/loginTickets/' + loginTicket;

            global.etcd3.get(loginTicketPath + '/accountId').string().
            then((accountId) => {
                return models.Account.find({ include: [ { model: models.GameAccount, as: 'gameAccounts'} ], where: { id: accountId }});
            }, () => {
                authenticationListener.OnLogonComplete(0x0000000A); //ERROR_NO_AUTH
            }).
            then((account) => {
                global.etcd3.get(loginTicketPath + '/program').string().then((program) => {
                    let usableGameAccounts = account.gameAccounts.filter((gameAccount) => {
                        return gameAccount.program === program;
                    });

                    if(usableGameAccounts.length >= 1) {
                        authenticationListener.OnLogonComplete(0, account, usableGameAccounts); //ERROR_OK
                    }
                    else {
                        authenticationListener.OnLogonComplete(0x0000000C); //ERROR_NO_GAME_ACCOUNT
                    }
                });
            }).catch((error) => {
                global.logger.error(error);
                authenticationListener.OnLogonComplete(0x00000001); //ERROR_INTERNAL
            });

            return Promise.resolve(0);
        }
        else {
            return Promise.reject(0x00000001);
        }
    }
}

module.exports = AuthenticationService;
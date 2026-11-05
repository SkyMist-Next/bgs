'use strict';

const crypto = require('crypto');

const Listener = require('./listener');

class AuthenticationListener extends Listener {
    constructor(context, amqpConnection){
        super('AuthenticationListener', 'proto/bgs/low/pb/client/authentication_service.proto', amqpConnection);
        this.setClientQueueName(context.queueName);
    }

    OnLogonComplete(status, account = undefined, gameAccounts = undefined) {
        return this.call('OnLogonComplete', (request) => {
            request.errorCode = status;

            if(account) {
                request.accountId = account.entityId;

                request.battleTag = account.battleTag;
                request.geoipCountry = account.country;

                gameAccounts.forEach((gameAccount) => {
                    request.gameAccountId.push(gameAccount.entityId);
                    if (!request.availableRegion.includes(gameAccount.region)) {
                        request.availableRegion.push(gameAccount.region);
                    }
                });

                request.sessionKey = crypto.randomBytes(64);
                request.connectedRegion = gameAccounts[0].region;
            }
        });
    }
}

module.exports = AuthenticationListener;
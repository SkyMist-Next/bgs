'use strict';

const crypto = require('crypto');

const Listener = require('./listener');

const Region = {
    Uninitialized: -1,
    Unknown: 0,
    Us: 1,
    Kr: 2,
    Eu: 3,
    Tw: 4,
    Cn: 5,
    Dev: 60,
    Ptr: 98
};

class AuthenticationListener extends Listener {
    constructor(context){
        super('AuthenticationListener', 'proto/bgs/low/pb/client/authentication_service.proto');
        this.setClientQueueName(context.queueName);
    }

    OnLogonComplete(status, account = undefined, gameAccounts = undefined) {
        this.call('OnLogonComplete', (request) => {
            request.errorCode = status;

            if(account) {
                request.accountId = account.entityId;

                request.battleTag = account.battleTag;
                request.geoipCountry = account.country;

                gameAccounts.forEach((gameAccount) => {
                    request.gameAccountId.push(gameAccount.entityId);
                });

                request.sessionKey = crypto.randomBytes(64).toString('hex');
                request.connectedRegion = Region.Eu;
            }
        });
    }
}

module.exports = AuthenticationListener;
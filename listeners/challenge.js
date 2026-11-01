'use strict';

const Listener = require('./listener');

class ChallengeListener extends Listener {
    constructor(context) {
        super('ChallengeListener', 'proto/bgs/low/pb/client/challenge_service.proto');
        this.setClientQueueName(context.queueName);
    }

    OnExternalChallenge(url) {
        this.call('OnExternalChallenge', (request) => {
            request.payloadType = 'web_auth_url';
            request.payload = Buffer.from(url, 'ascii');
        });
    }
}

module.exports = ChallengeListener;
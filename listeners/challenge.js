'use strict';

const Listener = require('./listener');

class ChallengeListener extends Listener {
    constructor(context, amqpConnection) {
        super('ChallengeListener', 'proto/bgs/low/pb/client/challenge_service.proto', amqpConnection);
        this.setClientQueueName(context.queueName);
    }

    OnExternalChallenge(url) {
        return this.call('OnExternalChallenge', (request) => {
            request.payloadType = 'web_auth_url';
            request.payload = Buffer.from(url, 'ascii');
        });
    }
}

module.exports = ChallengeListener;
'use strict';

const Service = require('./service');
const { FILE, NAMESPACE } = require('../social/legacy-chat');
const { registerSocialHandlers } = require('../social/errors');

class LegacyChatService extends Service {
    constructor({ logger, legacyChat }) {
        super(NAMESPACE + 'LegacyChatService', FILE, { logger });
        this.legacyOnly = true;
        if (!legacyChat) { throw new Error('Legacy chat service requires the shared legacy chat module'); }
        this.chat = legacyChat;
        const operations = { Subscribe: 'subscribe', Create: 'create', Invite: 'invite', Leave: 'leave', Send: 'send' };
        registerSocialHandlers(this, Object.keys(operations), 'legacy', method => async context => {
            Object.assign(context.response, await this.chat[operations[method]](context));
            return 0;
        });
    }
}
module.exports = LegacyChatService;

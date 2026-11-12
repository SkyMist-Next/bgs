'use strict';

const Service = require('./service');
const { LegacyChat, FILE, NAMESPACE } = require('../social/legacy-chat');
const { registerSocialHandlers } = require('../social/errors');

class LegacyChatService extends Service {
    constructor({ logger, runtime, worldPresence }) {
        super(NAMESPACE + 'LegacyChatService', FILE, { logger });
        this.legacyOnly = true;
        if (!runtime) { throw new Error('Legacy chat requires the shared social runtime'); }
        this.chat = runtime.legacyChat || new LegacyChat(runtime, { worldPresence });
        const operations = { Subscribe: 'subscribe', Create: 'create', Invite: 'invite', Leave: 'leave', Send: 'send' };
        registerSocialHandlers(this, Object.keys(operations), 'legacy', method => async context => {
            Object.assign(context.response, await this.chat[operations[method]](context));
            return 0;
        });
    }
}
module.exports = LegacyChatService;

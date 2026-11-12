'use strict';

const Service = require('./service');
const { LegacyChat, LegacyChatError, FILE, NAMESPACE } = require('../social/legacy-chat');

class LegacyChatService extends Service {
    constructor({ logger, runtime, worldPresence }) {
        super(NAMESPACE + 'LegacyChatService', FILE, { logger });
        this.legacyOnly = true;
        if (!runtime) { throw new Error('Legacy chat requires the shared social runtime'); }
        this.chat = runtime.legacyChat || new LegacyChat(runtime, { worldPresence });
        for (const [method, operation] of Object.entries({ Subscribe: 'subscribe', Create: 'create', Invite: 'invite', Leave: 'leave', Send: 'send' })) {
            this.registerHandler(method, async context => {
                try {
                    Object.assign(context.response, await this.chat[operation](context));
                    return 0;
                } catch (error) {
                    if (error instanceof LegacyChatError) { throw error.status; }
                    throw error;
                }
            });
        }
    }
}
module.exports = LegacyChatService;

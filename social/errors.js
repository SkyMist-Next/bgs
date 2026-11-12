'use strict';

// Internal policy errors only. Service adapters own build-specific RPC statuses.
class SocialError extends Error {
    constructor(code) {
        super(code);
        this.name = 'SocialError';
        this.code = code;
    }
}

// Values are taken from legion-core/src/server/proto/BattlenetRpcErrorCodes.h.
// Ambiguous cap errors use ERROR_SERVER_BUSY instead of guessing inviter/invitee-specific statuses.
const STATUS = Object.freeze({
    ACCOUNT_NOT_FOUND: 0x14, SELF_TARGET: 0x7,
    BLOCKED: 0x1391, NOT_FRIENDS: 0x138C, REAL_ID_DISABLED: 0x1394,
    INVITATION_NOT_FOUND: 0x138E, INVITATION_CONFLICT: 0x138E,
    INVITATION_NOT_RECIPIENT: 0xBC1, INVITATION_NOT_OWNER: 0xBC1,
    INVALID_NOTE: 0x1395, BLOCK_LIMIT: 0x1F45, REPORT_LIMIT: 0xAFD0, INVALID_REPORT: 0xAFCB,
    FRIEND_LIMIT: 0x25, INVITATION_LIMIT: 0x25, OUTBOX_FULL: 0x25,
    INVALID_KIND: 0x1393, OPERATION_CONFLICT: 0x7,
    INVALID_ID: 0x7, INVALID_MESSAGE: 0x7, INVALID_OPERATION_ID: 0x7, INVALID_LIMIT: 0x7
});
const OVERRIDES = Object.freeze({ blocks: { SELF_TARGET: 0x1F42 } });

// The wire status for a social failure, or undefined when the error is not a
// known social outcome (a dependency failure or a defect).
function socialStatus(error, service = 'friends') {
    if (Number.isInteger(error)) { return error; }
    if (Number.isInteger(error?.status)) { return error.status; }
    return OVERRIDES[service]?.[error?.code] ?? STATUS[error?.code];
}

// Registers RPC handlers whose known social failures become wire statuses.
// Unknown errors propagate, so the service logs them and replies 0x1.
function registerSocialHandlers(service, names, serviceKey = 'friends', invoke = name => context => service[name](context)) {
    for (const name of names) {
        const handler = invoke(name);
        service.registerHandler(name, async context => {
            try { return await handler(context); }
            catch (error) {
                const status = socialStatus(error, serviceKey);
                throw status === undefined ? error : status;
            }
        });
    }
}

module.exports = { SocialError, socialStatus, registerSocialHandlers };

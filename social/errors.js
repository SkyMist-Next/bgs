'use strict';

// Internal policy errors only. Service adapters own build-specific RPC statuses.
class SocialError extends Error {
    constructor(code) {
        super(code);
        this.name = 'SocialError';
        this.code = code;
    }
}

module.exports = { SocialError };

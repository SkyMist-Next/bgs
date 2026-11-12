'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SocialError, socialStatus, registerSocialHandlers } = require('../social/errors');
const { LegacyChatError } = require('../social/legacy-chat');

test('social outcomes map to wire statuses with per-service overrides', () => {
    assert.equal(socialStatus(0xA), 0xA);
    assert.equal(socialStatus(new SocialError('NOT_FRIENDS')), 0x138C);
    assert.equal(socialStatus(new SocialError('SELF_TARGET')), 0x7);
    assert.equal(socialStatus(new SocialError('SELF_TARGET'), 'blocks'), 0x1F42);
    assert.equal(socialStatus(new LegacyChatError('LEGACY_OFFLINE')), new LegacyChatError('LEGACY_OFFLINE').status);
    assert.equal(socialStatus(new SocialError('UNKNOWN_CODE')), undefined);
    assert.equal(socialStatus(new Error('database unavailable')), undefined);
});

test('registered handlers translate known outcomes and propagate unknown failures for logging', async () => {
    const handlers = new Map(), outage = new Error('database unavailable');
    const service = { registerHandler: (name, handler) => handlers.set(name, handler),
        Known: async () => { throw new SocialError('SELF_TARGET'); }, Unknown: async () => { throw outage; }, Ok: async () => 0 };
    registerSocialHandlers(service, ['Known', 'Unknown', 'Ok'], 'blocks');
    await assert.rejects(handlers.get('Known')({}), error => error === 0x1F42);
    await assert.rejects(handlers.get('Unknown')({}), error => error === outage);
    assert.equal(await handlers.get('Ok')({}), 0);
});

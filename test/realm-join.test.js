'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RealmJoin } = require('../realm/join');
const { realmFixture, realmRow, joinTickets, identity, REALM_UID } = require('./support/realm-join-fixture');

const GAME = '9007199254740993';
const ADDRESS = 0x01010001;
const status = code => error => error === code;
function setup(build) {
    const f = realmFixture(build);
    f.join = new RealmJoin({ store: f.redis, models: f.models, realmDirectory: f.realmDirectory });
    f.ticket = (info, gameAccountId = GAME) => f.join.issueListTicket(f.context, { gameAccountId, clientInfo: f.clientInfo(info) });
    return f;
}

test('a Legion client lists and joins a realm with a join secret bound to its list ticket', async () => {
    const f = setup();
    f.state.counts = [{ realm_uid: REALM_UID, character_count: 4 }];
    const ticket = await f.ticket();
    assert.equal(ticket.length, 20);
    const listed = await f.join.listRealms(f.context, ticket, '1-1-0');
    assert.equal(f.state.countQuery.where.game_account_id, GAME);
    assert.equal(listed.updates.length, 1);
    assert.equal(listed.updates[0].update.name, 'Test');
    assert.equal(listed.updates[0].update.wowRealmAddress, ADDRESS);
    assert.equal(listed.updates[0].update.flags, 0);
    assert.deepEqual(listed.counts, [{ count: 4, wowRealmAddress: ADDRESS }]);
    const joined = await f.join.join(f.context, ticket, ADDRESS, 26972);
    assert.deepEqual(joined.endpoints, [{ family: 1, addresses: [] }]);
    assert.equal(joined.ticket.length, 20);
    assert.equal(joined.joinSecret.length, 32);
    const [{ key, record }] = joinTickets(f.redis);
    assert.equal(key, '/skymist/v1/realms/' + REALM_UID + '/tickets/' + joined.ticket.toString('hex'));
    assert.equal(record.version, 1); assert.equal(record.game_account_id, GAME); assert.equal(record.account_id, '1');
    assert.equal(record.client_secret, '07'.repeat(32)); assert.equal(record.join_secret, joined.joinSecret.toString('hex'));
    assert.equal(record.expansion, 6); assert.equal(record.platform, 'Win');
    assert.equal(await f.redis.client.pTTL(key), 60000);
    assert.equal(await f.redis.client.pTTL('/aurora/services/GameUtilitiesService/realmListTickets/' + ticket.toString('hex')), 300000);
});

test('a Cataclysm client joins with its stable alias and raw realm key', async () => {
    const f = setup(15595);
    const joined = await f.join.join(f.context, await f.ticket(), ADDRESS, 15595);
    assert.equal(joined.accountName, '1#2');
    assert.equal(joined.sessionKey.length, 40);
    assert.equal(joined.joinSecret, undefined);
    const record = joinTickets(f.redis).map(entry => entry.record).find(value => value.auth_protocol === 'wow-15595-v0');
    assert.equal(record.game_account_id, GAME); assert.equal(record.account_id, '1'); assert.equal(record.wow_license_index, 2);
    assert.equal(record.realm_key, joined.sessionKey.toString('hex'));
    assert.equal(record.expires_at_ms - record.issued_at_ms, 60000);
    assert.equal(record.client_secret, undefined);
});

test('joining reports the failing stage', async () => {
    let f = setup();
    await assert.rejects(f.join.join(f.context, await f.ticket(), 0x01010002, 26972), status(0x8000006B));
    f = setup(); f.state.directoryError = new Error('SQL unavailable');
    await assert.rejects(f.join.join(f.context, Buffer.alloc(20), ADDRESS, 26972), status(0x8000006B));
    for (const endpoints of [null, '[]', '{', JSON.stringify({})]) {
        f = setup(); f.rows[0].endpoints = endpoints;
        await assert.rejects(f.join.join(f.context, await f.ticket(), ADDRESS, 26972), status(0x8000012F));
    }
    f = setup();
    await assert.rejects(f.join.join(f.context, Buffer.alloc(20), ADDRESS, 26972), status(0x8000012D));
    const ticket = await f.ticket();
    await assert.rejects(f.join.join({ identity: { ...identity, connectionId: 'another' } }, ticket, ADDRESS, 26972), error => error === 0xA || error === 0x8000012D);
    await assert.rejects(f.join.join(f.context, ticket, ADDRESS, 15595), status(0xA));
    assert.equal(joinTickets(f.redis).length, 0);
});

test('offline, incompatible, foreign-region or privileged realms issue no join ticket', async () => {
    for (const [change, setPrivilege] of [[{ available: 0 }], [{ build: 15595 }], [{ expansion: 3 }],
        [{ version_revision: 4 }], [{ security_level: 3 }], [{ security_level: 3 }, { level: 2 }]]) {
        const f = setup();
        const ticket = await f.ticket();
        Object.assign(f.rows[0], change); f.state.privilege = setPrivilege || null;
        await assert.rejects(f.join.join(f.context, ticket, ADDRESS, 26972), status(0x80000075));
        assert.equal(joinTickets(f.redis).length, 0);
    }
    const f = setup(); f.rows[0].security_level = 3; f.state.privilege = { level: 3 };
    assert.equal((await f.join.join(f.context, await f.ticket(), ADDRESS, 26972)).ticket.length, 20);
});

test('listing reports a missing catalog, a bad ticket or an unavailable character count distinctly', async () => {
    let f = setup(); const ticket = await f.ticket(); f.state.directoryError = new Error('SQL unavailable');
    await assert.rejects(f.join.listRealms(f.context, ticket, '1-1-0'), status(0x8000006D));
    f = setup();
    await assert.rejects(f.join.listRealms(f.context, Buffer.alloc(20), '1-1-0'), status(0x8000012D));
    f = setup(); f.state.countError = new Error('SQL unavailable');
    await assert.rejects(f.join.listRealms(f.context, await f.ticket(), '1-1-0'), status(0x80000075));
});

test('list tickets cannot cross connections or survive a ban or reassignment', async () => {
    const f = setup();
    const ticket = await f.ticket();
    await assert.rejects(f.join.listRealms({ identity: { ...identity, connectionId: 'another' } }, ticket, '1-1-0'));
    f.state.game.isBanned = true;
    await assert.rejects(f.join.listRealms(f.context, ticket, '1-1-0'), status(0x8000012D));
    await assert.rejects(f.ticket(), status(0xA));
    f.state.game = { ...f.state.game, isBanned: false, accountId: '2' };
    await assert.rejects(f.join.join(f.context, ticket, ADDRESS, 26972), status(0x8000012D));
});

test('list tickets require an eligible WoW licence, matching build, full secret and canonical platform', async () => {
    for (const gameAccountId of [undefined, 0, 'invalid', '9223372036854775808']) {
        const f = setup();
        await assert.rejects(f.join.issueListTicket(f.context, { gameAccountId, clientInfo: f.clientInfo() }), status(0xA));
    }
    for (const change of [{ accountId: '2' }, { isBanned: true }, { isSuspended: true }, { program: 'D3' }, { expansion: 3 }]) {
        const f = setup(); Object.assign(f.state.game, change);
        await assert.rejects(f.ticket(), status(0xA));
    }
    for (const info of [{ secret: Array(31).fill(7) }, { secret: Array(32).fill(256) }, { version: { versionBuild: 15595 } },
        ...[-1, 0x100000000, 1.5, 0, null, {}, 'too-long', 0xD76E3634].map(platform => ({ platform }))]) {
        const f = setup(); await assert.rejects(f.ticket(info), status(0xA));
        assert.equal(f.redis.values.size, 1); // Only the seeded client session.
    }
    const f = setup(); f.redis.client.set = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(f.ticket(), status(0x80000076));
});

test('native numeric platform FourCCs become canonical join platform strings', async () => {
    for (const [platform, expected] of [[1466840628, 'Wn64'], [0x57696E00, 'Win'], [0x4D633634, 'Mc64'], ['Win', 'Win']]) {
        const f = setup();
        await f.join.join(f.context, await f.ticket({ platform }), ADDRESS, 26972);
        assert.equal(joinTickets(f.redis)[0].record.platform, expected);
    }
});

test('realm addresses keep all sixteen realm id bits and unsigned region bits', async () => {
    const f = setup();
    f.rows.push(realmRow(26972, { realm_uid: '22222222-2222-4222-8222-222222222222', realm_id: 513, name: 'Wide ID' }),
        realmRow(26972, { realm_uid: '33333333-3333-4333-8333-333333333333', region: 200, name: 'High region' }));
    const listed = await f.join.listRealms(f.context, await f.ticket(), '1-1-0');
    assert.deepEqual(listed.updates.map(entry => entry.update.wowRealmAddress), [ADDRESS, 16843265]);
    f.state.game.region = 200;
    const high = await f.join.listRealms(f.context, await f.ticket(), '200-1-0');
    assert.deepEqual(high.updates.map(entry => entry.update.wowRealmAddress), [0xC8010001]);
});

test('offline realms list as hidden with no population', async () => {
    const f = setup(); f.rows[0].available = 0;
    const [entry] = (await f.join.listRealms(f.context, await f.ticket(), '1-1-0')).updates;
    assert.equal(entry.update.flags, 0x2);
    assert.equal(entry.update.populationState, 0);
});

test('discovery offers sub-regions with realms for the client build and its eligible licences', async () => {
    const f = setup();
    f.rows.push(realmRow(15595, { realm_uid: '44444444-4444-4444-8444-444444444444', battlegroup: 2 }),
        realmRow(26972, { realm_uid: '55555555-5555-4555-8555-555555555555', region: 2 }));
    assert.deepEqual(await f.join.subRegions(f.context), ['1-1-0']);
    f.state.game.expansion = 3;
    assert.deepEqual(await f.join.subRegions(f.context), []);
});

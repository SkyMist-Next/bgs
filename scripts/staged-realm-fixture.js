'use strict';
const assert = require('node:assert/strict');

module.exports = async function stagedFixture({ call, request, sql, owner }) {
    const changes = Array.from({ length: 33 }, (_, index) => ({ domain: 'toys', key: 'staged.' + index, revision: '0', value: { id: '9007199254740993' } }));
    const begin = request('state.begin', { change_count: 33, chunk_count: 3 });
    const reservation = begin.request_id;
    assert.equal((await call(begin)).result.reservation_id, reservation);
    assert.deepEqual(await call(begin), await call(begin), 'Lost begin reply must not create another reservation');
    const finalize = operation => request(operation, { reservation_id: reservation });
    assert.equal((await call(finalize('state.commit'))).error.code, 'RESERVATION_NOT_PREPARED');
    assert.equal((await call(finalize('state.seal'))).error.code, 'INCOMPLETE_RESERVATION');
    const append = request('state.append', { reservation_id: reservation, index: 0, changes: changes.slice(0, 16) });
    assert.equal((await call(append)).result.index, 0);
    assert.deepEqual(await call(append), await call(append), 'Lost chunk reply must not duplicate its changes');
    assert.equal((await call(request('state.append', append.arguments))).result.index, 0, 'Equivalent chunk identities are harmless');
    assert.equal((await call(request('state.append', { ...append.arguments, changes: [{ ...changes[0], value: false }] }))).error.code, 'CHUNK_CONFLICT');
    assert.equal((await call(request('state.append', { ...append.arguments, index: 3 }))).error.code, 'INVALID_CHUNK_INDEX');
    const pending = await call({ ...request('state.pending', { after: '', limit: 100 }), game_account_id: '0', generation: '0' });
    assert.equal(pending.result.items[0].status, 'staging');
    for (let index = 1; index < 3; index++) {
        assert.equal((await call(request('state.append', { reservation_id: reservation, index, changes: changes.slice(index * 16, (index + 1) * 16) }))).status, 'success');
    }
    const [[before]] = await sql.query("SELECT COUNT(*) AS count FROM game_account_state WHERE game_account_id=? AND entity_key LIKE 'staged.%'", { replacements: [owner.game_account_id] });
    assert.equal(Number(before.count), 0, 'Uploading chunks must not apply shared changes');
    const seal = finalize('state.seal');
    assert.equal((await call(seal)).result.change_count, 33);
    assert.deepEqual(await call(seal), await call(seal), 'Sealing has a stable durable outcome');
    assert.equal((await call(request('state.put', changes[0]))).error.code, 'MUTATION_RECOVERY_REQUIRED');
    const commit = finalize('state.commit');
    assert.equal((await call(commit)).result.change_count, 33);
    assert.deepEqual(await call(commit), await call(commit));
    assert.equal((await call(finalize('state.commit'))).result.status, 'committed', 'Replacement recovery must not reapply revisions');
    const [rows] = await sql.query("SELECT revision FROM game_account_state WHERE game_account_id=? AND entity_key LIKE 'staged.%'", { replacements: [owner.game_account_id] });
    assert.equal(rows.length, 33); assert(rows.every(row => String(row.revision) === '1'));

    // An interrupted upload can be aborted without applying any of its chunks.
    const partial = request('state.begin', { change_count: 17, chunk_count: 2 });
    assert.equal((await call(partial)).status, 'success');
    const partialArgs = { reservation_id: partial.request_id };
    assert.equal((await call(request('state.append', { ...partialArgs, index: 0, changes: [{ ...changes[0], key: 'interrupted' }] }))).status, 'success');
    assert.equal((await call(request('state.abort', partialArgs))).result.status, 'aborted');
    assert.equal((await call(request('state.seal', partialArgs))).error.code, 'RESERVATION_NOT_STAGING');
    const [[remaining]] = await sql.query('SELECT COUNT(*) AS count FROM game_account_reservation_chunks WHERE realm_uid=?', { replacements: [owner.realm_uid] });
    assert.equal(Number(remaining.count), 0);

    // Duplicate keys across chunks are rejected before character SQL could run.
    const duplicate = request('state.begin', { change_count: 2, chunk_count: 2 });
    assert.equal((await call(duplicate)).status, 'success');
    const duplicateArgs = { reservation_id: duplicate.request_id };
    for (const index of [0, 1]) {
        assert.equal((await call(request('state.append', { ...duplicateArgs, index, changes: [{ ...changes[0], key: 'duplicate' }] }))).status, 'success');
    }
    assert.equal((await call(request('state.seal', duplicateArgs))).error.code, 'DUPLICATE_CHANGE');
    assert.equal((await call(request('state.abort', duplicateArgs))).result.status, 'aborted');

    // Revisions are checked at sealing, and a failed seal stays recoverable.
    const stale = request('state.begin', { change_count: 1, chunk_count: 1 });
    assert.equal((await call(stale)).status, 'success');
    const staleArgs = { reservation_id: stale.request_id };
    assert.equal((await call(request('state.append', { ...staleArgs, index: 0, changes: [changes[0]] }))).status, 'success');
    assert.equal((await call(request('state.seal', staleArgs))).error.code, 'REVISION_CONFLICT');
    assert.equal((await call(request('state.abort', staleArgs))).result.status, 'aborted');
    return 'passed';
};

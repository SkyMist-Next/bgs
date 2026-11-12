'use strict';

const wire = require('./wire');
const BN = 16974;
const WOW = 5730135;
const EXTENSION = '.bgs.protocol.presence.v1.ChannelState.presence';
// ChannelState's extension is declared in presence_types, outside channel_service's import graph.
wire.root('channel_service').loadSync('proto/bgs/low/pb/client/presence_types.proto');
function field(program, group, number, value, uniqueId = '0') {
    return { key: { program, group, field: number, uniqueId }, value };
}
function key(value) { return [value.program, value.group, value.field, value.uniqueId || '0'].join(':'); }
function selected(fields, filter) {
    return fields.filter(value => (!filter.program?.length || filter.program.includes(value.key.program)) &&
        (!filter.keys?.length || filter.keys.some(wanted => wanted.program === value.key.program &&
            wanted.group === value.key.group && wanted.field === value.key.field &&
            (!wanted.uniqueId || wanted.uniqueId === '0' || wanted.uniqueId === value.key.uniqueId))));
}
function diff(previous, next, row) {
    const before = new Map((previous?.fields || []).map(value => [key(value.key), value]));
    const after = new Map(next.fields.map(value => [key(value.key), value]));
    const operations = [];
    for (const [id, value] of before) {
        if (!after.has(id)) { operations.push({ field: { key: value.key, value: {} }, operation: 1 }); }
    }
    for (const [id, value] of after) {
        if (JSON.stringify(before.get(id)) !== JSON.stringify(value)) { operations.push({ field: value, operation: 0 }); }
    }
    if (previous && !operations.length) { return []; }
    const state = { [EXTENSION]: { entityId: next.entity, fieldOperation: operations, healing: !previous } };
    return [wire.notification('channel_service', 'ChannelListener', previous ? 'OnUpdateChannelState' : 'OnJoin',
        String(row.objectId), previous ? { stateChange: state } : { channelState: state })];
}
module.exports = { BN, WOW, EXTENSION, field, key, selected, diff };

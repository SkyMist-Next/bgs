'use strict';

const Service = require('./service');
const wire = require('../social/wire');
const friends = require('../social/friends-wire');
const { registerSocialHandlers } = require('../social/errors');

const TYPES = Object.freeze({ spamReport: 'spam', harassmentReport: 'harassment', realLifeThreatReport: 'real_life_threat',
    inappropriateBattleTagReport: 'inappropriate_battle_tag', hackingReport: 'hacking', bottingReport: 'botting' });

class ReportService extends Service {
    constructor({ logger, models, runtime }) {
        super('ReportService', 'proto/bgs/low/pb/client/report_service.proto', { logger });
        this.models = models;
        this.runtime = runtime;
        this.graph = runtime.graph;
        registerSocialHandlers(this, ['SendReport', 'SubmitReport'], 'report');
    }

    async SendReport(context) {
        const owner = await this.runtime.owner(context);
        wire.id(owner.accountId);
        const report = context.request.report;
        if (!report) { throw 0xBC5; }
        if (report.reportingAccount && wire.accountId(report.reportingAccount) !== owner.accountId) { throw 0xA; }
        if (report.reportingGameAccount) { await friends.gameEntity(this.models, report.reportingGameAccount, owner); }
        if (Buffer.byteLength(report.reportType || '') > 64 || (report.attribute || []).length > 16) { throw 0xAFC9; }
        // This older method has only generic attributes. Their target field names/encodings must be
        // recovered before use; do not invent a report schema or trust a client-supplied reporter.
        throw 0xBC7;
    }

    async SubmitReport(context) {
        const owner = await this.runtime.owner(context);
        wire.id(owner.accountId);
        if (context.request.agentId) { await friends.gameHandle(this.models, context.request.agentId, owner); }
        const report = context.request.reportType;
        if (!report) { throw 0xAFCA; }
        const selected = [...Object.keys(TYPES), 'customReport'].filter(key => Object.hasOwn(report, key));
        if (selected.length !== 1 || selected[0] === 'customReport') { throw 0xAFCA; }
        const key = selected[0];
        const value = report[key];
        if (!value?.target) { throw 0xAFCB; }
        const target = await friends.gameHandle(this.models, value.target);
        const details = { note: report.note || '', gameAccountId: friends.storedId(target.id) };
        for (const name of ['text', 'battleTag']) {
            if (Object.hasOwn(value, name)) { details[name] = value[name]; }
        }
        if (key === 'spamReport') {
            if (Object.hasOwn(value, 'source') && ![1, 2, 3, 4].includes(value.source)) { throw 0xAFCB; }
            details.source = value.source || 1;
        }
        for (const text of [details.note, details.text, details.battleTag].filter(value => value !== undefined)) {
            if (typeof text !== 'string' || !text.isWellFormed() || text.includes('\0')) { throw 0xAFCB; }
            if (Buffer.byteLength(text) > 4096) { throw 0xAFC9; }
        }
        const serialized = JSON.stringify(details);
        if (Buffer.byteLength(serialized) > 4096) { throw 0xAFC9; }
        const result = await this.graph.report({ actorId: owner.accountId, targetId: friends.storedId(target.accountId),
            operationId: this.runtime.operationId(context), reason: TYPES[key], details: serialized });
        friends.reconcile(this.runtime, result, context);
        return 0;
    }
}

module.exports = ReportService;

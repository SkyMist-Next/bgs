'use strict';

const RealmService = require('../realm/service');
const { Failure } = require('../realm/contract');
const { type } = require('./wire');
const Header = type('rpc_types', 'bgs.protocol.Header');

class SocialRealm {
    constructor(dependencies, runtime, services, worldPresence) {
        Object.assign(this, dependencies, { runtime, services, worldPresence });
        this.authority = new RealmService(dependencies);
    }
    async execute(request, properties = {}) {
        if (!['social.presence', 'social.call'].includes(request.operation)) { throw new Failure('UNSUPPORTED_OPERATION'); }
        if (Date.now() > Date.parse(request.deadline)) { throw new Failure('DEADLINE_EXPIRED'); }
        if (request.generation === '0') { throw new Failure('SESSION_NOT_OPEN'); }
        try {
            await this.authority.authorize(request);
            const raw = await this.store.run(client => client.get('/skymist/v1/sessions/' + request.game_account_id));
            if (!raw) { throw new Failure('SESSION_OWNERSHIP_LOST'); }
            const owner = JSON.parse(raw);
            if (owner.session_id !== request.session_id || owner.generation !== request.generation ||
                !Object.keys(request.realm).every(field => owner[field] === request.realm[field])) { throw new Failure('STALE_SESSION'); }
            const routeEpoch = properties.headers?.social_route_epoch;
            if (typeof routeEpoch !== 'string' || !/^[1-9][0-9]{0,19}$/.test(routeEpoch) ||
                BigInt(routeEpoch) > 18446744073709551615n) { throw new Failure('INVALID_SOCIAL_ROUTE'); }
            owner.routeEpoch = routeEpoch;
            try { await this.runtime.refreshWorldRoute(owner, properties.replyTo); }
            catch (error) {
                if (error === 0xA) { throw new Failure('STALE_SOCIAL_ROUTE'); }
                if (error === 0xBC5 || error === 0xBC6) { throw new Failure('INVALID_SOCIAL_ROUTE'); }
                throw error;
            }
            let result, afterReply;
            if (request.operation === 'social.presence') {
                result = await this.worldPresence.publish(owner, request.arguments);
            } else {
                if (owner.build !== 26972) { throw new Failure('UNSUPPORTED_BUILD'); }
                const args = request.arguments, service = this.services.get(args.service_hash);
                if (!service || service.legacyOnly) { throw new Failure('UNSUPPORTED_SOCIAL_SERVICE'); }
                const context = { requestId: request.request_id, header: { serviceId: 0, serviceHash: service.getServiceHash(),
                    methodId: args.method_id, objectId: args.object_id, token: 0 }, queueName: properties.replyTo };
                this.runtime.worldContext(context, owner, properties.replyTo);
                const response = await service.handleCall(context, Buffer.from(args.payload, 'base64'));
                if (response) {
                    const length = response.readUInt16BE(0), header = Header.decode(response.subarray(2, 2 + length));
                    if (response.length - 2 - length > 1048576) { throw new Failure('SOCIAL_PAYLOAD_TOO_LARGE'); }
                    result = { status: header.status, payload: response.subarray(2 + length).toString('base64') };
                } else { result = { status: 0, payload: '' }; }
                afterReply = context.afterReply;
            }
            const response = { version: 1, request_id: request.request_id, status: 'success', result };
            if (afterReply) { Object.defineProperty(response, 'afterReply', { value: afterReply }); }
            return response;
        } catch (error) {
            if (error instanceof Failure) { throw error; }
            // This worker is separate from realm admission/persistence. Dependency
            // failures return a social rejection and do not poison gameplay health.
            throw new Failure('SOCIAL_UNAVAILABLE', true);
        }
    }
}
module.exports = SocialRealm;

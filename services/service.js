/**
 * Created by kaloyan on 8.7.2016 г..
 */
'use strict';

const FNV = require('fnv').FNV;
const protobuf = require('protobufjs');

const Header = protobuf.loadSync('proto/bgs/low/pb/client/rpc_types.proto').lookupType('bgs.protocol.Header');

class Service {
    constructor(name, file) {
        this.hash = 0;
        this.name = name;
        this.methods = [];
        this.handlers = [];
        this.rootNamespace = protobuf.loadSync(file);

        let service = this.rootNamespace.lookupService(this.name);

        this.methods = service.methodsArray;

        let hash = new FNV();
        hash.update(service.getOption('(.bgs.protocol.service_options).descriptor_name'));
        this.hash = parseInt(hash.digest('hex'), 16);
    }

    getServiceHash() {
        return this.hash;
    }

    getServiceName() {
        return this.name;
    }

    registerHandler(name, handler) {
        this.methods.forEach((method) => {
            if (method.hasOwnProperty('name') && method.name === name) {
                this.handlers[method.getOption('(.bgs.protocol.method_options).id')] = handler;
            }
        });
    }

    sendError(context, error) {
        let errorHeader = Header.fromObject(context.header);

            if (!Number.isNaN(error)) {
                errorHeader.status = error;
            }
            else {
                global.logger.error(error);
                errorHeader.status = 0x00000001;
            }

            errorHeader.serviceId = 0xFE;
            errorHeader.size = 0;
            let headerBuffer = Header.encode(errorHeader).finish();
            let buffer = Buffer.alloc(2 + headerBuffer.length);
            buffer.writeUInt16BE(headerBuffer.length, 0);
            headerBuffer.copy(buffer, 2);
            return Promise.resolve(buffer);
    }

    handleCall(context, payload) {
        if (this.handlers[context.header.methodId] !== undefined) {
            let method = this.methods.find((element) => {
                return element.getOption('(.bgs.protocol.method_options).id') === context.header.methodId;
            });

            let responseType = this.rootNamespace.lookupType(method.responseType);
            let requestType = this.rootNamespace.lookupType(method.requestType);

            try {
                context.response = responseType.create();

                if (method.requestType !== '.bgs.protocol.NoData') {
                    context.request = requestType.decode(payload);
                }
            }
            catch (error) {
                global.logger.error(error);
                return this.sendError(context, 0x00000BC5); //ERROR_RPC_MALFORMED_REQUEST
            }

            return this.handlers[context.header.methodId](context).then((status) => {
                if(method.responseType !== '.bgs.protocol.NO_RESPONSE') {
                    let responseBuffer = responseType.encode(context.response).finish();
                    let responseHeader = Header.fromObject(context.header);
                    responseHeader.serviceId = 0xFE;
                    responseHeader.status = status;
                    responseHeader.size = responseBuffer.length;

                    let headerBuffer = Header.encode(responseHeader).finish();

                    let buffer = Buffer.alloc(2 + headerBuffer.length + responseBuffer.length);
                    buffer.writeUInt16BE(headerBuffer.length, 0);
                    headerBuffer.copy(buffer, 2);
                    responseBuffer.copy(buffer,2+headerBuffer.length);

                    return Promise.resolve(buffer);
                }
                else {
                    return Promise.resolve(null);
                }
            }, this.sendError.bind(this, context));
        }
        else {
            return this.sendError(context, 0x00000BC7); //ERROR_RPC_NOT_IMPLEMENTED
        }
    }
}

module.exports = Service;
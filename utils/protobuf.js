'use strict';

const path = require('node:path');
const protobuf = require('protobufjs');
const protoDirectory = path.resolve(__dirname, '../proto');

module.exports = function loadProto(filename) {
    const root = new protobuf.Root();
    // BGS imports are relative to proto/, not to the importing file's directory.
    root.resolvePath = (origin, target) => path.isAbsolute(target)
        ? target
        : path.resolve(protoDirectory, target.replace(/^proto\//, ''));
    return root.loadSync(filename);
};

'use strict';

function waitForDrain(stream) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            stream.removeListener('drain', drained);
            stream.removeListener('close', closed);
            stream.removeListener('error', failed);
        };
        const drained = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('Transport closed while waiting for drain'));
        stream.once('drain', drained);
        stream.once('close', closed);
        stream.once('error', failed);
    });
}

module.exports = { waitForDrain };

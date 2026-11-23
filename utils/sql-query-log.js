'use strict';

const path = require('node:path');
const { finished } = require('node:stream/promises');
const { createStream } = require('rotating-file-stream');

module.exports = function openSqlQueryLog(filename, logger) {
    if (!path.isAbsolute(filename) || filename.endsWith(path.sep)) {
        logger?.error('BGS_SQL_LOG_FILE must be an absolute file path');
        return undefined;
    }
    const stream = createStream(path.basename(filename), {
        path: path.dirname(filename),
        size: '10M',
        rotate: 3,
        mode: 0o600
    });
    stream.once('error', () => logger?.error('SQL query log file unavailable; query logging disabled'));
    return {
        write(message) {
            if (stream.writable && !stream.writableNeedDrain) {
                stream.write(JSON.stringify({ timestamp: new Date().toISOString(), message }) + '\n');
            }
        },
        async close() {
            const flushed = finished(stream, { cleanup: true }).catch(() => {
                // The file sink reports write errors separately.
            });
            stream.end();
            await flushed;
        },
        destroy() { stream.destroy(); }
    };
};

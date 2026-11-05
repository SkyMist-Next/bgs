'use strict';
const RealmServer = require('./servers/realm-server');
const { configuration, logger } = require('./servers/configuration');
const { launch } = require('./servers/cli');
function createServer(options = {}) {
    const config = options.config || configuration('realm');
    if (!options.config) { config.amqpUrl += '/skymist-realms'; }
    return new RealmServer({ ...options, config, logger: options.logger || logger() });
}
if (require.main === module) { void launch(createServer); }
module.exports = { createServer };

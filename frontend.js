'use strict';

const NetworkingServer = require('./servers/networking-server');
const ConnectionPlugin = require('./servers/plugins/connection-plugin');
const { configuration, logger } = require('./servers/configuration');
const { launch } = require('./servers/cli');

function createServer(options = {}) {
    const config = options.config || configuration('connection');
    return new NetworkingServer({ ...options, config, logger: options.logger || logger(), requiresAmqp: true,
        plugin: options.plugin || new ConnectionPlugin(config, options.factories) });
}

if (require.main === module) { void launch(createServer); }
module.exports = { createServer };

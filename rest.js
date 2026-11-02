'use strict';

const NetworkingServer = require('./servers/networking-server');
const RestPlugin = require('./servers/plugins/rest-plugin');
const { configuration, logger } = require('./servers/configuration');
const { launch } = require('./servers/cli');

function createServer(options = {}) {
    const config = options.config || configuration('rest');
    return new NetworkingServer({ ...options, config, logger: options.logger || logger(), requiresAmqp: false,
        plugin: options.plugin || new RestPlugin(config, options.factories) });
}

if (require.main === module) { void launch(createServer); }
module.exports = { createServer };

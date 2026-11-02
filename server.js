'use strict';

const ServiceServer = require('./servers/service-server');
const { configuration, logger } = require('./servers/configuration');
const { launch } = require('./servers/cli');

function createServer(options = {}) {
    const config = options.config || { ...configuration('service'), service: process.argv[2] };
    return new ServiceServer({ ...options, config, logger: options.logger || logger() });
}

if (require.main === module) { void launch(createServer); }
module.exports = { createServer };

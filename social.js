'use strict';

const SocialServer = require('./servers/social-server');
const { configuration, logger } = require('./servers/configuration');
const { launch } = require('./servers/cli');
function createServer(options = {}) {
    return new SocialServer({ ...options, config: options.config || configuration('social'), logger: options.logger || logger() });
}
if (require.main === module) { void launch(createServer); }
module.exports = { createServer };

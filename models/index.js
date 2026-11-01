'use strict';

const createDatabase = require('../utils/database');
// eslint-disable-next-line n/no-missing-require -- Operator-supplied configuration.
const config = require('../config/database.json')[process.env.NODE_ENV || 'development'];

module.exports = createDatabase(config, { debug: message => global.logger.debug(message) });

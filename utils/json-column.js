'use strict';

// MariaDB returns JSON columns as strings under the connection's jsonStrings
// option, and raw queries bypass model getters. Decode a JSON column value once.
function jsonColumn(value) { return typeof value === 'string' ? JSON.parse(value) : value; }

module.exports = { jsonColumn };

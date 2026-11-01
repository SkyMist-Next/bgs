'use strict';

const js = require('@eslint/js');
const node = require('eslint-plugin-n');

module.exports = [
    // This unfinished, unused stub references an absent Realm model.
    { ignores: ['services/wow/realmlist.js', 'config/**'] },
    js.configs.recommended,
    node.configs['flat/recommended-script'],
    {
        languageOptions: { ecmaVersion: 2026, sourceType: 'commonjs' },
        rules: {
            'n/exports-style': ['error', 'module.exports'],
            // This application is deployed as a container, not published to npm.
            'n/no-unpublished-require': 'off'
        }
    },
    {
        files: ['frontend.js', 'server.js', 'rest.js', 'utils/lifecycle.js'],
        rules: { 'n/no-process-exit': 'off' } // Preserve fatal startup/rejection handling.
    }
];

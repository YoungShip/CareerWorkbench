'use strict';
// Reuse read-only checks. Does not start an agent.
process.argv[2] = 'zcode';
require('./trae-preflight.js');

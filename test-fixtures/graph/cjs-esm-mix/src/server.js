const express = require('express');
const { chunk, map: lmap } = require('lodash');
const util = require('./util.mjs');
const app = express();
chunk([1, 2], 1);
lmap([1], util.red);
module.exports = app;

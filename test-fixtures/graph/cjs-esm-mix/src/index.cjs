require('./server');
const load = () => import('./util.mjs');
module.exports = { load };

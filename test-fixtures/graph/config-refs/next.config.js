// If this file were ever executed, it would leave a marker file behind.
require('fs').writeFileSync(require('path').join(__dirname, 'EXECUTED_MARKER'), 'executed');
module.exports = { reactStrictMode: true };

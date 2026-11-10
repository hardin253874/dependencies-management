const path = require('path');
const { aliasFromEnv } = require('./tools/aliases');

module.exports = {
  entry: './src/app.js',
  resolve: {
    alias: {
      Components: path.resolve(__dirname, 'src/components'),
      '@shared': path.join(__dirname, 'shared'),
      Utils$: path.resolve(__dirname, 'src/utils/index.js'),
      Dynamic: aliasFromEnv('dyn'),
    },
  },
};

const path = require('path');

module.exports = {
  reactStrictMode: true,
  webpack(config) {
    config.resolve.alias['@lib'] = path.resolve(__dirname, 'lib');
    config.resolve.alias = { ...config.resolve.alias, '@ui': path.join(__dirname, 'components/ui') };
    return config;
  },
};

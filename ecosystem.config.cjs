module.exports = {
  apps: [{
    name: 'ganyiq',
    script: 'npm',
    args: ['start', '--', '-p', '3003'],
    cwd: '/root/GANYIQ',
    env: {
      GANYIQ_TELEGRAM_TARGET: 'telegram:Budak dan aspri / topic 22374',
      NODE_ENV: 'production',
    },
  }]
};

module.exports = {
  apps: [{
    name: 'ganyiq-worker',
    script: 'npx',
    args: 'tsx index.ts',
    cwd: '/root/GANYIQ/worker',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/root/.pm2/logs/ganyiq-worker-error.log',
    out_file: '/root/.pm2/logs/ganyiq-worker-out.log',
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    exp_backoff_restart_delay: 10000,
  }]
};

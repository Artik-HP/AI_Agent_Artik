module.exports = {
  apps: [
    {
      name: "ai-agent-artik",
      script: "index.js",
      args: "--telegram",
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

module.exports = {
  apps: [
    {
      name: "giveaway-bot",
      script: "./artifacts/api-server/dist/index.mjs",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      // Restart if it crashes
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      // Log config
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};

const pino = require('pino').default;
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});
module.exports = logger;
import winston from 'winston';

const level = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const rest = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${rest}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

export default logger;

// logger.js
import winston from 'winston';
import fs from 'fs';
import path from 'path';

const { format, transports } = winston;

const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    success: 2,
    info: 3,
    debug: 4,
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    success: 'green',
    info: 'blue',
    debug: 'gray',
  },
};

winston.addColors(customLevels.colors);

function resolveLogFile(envPath, fallback) {
  if (envPath) {
    try {
      const dir = path.dirname(envPath);
      fs.accessSync(dir, fs.constants.W_OK);
      return envPath;
    } catch (e) {
      console.warn(`[Logger] Cannot write to ${envPath}, falling back to ${fallback}`);
    }
  }
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  return fallback;
}

const ACCESS_LOG_FILE = resolveLogFile(process.env.ACCESS_LOG, 'logs/access.log');
const APP_LOG_FILE = resolveLogFile(process.env.APP_LOG, 'logs/app.log');

const jsonFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.json()
);

const consoleFormat = format.combine(
  format.colorize({ all: true }),
  format.simple()
);

const appLogger = winston.createLogger({
  levels: customLevels.levels,
  level: process.env.LOG_LEVEL || 'info',
  format: jsonFormat,
  transports: [
    new transports.File({
      filename: APP_LOG_FILE,
      level: 'debug', 
    }),
    ...(process.env.LOG_TO_STDOUT === 'true'
      ? [
          new transports.Console({
            format: consoleFormat,
          }),
        ]
      : []),
  ],
});



const accessLogger = winston.createLogger({
  level: 'info',
  format: jsonFormat,
  transports: [
    new transports.File({
      filename: ACCESS_LOG_FILE,
    }),
  ],
});

const logger = {
  info: (msg) => appLogger.info(msg),
  warn: (msg) => appLogger.warn(msg),
  error: (msg, err = null) =>
    appLogger.error(err ? `${msg} → ${err.stack || err}` : msg),
  success: (msg) => appLogger.log('success', msg),
  debug: (msg) => {
    if (process.env.DEBUG === 'true') appLogger.debug(msg);
  },

  adas: (msg) => appLogger.info(`[ADAS] ${msg}`),
  cluster: (msg) => appLogger.info(`[CLUSTER] ${msg}`),
  snap: (msg) => appLogger.info(`[SNAP] ${msg}`),

  access: (info) => accessLogger.info(info),


  accessApp: (message, meta = {}) => {
    accessLogger.info({
      timestamp: new Date().toISOString(),
      type: 'app_event',
      message,
      ...meta,
    });
  },
};


export const rawAppLogger = appLogger;
export const rawAccessLogger = accessLogger;

export default logger;
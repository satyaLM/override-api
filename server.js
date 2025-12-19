// server.js
import restify from 'restify';
import dotenv from 'dotenv';
import registerOverrideRoutes from './controller/overrideController.js';
import { Pool } from 'pg';
import os from 'os';  
import logger, { rawAccessLogger } from './logger.js';  

dotenv.config();

const server = restify.createServer({
  name: 'OverrideAPI',
  version: '1.0.0',
});

server.use(restify.plugins.bodyParser({ mapParams: true }));
server.use(restify.plugins.queryParser());

server.pre((req, res, next) => {
  req._startTime = Date.now();
  return next();
});

server.on('after', (req, res, route, error) => {
  const duration = Date.now() - req._startTime;

  logger.accessApp('HTTP Audit Log', {
    audit: true,
    component: 'after',
    hostname: os.hostname(),  
    remoteAddress: req.connection.remoteAddress || 'unknown',
    remotePort: req.connection.remotePort,
    req_id: req.id?.() || 'unknown',
    req: {
      query: req.query,
      method: req.method,
      url: req.url,
      headers: req.headers,
      httpVersion: req.httpVersion,
      trailers: req.trailers,
      version: req.version,
    },
    res: {
      statusCode: res.statusCode,
      headers: res.getHeaders(),
      trailer: res.trailer,
    },
    latency: duration,
    error: error ? { type: error.name, message: error.message, stack: error.stack } : null,
    msg: `handled: ${res.statusCode}`
  });
});

server.on('uncaughtException', (req, res, route, err) => {
  logger.error(`Uncaught Exception: ${req.method} ${req.url}`, err);
  if (!res.headersSent) {
    res.send(500, { success: false, message: 'Internal Server Error' });
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', reason);
});

server.get('/', (req, res, next) => {
  res.send(200, {
    success: true,
    message: 'Override API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
  return next();
});

(async () => {
  let pool;

  try {
    pool = new Pool({
      user: process.env.LOCATION_DATA_POSTGRES_USERNAME,
      host: process.env.LOCATION_DATA_POSTGRES_HOST,
      database: process.env.LOCATION_DATA_POSTGRES_DATABASENAME,
      password: process.env.LOCATION_DATA_POSTGRES_PASSWORD,
      port: parseInt(process.env.LOCATION_DATA_POSTGRES_PORT || '5432'),
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
      max: 20,              
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

  
    const client = await pool.connect();
    client.release();
    logger.access('Database connected successfully!');

  
    registerOverrideRoutes(server, pool);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.access(`OverrideAPI server running on port: ${PORT}`);
    });

  } catch (err) {
    logger.error('Failed to start server - Database connection error', err);
    process.exit(1);
  }
})();

// server.js
import restify from 'restify';
import dotenv from 'dotenv';
import registerOverrideRoutes from './controller/overrideController.js';
import db from './database.js';
import os from 'os';  
import logger from './logger.js';  

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

(async () => {
  try {
    const client = await db.pool.connect();
    client.release();
    logger.access('Database connected successfully!');

    registerOverrideRoutes(server, db.pool);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.access(`OverrideAPI server running on port: ${PORT}`);
    });
  } catch (err) {
    logger.access('Failed to start server - Database connection error', err);
    process.exit(1);
  }
})();

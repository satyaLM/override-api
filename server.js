import restify from 'restify';
import dotenv from 'dotenv';
import registerOverrideRoutes from './routes/overrideController.js';
import { startTunnel } from './dbTunnel.js';
import { Pool } from 'pg';

dotenv.config();

const server = restify.createServer({
  name: 'OverrideAPI',
  version: '1.0.0'
});

server.use(restify.plugins.bodyParser({ mapParams: true }));
server.use(restify.plugins.queryParser());

try {
  const tunnel = await startTunnel(); 
  console.log('Tunnel started, attempting DB connection...');

  const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
  });

  await pool.connect();
  console.log('PostgreSQL connected via tunnel');

  registerOverrideRoutes(server);

  server.get('/', (req, res, next) => {
    res.send(200, { message: 'Override API running ' });
    next();
  });

  server.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
  });


  tunnel.on('close', () => {
    console.error('SSH tunnel closed unexpectedly');
    process.exit(1);
  });
} catch (err) {
  console.error('Cannot start server:', err.message, err.stack);
  process.exit(1);
}
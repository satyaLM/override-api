import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

async function callProcedure(procName, params = []) {
  const client = await pool.connect();
  try {
    console.log('Executing function with params:', params);
    // Set search_path to public
    await client.query('SET search_path TO public');
    const result = await client.query(
      `SELECT * FROM ${procName}($1)`,
      [params[0]]
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error executing function ${procName}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

export default {
  pool,
  proc: callProcedure
};
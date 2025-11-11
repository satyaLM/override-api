// database.js
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

async function callFunction(funcName, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO public');

    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const query = `SELECT * FROM ${funcName}(${placeholders})`;

    const result = await client.query(query, params);
    await client.query('COMMIT');
    return result.rows; // returns array of rows
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error in function ${funcName}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function callProcedure(procName, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO public');

    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const query = `CALL ${procName}(${placeholders})`;

    await client.query(query, params);
    await client.query('COMMIT');
    return true; // no return value
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error in procedure ${procName}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

export default {
  pool,
  func: callFunction,
  proc: callProcedure
};
// database.js
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  user: process.env.LOCATION_DATA_POSTGRES_USERNAME,
  host: process.env.LOCATION_DATA_POSTGRES_HOST,
  database: process.env.LOCATION_DATA_POSTGRES_DATABASENAME,
  password: process.env.LOCATION_DATA_POSTGRES_PASSWORD,
  port: process.env.LOCATION_DATA_POSTGRES_PORT,
  ssl: { rejectUnauthorized: false }
});

async function callFunction(funcName, params = [], paramTypes = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO public');

    const placeholders = params.map((_, i) => {
      const type = Array.isArray(paramTypes) ? paramTypes[i] : paramTypes;
      return type ? `$${i + 1}::${type}` : `$${i + 1}`;
    }).join(', ');

    const query = placeholders
      ? `SELECT * FROM ${funcName}(${placeholders})`
      : `SELECT * FROM ${funcName}()`;

    const result = await client.query(query, params);
    await client.query('COMMIT');
    return result.rows;
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
    return true;
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
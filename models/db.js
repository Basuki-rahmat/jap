const pool = require('../config/database');

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function insert(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result.insertId;
}

module.exports = { query, get, insert };
// routes/costCenters.js
const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');
const ccRouter = express.Router();

ccRouter.get('/', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    let where = active === 'true' ? 'WHERE active = TRUE' : '';
    const result = await query(`
      SELECT cc.*, 
        COUNT(DISTINCT gii.id) AS line_count
      FROM cost_centers cc
      LEFT JOIN goc_import_items gii ON gii.cost_center_id = cc.id
        AND gii.goc_import_id = (SELECT id FROM goc_imports ORDER BY reference_month DESC LIMIT 1)
      ${where}
      GROUP BY cc.id
      ORDER BY cc.code
    `);
    res.json({ costCenters: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

ccRouter.post('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { code, name, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Código e nome obrigatórios' });

    const result = await query(
      'INSERT INTO cost_centers (code, name, description) VALUES ($1, $2, $3) RETURNING *',
      [code, name, description]
    );
    res.status(201).json({ costCenter: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Código já existe' });
    res.status(500).json({ error: err.message });
  }
});

ccRouter.put('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { name, description, active } = req.body;
    const result = await query(
      'UPDATE cost_centers SET name=$1, description=$2, active=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [name, description, active, req.params.id]
    );
    res.json({ costCenter: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// routes/users.js  
const usersRouter = express.Router();

usersRouter.get('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.name, u.email, u.active, u.last_login, u.created_at,
             r.name as role_name, r.id as role_id
      FROM users u JOIN roles r ON r.id = u.role_id
      ORDER BY u.name
    `);
    res.json({ users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

usersRouter.post('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { name, email, password, roleId } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });

    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, $3, $4) RETURNING id, name, email',
      [name, email.toLowerCase(), hash, roleId]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

// routes/audit.js
const auditRouter = express.Router();

auditRouter.get('/', authenticate, requirePermission('audit'), async (req, res) => {
  try {
    const { action, entity, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (action) { params.push(action); where += ` AND al.action = $${params.length}`; }
    if (entity) { params.push(entity); where += ` AND al.entity_type = $${params.length}`; }

    params.push(limit, (page - 1) * limit);
    const result = await query(`
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ logs: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Logger util
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
  ],
});

// Export all
module.exports = { ccRouter, usersRouter, auditRouter, logger };

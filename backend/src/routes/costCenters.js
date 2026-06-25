// routes/costCenters.js
const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { active } = req.query;
    const whereClause = active === 'true' ? 'WHERE cc.active = TRUE' : '';
    const result = await query(`
      SELECT cc.*
      FROM cost_centers cc
      ${whereClause}
      ORDER BY cc.code
    `);
    res.json({ costCenters: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authenticate, requirePermission('all'), async (req, res) => {
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

router.put('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { name, description, active } = req.body;
    const result = await query(
      'UPDATE cost_centers SET name=$1, description=$2, active=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [name, description, active, req.params.id]
    );
    res.json({ costCenter: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

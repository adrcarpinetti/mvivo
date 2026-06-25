// routes/rules.js
const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');

const rulesRouter = express.Router();

rulesRouter.get('/', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT ar.*, u.name as created_by_name
      FROM allocation_rules ar
      LEFT JOIN users u ON u.id = ar.created_by
      ORDER BY ar.priority ASC, ar.name
    `);
    res.json({ rules: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

rulesRouter.post('/', authenticate, requirePermission('allocate'), async (req, res) => {
  try {
    const { name, description, rule_type, applies_to, charge_type_filter,
            valid_from, valid_until, priority, config } = req.body;

    if (!name || !rule_type || !valid_from) {
      return res.status(400).json({ error: 'Nome, tipo e data de início são obrigatórios' });
    }

    const result = await query(`
      INSERT INTO allocation_rules (name, description, rule_type, applies_to,
        charge_type_filter, valid_from, valid_until, priority, config, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [name, description, rule_type, applies_to || 'unallocated', charge_type_filter,
        valid_from, valid_until, priority || 10, JSON.stringify(config || {}), req.user.id]);

    res.status(201).json({ rule: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

rulesRouter.put('/:id', authenticate, requirePermission('allocate'), async (req, res) => {
  try {
    const { name, description, rule_type, applies_to, valid_from, valid_until,
            priority, config, active } = req.body;

    const result = await query(`
      UPDATE allocation_rules SET
        name=$1, description=$2, rule_type=$3, applies_to=$4,
        valid_from=$5, valid_until=$6, priority=$7, config=$8, active=$9, updated_at=NOW()
      WHERE id=$10 RETURNING *
    `, [name, description, rule_type, applies_to, valid_from, valid_until,
        priority, JSON.stringify(config), active, req.params.id]);

    res.json({ rule: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

rulesRouter.delete('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    await query('UPDATE allocation_rules SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ message: 'Regra desativada' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = rulesRouter;

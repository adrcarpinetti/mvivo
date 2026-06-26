const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { query } = require('../utils/db');
const router = express.Router();

// GET /api/rules
router.get('/', authenticate, async (req, res) => {
  try {
    const { account_number } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (account_number) {
      params.push(account_number);
      where += ` AND (r.account_number = $${params.length} OR r.account_number IS NULL)`;
    }
    const result = await query(`
      SELECT r.*,
        COUNT(DISTINCT va.id) AS account_count
      FROM allocation_rules r
      LEFT JOIN vivo_accounts va ON va.account_number = r.account_number
      ${where}
      GROUP BY r.id
      ORDER BY r.account_number NULLS LAST, r.priority, r.valid_from DESC
    `, params);
    res.json({ rules: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rules
router.post('/', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const {
      name, description, rule_type, applies_to = 'unallocated',
      valid_from, valid_until, priority = 10, config = {},
      account_number  // null = global, '0454705224' = só essa conta
    } = req.body;

    if (!name || !rule_type || !valid_from) {
      return res.status(400).json({ error: 'Nome, tipo e data de início são obrigatórios' });
    }

    const result = await query(`
      INSERT INTO allocation_rules (
        name, description, rule_type, applies_to,
        valid_from, valid_until, priority, config, account_number, active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
      RETURNING *
    `, [name, description, rule_type, applies_to,
        valid_from, valid_until || null, priority,
        JSON.stringify(config), account_number || null]);

    res.status(201).json({ rule: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/rules/:id
router.put('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { name, description, rule_type, applies_to, valid_from, valid_until,
            priority, config, active, account_number } = req.body;
    const result = await query(`
      UPDATE allocation_rules SET
        name=$1, description=$2, rule_type=$3, applies_to=$4,
        valid_from=$5, valid_until=$6, priority=$7, config=$8,
        active=$9, account_number=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [name, description, rule_type, applies_to,
        valid_from, valid_until || null, priority,
        JSON.stringify(config || {}), active !== false,
        account_number || null, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ rule: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/rules/:id
router.delete('/:id', authenticate, requirePermission('all'), async (req, res) => {
  try {
    await query('UPDATE allocation_rules SET active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ message: 'Regra desativada' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

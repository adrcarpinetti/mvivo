const express = require('express');
const { authenticate } = require('../middleware/auth');
const { query } = require('../utils/db');
const router = express.Router();

// GET /api/lines
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, page = 1, limit = 2000 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let searchWhere = '';

    if (search) {
      params.push(`%${search}%`);
      searchWhere = `WHERE pl.number ILIKE $1
        OR gi.employee_name ILIKE $1
        OR gi.cost_center_code ILIKE $1
        OR gi.cost_center_name ILIKE $1`;
    }

    params.push(parseInt(limit), parseInt(offset));
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const result = await query(`
      SELECT
        pl.number,
        pl.active,
        pl.first_seen_date,
        pl.last_seen_date,
        gi.employee_name,
        gi.employee_id,
        gi.cost_center_code,
        gi.cost_center_name,
        gi.plan_type,
        gi.line_type,
        gi.reference_value,
        vi.amount          AS last_billed_amount,
        vi.reference_month AS last_reference_month
      FROM phone_lines pl
      LEFT JOIN LATERAL (
        SELECT gi2.*
        FROM goc_import_items gi2
        JOIN goc_imports g ON g.id = gi2.goc_import_id
        WHERE gi2.phone_number = pl.number
        ORDER BY g.reference_month DESC
        LIMIT 1
      ) gi ON TRUE
      LEFT JOIN LATERAL (
        SELECT vii.amount, va.reference_month
        FROM vivo_invoice_items vii
        JOIN vivo_accounts va ON va.id = vii.vivo_account_id
        WHERE vii.line_number = pl.number
          AND vii.item_category = 'monthly_total'
        ORDER BY va.reference_month DESC
        LIMIT 1
      ) vi ON TRUE
      ${searchWhere}
      ORDER BY pl.number
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    // Contagem total
    const countParams = search ? [params[0]] : [];
    const countRes = await query(`
      SELECT COUNT(*) FROM phone_lines pl
      LEFT JOIN LATERAL (
        SELECT gi2.employee_name, gi2.cost_center_code, gi2.cost_center_name
        FROM goc_import_items gi2
        JOIN goc_imports g ON g.id = gi2.goc_import_id
        WHERE gi2.phone_number = pl.number
        ORDER BY g.reference_month DESC LIMIT 1
      ) gi ON TRUE
      ${searchWhere}
    `, countParams);

    res.json({
      lines: result.rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lines/:number/history
router.get('/:number/history', authenticate, async (req, res) => {
  try {
    const { number } = req.params;
    const result = await query(`
      SELECT
        va.reference_month,
        gi.employee_name,
        gi.cost_center_code,
        gi.cost_center_name,
        vii.amount,
        gi.plan_type
      FROM vivo_invoice_items vii
      JOIN vivo_accounts va ON va.id = vii.vivo_account_id
      LEFT JOIN LATERAL (
        SELECT gi2.*
        FROM goc_import_items gi2
        JOIN goc_imports g ON g.id = gi2.goc_import_id
        WHERE gi2.phone_number = vii.line_number
          AND g.reference_month = va.reference_month
        LIMIT 1
      ) gi ON TRUE
      WHERE vii.line_number = $1
        AND vii.item_category = 'monthly_total'
      ORDER BY va.reference_month DESC
    `, [number]);

    res.json({ lineNumber: number, history: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { query } = require('../utils/db');

const router = express.Router();

// GET /api/reports/dashboard - Dados para o dashboard principal
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    // Totais por mês no ano
    const monthlyTotals = await query(`
      SELECT 
        TO_CHAR(ma.reference_month, 'YYYY-MM') AS month,
        SUM(ma.total_invoice_amount) AS invoice_total,
        SUM(ma.total_allocated_amount) AS allocated_total,
        SUM(ma.total_unallocated_amount) AS unallocated_total,
        COUNT(DISTINCT ma.id) AS account_count,
        SUM(ma.total_lines) AS total_lines,
        SUM(ma.lines_without_cc) AS lines_without_cc
      FROM monthly_allocations ma
      WHERE EXTRACT(YEAR FROM ma.reference_month) = $1
      GROUP BY month
      ORDER BY month
    `, [year]);

    // Top centros de custo (último mês fechado)
    const topCC = await query(`
      SELECT 
        cc.code,
        cc.name,
        ai.total_amount,
        ai.direct_line_count,
        ai.allocation_percentage,
        ma.reference_month
      FROM allocation_items ai
      JOIN cost_centers cc ON cc.id = ai.cost_center_id
      JOIN monthly_allocations ma ON ma.id = ai.monthly_allocation_id
      WHERE ma.reference_month = (
        SELECT MAX(reference_month) FROM monthly_allocations WHERE status IN ('confirmed','closed')
      )
      ORDER BY ai.total_amount DESC
      LIMIT 10
    `);

    // Linhas sem CC (último mês importado)
    const linesWithoutCC = await query(`
      SELECT 
        vii.line_number,
        SUM(vii.amount) AS amount
      FROM vivo_invoice_items vii
      WHERE vii.cost_center_id IS NULL
        AND vii.vivo_account_id IN (
          SELECT id FROM vivo_accounts ORDER BY reference_month DESC LIMIT 5
        )
      GROUP BY vii.line_number
      ORDER BY SUM(vii.amount) DESC
      LIMIT 20
    `);

    // Contas recentes
    const recentAccounts = await query(`
      SELECT va.*, ma.status AS allocation_status, ma.id AS allocation_id
      FROM vivo_accounts va
      LEFT JOIN monthly_allocations ma ON ma.vivo_account_id = va.id
      ORDER BY va.reference_month DESC, va.account_number
      LIMIT 10
    `);

    // KPIs do mês atual
    const lastMonthRes = await query(`
      SELECT 
        SUM(total_invoice_amount) AS total_invoice,
        SUM(total_allocated_amount) AS total_allocated,
        SUM(total_lines) AS total_lines,
        SUM(lines_with_cc) AS lines_with_cc,
        SUM(lines_without_cc) AS lines_without_cc,
        SUM(lines_in_vivo_not_goc) AS unmatched
      FROM monthly_allocations
      WHERE reference_month = (SELECT MAX(reference_month) FROM monthly_allocations)
    `);

    res.json({
      monthlyEvolution: monthlyTotals.rows,
      topCostCenters: topCC.rows,
      linesWithoutCC: linesWithoutCC.rows,
      recentAccounts: recentAccounts.rows,
      kpis: lastMonthRes.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/cost-center/:code - Histórico de um CC
router.get('/cost-center/:code', authenticate, async (req, res) => {
  try {
    const { code } = req.params;
    const { months = 12 } = req.query;

    const result = await query(`
      SELECT 
        TO_CHAR(ma.reference_month, 'YYYY-MM') AS month,
        ai.direct_amount,
        ai.allocated_amount,
        ai.total_amount,
        ai.direct_line_count,
        cc.name
      FROM allocation_items ai
      JOIN monthly_allocations ma ON ma.id = ai.monthly_allocation_id
      JOIN cost_centers cc ON cc.id = ai.cost_center_id
      WHERE cc.code = $1
        AND ma.reference_month >= NOW() - INTERVAL '1 month' * $2
      ORDER BY ma.reference_month DESC
    `, [code, months]);

    const ccInfo = result.rows[0] || {};
    res.json({
      costCenter: { code, name: ccInfo.name },
      history: result.rows.map(r => ({
        month: r.month, lineCount: r.direct_line_count,
        directAmount: parseFloat(r.direct_amount || 0),
        allocatedAmount: parseFloat(r.allocated_amount || 0),
        totalAmount: parseFloat(r.total_amount || 0),
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/line/:number - Histórico de uma linha
router.get('/line/:number', authenticate, async (req, res) => {
  try {
    const number = req.params.number.replace(/\D/g, '');

    const result = await query(`
      SELECT 
        TO_CHAR(gi.reference_month, 'YYYY-MM') AS month,
        gii.phone_number,
        gii.cost_center_code,
        gii.cost_center_name,
        gii.employee_name,
        gii.plan_type,
        gii.reference_value,
        vii_total.total_billed
      FROM goc_import_items gii
      JOIN goc_imports gi ON gi.id = gii.goc_import_id
      LEFT JOIN (
        SELECT 
          vii.line_number,
          va.reference_month,
          SUM(vii.amount) AS total_billed
        FROM vivo_invoice_items vii
        JOIN vivo_accounts va ON va.id = vii.vivo_account_id
        WHERE vii.item_category = 'monthly_fee'
        GROUP BY vii.line_number, va.reference_month
      ) vii_total ON vii_total.line_number = gii.phone_number
        AND vii_total.reference_month = gi.reference_month
      WHERE REGEXP_REPLACE(gii.phone_number, '[^0-9]', '', 'g') = $1
      ORDER BY gi.reference_month DESC
      LIMIT 24
    `, [number]);

    res.json({
      lineNumber: number,
      history: result.rows.map(r => ({
        month: r.month,
        employee: r.employee_name,
        costCenter: r.cost_center_code ? `${r.cost_center_code} — ${r.cost_center_name}` : null,
        amount: parseFloat(r.total_billed || r.reference_value || 0),
        planName: r.plan_type,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/monthly-summary - Resumo mensal completo
router.get('/monthly-summary', authenticate, async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'Mês obrigatório (YYYY-MM)' });

    const refDate = `${month}-01`;

    const summary = await query(`
      SELECT 
        va.account_number,
        va.company_name,
        ma.total_invoice_amount,
        ma.total_allocated_amount,
        ma.difference,
        ma.total_lines,
        ma.lines_with_cc,
        ma.lines_without_cc,
        ma.lines_in_vivo_not_goc,
        ma.status,
        ai_summary.cost_centers_json
      FROM vivo_accounts va
      LEFT JOIN monthly_allocations ma ON ma.vivo_account_id = va.id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
          'code', cc.code,
          'name', cc.name,
          'total', ai.total_amount
        ) ORDER BY ai.total_amount DESC) AS cost_centers_json
        FROM allocation_items ai
        JOIN cost_centers cc ON cc.id = ai.cost_center_id
        WHERE ai.monthly_allocation_id = ma.id
      ) ai_summary ON TRUE
      WHERE va.reference_month = $1
      ORDER BY va.account_number
    `, [refDate]);

    // Agrega totais e lista de CCs no formato esperado pelo frontend
    let totalAmount = 0, allocatedAmount = 0, totalLines = 0;
    const ccMap = new Map();

    for (const row of summary.rows) {
      totalAmount += parseFloat(row.total_invoice_amount || 0);
      allocatedAmount += parseFloat(row.total_allocated_amount || 0);
      totalLines += parseInt(row.total_lines || 0);
      if (row.cost_centers_json) {
        for (const cc of row.cost_centers_json) {
          const key = cc.code;
          if (!ccMap.has(key)) ccMap.set(key, { code: cc.code, name: cc.name, totalAmount: 0, directAmount: 0, allocatedAmount: 0, lineCount: 0 });
          ccMap.get(key).totalAmount += parseFloat(cc.total || 0);
        }
      }
    }

    res.json({
      totalAmount, allocatedAmount, totalLines,
      costCenters: Array.from(ccMap.values()),
      summary: summary.rows,
      referenceMonth: month
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/comparison - Comparação entre dois meses
router.get('/comparison', authenticate, async (req, res) => {
  try {
    const { month1, month2 } = req.query;
    if (!month1 || !month2) return res.status(400).json({ error: 'Dois meses obrigatórios' });

    const result = await query(`
      SELECT 
        cc.code,
        cc.name,
        SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END) AS amount_m1,
        SUM(CASE WHEN ma.reference_month = $2 THEN ai.total_amount ELSE 0 END) AS amount_m2,
        SUM(CASE WHEN ma.reference_month = $2 THEN ai.total_amount ELSE 0 END) - 
        SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END) AS difference,
        CASE 
          WHEN SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END) > 0
          THEN ROUND(
            (SUM(CASE WHEN ma.reference_month = $2 THEN ai.total_amount ELSE 0 END) - 
             SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END)) /
            SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END) * 100, 2
          )
          ELSE NULL
        END AS change_pct
      FROM allocation_items ai
      JOIN monthly_allocations ma ON ma.id = ai.monthly_allocation_id
      JOIN cost_centers cc ON cc.id = ai.cost_center_id
      WHERE ma.reference_month IN ($1, $2)
      GROUP BY cc.code, cc.name
      ORDER BY ABS(
        SUM(CASE WHEN ma.reference_month = $2 THEN ai.total_amount ELSE 0 END) - 
        SUM(CASE WHEN ma.reference_month = $1 THEN ai.total_amount ELSE 0 END)
      ) DESC
    `, [`${month1}-01`, `${month2}-01`]);

    const month1Total = result.rows.reduce((s, r) => s + parseFloat(r.amount_m1 || 0), 0);
    const month2Total = result.rows.reduce((s, r) => s + parseFloat(r.amount_m2 || 0), 0);
    res.json({
      month1Total, month2Total,
      byCostCenter: result.rows.map(r => ({
        code: r.code, name: r.name,
        month1: parseFloat(r.amount_m1 || 0),
        month2: parseFloat(r.amount_m2 || 0),
        difference: parseFloat(r.difference || 0),
        changePct: r.change_pct ? parseFloat(r.change_pct) : null,
      })),
      comparison: result.rows, month1, month2
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

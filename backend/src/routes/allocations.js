const express = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { processAllocation, closeMonthlyAllocation, reopenMonthlyAllocation } = require('../services/allocationService');
const { query } = require('../utils/db');
const XLSX = require('xlsx');

const router = express.Router();

// GET /api/allocations - Lista rateios
router.get('/', authenticate, async (req, res) => {
  try {
    const { month, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = 'WHERE 1=1';

    if (month) {
      params.push(`${month}-01`);
      where += ` AND ma.reference_month = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND ma.status = $${params.length}`;
    }

    params.push(limit, offset);
    const result = await query(`
      SELECT 
        ma.*,
        va.account_number,
        va.company_name,
        u_conf.name AS confirmed_by_name,
        u_closed.name AS closed_by_name,
        COUNT(ai.id) AS cost_center_count
      FROM monthly_allocations ma
      JOIN vivo_accounts va ON va.id = ma.vivo_account_id
      LEFT JOIN users u_conf ON u_conf.id = ma.confirmed_by
      LEFT JOIN users u_closed ON u_closed.id = ma.closed_by
      LEFT JOIN allocation_items ai ON ai.monthly_allocation_id = ma.id
      ${where}
      GROUP BY ma.id, va.account_number, va.company_name, u_conf.name, u_closed.name
      ORDER BY ma.reference_month DESC, va.account_number
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // Retorna também `accounts` para compatibilidade com a tela de Rateio e Simulação
    // O frontend usa `d.accounts` em vários lugares
    const accountsQuery = await query(`
      SELECT
        va.id,
        va.account_number,
        va.reference_month,
        va.total_amount,
        va.status,
        ma.id              AS allocation_id,
        ma.total_invoice_amount,
        ma.total_allocated_amount,
        ma.difference,
        ma.total_lines,
        ma.lines_without_cc,
        ma.status          AS allocation_status
      FROM vivo_accounts va
      LEFT JOIN monthly_allocations ma ON ma.vivo_account_id = va.id
      ORDER BY va.reference_month DESC, va.account_number
      LIMIT 100
    `);
    res.json({ allocations: result.rows, accounts: accountsQuery.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/allocations/process - Processa rateio (simulate ou definitivo)
router.post('/process', authenticate, requirePermission('allocate'), async (req, res) => {
  try {
    const { vivoAccountId, accountId, simulate = false } = req.body;
    const accId = vivoAccountId || accountId;
    if (!accId) return res.status(400).json({ error: 'vivoAccountId obrigatório' });

    const result = await processAllocation(accId, {
      simulate,
      userId: req.user.id,
    });

    res.json({
      message: simulate ? 'Simulação concluída' : 'Rateio processado com sucesso',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/allocations/:id - Detalhes de um rateio
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const allocRes = await query(`
      SELECT ma.*, va.account_number, va.company_name, va.total_amount as invoice_total
      FROM monthly_allocations ma
      JOIN vivo_accounts va ON va.id = ma.vivo_account_id
      WHERE ma.id = $1
    `, [id]);

    if (allocRes.rows.length === 0) return res.status(404).json({ error: 'Rateio não encontrado' });

    const itemsRes = await query(`
      SELECT
        ai.id,
        ai.cost_center_id,
        ai.direct_amount,
        ai.direct_line_count,
        ai.allocated_amount,
        ai.allocation_percentage,
        ai.total_amount,
        cc.code,
        cc.name
      FROM allocation_items ai
      JOIN cost_centers cc ON cc.id = ai.cost_center_id
      WHERE ai.monthly_allocation_id = $1
      ORDER BY ai.total_amount DESC
    `, [id]);

    // Resumo por categoria de cobrança
    const catRes = await query(`
      SELECT
        item_category,
        COUNT(*)::int   AS count,
        SUM(amount)     AS total
      FROM vivo_invoice_items
      WHERE vivo_account_id = $1
        AND item_category IN ('monthly_total','installment','consumption','extra_charge','adjustment')
      GROUP BY item_category
      ORDER BY total DESC
    `, [allocRes.rows[0].vivo_account_id]);

    res.json({
      allocation: allocRes.rows[0],
      items: itemsRes.rows,
      categorySummary: catRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/allocations/:id/close - Fecha o rateio
router.post('/:id/close', authenticate, requirePermission('close_month'), async (req, res) => {
  try {
    const { notes } = req.body;
    await closeMonthlyAllocation(parseInt(req.params.id), req.user.id, notes);
    res.json({ message: 'Rateio fechado com sucesso' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/allocations/:id/reopen - Reabre o rateio
router.post('/:id/reopen', authenticate, requirePermission('all'), async (req, res) => {
  try {
    const { reason } = req.body;
    await reopenMonthlyAllocation(parseInt(req.params.id), req.user.id, reason);
    res.json({ message: 'Rateio reaberto com sucesso' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/allocations/:id/reconciliation - Reconciliação Vivo X GOC
// :id pode ser o ID da vivo_account OU do monthly_allocation
router.get('/:id/reconciliation', authenticate, async (req, res) => {
  try {
    // Tenta primeiro como vivo_account_id
    let vaRes = await query(
      'SELECT id, account_number, reference_month, total_amount FROM vivo_accounts WHERE id = $1',
      [req.params.id]
    );
    let vivo_account_id = req.params.id;
    let reference_month, account_number, total_amount;

    if (vaRes.rows.length > 0) {
      // É um vivo_account_id
      ({ account_number, total_amount } = vaRes.rows[0]);
      const rm = vaRes.rows[0].reference_month;
      reference_month = rm instanceof Date ? rm.toISOString().substring(0,10) : String(rm).substring(0,10);
    } else {
      // Tenta como monthly_allocation_id
      const allocRes = await query(
        'SELECT ma.*, va.id as va_id, va.reference_month as va_ref, va.account_number, va.total_amount FROM monthly_allocations ma JOIN vivo_accounts va ON va.id = ma.vivo_account_id WHERE ma.id = $1',
        [req.params.id]
      );
      if (allocRes.rows.length === 0) return res.status(404).json({ error: 'Conta não encontrada' });
      const a = allocRes.rows[0];
      vivo_account_id = a.va_id;
      account_number  = a.account_number;
      total_amount    = a.total_amount;
      const rm = a.va_ref || a.reference_month;
      reference_month = rm instanceof Date ? rm.toISOString().substring(0,10) : String(rm).substring(0,10);
    }

    // Linhas na Vivo (usa monthly_total que tem um valor por linha)
    const vivoLines = await query(`
      SELECT DISTINCT ON (line_number) line_number, amount as total_amount
      FROM vivo_invoice_items
      WHERE vivo_account_id = $1 AND item_category = 'monthly_total'
      ORDER BY line_number, amount DESC
    `, [vivo_account_id]);

    // Linhas no GOC para o mês (filtra por account_number se disponível)
    // Usa as linhas Vivo como âncora — só busca no GOC os números que aparecem na Vivo
    // OU que têm o mesmo account_number
    const vivoPhones = vivoLines.rows.map(r => r.line_number?.replace(/\D/g, '')).filter(Boolean);

    const gocLines = vivoPhones.length > 0
      ? await query(`
          SELECT DISTINCT ON (gii.phone_number)
            gii.phone_number, gii.cost_center_code, gii.cost_center_name, gii.employee_name
          FROM goc_import_items gii
          JOIN goc_imports gi ON gi.id = gii.goc_import_id
          WHERE gi.reference_month = $1
            AND gii.phone_number = ANY($2)
          ORDER BY gii.phone_number, gii.id DESC
        `, [reference_month, vivoPhones])
      : { rows: [] };

    // Também busca linhas do GOC com o mesmo account_number (para detectar "só no GOC")
    const gocByAccount = account_number ? await query(`
      SELECT DISTINCT ON (gii.phone_number)
        gii.phone_number, gii.cost_center_code, gii.cost_center_name, gii.employee_name
      FROM goc_import_items gii
      JOIN goc_imports gi ON gi.id = gii.goc_import_id
      WHERE gi.reference_month = $1
        AND gii.account_number = $2
      ORDER BY gii.phone_number, gii.id DESC
    `, [reference_month, account_number]) : { rows: [] };

    // Merge: GOC por telefone + GOC por conta
    const gocAllPhones = new Set([
      ...gocLines.rows.map(r => r.phone_number),
      ...gocByAccount.rows.map(r => r.phone_number),
    ]);
    const gocAllRows = [...gocLines.rows, ...gocByAccount.rows.filter(r => !gocLines.rows.find(g => g.phone_number === r.phone_number))];

    const vivoSet = new Set(vivoLines.rows.map(r => r.line_number?.replace(/\D/g, '')));
    const gocMap = new Map(gocAllRows.map(r => [r.phone_number?.replace(/\D/g, ''), r]));

    const inBoth = [];
    const inVivoOnly = [];
    const inGocOnly = [];

    for (const vr of vivoLines.rows) {
      const phone = vr.line_number?.replace(/\D/g, '');
      if (gocMap.has(phone)) {
        inBoth.push({ phone, vivoAmount: vr.total_amount, ...gocMap.get(phone) });
      } else {
        inVivoOnly.push({ phone, vivoAmount: vr.total_amount });
      }
    }

    // Linhas no GOC da mesma conta mas ausentes na Vivo
    for (const r of gocByAccount.rows) {
      const phone = r.phone_number?.replace(/\D/g, '');
      if (phone && !vivoSet.has(phone)) {
        inGocOnly.push({ phone, ...r });
      }
    }

    // Calcula totais
    const totalVivo = parseFloat(total_amount) || vivoLines.rows.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);
    // Busca total rateado do monthly_allocation se existir
    const maRes = await query(
      'SELECT total_allocated_amount FROM monthly_allocations WHERE vivo_account_id = $1',
      [vivo_account_id]
    );
    const totalAllocated = maRes.rows.length > 0
      ? parseFloat(maRes.rows[0].total_allocated_amount || 0)
      : totalVivo;

    // Linhas sem CC: estão na Vivo mas o GOC não tem CC preenchido
    const linesWithoutCC = inBoth.filter(l => !l.cost_center_code).map(l => ({
      number: l.phone, amount: parseFloat(l.vivoAmount || 0)
    }));

    const fmtPhone = (p) => {
      if (!p) return p;
      const d = p.replace(/\D/g, '');
      if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
      if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
      return p;
    };

    res.json({
      totalVivo,
      totalAllocated,
      difference: totalVivo - totalAllocated,
      linesWithoutCC: linesWithoutCC.map(l => ({ ...l, number: fmtPhone(l.number) || l.number })),
      onlyInVivo: inVivoOnly.map(l => ({ number: fmtPhone(l.phone) || l.phone, amount: parseFloat(l.vivoAmount || 0) })),
      onlyInGOC: inGocOnly.map(l => ({
        number: fmtPhone(l.phone) || l.phone,
        employee: l.employee_name,
        costCenter: l.cost_center_code ? `${l.cost_center_code} — ${l.cost_center_name || ''}` : null,
      })),
      lines: [
        ...inBoth.map(l => ({
          number: fmtPhone(l.phone) || l.phone,
          employee: l.employee_name || '—',
          costCenter: l.cost_center_code
            ? `${l.cost_center_code} — ${l.cost_center_name || ''}`.trim().replace(/—\s*$/, '')
            : null,
          vivoAmount: parseFloat(l.vivoAmount || 0),
          status: l.cost_center_code ? 'matched' : 'no_cc',
        })),
        ...inVivoOnly.map(l => ({
          number: fmtPhone(l.phone) || l.phone,
          employee: '—',
          costCenter: null,
          vivoAmount: parseFloat(l.vivoAmount || 0),
          status: 'only_vivo',
        })),
      ].sort((a, b) => {
        const order = { matched: 0, no_cc: 1, only_vivo: 2 };
        return (order[a.status] || 0) - (order[b.status] || 0);
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/allocations/:id/export - Exporta para Excel
router.get('/:id/export', authenticate, async (req, res) => {
  try {
    const { format = 'xlsx' } = req.query;

    const allocRes = await query(`
      SELECT ma.*, va.account_number, va.company_name, va.reference_month
      FROM monthly_allocations ma
      JOIN vivo_accounts va ON va.id = ma.vivo_account_id
      WHERE ma.id = $1
    `, [req.params.id]);

    if (allocRes.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    const alloc = allocRes.rows[0];

    const itemsRes = await query(`
      SELECT 
        cc.code AS "Centro de Custo",
        cc.name AS "Nome CC",
        ai.direct_line_count AS "Qtd Linhas",
        ai.direct_amount AS "Valor Direto (R$)",
        ai.allocated_amount AS "Valor Rateado (R$)",
        ai.total_amount AS "Total (R$)",
        ROUND((ai.total_amount / NULLIF($1, 0)) * 100, 2) AS "% do Total"
      FROM allocation_items ai
      JOIN cost_centers cc ON cc.id = ai.cost_center_id
      WHERE ai.monthly_allocation_id = $2
      ORDER BY ai.total_amount DESC
    `, [alloc.total_invoice_amount, req.params.id]);

    if (format === 'csv') {
      const csvLines = [Object.keys(itemsRes.rows[0]).join(';')];
      for (const row of itemsRes.rows) {
        csvLines.push(Object.values(row).join(';'));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rateio_${alloc.reference_month}.csv"`);
      return res.send('\ufeff' + csvLines.join('\n')); // BOM para Excel
    }

    // Excel
    const wb = XLSX.utils.book_new();
    
    // Aba resumo
    const summaryData = [
      ['Conta', alloc.account_number],
      ['Empresa', alloc.company_name],
      ['Mês', alloc.reference_month],
      ['Total Fatura', alloc.total_invoice_amount],
      ['Total Rateado', alloc.total_allocated_amount],
      ['Diferença', alloc.difference],
      ['Status', alloc.status],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumo');

    // Aba detalhes por CC
    const wsDetail = XLSX.utils.json_to_sheet(itemsRes.rows);
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Por Centro de Custo');

    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rateio_${alloc.reference_month}.xlsx"`);
    res.send(xlsxBuffer);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

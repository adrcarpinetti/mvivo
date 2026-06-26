/**
 * Serviço de Rateio
 * 
 * Implementa todas as regras de negócio para cálculo e distribuição
 * dos valores da conta Vivo entre os centros de custo.
 */

const { query, withTransaction } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * Processa o rateio de uma conta Vivo para um determinado mês
 * 
 * @param {number} vivoAccountId - ID da conta Vivo
 * @param {object} options - Opções { simulate: bool, userId: uuid }
 */
async function processAllocation(vivoAccountId, options = {}) {
  const { simulate = false, userId } = options;

  logger.info(`Starting allocation for account ${vivoAccountId}, simulate: ${simulate}`);

  return await withTransaction(async (client) => {
    // 1. Carrega a conta Vivo
    const accountRes = await client.query(
      'SELECT * FROM vivo_accounts WHERE id = $1',
      [vivoAccountId]
    );
    if (accountRes.rows.length === 0) {
      throw new Error('Conta Vivo não encontrada');
    }
    const account = accountRes.rows[0];

    // 2. Carrega os itens da fatura agrupados por linha (apenas total mensal por linha)
    const itemsRes = await client.query(`
      SELECT DISTINCT ON (vii.line_number)
        vii.line_number,
        COALESCE(pl.number, vii.line_number) AS phone_number,
        vii.amount AS total_amount
      FROM vivo_invoice_items vii
      LEFT JOIN phone_lines pl ON pl.id = vii.phone_line_id
      WHERE vii.vivo_account_id = $1
        AND vii.item_category = 'monthly_total'
      ORDER BY vii.line_number, vii.amount DESC
    `, [vivoAccountId]);

    // 3. Carrega o mapeamento GOC para o mês da conta
    const gocRes = await client.query(`
      SELECT 
        gii.phone_number,
        gii.cost_center_id,
        gii.cost_center_code,
        gii.cost_center_name,
        cc.id AS cc_id
      FROM goc_import_items gii
      JOIN goc_imports gi ON gi.id = gii.goc_import_id
      LEFT JOIN cost_centers cc ON cc.code = gii.cost_center_code
      WHERE gi.reference_month = $1
        AND gii.is_valid = TRUE
        AND (gii.active IS NULL OR gii.active = TRUE)
      ORDER BY gii.phone_number
    `, [account.reference_month]);

    // Mapa: número da linha -> centro de custo
    const gocMap = new Map();
    for (const row of gocRes.rows) {
      const phone = row.phone_number.replace(/\D/g, '');
      gocMap.set(phone, {
        costCenterId: row.cc_id || row.cost_center_id,
        costCenterCode: row.cost_center_code,
        costCenterName: row.cost_center_name,
      });
    }

    // 4. Classifica os itens
    const allocationData = {
      withCC: [],        // Linhas com CC identificado
      withoutCC: [],     // Linhas sem CC
      unmatched: [],     // Linhas na Vivo mas não no GOC
      totalDirect: 0,
      totalUnallocated: 0,
    };

    for (const item of itemsRes.rows) {
      const phone = (item.line_number || item.phone_number || '').replace(/\D/g, '');
      const gocEntry = gocMap.get(phone);

      if (gocEntry && gocEntry.costCenterId) {
        allocationData.withCC.push({
          phone,
          costCenterId: gocEntry.costCenterId,
          amount: parseFloat(item.total_amount),
        });
        allocationData.totalDirect += parseFloat(item.total_amount);
      } else {
        allocationData.withoutCC.push({
          phone,
          amount: parseFloat(item.total_amount),
        });
        allocationData.totalUnallocated += parseFloat(item.total_amount);
        if (!gocEntry) {
          allocationData.unmatched.push(phone);
        }
      }
    }

    // 5. Carrega centros de custo ativos
    const ccRes = await client.query(
      'SELECT * FROM cost_centers WHERE active = TRUE ORDER BY code'
    );
    const costCenters = ccRes.rows;

    // 6. Aplica regras de rateio para valores sem CC
    const rules = await getActiveRules(client, account.reference_month);
    const ratedUnallocated = await applyAllocationRules(
      allocationData.withoutCC,
      allocationData.withCC,
      costCenters,
      rules,
      allocationData.totalUnallocated
    );

    // 7. Consolida por centro de custo
    // Mapa auxiliar: id -> info do CC
    const ccInfoMap = new Map();
    for (const cc of costCenters) {
      ccInfoMap.set(cc.id, { code: cc.code, name: cc.name });
    }

    const ccTotals = new Map();

    // Garante entrada para cada CC que tem linha direta
    const ensureCC = (id) => {
      if (!ccTotals.has(id)) {
        const info = ccInfoMap.get(id) || {};
        ccTotals.set(id, {
          costCenterId: id,
          costCenterCode: info.code || '',
          costCenterName: info.name || '',
          directAmount: 0,
          directLineCount: 0,
          allocatedAmount: 0,
          allocationRuleId: null,
          allocationPercentage: 0,
        });
      }
      return ccTotals.get(id);
    };

    // Valores diretos
    for (const item of allocationData.withCC) {
      const cc = ensureCC(item.costCenterId);
      cc.directAmount += item.amount;
      cc.directLineCount++;
    }

    // Valores rateados
    for (const rated of ratedUnallocated) {
      const cc = ensureCC(rated.costCenterId);
      cc.allocatedAmount += rated.amount;
      cc.allocationRuleId = rated.ruleId;
      cc.allocationPercentage = rated.percentage;
    }

    const ccBreakdown = Array.from(ccTotals.values())
      .map(cc => ({
        costCenterId: cc.costCenterId,
        costCenterCode: cc.costCenterCode || '',
        costCenterName: cc.costCenterName || '',
        cost_center_code: cc.costCenterCode || '',
        cost_center_name: cc.costCenterName || '',
        directAmount: cc.directAmount || 0,
        allocatedAmount: cc.allocatedAmount || 0,
        totalAmount: (cc.directAmount || 0) + (cc.allocatedAmount || 0),
        lineCount: cc.directLineCount || 0,
      }))
      .filter(cc => cc.totalAmount > 0)  // Remove CCs sem valor
      .sort((a, b) => b.totalAmount - a.totalAmount);

    const totalAllocated = ccBreakdown.reduce((s, c) => s + c.totalAmount, 0);

    const allocationResult = {
      vivoAccountId,
      referenceMonth: account.reference_month,
      totalAmount: parseFloat(account.total_amount) || allocationData.totalDirect + allocationData.totalUnallocated,
      totalInvoiceAmount: parseFloat(account.total_amount) || allocationData.totalDirect + allocationData.totalUnallocated,
      totalAllocated,
      totalAllocatedAmount: totalAllocated,
      difference: (parseFloat(account.total_amount) || 0) - totalAllocated,
      totalUnallocatedAmount: allocationData.totalUnallocated,
      totalLines: itemsRes.rows.length,
      linesWithCC: allocationData.withCC.length,
      linesWithoutCC: allocationData.withoutCC.length,
      linesInVivoNotGoc: allocationData.unmatched.length,
      items: ccBreakdown,
      costCenterBreakdown: ccBreakdown,
      unallocatedLines: allocationData.withoutCC.map(l => ({
        number: l.lineNumber || l.number,
        line_number: l.lineNumber || l.number,
        amount: l.amount || 0,
      })),
      rulesApplied: rules.map(r => ({ id: r.id, name: r.name, type: r.rule_type })),
    };

    if (!simulate) {
      // Salva o rateio no banco
      await saveAllocation(client, allocationResult, userId);
      
      // Registra log de auditoria
      await client.query(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
        VALUES ($1, 'allocation_processed', 'vivo_account', $2, $3)
      `, [userId, vivoAccountId.toString(), `Rateio processado para ${account.reference_month}`]);
    }

    return allocationResult;
  });
}

/**
 * Aplica as regras de rateio para valores sem centro de custo
 */
async function applyAllocationRules(withoutCC, withCC, costCenters, rules, totalUnallocated) {
  if (totalUnallocated === 0 || costCenters.length === 0) return [];

  const results = [];

  // Encontra a regra mais prioritária aplicável
  const applicableRule = rules.find(r => 
    r.active && r.applies_to === 'unallocated'
  );

  if (!applicableRule) {
    // Sem regra: distribui proporcionalmente por linhas
    logger.warn('No allocation rule found, using proportional by line count as default');
    return distributeProportionalByLines(withCC, costCenters, totalUnallocated, null);
  }

  switch (applicableRule.rule_type) {
    case 'proportional_lines':
      return distributeProportionalByLines(withCC, costCenters, totalUnallocated, applicableRule);

    case 'proportional_value':
      return distributeProportionalByValue(withCC, costCenters, totalUnallocated, applicableRule);

    case 'fixed_percentage': {
      const config = applicableRule.config || {};
      const ccPercentages = config.cost_centers || [];
      return distributeByFixedPercentage(ccPercentages, totalUnallocated, applicableRule);
    }

    case 'manual': {
      const config = applicableRule.config || {};
      const ccAmounts = config.cost_centers || [];
      return distributeManually(ccAmounts, applicableRule);
    }

    default:
      return distributeProportionalByLines(withCC, costCenters, totalUnallocated, applicableRule);
  }
}

function distributeProportionalByLines(withCC, costCenters, totalAmount, rule) {
  // Conta linhas por CC
  const lineCountPerCC = new Map();
  for (const item of withCC) {
    const count = lineCountPerCC.get(item.costCenterId) || 0;
    lineCountPerCC.set(item.costCenterId, count + 1);
  }

  const totalLines = withCC.length;
  if (totalLines === 0) {
    // Distribui igualmente se não há linhas com CC
    const perCC = totalAmount / costCenters.length;
    return costCenters.map(cc => ({
      costCenterId: cc.id,
      amount: perCC,
      percentage: 100 / costCenters.length,
      ruleId: rule?.id || null,
      details: { method: 'equal_distribution', lineCount: 0 },
    }));
  }

  return costCenters
    .filter(cc => lineCountPerCC.has(cc.id))
    .map(cc => {
      const lines = lineCountPerCC.get(cc.id) || 0;
      const percentage = (lines / totalLines) * 100;
      return {
        costCenterId: cc.id,
        amount: (lines / totalLines) * totalAmount,
        percentage,
        ruleId: rule?.id || null,
        details: { method: 'proportional_lines', lineCount: lines, totalLines },
      };
    });
}

function distributeProportionalByValue(withCC, costCenters, totalAmount, rule) {
  // Soma valores por CC
  const valuePerCC = new Map();
  let totalDirectValue = 0;
  for (const item of withCC) {
    const cur = valuePerCC.get(item.costCenterId) || 0;
    valuePerCC.set(item.costCenterId, cur + item.amount);
    totalDirectValue += item.amount;
  }

  if (totalDirectValue === 0) {
    return distributeProportionalByLines(withCC, costCenters, totalAmount, rule);
  }

  return costCenters
    .filter(cc => valuePerCC.has(cc.id))
    .map(cc => {
      const value = valuePerCC.get(cc.id) || 0;
      const percentage = (value / totalDirectValue) * 100;
      return {
        costCenterId: cc.id,
        amount: (value / totalDirectValue) * totalAmount,
        percentage,
        ruleId: rule?.id || null,
        details: { method: 'proportional_value', directValue: value },
      };
    });
}

function distributeByFixedPercentage(ccPercentages, totalAmount, rule) {
  return ccPercentages
    .filter(c => c.percentage > 0)
    .map(c => ({
      costCenterId: c.id,
      amount: (c.percentage / 100) * totalAmount,
      percentage: c.percentage,
      ruleId: rule?.id || null,
      details: { method: 'fixed_percentage' },
    }));
}

function distributeManually(ccAmounts, rule) {
  return ccAmounts
    .filter(c => c.amount > 0)
    .map(c => ({
      costCenterId: c.id,
      amount: c.amount,
      percentage: null,
      ruleId: rule?.id || null,
      details: { method: 'manual' },
    }));
}

async function getActiveRules(client, referenceMonth) {
  const res = await client.query(`
    SELECT * FROM allocation_rules
    WHERE active = TRUE
      AND valid_from <= $1
      AND (valid_until IS NULL OR valid_until >= $1)
    ORDER BY priority ASC
  `, [referenceMonth]);
  return res.rows;
}

async function saveAllocation(client, allocationResult, userId) {
  // Upsert da alocação mensal
  const upsertRes = await client.query(`
    INSERT INTO monthly_allocations (
      vivo_account_id, reference_month, status,
      total_invoice_amount, total_allocated_amount, total_unallocated_amount,
      total_lines, lines_with_cc, lines_without_cc, lines_in_vivo_not_goc,
      rules_applied, confirmed_by, confirmed_at
    ) VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    ON CONFLICT (vivo_account_id) DO UPDATE SET
      status = 'confirmed',
      total_invoice_amount = EXCLUDED.total_invoice_amount,
      total_allocated_amount = EXCLUDED.total_allocated_amount,
      total_unallocated_amount = EXCLUDED.total_unallocated_amount,
      total_lines = EXCLUDED.total_lines,
      lines_with_cc = EXCLUDED.lines_with_cc,
      lines_without_cc = EXCLUDED.lines_without_cc,
      lines_in_vivo_not_goc = EXCLUDED.lines_in_vivo_not_goc,
      rules_applied = EXCLUDED.rules_applied,
      confirmed_by = EXCLUDED.confirmed_by,
      confirmed_at = EXCLUDED.confirmed_at,
      updated_at = NOW()
    RETURNING id
  `, [
    allocationResult.vivoAccountId,
    allocationResult.referenceMonth,
    allocationResult.totalInvoiceAmount,
    allocationResult.totalAllocatedAmount,
    allocationResult.totalUnallocatedAmount,
    allocationResult.totalLines,
    allocationResult.linesWithCC,
    allocationResult.linesWithoutCC,
    allocationResult.linesInVivoNotGoc,
    JSON.stringify(allocationResult.rulesApplied),
    userId,
  ]);

  const allocationId = upsertRes.rows[0].id;

  // Apaga itens anteriores e reinsere
  await client.query('DELETE FROM allocation_items WHERE monthly_allocation_id = $1', [allocationId]);

  for (const cc of allocationResult.costCenterBreakdown) {
    if (cc.directAmount > 0 || cc.allocatedAmount > 0) {
      await client.query(`
        INSERT INTO allocation_items (
          monthly_allocation_id, cost_center_id,
          direct_amount, direct_line_count,
          allocated_amount, allocation_rule_id, allocation_percentage,
          details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        allocationId,
        cc.costCenterId,
        cc.directAmount,
        cc.directLineCount,
        cc.allocatedAmount,
        cc.allocationRuleId,
        cc.allocationPercentage,
        JSON.stringify(cc.details),
      ]);
    }
  }

  return allocationId;
}

/**
 * Fecha o rateio de um mês (impede alterações)
 */
async function closeMonthlyAllocation(allocationId, userId, notes) {
  return await withTransaction(async (client) => {
    const res = await client.query(
      'SELECT * FROM monthly_allocations WHERE id = $1',
      [allocationId]
    );
    if (res.rows.length === 0) throw new Error('Rateio não encontrado');

    const allocation = res.rows[0];
    if (allocation.status === 'closed') {
      throw new Error('Rateio já está fechado');
    }

    await client.query(`
      UPDATE monthly_allocations 
      SET status = 'closed', closed_by = $1, closed_at = NOW(), notes = $2, updated_at = NOW()
      WHERE id = $3
    `, [userId, notes, allocationId]);

    // Fecha também a conta Vivo
    await client.query(`
      UPDATE vivo_accounts 
      SET status = 'closed', closed_by = $1, closed_at = NOW()
      WHERE id = $2
    `, [userId, allocation.vivo_account_id]);

    await client.query(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
      VALUES ($1, 'allocation_closed', 'monthly_allocation', $2, $3)
    `, [userId, allocationId.toString(), `Rateio do mês ${allocation.reference_month} fechado`]);

    return { success: true };
  });
}

/**
 * Reabre um rateio fechado (requer permissão especial)
 */
async function reopenMonthlyAllocation(allocationId, userId, reason) {
  return await withTransaction(async (client) => {
    if (!reason || reason.trim().length < 10) {
      throw new Error('Justificativa obrigatória (mínimo 10 caracteres)');
    }

    await client.query(`
      UPDATE monthly_allocations 
      SET status = 'confirmed', notes = $1, updated_at = NOW()
      WHERE id = $2 AND status = 'closed'
    `, [`[REABERTURA] ${reason}`, allocationId]);

    await client.query(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, new_values)
      VALUES ($1, 'allocation_reopened', 'monthly_allocation', $2, $3, $4)
    `, [userId, allocationId.toString(), 
        'Rateio reaberto', 
        JSON.stringify({ reason })]);

    return { success: true };
  });
}

module.exports = {
  processAllocation,
  closeMonthlyAllocation,
  reopenMonthlyAllocation,
};

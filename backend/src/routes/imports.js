const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const { authenticate, requirePermission } = require('../middleware/auth');
const { parseVivoFile, extractAccountFromFileName } = require('../parsers/vivoParser');
const { parseGocFile } = require('../parsers/gocParser');
const { query, withTransaction } = require('../utils/db');
const logger = require('../utils/logger');

const router = express.Router();

// Configuração do multer (memória)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.zip', '.txt', '.csv', '.ZIP', '.TXT', '.CSV'];
    const ext = '.' + file.originalname.split('.').pop();
    if (allowed.includes(ext.toUpperCase())) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido'));
  }
});

// ============================================================
// IMPORTAR ARQUIVO VIVO (ZIP contendo TXT)
// ============================================================
router.post('/vivo', authenticate, requirePermission('import'), 
  upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Arquivo não enviado' });

    const { referenceMonth } = req.body;
    if (!referenceMonth) return res.status(400).json({ error: 'Mês de referência obrigatório (YYYY-MM)' });

    const refDate = `${referenceMonth}-01`;

    // Cria log de importação
    const logRes = await query(`
      INSERT INTO import_logs (import_type, file_name, file_size, reference_month, status, imported_by, started_at)
      VALUES ('vivo', $1, $2, $3, 'processing', $4, NOW())
      RETURNING id
    `, [file.originalname, file.size, refDate, req.user.id]);
    const logId = logRes.rows[0].id;

    // Extrai o TXT do ZIP
    let txtBuffer;
    if (file.originalname.toUpperCase().endsWith('.ZIP')) {
      const directory = await unzipper.Open.buffer(file.buffer);
      const txtFile = directory.files.find(f => f.path.toUpperCase().endsWith('.TXT'));
      if (!txtFile) {
        await failImport(logId, 'Arquivo TXT não encontrado dentro do ZIP');
        return res.status(400).json({ error: 'Arquivo TXT não encontrado no ZIP' });
      }
      txtBuffer = await txtFile.buffer();
    } else {
      txtBuffer = file.buffer;
    }

    // Parseia o arquivo
    const parsed = await parseVivoFile(txtBuffer, file.originalname);

    if (!parsed.accountNumber) {
      await failImport(logId, 'Número da conta não identificado no arquivo');
      return res.status(400).json({ 
        error: 'Não foi possível identificar o número da conta no arquivo',
        warnings: parsed.warnings,
      });
    }

    // Persiste no banco dentro de uma transação
    const result = await withTransaction(async (client) => {
      // Cria ou atualiza a conta Vivo
      const accountRes = await client.query(`
        INSERT INTO vivo_accounts (
          account_number, reference_month, company_name,
          total_amount, status, file_name, file_size, import_log_id
        ) VALUES ($1, $2, $3, $4, 'imported', $5, $6, $7)
        ON CONFLICT (account_number, reference_month) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          total_amount = EXCLUDED.total_amount,
          file_name = EXCLUDED.file_name,
          file_size = EXCLUDED.file_size,
          import_log_id = EXCLUDED.import_log_id,
          status = 'imported',
          updated_at = NOW()
        RETURNING id
      `, [
        parsed.accountNumber,
        parsed.referenceMonth || refDate,
        parsed.companyName,
        parsed.totalAmount,
        file.originalname,
        file.size,
        logId,
      ]);

      const accountId = accountRes.rows[0].id;

      // Apaga itens anteriores (reimportação)
      await client.query('DELETE FROM vivo_invoice_items WHERE vivo_account_id = $1', [accountId]);

      // Insere linhas telefônicas e itens
      let processedCount = 0;
      for (const line of parsed.lines) {
        // Upsert da linha telefônica
        const lineRes = await client.query(`
          INSERT INTO phone_lines (number, active, first_seen_date, last_seen_date)
          VALUES ($1, TRUE, $2, $2)
          ON CONFLICT (number) DO UPDATE SET
            last_seen_date = EXCLUDED.last_seen_date,
            active = TRUE
          RETURNING id
        `, [line.number, refDate]);

        const phoneLineId = lineRes.rows[0].id;

        // Insere item de cobrança mensal
        await client.query(`
          INSERT INTO vivo_invoice_items (
            vivo_account_id, phone_line_id, account_number, line_number,
            item_category, description, amount, raw_data
          ) VALUES ($1, $2, $3, $4, 'monthly_fee', 'Cobrança mensal', $5, $6)
        `, [
          accountId, phoneLineId, parsed.accountNumber,
          line.number, line.totalAmount,
          JSON.stringify({ services: line.services, planName: line.planName }),
        ]);

        processedCount++;
      }

      // Insere itens detalhados (inclusive extra_charge sem linha)
      for (const raw of parsed.rawItems) {
        if (raw.amount && raw.amount !== 0) {
          let phoneLineId = null;
          if (raw.lineNumber) {
            const lineRes = await client.query(
              'SELECT id FROM phone_lines WHERE number = $1', [raw.lineNumber]
            );
            phoneLineId = lineRes.rows[0]?.id || null;
          }

          await client.query(`
            INSERT INTO vivo_invoice_items (
              vivo_account_id, phone_line_id, account_number, line_number,
              subscription_code, segment_code, item_category, description, amount, raw_data
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            accountId, phoneLineId, parsed.accountNumber, raw.lineNumber || null,
            raw.subscriptionCode, raw.segmentCode, raw.category,
            raw.description, raw.amount, JSON.stringify(raw),
          ]);
        }
      }

      // Atualiza log
      await client.query(`
        UPDATE import_logs SET
          status = 'completed',
          total_records = $1,
          processed_records = $2,
          warnings = $3,
          completed_at = NOW(),
          related_id = $4
        WHERE id = $5
      `, [
        parsed.lines.length,
        processedCount,
        JSON.stringify(parsed.warnings),
        accountId,
        logId,
      ]);

      return {
        accountId,
        accountNumber: parsed.accountNumber,
        referenceMonth: parsed.referenceMonth || refDate,
        linesImported: processedCount,
        totalAmount: parsed.totalAmount,
        warnings: parsed.warnings,
        errors: parsed.errors,
      };
    });

    res.json({
      message: `Arquivo importado com sucesso. ${result.linesImported} linhas processadas.`,
      ...result,
    });

  } catch (err) {
    logger.error('Error importing Vivo file', { error: err.message });
    res.status(500).json({ error: err.message || 'Erro ao importar arquivo' });
  }
});

// ============================================================
// IMPORTAR ARQUIVO GOC (CSV)
// ============================================================
router.post('/goc', authenticate, requirePermission('import'),
  upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Arquivo não enviado' });

    const { referenceMonth } = req.body;
    if (!referenceMonth) return res.status(400).json({ error: 'Mês de referência obrigatório' });

    const refDate = `${referenceMonth}-01`;

    const logRes = await query(`
      INSERT INTO import_logs (import_type, file_name, file_size, reference_month, status, imported_by, started_at)
      VALUES ('goc', $1, $2, $3, 'processing', $4, NOW())
      RETURNING id
    `, [file.originalname, file.size, refDate, req.user.id]);
    const logId = logRes.rows[0].id;

    const parsed = await parseGocFile(file.buffer, file.originalname);

    if (parsed.errors.length > 0 && parsed.items.length === 0) {
      await failImport(logId, parsed.errors[0].message);
      return res.status(400).json({ errors: parsed.errors });
    }

    const result = await withTransaction(async (client) => {
      // Cria importação GOC
      const importRes = await client.query(`
        INSERT INTO goc_imports (
          reference_month, file_name, file_size,
          total_lines, valid_lines, invalid_lines,
          status, imported_by
        ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)
        RETURNING id
      `, [
        refDate, file.originalname, file.size,
        parsed.totalLines, parsed.validLines, parsed.invalidLines,
        req.user.id,
      ]);
      const gocImportId = importRes.rows[0].id;

      // Apaga itens anteriores da mesma conta/mês
      const accountNumbers = [...new Set(parsed.items.map(i => i.accountNumber).filter(Boolean))];
      if (accountNumbers.length > 0) {
        await client.query(`
          DELETE FROM goc_import_items 
          WHERE goc_import_id IN (
            SELECT id FROM goc_imports 
            WHERE reference_month = $1 AND id != $2
          )
        `, [refDate, gocImportId]);
      }

      // Insere itens
      for (const item of parsed.items) {
        // Resolve ou cria CC
        let costCenterId = null;
        if (item.costCenterCode) {
          const ccRes = await client.query(`
            INSERT INTO cost_centers (code, name, active)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
          `, [item.costCenterCode, item.costCenterName || item.costCenterCode]);
          costCenterId = ccRes.rows[0].id;
        }

        // Resolve ou cria linha
        let phoneLineId = null;
        if (item.phoneNumber) {
          const lineRes = await client.query(`
            INSERT INTO phone_lines (number, active, first_seen_date)
            VALUES ($1, $2, $3)
            ON CONFLICT (number) DO UPDATE SET active = EXCLUDED.active
            RETURNING id
          `, [item.phoneNumber, item.isActive !== false, refDate]);
          phoneLineId = lineRes.rows[0].id;
        }

        await client.query(`
          INSERT INTO goc_import_items (
            goc_import_id, phone_line_id, cost_center_id,
            phone_number, cost_center_code, cost_center_name,
            employee_name, employee_id, cpf, active,
            delivery_date, return_date, plan_type, line_type,
            reference_value, activation_date, contract_end_date,
            account_number, cnpj, active_services,
            raw_data, is_valid, validation_errors
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        `, [
          gocImportId, phoneLineId, costCenterId,
          item.phoneNumber, item.costCenterCode, item.costCenterName,
          item.employeeName, item.employeeId, item.cpf, item.isActive,
          item.deliveryDate, item.returnDate, item.planType, item.lineType,
          item.referenceValue, item.activationDate, item.contractEndDate,
          item.accountNumber, item.cnpj, item.activeServices,
          JSON.stringify(item.rawData), item.isValid,
          JSON.stringify(item.validationErrors),
        ]);
      }

      await client.query(`
        UPDATE import_logs SET
          status = 'completed', total_records = $1,
          processed_records = $2, error_records = $3,
          warnings = $4, completed_at = NOW(), related_id = $5
        WHERE id = $6
      `, [parsed.totalLines, parsed.validLines, parsed.invalidLines,
          JSON.stringify(parsed.warnings), gocImportId, logId]);

      return {
        gocImportId,
        referenceMonth: refDate,
        totalLines: parsed.totalLines,
        validLines: parsed.validLines,
        invalidLines: parsed.invalidLines,
        warnings: parsed.warnings,
      };
    });

    res.json({
      message: `GOC importado com sucesso. ${result.validLines} linhas válidas.`,
      ...result,
    });

  } catch (err) {
    logger.error('Error importing GOC file', { error: err.message });
    res.status(500).json({ error: err.message || 'Erro ao importar arquivo GOC' });
  }
});

// GET /api/imports/history
router.get('/history', authenticate, async (req, res) => {
  try {
    const { type, month, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (type) {
      params.push(type);
      where += ` AND import_type = $${params.length}`;
    }
    if (month) {
      params.push(`${month}-01`);
      where += ` AND reference_month = $${params.length}`;
    }

    params.push(limit, offset);
    const res2 = await query(`
      SELECT il.*, u.name as imported_by_name
      FROM import_logs il
      LEFT JOIN users u ON u.id = il.imported_by
      ${where}
      ORDER BY il.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ imports: res2.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function failImport(logId, message) {
  await query(`
    UPDATE import_logs SET status = 'failed', errors = $1, completed_at = NOW()
    WHERE id = $2
  `, [JSON.stringify([{ message }]), logId]);
}

module.exports = router;

/**
 * Parser para arquivos de fatura da Vivo (formato TXT posicional)
 *
 * Estrutura posicional identificada nos arquivos reais:
 *   Col   0-13:  Número da conta (14 chars)
 *   Col  14-28:  Código de assinatura / sub-conta (15 chars)
 *   Col  29-43:  Número da linha telefônica (15 chars)
 *   Col  44-58:  Campo docType / nivel (15 chars)
 *   Col  59-74:  Campo sequencial (15 chars)
 *   Col  75-89:  Número da página / código (15 chars)
 *   Col  90-104: Espaço (15 chars)
 *   Col 105-119: Código do segmento (15 chars) ← posição real confirmada
 *   Col 120-164: Descrição / conteúdo (45 chars)
 *   Col 165-194: Valor monetário principal (30 chars)
 *   Col 195+:    Valores adicionais
 *
 * Segmentos relevantes:
 *   059A  → total geral da conta
 *   215D  → total por linha telefônica
 *   224Z  → nome do plano
 *   110D  → lista de linhas (header de linha)
 *   110A  → header do contrato
 */

const iconv = require('iconv-lite');
const logger = require('../utils/logger');

const SEG_ACCOUNT_TOTAL  = '059A';
const SEG_LINE_TOTAL     = '215D';
const SEG_PLAN_NAME      = '224Z';
const SEG_LINE_LIST      = '110D';
const SEG_CONTRACT_HDR   = '110A';

/**
 * Parseia um Buffer de arquivo TXT/ZIP já descompactado da Vivo.
 * @param {Buffer} fileBuffer
 * @param {string} fileName  - nome do arquivo original (ex: VIVO_0454705224_0626.TXT)
 * @returns {object}
 */
async function parseVivoFile(fileBuffer, fileName) {
  const result = {
    accountNumber: null,
    companyName: null,
    referenceMonth: null,   // 'YYYY-MM-01'
    totalAmount: 0,
    lines: [],              // [{ number, subscriptionCode, totalAmount, planName }]
    rawItems: [],           // itens detalhados para invoice_items
    errors: [],
    warnings: [],
  };

  try {
    const content = iconv.decode(fileBuffer, 'latin1');
    const rows    = content.split(/\r?\n/);

    logger.info(`Parsing Vivo file: ${fileName}, ${rows.length} rows`);

    // Mês de referência pelo nome do arquivo  ex: _0626. → 06/2026
    const mMatch = fileName.match(/_(\d{2})(\d{2})\.(ZIP|TXT)/i);
    if (mMatch) {
      const mm   = String(mMatch[1]).padStart(2, '0');
      const yyyy = 2000 + parseInt(mMatch[2]);
      result.referenceMonth = `${yyyy}-${mm}-01`;
    }

    const lineMap = new Map(); // telefone → dados acumulados

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < 110) continue;

      try {
        const account  = row.substring(0, 14).trim();
        const subscr   = row.substring(14, 29).trim();
        const phone    = row.substring(29, 44).trim();
        const segment  = row.substring(105, 120).trim();
        const desc     = row.substring(120, 165).trim();
        const valStr   = row.substring(165, 195).trim();
        const descStr  = row.length > 165 ? row.substring(120, 165).trim() : '';

        if (!result.accountNumber && account && /^\d{5,}$/.test(account)) {
          result.accountNumber = account;
        }

        // ── total geral da conta ──────────────────────────────────────
        if (segment === SEG_ACCOUNT_TOTAL) {
          const v = parseMonetary(valStr);
          if (v !== null) result.totalAmount = v;
        }

        // ── total por linha ───────────────────────────────────────────
        if (segment === SEG_LINE_TOTAL && isPhone(phone)) {
          const v = parseMonetary(valStr);
          if (v !== null) {
            ensureLine(lineMap, phone, subscr);
            lineMap.get(phone).totalAmount = v;

            result.rawItems.push({
              lineNumber: phone,
              subscriptionCode: subscr || null,
              segmentCode: segment,
              category: 'monthly_total',
              description: 'Total da linha',
              amount: v,
            });
          }
        }

        // ── cobranças extras (não por linha): apenas 190T ────────────
        // 190T = total de cobranças extras da conta
        // 195A = valor líquido (mesmo número, ignorar para não duplicar)
        if (segment === '190T' && !isPhone(phone)) {
          // 190T: valor está em posição 180-195 (não 165-195)
          let v = parseMonetary(valStr); // 165-195
          if (v === null || v === 0) {
            const altVal = row.length > 195 ? row.substring(180, 210).trim() : '';
            v = parseMonetary(altVal);
          }
          if (v !== null && v > 0) {
            logger.info('Extra charge captured: seg=' + segment + ' val=' + v);
            result.rawItems.push({
              lineNumber: null, subscriptionCode: null,
              segmentCode: segment, category: 'extra_charge',
              description: 'Cobrança extra (não por linha)', amount: v,
            });
          }
        }

        // ── 225D = detalhe de serviço contratado (NÃO é parcela de aparelho)
        // O 215D já inclui esses valores — não capturar para evitar duplicação
        // Parcelas reais de aparelho aparecem como 190D com valor alto

        // ── consumo (510T = total de consumo por linha) ───────────────
        // 510T = totalizador, 510D = detalhe individual — só capturar 510T
        // e apenas se a linha ainda não tem consumo registrado (evitar duplicatas)
        if (segment.startsWith('510T') && !segment.startsWith('510D') && isPhone(phone)) {
          const v = parseMonetary(valStr);
          if (v !== null && v > 0 && v < 5000) {
            ensureLine(lineMap, phone, subscr);
            const entry = lineMap.get(phone);
            // Só adiciona se ainda não tem consumo para esta linha
            if (!entry._hasConsumption) {
              entry._hasConsumption = true;
              result.rawItems.push({
                lineNumber: phone, subscriptionCode: subscr || null,
                segmentCode: segment, category: 'consumption',
                description: 'Consumo (chamadas/dados/SMS)', amount: v,
              });
            }
          }
        }

        // 162D/164A/162T: desativados permanentemente
        // Estrutura posicional variável causa leitura de valores incorretos

        // ── nome do plano ─────────────────────────────────────────────
        if (segment === SEG_PLAN_NAME && isPhone(phone) && desc) {
          ensureLine(lineMap, phone, subscr);
          const entry = lineMap.get(phone);
          if (!entry.planName) entry.planName = desc;
        }

        // ── header de linha (garante a linha no mapa) ─────────────────
        if (segment === SEG_LINE_LIST && isPhone(phone)) {
          ensureLine(lineMap, phone, subscr);
        }

      } catch (rowErr) {
        result.warnings.push({ line: i + 1, message: rowErr.message });
      }
    }

    result.lines = Array.from(lineMap.values());

    // Se 059A não encontrado, usa soma das linhas
    if (result.totalAmount === 0 && result.lines.length > 0) {
      result.totalAmount = result.lines.reduce((s, l) => s + l.totalAmount, 0);
      result.warnings.push({ message: 'Total da conta (059A) não encontrado — usando soma das linhas.' });
    }

    logger.info(`Vivo parsed OK: ${result.lines.length} linhas, R$ ${result.totalAmount.toFixed(2)}`);

  } catch (err) {
    logger.error('Erro ao parsear arquivo Vivo', { error: err.message });
    result.errors.push({ message: err.message });
    throw err;
  }

  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureLine(map, phone, subscr) {
  if (!map.has(phone)) {
    map.set(phone, {
      number: phone,
      subscriptionCode: subscr || null,
      totalAmount: 0,
      planName: null,
    });
  }
}

function isPhone(str) {
  if (!str) return false;
  const d = str.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 && /^\d+$/.test(d);
}

function parseMonetary(str) {
  if (!str) return null;
  // Suporta "47.86", "1.234,56", "1234.56"
  const clean = str.replace(/[^\d.,\-]/g, '').trim();
  if (!clean) return null;
  // se tem vírgula como decimal (pt-BR)
  let normalized = clean;
  if (/,\d{2}$/.test(clean)) {
    normalized = clean.replace('.', '').replace(',', '.');
  }
  const v = parseFloat(normalized);
  return isNaN(v) ? null : v;
}

function extractAccountFromFileName(fileName) {
  const m = fileName.match(/VIVO_(\d+)_/);
  return m ? m[1] : null;
}

module.exports = { parseVivoFile, extractAccountFromFileName };

/**
 * Parser para arquivos GOC (CSV com separador ";")
 * 
 * Colunas do arquivo GOC:
 * LINHA, LINHA_ATIVA, EMPRESA, COD_CENTRO_CUSTO, CENTRO_CUSTO,
 * FUNCIONARIO, MATRICULA, CPF, SITUACAO_CPF_RM, DATA_ENTREGA,
 * DATA_DEVOLUCAO, OBSERVACOES, POSSUI_ANEXO, FABRICANTE, MODELO,
 * IMEI, COR, NOTA_FISCAL, DATA_COMPRA, CHIP, TIPO_PLANO,
 * TIPO_LINHA, VALOR_REFERENCIA, DATA_ATIVACAO, DATA_TERMINO_CONTRATO,
 * NUMERO_CONTA, CNPJ, SERVICOS_ATIVOS
 */

const iconv = require('iconv-lite');
const logger = require('../utils/logger');

const REQUIRED_COLUMNS = ['LINHA', 'COD_CENTRO_CUSTO', 'CENTRO_CUSTO', 'NUMERO_CONTA'];

/**
 * Parseia um arquivo GOC (CSV separado por ponto-e-vírgula)
 */
async function parseGocFile(fileBuffer, fileName) {
  const result = {
    items: [],
    errors: [],
    warnings: [],
    totalLines: 0,
    validLines: 0,
    invalidLines: 0,
  };

  try {
    // Tenta detectar encoding (Vivo/GOC geralmente usa latin-1)
    let content;
    try {
      content = iconv.decode(fileBuffer, 'latin1');
    } catch {
      content = fileBuffer.toString('utf-8');
    }

    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

    if (lines.length === 0) {
      result.errors.push({ message: 'Arquivo vazio' });
      return result;
    }

    // Lê o cabeçalho
    const headerLine = lines[0];
    const headers = headerLine.split(';').map(h => h.trim().toUpperCase().replace(/['"]/g, ''));

    // Valida colunas obrigatórias
    const missingCols = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
    if (missingCols.length > 0) {
      result.errors.push({
        message: `Colunas obrigatórias não encontradas: ${missingCols.join(', ')}`,
        line: 1,
      });
      return result;
    }

    result.totalLines = lines.length - 1;

    // Índices das colunas
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    // Processa cada linha
    for (let i = 1; i < lines.length; i++) {
      const lineStr = lines[i].trim();
      if (!lineStr) continue;

      try {
        const cols = splitCsvLine(lineStr, ';');
        const item = parseGocLine(cols, idx, i + 1);

        if (item.isValid) {
          result.items.push(item);
          result.validLines++;
        } else {
          result.invalidLines++;
          result.warnings.push({
            line: i + 1,
            phoneNumber: item.phoneNumber,
            errors: item.validationErrors,
          });
          // Inclui mesmo com erros de validação leve
          if (item.phoneNumber && item.costCenterCode) {
            result.items.push(item);
          }
        }
      } catch (lineError) {
        result.invalidLines++;
        result.errors.push({
          line: i + 1,
          message: lineError.message,
        });
      }
    }

    logger.info(`GOC file parsed: ${result.validLines} valid, ${result.invalidLines} invalid lines`);

  } catch (err) {
    logger.error('Error parsing GOC file', { error: err.message });
    result.errors.push({ message: err.message });
    throw err;
  }

  return result;
}

/**
 * Parseia uma linha do CSV do GOC
 */
function parseGocLine(cols, idx, lineNumber) {
  const get = (col) => {
    const i = idx[col];
    return i !== undefined && cols[i] !== undefined ? cols[i].trim() : null;
  };

  const validationErrors = [];

  const rawPhone = get('LINHA');
  const phoneNumber = cleanPhone(rawPhone);

  if (!phoneNumber) {
    validationErrors.push('Número de linha inválido ou ausente');
  }

  const costCenterCode = get('COD_CENTRO_CUSTO');
  if (!costCenterCode) {
    validationErrors.push('Centro de custo não informado');
  }

  const accountNumber = cleanAccountNumber(get('NUMERO_CONTA'));

  const item = {
    lineNumber,
    phoneNumber,
    isActive: normalizeBoolean(get('LINHA_ATIVA')),
    company: get('EMPRESA'),
    costCenterCode,
    costCenterName: get('CENTRO_CUSTO'),
    employeeName: get('FUNCIONARIO'),
    employeeId: get('MATRICULA'),
    cpf: cleanCpf(get('CPF')),
    cpfStatus: get('SITUACAO_CPF_RM'),
    deliveryDate: parseDate(get('DATA_ENTREGA')),
    returnDate: parseDate(get('DATA_DEVOLUCAO')),
    observations: get('OBSERVACOES'),
    manufacturer: get('FABRICANTE'),
    model: get('MODELO'),
    imei: get('IMEI'),
    color: get('COR'),
    planType: get('TIPO_PLANO'),
    lineType: get('TIPO_LINHA'),
    referenceValue: parseMonetary(get('VALOR_REFERENCIA')),
    activationDate: parseDate(get('DATA_ATIVACAO')),
    contractEndDate: parseDate(get('DATA_TERMINO_CONTRATO')),
    accountNumber,
    cnpj: get('CNPJ'),
    activeServices: get('SERVICOS_ATIVOS'),
    rawData: Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, cols[i] || null])),
    isValid: validationErrors.length === 0,
    validationErrors,
  };

  return item;
}

// Helpers
function splitCsvLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function cleanPhone(str) {
  if (!str) return null;
  const cleaned = str.replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 13) return null;
  return cleaned;
}

function cleanCpf(str) {
  if (!str) return null;
  return str.replace(/\D/g, '').padStart(11, '0');
}

function cleanAccountNumber(str) {
  if (!str) return null;
  return str.replace(/\D/g, '');
}

function normalizeBoolean(str) {
  if (!str) return null;
  return ['S', 'SIM', 'YES', 'TRUE', '1'].includes(str.toUpperCase());
}

function parseDate(str) {
  if (!str || str.trim() === '') return null;
  // Formato DD/MM/YYYY
  const match = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return null;
}

function parseMonetary(str) {
  if (!str) return null;
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

module.exports = { parseGocFile };

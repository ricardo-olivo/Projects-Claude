// ============================================================
// CONFIGURAÇÃO - Adicione os IDs das 28 planilhas de filiais
// ============================================================
const BRANCHES = {
  'Filial 01': '10YBsWrKGOPWTn_Zcph2K1bJZmsI68cEbPxwNizVIdKg',
  'Filial 02': '1qMt8Iwe1Iotjr1fBtlhxF-q4KptkoPEN1q9urOX4Sqg',
  // Adicione as demais filiais no formato:
  // 'Nome da Filial': 'ID_DA_PLANILHA',
  // O ID está na URL da planilha:
  // https://docs.google.com/spreadsheets/d/[ID_AQUI]/edit
};

// Planilha de funcionários sem registro (pagamento de férias)
const PAYMENT_SHEET_ID = '1tJ7O2gy3v-NTvyDln0QBdcjqs2AUUBuXzt622nxN1Sk';

// Colunas da planilha de pagamento (baseado em zero)
const PAY_COL = {
  NOME:        0,
  FILIAL:      1,
  MES_VENC:    2,
  PAGAR_30:    3,
};

// Índice das colunas na planilha (baseado em zero)
const COL = {
  NOME: 0,
  INICIO: 1,
  FIM: 2,
  RETORNO: 3,
  TOTAL: 4,
};

// ============================================================
// PONTO DE ENTRADA DA WEB APP
// ============================================================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Dashboard de Férias - RH')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================
// LEITURA E CONSOLIDAÇÃO DOS DADOS
// ============================================================
function getVacationData() {
  const allData = [];
  const errors = [];

  for (const [branchName, sheetId] of Object.entries(BRANCHES)) {
    try {
      const spreadsheet = SpreadsheetApp.openById(sheetId);
      const sheet = spreadsheet.getSheets()[0];
      const lastRow = sheet.getLastRow();

      if (lastRow <= 1) continue;

      const range = sheet.getRange(2, 1, lastRow - 1, 5);
      const rows = range.getValues();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = row[COL.NOME];
        if (!name || String(name).trim() === '') continue;

        const startRaw  = row[COL.INICIO];
        const endRaw    = row[COL.FIM];
        const retRaw    = row[COL.RETORNO];
        const totalRaw  = row[COL.TOTAL];

        const startDate = toDate(startRaw);
        const endDate   = toDate(endRaw);

        // Auto-fill Retorno and Total when empty but dates are present
        if (startDate && endDate) {
          const sheetRow = i + 2; // 1-based, skipping header

          if (!retRaw || retRaw === '') {
            const returnDate = new Date(endDate);
            returnDate.setDate(returnDate.getDate() + 1);
            const retCell = sheet.getRange(sheetRow, COL.RETORNO + 1);
            retCell.setValue(returnDate);
            retCell.setNumberFormat('dd/mm/yyyy');
            row[COL.RETORNO] = returnDate;
          }

          if (!totalRaw || totalRaw === '') {
            const totalDays = Math.round((endDate - startDate) / 864e5) + 1;
            sheet.getRange(sheetRow, COL.TOTAL + 1).setValue(totalDays);
            row[COL.TOTAL] = totalDays;
          }
        }

        allData.push({
          branch: branchName,
          name: String(name).trim(),
          startDate: formatDate(startRaw),
          endDate: formatDate(endRaw),
          returnDate: formatDate(row[COL.RETORNO]),
          total: row[COL.TOTAL] || '',
          rowIndex: i + 2, // sheet row number (1-based, skips header)
        });
      }
    } catch (e) {
      errors.push({ branch: branchName, error: e.message });
    }
  }

  const conflicts = detectConflicts(allData);
  const paymentData = getPaymentData();

  return JSON.stringify({
    data: allData,
    conflicts: conflicts,
    errors: errors,
    paymentDue: paymentData.due,
    paymentAll: paymentData.all,
    paymentErrors: paymentData.errors,
  });
}

// ============================================================
// FUNCIONÁRIOS SEM REGISTRO — PAGAMENTO DE FÉRIAS
// ============================================================
function getPaymentData() {
  const MONTHS_PT = {
    'janeiro': 1, 'fevereiro': 2, 'março': 3, 'abril': 4,
    'maio': 5, 'junho': 6, 'julho': 7, 'agosto': 8,
    'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12,
  };

  const currentMonth = new Date().getMonth() + 1;
  const all = [];
  const due = [];
  const errors = [];

  try {
    const sheet = SpreadsheetApp.openById(PAYMENT_SHEET_ID).getSheets()[0];
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { all, due, errors };

    const rows = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

    for (const row of rows) {
      const name = row[PAY_COL.NOME];
      if (!name || String(name).trim() === '') continue;

      const monthStr = String(row[PAY_COL.MES_VENC] || '').toLowerCase().trim();
      const monthNum = MONTHS_PT[monthStr] || null;
      const pay30    = String(row[PAY_COL.PAGAR_30] || '').trim().toLowerCase();

      const record = {
        name:     String(name).trim(),
        branch:   String(row[PAY_COL.FILIAL] || '').trim(),
        month:    String(row[PAY_COL.MES_VENC] || '').trim(),
        monthNum: monthNum,
        pay30:    pay30 === 'sim',
        isDue:    monthNum === currentMonth,
      };

      all.push(record);
      if (record.isDue) due.push(record);
    }
  } catch (e) {
    errors.push(e.message);
  }

  return { all, due, errors };
}

// ============================================================
// INCLUSÃO DE NOVO REGISTRO — chamado pelo dashboard
// ============================================================
function addVacationRecord(payload) {
  // payload = { branch, name, startDate, endDate }
  try {
    const sheetId = BRANCHES[payload.branch];
    if (!sheetId) return JSON.stringify({ success: false, error: 'Filial não encontrada: ' + payload.branch });

    const startDate = toDate(payload.startDate);
    const endDate   = toDate(payload.endDate);

    if (!payload.name || String(payload.name).trim() === '')
      return JSON.stringify({ success: false, error: 'Nome do funcionário é obrigatório.' });
    if (!startDate)
      return JSON.stringify({ success: false, error: 'Data de início inválida.' });
    if (!endDate)
      return JSON.stringify({ success: false, error: 'Data de fim inválida.' });
    if (endDate < startDate)
      return JSON.stringify({ success: false, error: 'Data de fim anterior ao início.' });

    const returnDate = new Date(endDate);
    returnDate.setDate(returnDate.getDate() + 1);
    const totalDays = Math.round((endDate - startDate) / 864e5) + 1;

    const sheet    = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const newRow   = sheet.getLastRow() + 1;
    const rowRange = sheet.getRange(newRow, 1, 1, 5);

    rowRange.setValues([[
      String(payload.name).trim(),
      startDate,
      endDate,
      returnDate,
      totalDays,
    ]]);

    // Format date columns
    sheet.getRange(newRow, COL.INICIO   + 1).setNumberFormat('dd/mm/yyyy');
    sheet.getRange(newRow, COL.FIM      + 1).setNumberFormat('dd/mm/yyyy');
    sheet.getRange(newRow, COL.RETORNO  + 1).setNumberFormat('dd/mm/yyyy');

    return JSON.stringify({
      success:    true,
      rowIndex:   newRow,
      returnDate: formatDate(returnDate),
      total:      totalDays,
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// ============================================================
// ATUALIZAÇÃO DE REGISTRO — chamado pelo dashboard
// ============================================================
function updateVacationRecord(payload) {
  // payload = { branch, rowIndex, startDate, endDate }
  try {
    const sheetId = BRANCHES[payload.branch];
    if (!sheetId) return JSON.stringify({ success: false, error: 'Filial não encontrada: ' + payload.branch });

    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const row   = payload.rowIndex;

    const startDate = toDate(payload.startDate);
    const endDate   = toDate(payload.endDate);

    if (!startDate) return JSON.stringify({ success: false, error: 'Data de início inválida.' });
    if (!endDate)   return JSON.stringify({ success: false, error: 'Data de fim inválida.' });
    if (endDate < startDate) return JSON.stringify({ success: false, error: 'Data de fim anterior ao início.' });

    const setDateCell = (col, date) => {
      const cell = sheet.getRange(row, col + 1);
      cell.setValue(date);
      cell.setNumberFormat('dd/mm/yyyy');
    };

    setDateCell(COL.INICIO, startDate);
    setDateCell(COL.FIM, endDate);

    const returnDate = new Date(endDate);
    returnDate.setDate(returnDate.getDate() + 1);
    const totalDays = Math.round((endDate - startDate) / 864e5) + 1;

    setDateCell(COL.RETORNO, returnDate);
    sheet.getRange(row, COL.TOTAL + 1).setValue(totalDays);

    return JSON.stringify({
      success: true,
      returnDate: formatDate(returnDate),
      total: totalDays,
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// ============================================================
// DETECÇÃO DE CONFLITOS
// ============================================================
function detectConflicts(data) {
  const conflicts = [];
  const byBranch = {};

  for (const record of data) {
    if (!record.startDate || !record.endDate) continue;
    if (!byBranch[record.branch]) byBranch[record.branch] = [];
    byBranch[record.branch].push(record);
  }

  for (const [branch, records] of Object.entries(byBranch)) {
    for (let i = 0; i < records.length; i++) {
      const overlapping = [];
      const startA = new Date(records[i].startDate);
      const endA = new Date(records[i].endDate);

      for (let j = 0; j < records.length; j++) {
        if (i === j) continue;
        const startB = new Date(records[j].startDate);
        const endB = new Date(records[j].endDate);

        if (startA <= endB && endA >= startB) {
          overlapping.push(records[j].name);
        }
      }

      if (overlapping.length >= 2) {
        const key = [branch, records[i].startDate, ...overlapping.sort()].join('|');
        if (!conflicts.find(c => c.key === key)) {
          conflicts.push({
            key: key,
            branch: branch,
            period: `${formatDateBR(records[i].startDate)} a ${formatDateBR(records[i].endDate)}`,
            employees: [records[i].name, ...overlapping],
            count: overlapping.length + 1,
          });
        }
      }
    }
  }

  return conflicts;
}

// ============================================================
// UTILITÁRIOS
// ============================================================
// Returns a Date object or null; handles Date, ISO string, and BR format (dd/mm/yyyy)
function toDate(value) {
  if (!value || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  // dd/mm/yyyy
  const brMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (brMatch) return new Date(+brMatch[3], +brMatch[2] - 1, +brMatch[1]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return String(value);
}

function formatDateBR(isoDate) {
  if (!isoDate) return '';
  const parts = isoDate.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return isoDate;
}

// ============================================================
// CONFIGURAÇÃO — Cole o ID da sua planilha do Google Drive
// ============================================================
// Como encontrar o ID: abra a planilha → copie o trecho entre /d/ e /edit
// Exemplo: https://docs.google.com/spreadsheets/d/[ID_AQUI]/edit
const SALES_SHEET_ID = 'COLE_O_ID_DA_PLANILHA_AQUI';

// ============================================================
// ESTRUTURA DA PLANILHA (não altere se a planilha não mudou)
// ============================================================
const SHEET_CONFIG = {
  cats2025:   { idx: 0, startRow: 4,  count: 10, limitToMay: false }, // Realiz. 25 CATEGORIA
  stores2025: { idx: 1, startRow: 4,  count: 29, limitToMay: false }, // Realizado 29 LOJAS
  cats2026:   { idx: 2, startRow: 32, count: 10, limitToMay: true  }, // META 2026 CATEGORIA
  stores2026: { idx: 3, startRow: 70, count: 29, limitToMay: true  }, // META 2026 LOJAS
  stock:      { idx: 4 },                                              // ESTOQUE
};

// Normaliza nomes de categorias para bater com o dashboard
const CAT_NORMALIZE = {
  'genericos':        'Genéricos',
  'conveniencia':     'Conveniência',
  'ortopedicos':      'Ortopédicos',
  'servicos':         'Serviços',
  'prescricao':       'Prescrição',
  'anticoncepcional': 'Anticoncepcional',
  'similar':          'Similar',
  'fralda':           'Fralda',
  'leite':            'Leite',
  'perfumaria':       'Perfumaria',
};

// ============================================================
// PONTO DE ENTRADA DA WEB APP
// ============================================================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('SalesDashboard')
    .setTitle('Dashboard de Vendas — Drogaria Somensi')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================
// LEITURA DOS DADOS — chamada pelo dashboard via google.script.run
// ============================================================
function getSalesData() {
  try {
    const ss = SpreadsheetApp.openById(SALES_SHEET_ID);

    const result = {
      cats2025:   readSalesSheet(ss, SHEET_CONFIG.cats2025,   'cat'),
      stores2025: readSalesSheet(ss, SHEET_CONFIG.stores2025, 'store'),
      cats2026:   readSalesSheet(ss, SHEET_CONFIG.cats2026,   'cat'),
      stores2026: readSalesSheet(ss, SHEET_CONFIG.stores2026, 'store'),
      stock:      readStockSheet(ss, SHEET_CONFIG.stock),
      updatedAt:  Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
    };

    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

// ============================================================
// LEITURA DE ABA DE VENDAS
// Estrutura: col B = nome, col D(índice3) a O(índice14) = Jan-Dez
// ============================================================
function readSalesSheet(ss, cfg, type) {
  const sheet = ss.getSheets()[cfg.idx];
  const result = {};

  if (!sheet || sheet.getLastRow() < cfg.startRow) return result;

  const data = sheet.getRange(cfg.startRow, 1, cfg.count, 15).getValues(); // cols A-O

  for (const row of data) {
    let name = String(row[1] || '').trim(); // col B
    if (!name || name.toUpperCase().startsWith('TT') || name === '') continue;

    // Normaliza nomes de categorias
    if (type === 'cat') {
      const key = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      name = CAT_NORMALIZE[key] || name;
    }

    const monthly = cfg.limitToMay
      ? [n(row[3]),n(row[4]),n(row[5]),n(row[6]),n(row[7]), 0,0,0,0,0,0,0]
      : [n(row[3]),n(row[4]),n(row[5]),n(row[6]),n(row[7]),n(row[8]),n(row[9]),n(row[10]),n(row[11]),n(row[12]),n(row[13]),n(row[14])];

    result[name] = monthly;
  }
  return result;
}

// ============================================================
// LEITURA DE ABA DE ESTOQUE
// Retorna objeto vazio por ora — o dashboard usa dados estáticos para estoque
// Implemente aqui se quiser leitura ao vivo do estoque
// ============================================================
function readStockSheet(ss, cfg) {
  // Exemplo de implementação futura:
  // const sheet = ss.getSheets()[cfg.idx];
  // ...
  return {}; // usa os dados estáticos embutidos no dashboard
}

// Helper: converte para número
function n(v) { return parseFloat(v) || 0; }

// ============================================================
// TESTE — rode esta função manualmente no editor do Apps Script
// para verificar se os dados estão sendo lidos corretamente
// ============================================================
function testGetSalesData() {
  const result = JSON.parse(getSalesData());
  if (result.error) {
    Logger.log('ERRO: ' + result.error);
    return;
  }
  Logger.log('=== 2025 CATEGORIAS ===');
  for (const [k, v] of Object.entries(result.cats2025)) {
    Logger.log(k + ': Jan=' + v[0] + ' ... Total=' + v.reduce((a,b)=>a+b,0));
  }
  Logger.log('=== 2025 LOJAS (primeiras 5) ===');
  let i = 0;
  for (const [k, v] of Object.entries(result.stores2025)) {
    if (i++ >= 5) break;
    Logger.log(k + ': Jan=' + v[0] + ' ... Total=' + v.reduce((a,b)=>a+b,0));
  }
  Logger.log('=== 2026 META (Jan-Mai) ===');
  for (const [k, v] of Object.entries(result.cats2026)) {
    Logger.log(k + ': ' + v.slice(0,5).join(', '));
  }
  Logger.log('Atualizado em: ' + result.updatedAt);
}

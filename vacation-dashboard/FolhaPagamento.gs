// ============================================================
// FOLHA DE PAGAMENTO — módulo isolado dentro do painel de férias
//
// Tudo da folha mora neste arquivo (FolhaPagamento.gs, servidor) e em Folha.html (tela). Do resto
// do projeto usa só: api()/_SESSAO (login), _scopeAtual_() (perfil RH),
// _hashSenha_/_conferirSenha_ e _err_. Para separar num projeto próprio no
// futuro, basta levar estes dois arquivos + Login.html e o bloco de login do Code.gs.
//
// SEGURANÇA (além do login do painel):
//   1. só perfil RH;
//   2. segunda senha, exclusiva da folha (hash com salt, em Script Properties);
//   3. código de 6 dígitos do Google/Microsoft Authenticator (TOTP, RFC 6238);
//   4. sessão da folha própria, expira após FOLHA_SESSAO_SEG sem uso;
//   5. bloqueio após FOLHA_MAX_TENT erros por FOLHA_BLOQUEIO_SEG;
//   6. registro de acessos na aba AcessosFolha.
// Credenciais ficam em Script Properties (chave FOLHA_CRED_<e-mail>) — nunca na
// planilha. Para RESETAR a segunda senha/Authenticator de alguém: no editor do
// Apps Script, Configurações do projeto → Propriedades do script → apagar a chave.
// ============================================================

// ID da planilha da folha (Google Sheets, NÃO compartilhada com ninguém).
const FOLHA_SHEET_ID = '1A9OpzvS2FTdpkpY336mgRil3JkBIw0keTCKG-SFbQTo';

const FOLHA_TAB = {
  FUNC: 'Funcionarios', FILIAIS: 'Filiais', RUBRICAS: 'Rubricas', LANC: 'Lancamentos',
  IMPORT: 'Importacoes', ACESSOS: 'AcessosFolha',
};
const FOLHA_HEADERS = {
  Funcionarios: ['ID', 'Nome', 'Filial', 'Início', 'Ativo', 'Matrícula (férias)', 'Nome na comissão', 'Nome nos manipulados', 'Origem (planilha antiga)', 'Piso premiação', 'Nome na contabilidade'],
  Filiais: ['Filial', 'Código no sistema', 'Código nos manipulados'],
  Rubricas: ['Código', 'Nome', 'Tipo (P/D/I)', 'Recorrente', 'Origem'],
  Lancamentos: ['Mês', 'ID', 'Filial', 'Nome', 'Tipo', 'Rubrica', 'Descrição', 'Valor', 'Ordem'],
  Importacoes: ['Data', 'Por', 'Mês', 'Arquivo', 'Tipo', 'Linhas', 'Total', 'Observação'],
  AcessosFolha: ['Data', 'E-mail', 'Ação', 'Detalhe'],
};
const FU = { ID: 0, NOME: 1, FILIAL: 2, INICIO: 3, ATIVO: 4, MAT_FERIAS: 5, NOME_COM: 6, NOME_MAN: 7, PISO: 9, NOME_CONT: 10 };
const FL = { MES: 0, ID: 1, FILIAL: 2, NOME: 3, TIPO: 4, RUB: 5, DESC: 6, VALOR: 7, ORDEM: 8 };

const FOLHA_SESSAO_SEG   = 15 * 60;   // folha se fecha após 15 min sem uso
const FOLHA_MAX_TENT     = 5;
const FOLHA_BLOQUEIO_SEG = 30 * 60;
const FOLHA_EMISSOR      = 'Lider Farma Folha';

// funções que o navegador pode chamar (a api() do Code.gs procura aqui também)
const FOLHA_API = {
  paginaFolha: paginaFolha_,
  folhaStatus: folhaStatus_, folhaConfigurar: folhaConfigurar_, folhaConfirmar: folhaConfirmar_,
  folhaDesbloquear: folhaDesbloquear_, folhaBloquear: folhaBloquear_,
  folhaMeses: folhaMeses_, folhaDados: folhaDados_,
  folhaImportarPrevia: folhaImportarPrevia_, folhaImportarGravar: folhaImportarGravar_,
  folhaSalvarRecibo: folhaSalvarRecibo_, folhaAbrirMes: folhaAbrirMes_,
  folhaNovoFuncionario: folhaNovoFuncionario_,
};

// modo 'dre' (botão 📊 Gerar DRE do painel): mesma página e mesma proteção, abre na DRE
function paginaFolha_(modo) {
  _folhaSoRH_();
  const html = HtmlService.createHtmlOutputFromFile('Folha').getContent();
  return modo === 'dre' ? html.replace('</head>', '<script>var FOLHA_INICIO = "dre";</script></head>') : html;
}

// ---------- credenciais (segunda senha + segredo do Authenticator) ----------
function _folhaSoRH_() {
  if (_scopeAtual_().perfil !== 'rh') throw new Error('Acesso à folha restrito ao RH.');
  return _SESSAO.email;
}
function _folhaCredKey_(email) { return 'FOLHA_CRED_' + String(email).toLowerCase(); }
function _folhaCred_(email) {
  const v = PropertiesService.getScriptProperties().getProperty(_folhaCredKey_(email));
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function _folhaSalvarCred_(email, cred) {
  PropertiesService.getScriptProperties().setProperty(_folhaCredKey_(email), JSON.stringify(cred));
}

// { configurado } — a tela decide entre "criar acesso" e "desbloquear"
function folhaStatus_() {
  try {
    const email = _folhaSoRH_();
    const c = _folhaCred_(email);
    return JSON.stringify({ success: true, configurado: !!(c && c.ok), email: email });
  } catch (e) { return _err_(e.message); }
}

// 1º acesso: payload = { senha }. Gera o segredo do Authenticator e devolve a chave
// para cadastrar no celular. Só vale enquanto o acesso ainda não foi confirmado.
function folhaConfigurar_(payload) {
  try {
    const email = _folhaSoRH_();
    const atual = _folhaCred_(email);
    if (atual && atual.ok) return _err_('O acesso à folha já está configurado.');
    const senha = String(payload && payload.senha || '');
    if (senha.length < 10) return _err_('A senha da folha precisa ter pelo menos 10 caracteres.');
    const segredo = _base32Encode_(_bytesAleatorios_(20));
    _folhaSalvarCred_(email, { h: _hashSenha_(senha), s: segredo, ok: false, ult: 0 });
    const conta = encodeURIComponent(FOLHA_EMISSOR + ':' + email);
    const uri = 'otpauth://totp/' + conta + '?secret=' + segredo
      + '&issuer=' + encodeURIComponent(FOLHA_EMISSOR) + '&algorithm=SHA1&digits=6&period=30';
    _folhaLog_(email, 'configurar', 'senha criada; aguardando código do Authenticator');
    return JSON.stringify({ success: true, chave: segredo.replace(/(.{4})/g, '$1 ').trim(), uri: uri });
  } catch (e) { return _err_(e.message); }
}

// 1º acesso, passo 2: payload = { codigo } — confirma que o celular gera o código certo.
function folhaConfirmar_(payload) {
  try {
    const email = _folhaSoRH_();
    const c = _folhaCred_(email);
    if (!c || !c.s) return _err_('Crie a senha da folha primeiro.');
    if (c.ok) return _err_('O acesso à folha já está configurado.');
    const passo = _totpConferir_(c.s, payload && payload.codigo, c.ult);
    if (!passo) return _err_('Código incorreto. Confira a hora do celular e tente o código atual.');
    c.ok = true; c.ult = passo;
    _folhaSalvarCred_(email, c);
    _folhaLog_(email, 'configurar', 'Authenticator confirmado');
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

// payload = { senha, codigo } -> { folhaToken }
function folhaDesbloquear_(payload) {
  try {
    const email = _folhaSoRH_();
    const cache = CacheService.getScriptCache();
    const kT = 'folha_tent_' + email;
    const tent = Number(cache.get(kT)) || 0;
    if (tent >= FOLHA_MAX_TENT) return _err_('Muitas tentativas erradas. A folha fica bloqueada por 30 minutos.');
    const c = _folhaCred_(email);
    if (!c || !c.ok) return _err_('O acesso à folha ainda não foi configurado.');

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const senhaOk = _conferirSenha_(String(payload && payload.senha || ''), c.h);
      const passo = senhaOk ? _totpConferir_(c.s, payload && payload.codigo, c.ult) : 0;
      if (!senhaOk || !passo) {
        cache.put(kT, String(tent + 1), FOLHA_BLOQUEIO_SEG);
        _folhaLog_(email, 'falha', 'senha ou código incorreto (' + (tent + 1) + 'ª)');
        return _err_('Senha da folha ou código incorretos.');
      }
      c.ult = passo;                                  // o mesmo código não serve duas vezes
      _folhaSalvarCred_(email, c);
    } finally { lock.releaseLock(); }

    cache.remove(kT);
    const ft = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('folha_' + ft, JSON.stringify({ email: email }), FOLHA_SESSAO_SEG);
    _folhaLog_(email, 'desbloquear', '');
    return JSON.stringify({ success: true, folhaToken: ft, minutos: FOLHA_SESSAO_SEG / 60 });
  } catch (e) { return _err_(e.message); }
}

function folhaBloquear_(ft) {
  try {
    CacheService.getScriptCache().remove('folha_' + String(ft || ''));
    if (_SESSAO) _folhaLog_(_SESSAO.email, 'bloquear', '');
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

// Confere a sessão da folha; lança FOLHA_BLOQUEADA para a tela pedir senha + código de novo.
function _folhaSessao_(ft) {
  const email = _folhaSoRH_();
  ft = String(ft || '');
  if (!/^[0-9a-f]{64}$/.test(ft)) throw new Error('FOLHA_BLOQUEADA');
  const cache = CacheService.getScriptCache();
  const v = cache.get('folha_' + ft);
  let s = null;
  try { s = v ? JSON.parse(v) : null; } catch (e) { s = null; }
  if (!s || s.email !== email) throw new Error('FOLHA_BLOQUEADA');
  cache.put('folha_' + ft, v, FOLHA_SESSAO_SEG);    // renova a cada uso
  return email;
}

// ---------- TOTP (RFC 6238: HMAC-SHA1, 6 dígitos, passo de 30 s) ----------
// Devolve o número do passo aceito (> ultimo) ou 0. Aceita ±1 passo de relógio.
function _totpConferir_(segredoB32, codigo, ultimo) {
  codigo = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(codigo)) return 0;
  const chave = _base32Decode_(segredoB32);
  const agora = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const passo = agora + d;
    if (passo <= (ultimo || 0)) continue;
    if (_totpCodigo_(chave, passo, _hmacSha1_) === codigo) return passo;
  }
  return 0;
}
// hmac(chaveBytes, mensagemBytes) -> bytes (com ou sem sinal)
function _totpCodigo_(chave, passo, hmac) {
  const msg = [];
  let x = passo;
  for (let i = 7; i >= 0; i--) { msg[i] = x & 0xff; x = Math.floor(x / 256); }
  const h = hmac(chave, msg).map(function (b) { return b & 0xff; });
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return ('000000' + (bin % 1000000)).slice(-6);
}
function _hmacSha1_(chave, msg) {
  const sb = function (a) { return a.map(function (b) { return b > 127 ? b - 256 : b; }); };  // Java byte
  return Array.prototype.slice.call(
    Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, sb(msg), sb(chave)));
}
function _bytesAleatorios_(n) {
  // UUID v4 vem de gerador criptográfico; usa só os dígitos hex
  let hex = '';
  while (hex.length < n * 2) hex += Utilities.getUuid().replace(/-/g, '');
  const out = [];
  for (let i = 0; i < n; i++) out.push(parseInt(hex.substr(i * 2, 2), 16));
  return out;
}
const _B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _base32Encode_(bytes) {
  let bits = 0, val = 0, out = '';
  bytes.forEach(function (b) {
    val = (val << 8) | (b & 0xff); bits += 8;
    while (bits >= 5) { out += _B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  });
  if (bits > 0) out += _B32[(val << (5 - bits)) & 31];
  return out;
}
function _base32Decode_(s) {
  s = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    val = (val << 5) | _B32.indexOf(s[i]); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return out;
}

// ---------- planilha da folha ----------
// Só aceita a planilha se ela já tiver as abas da folha — assim um ID errado dá erro claro
// em vez de criar abas vazias numa planilha que não é a da folha.
function _folhaSS_() {
  if (!FOLHA_SHEET_ID) throw new Error('Planilha da folha ainda não configurada (FOLHA_SHEET_ID no FolhaPagamento.gs).');
  const ss = SpreadsheetApp.openById(FOLHA_SHEET_ID);
  if (!ss.getSheetByName(FOLHA_TAB.FUNC) || !ss.getSheetByName(FOLHA_TAB.LANC))
    throw new Error('A planilha "' + ss.getName() + '" não é a planilha da folha (faltam as abas '
      + FOLHA_TAB.FUNC + ' e ' + FOLHA_TAB.LANC + '). Confira o FOLHA_SHEET_ID no FolhaPagamento.gs.');
  return ss;
}
function _folhaAba_(nome) {
  const ss = _folhaSS_();
  const head = FOLHA_HEADERS[nome];
  let sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getMaxColumns() < head.length || !String(sh.getRange(1, head.length).getValue()).trim()) {
    // coluna nova no fim (ex.: "Piso premiação"): cria e põe o cabeçalho
    if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
    sh.getRange(1, head.length).setValue(head[head.length - 1]).setFontWeight('bold');
  }
  return sh;
}
function _folhaRows_(nome) {
  const sh = _folhaAba_(nome);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, FOLHA_HEADERS[nome].length).getValues();
}
function _folhaLog_(email, acao, detalhe) {
  try {
    if (!FOLHA_SHEET_ID) return;
    _folhaAba_(FOLHA_TAB.ACESSOS).appendRow([new Date(), email, acao, String(detalhe || '')]);
  } catch (e) { /* registro nunca derruba a operação */ }
}
// "2026-08" pode virar data ao importar no Sheets — normaliza para aaaa-mm
function _folhaMes_(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + _pad2_(v.getMonth() + 1);
  const m = String(v || '').trim().match(/^(\d{4})-(\d{1,2})/);
  return m ? m[1] + '-' + _pad2_(Number(m[2])) : '';
}
function _folhaNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// meses que têm lançamentos (mais recente primeiro)
function folhaMeses_(ft) {
  try {
    const email = _folhaSessao_(ft);
    const meses = {};
    _folhaRows_(FOLHA_TAB.LANC).forEach(function (r) { const m = _folhaMes_(r[FL.MES]); if (m) meses[m] = 1; });
    _folhaLog_(email, 'listar meses', '');
    return JSON.stringify({ success: true, meses: Object.keys(meses).sort().reverse() });
  } catch (e) { return _err_(e.message); }
}

// recibos do mês: [{ id, nome, filial, inicio, ativo, linhas:[{tipo,rubrica,descricao,valor}], proventos, descontos, liquido }]
function folhaDados_(ft, mes) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    const func = {};
    _folhaRows_(FOLHA_TAB.FUNC).forEach(function (r) {
      const id = String(r[FU.ID] || '').trim();
      if (!id) return;
      func[id] = {
        id: id, nome: String(r[FU.NOME] || '').trim(), filial: String(r[FU.FILIAL] || '').trim(),
        inicio: r[FU.INICIO] instanceof Date ? formatDateBR_(formatDate_(r[FU.INICIO])) : String(r[FU.INICIO] || ''),
        ativo: String(r[FU.ATIVO] || 'Sim').trim().toLowerCase() !== 'não',
        matFerias: _mk_(r[FU.MAT_FERIAS]),
      };
    });
    // férias do mês vindas do painel de férias (mesma regra do Relatório Mensal)
    let ferias = {};
    try { if (!_folhaEh13_(mes)) ferias = _folhaFeriasDoMes_(mes, Object.keys(func).map(function (k) { return func[k]; })); }
    catch (e) { ferias = {}; }
    const recibos = {};
    _folhaRows_(FOLHA_TAB.LANC).forEach(function (r) {
      if (_folhaMes_(r[FL.MES]) !== mes) return;
      const id = String(r[FL.ID] || '').trim();
      const f = func[id] || { id: id, nome: String(r[FL.NOME] || ''), filial: String(r[FL.FILIAL] || ''), inicio: '', ativo: true };
      const rec = recibos[id] || (recibos[id] = {
        id: id, nome: f.nome, filial: String(r[FL.FILIAL] || f.filial), inicio: f.inicio, ativo: f.ativo,
        linhas: [], proventos: 0, descontos: 0 });
      const tipo = String(r[FL.TIPO] || '').trim().toUpperCase();
      const valor = _folhaNum_(r[FL.VALOR]);
      rec.linhas.push({ tipo: tipo, rubrica: String(r[FL.RUB] || ''), descricao: String(r[FL.DESC] || ''),
        valor: valor, ordem: Number(r[FL.ORDEM]) || 0 });
      if (tipo === 'P') rec.proventos += valor || 0;
      if (tipo === 'D') rec.descontos += valor || 0;
    });
    const lista = Object.keys(recibos).map(function (k) {
      const r = recibos[k];
      r.linhas.sort(function (a, b) { return a.ordem - b.ordem; });
      r.proventos = Math.round(r.proventos * 100) / 100;
      r.descontos = Math.round(r.descontos * 100) / 100;
      r.liquido = Math.round((r.proventos - r.descontos) * 100) / 100;
      r.ferias = ferias[k] || [];
      return r;
    });
    // contrato de experiência: selo no recibo + aviso dos prazos que vencem (só funcionários ativos)
    const exp = _folhaExperiencias_();
    lista.forEach(function (r) { if (exp[r.id]) r.experiencia = exp[r.id]; });
    const experiencias = Object.keys(exp).filter(function (id) { return func[id] && func[id].ativo; })
      .map(function (id) { return Object.assign({ id: id, nome: func[id].nome, filial: func[id].filial }, exp[id]); });
    _folhaLog_(email, 'ver mês', mes + ' (' + lista.length + ' recibos)');
    return JSON.stringify({ success: true, mes: mes, recibos: lista, experiencias: experiencias, hoje: formatDate_(new Date()) });
  } catch (e) { return _err_(e.message); }
}

// Férias (aba Lancamentos da planilha de férias) que tocam o mês: início ≤ mês ≤ término,
// como no Relatório Mensal do painel. Recusadas ficam de fora; pendentes vêm marcadas.
// Ligação funcionário da folha -> matrícula das férias: coluna "Matrícula (férias)" do
// cadastro da folha; sem ela, pelo nome (só se um único funcionário das férias combinar).
// Devolve { idFolha: [{ inicio, fim, dias, tipo, pendente }] }
// { idFolha: matrícula das férias } — coluna "Matrícula (férias)"; sem ela, pelo nome (só se um único combinar)
function _folhaLigarFerias_(funcFolha) {
  const tokFerias = [];
  _rows_(TAB.FUNC).forEach(function (r) {
    const mat = _mk_(r[F.MAT]);
    if (!mat) return;
    if (String(r[F.SITUACAO] || '').trim().toLowerCase() !== 'inativo')
      tokFerias.push({ mat: mat, t: _folhaTokens_(String(r[F.NOME] || '').trim()) });
  });
  const out = {};
  funcFolha.forEach(function (f) {
    let mat = f.matFerias !== undefined ? f.matFerias : (f.row ? _mk_(f.row[FU.MAT_FERIAS]) : '');
    if (!mat) {
      const t = _folhaTokens_(String(f.nome).replace(/^(.+?)\s*-\s*(\D+)$/, '$1'));
      const cands = tokFerias.map(function (x) { return { mat: x.mat, p: _folhaPontos_(t, x.t) }; })
        .filter(function (x) { return x.p >= 4; }).sort(function (a, b) { return b.p - a.p; });
      if (cands.length === 1 || (cands.length > 1 && cands[0].p > cands[1].p)) mat = cands[0].mat;
    }
    if (mat) out[f.id] = mat;
  });
  return out;
}
function _folhaFeriasDoMes_(mes, funcFolha) {
  const porMat = {};
  _rows_(TAB.LANC).forEach(function (r) {
    const mat = _mk_(r[L.MAT]);
    const st = _statusLanc_(r);
    if (!mat || st === ST.RECUS) return;
    const ini = toDate_(r[L.INICIO]), fim = toDate_(r[L.TERMINO]);
    if (!ini || !fim) return;
    const i = formatDate_(ini), f = formatDate_(fim);
    if (i.substring(0, 7) > mes || f.substring(0, 7) < mes) return;
    const dias = typeof r[L.DIAS] === 'number' && r[L.DIAS] ? r[L.DIAS] : Math.round((fim - ini) / 864e5) + 1;
    (porMat[mat] || (porMat[mat] = [])).push({
      inicio: i, fim: f, dias: dias, tipo: String(r[L.TIPO] || 'Gozo').trim() || 'Gozo', pendente: st === ST.PEND });
  });
  const out = {}, liga = _folhaLigarFerias_(funcFolha);
  funcFolha.forEach(function (f) {
    const mat = liga[f.id];
    if (mat && porMat[mat]) out[f.id] = porMat[mat].slice().sort(function (a, b) { return a.inicio < b.inicio ? -1 : 1; });
  });
  return out;
}

// ============================================================
// IMPORTAÇÃO DE COMISSÕES (fase 2)
//   O navegador lê os arquivos (Rel_0038 .xlsx e PDF "Vendas por Vendedor" dos manipulados)
//   e manda só as listas { nome, valor } (+ código no Rel_0038). Aqui: casar cada vendedor
//   com um funcionário, montar a prévia e, depois do "ok", gravar a Premiação do mês.
//   Regra: premiação = comissão + manipulados SEM os centavos; se houver piso (mínimo
//   garantido) e a soma não chegar nele, vale o piso. Vendedor sem funcionário = ignorado.
// ============================================================

// com = [{ cod, nome, valor }], man = [{ nome, valor }]
function folhaImportarPrevia_(ft, mes, com, man) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    if (_folhaEh13_(mes)) return _err_('No 13º salário não há importação de comissões.');
    const func = _folhaFuncionarios_();
    let aus = {};
    try { aus = _folhaAusencias_(mes, func.lista); } catch (e) { aus = {}; }
    const pisos = _folhaPisos_(func, _folhaRegras_(), aus);
    const atual = _folhaPremiacoes_(mes, pisos);
    const r = _folhaCasar_(func.lista, com || [], man || []);
    const linhas = func.lista.map(function (f) {
      const c = r.porFunc[f.id] || { com: null, man: null, comNomes: [], manNomes: [], vinculado: false };
      const temValor = c.com !== null || c.man !== null;
      const pi = pisos[f.id];
      if (!temValor && !pi) return null;
      const soma = Math.round(((c.com || 0) + (c.man || 0)) * 100) / 100;
      const semCentavos = Math.floor(soma + 1e-9);
      const pisoMes = pi ? Math.floor(pi.valor + 1e-9) : 0;
      const nova = Math.max(semCentavos, pisoMes);
      const at = atual[f.id];
      return {
        id: f.id, nome: f.nome, filial: f.filial, ativo: f.ativo,
        comissao: c.com, manipulados: c.man, soma: soma, piso: pi ? pisoMes : null,
        pisoBase: pi ? pi.base : null, diasTrab: pi ? pi.trab : null, linhaPiso: pi && pi.rubrica !== 'PREMIACAO' ? pi.descricao || pi.rubrica : '',
        usouPiso: pisoMes > semCentavos,
        nova: nova, atual: at ? at.valor : null, linhasPremiacao: at ? at.n : 0,
        comNomes: c.comNomes, manNomes: c.manNomes, vinculado: c.vinculado,
      };
    }).filter(Boolean);
    _folhaLog_(email, 'importar (prévia)', mes + ': ' + linhas.length + ' funcionários');
    return JSON.stringify({
      success: true, mes: mes, linhas: linhas, semFuncionario: r.semFuncionario, empates: r.empates,
      funcionarios: func.lista.filter(function (f) { return f.ativo; })
        .map(function (f) { return { id: f.id, nome: f.nome, filial: f.filial, piso: pisos[f.id] ? Math.floor(pisos[f.id].valor + 1e-9) : null }; }),
    });
  } catch (e) { return _err_(e.message); }
}

// itens = [{ id, valor }]; vinculos = [{ id, tipo: 'com'|'man', nome }] (vendedor ligado à mão na tela)
function folhaImportarGravar_(ft, mes, itens, vinculos, arquivos) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    if (_folhaEh13_(mes)) return _err_('No 13º salário não há importação de comissões.');
    if (!Array.isArray(itens) || !itens.length) return _err_('Nada para gravar.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaFuncionarios_();
      // 1) premiação do mês na aba Lancamentos: atualiza a 1ª linha PREMIACAO ou cria uma
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const rows = _folhaRows_(FOLHA_TAB.LANC);
      // piso numa linha que não é PREMIACAO (ex.: "Gratificação/Premiação"): a premiação vai nessa linha
      const pos = _folhaAlvosPremiacao_(mes, rows, _folhaPisos_(func, _folhaRegras_(), {})), ordemMax = {};
      rows.forEach(function (r, i) {
        if (_folhaMes_(r[FL.MES]) !== mes) return;
        const id = String(r[FL.ID] || '').trim();
        ordemMax[id] = Math.max(ordemMax[id] || 0, Number(r[FL.ORDEM]) || 0);
        if (String(r[FL.RUB]).trim() === 'PREMIACAO' && pos[id] === undefined) pos[id] = i + 2;
      });
      const novas = [];
      let total = 0, n = 0;
      itens.forEach(function (it) {
        const id = String(it && it.id || '').trim();
        const v = Math.floor(Number(it && it.valor));
        const f = func.porId[id];
        if (!f || !isFinite(v) || v < 0) return;
        if (pos[id]) sh.getRange(pos[id], FL.VALOR + 1).setValue(v);
        else novas.push([mes, id, f.filial, f.nome, 'P', 'PREMIACAO', 'Premiação', v, (ordemMax[id] || 0) + 1]);
        total += v; n++;
      });
      if (novas.length) sh.getRange(sh.getLastRow() + 1, 1, novas.length, novas[0].length).setValues(novas);
      // 2) vínculos novos: guarda o nome do vendedor no cadastro (no próximo mês casa sozinho)
      const shF = _folhaAba_(FOLHA_TAB.FUNC);
      (vinculos || []).forEach(function (vk) {
        const f = func.porId[String(vk && vk.id || '').trim()];
        const nome = String(vk && vk.nome || '').trim();
        if (!f || !nome) return;
        const col = vk.tipo === 'man' ? FU.NOME_MAN : FU.NOME_COM;
        if (_folhaApelidos_(f.row[col]).indexOf(_folhaNorm_(nome)) >= 0) return;
        const novo = [String(f.row[col] || '').trim(), nome].filter(String).join(' ; ');
        shF.getRange(f.linha, col + 1).setValue(novo);
        f.row[col] = novo;
      });
      _folhaAba_(FOLHA_TAB.IMPORT).appendRow([new Date(), email, mes, String(arquivos || ''), 'Premiação', n, total,
        (vinculos || []).length ? (vinculos.length + ' vínculo(s) novo(s)') : '']);
      _folhaLog_(email, 'importar (gravar)', mes + ': ' + n + ' premiações, total ' + total);
      return JSON.stringify({ success: true, gravados: n, total: total });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

function _folhaFuncionarios_() {
  const lista = [], porId = {};
  _folhaRows_(FOLHA_TAB.FUNC).forEach(function (r, i) {
    const id = String(r[FU.ID] || '').trim();
    if (!id) return;
    const f = {
      id: id, nome: String(r[FU.NOME] || '').trim(), filial: String(r[FU.FILIAL] || '').trim(),
      ativo: String(r[FU.ATIVO] || 'Sim').trim().toLowerCase() !== 'não',
      apelidosCom: _folhaApelidos_(r[FU.NOME_COM]), apelidosMan: _folhaApelidos_(r[FU.NOME_MAN]), apelidosCont: _folhaApelidos_(r[FU.NOME_CONT]),
      piso: _folhaNum_(r[FU.PISO]) || 0, linha: i + 2, row: r,
    };
    lista.push(f); porId[id] = f;
  });
  return { lista: lista, porId: porId };
}
// premiação atual do mês por funcionário: { id: { valor, n } }. Quem tem piso numa linha que
// não é PREMIACAO (ex.: "Gratificação/Premiação") conta só essa linha.
function _folhaPremiacoes_(mes, pisos) {
  const out = {};
  const alvos = _folhaAlvosPremiacao_(mes, _folhaRows_(FOLHA_TAB.LANC), pisos || {});
  _folhaRows_(FOLHA_TAB.LANC).forEach(function (r, i) {
    if (_folhaMes_(r[FL.MES]) !== mes) return;
    const id = String(r[FL.ID] || '').trim();
    const a = alvos[id];
    if (a ? a !== i + 2 : String(r[FL.RUB]).trim() !== 'PREMIACAO') return;
    const o = out[id] || (out[id] = { valor: 0, n: 0 });
    o.valor += _folhaNum_(r[FL.VALOR]) || 0; o.n++;
  });
  return out;
}
// { id: nº da linha na planilha } da linha que recebe a premiação quando o piso mora noutra rubrica
function _folhaAlvosPremiacao_(mes, rows, pisos) {
  const out = {}, cand = {};
  rows.forEach(function (r, i) {
    if (_folhaMes_(r[FL.MES]) !== mes) return;
    const id = String(r[FL.ID] || '').trim();
    const p = pisos[id];
    if (!p || p.rubrica === 'PREMIACAO' || String(r[FL.RUB]).trim().toUpperCase() !== p.rubrica) return;
    const exata = p.descricao && _folhaNorm_(r[FL.DESC]) === _folhaNorm_(p.descricao);
    const o = { linha: i + 2, ordem: Number(r[FL.ORDEM]) || 0, exata: !!exata };
    const c = cand[id];
    if (!c || (o.exata && !c.exata) || (o.exata === c.exata && o.ordem < c.ordem)) cand[id] = o;
  });
  Object.keys(cand).forEach(function (id) { out[id] = cand[id].linha; });
  return out;
}
// "84 ; FULANA S. EXEMPLO- 0100" -> lista normalizada
function _folhaApelidos_(v) {
  return String(v || '').split(';').map(_folhaNorm_).filter(String);
}
function _folhaNorm_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// ---------- casamento vendedor -> funcionário (função pura: testável fora do Apps Script) ----------
// func = [{ id, nome, ativo, apelidosCom, apelidosMan }]
// devolve { porFunc: { id: { com, man, comNomes, manNomes, vinculado } }, semFuncionario: [...], empates: [...] }
function _folhaCasar_(func, com, man) {
  const porFunc = {}, semFuncionario = [], empates = [];
  const tok = func.map(function (f) {
    const limpo = String(f.nome).replace(/^(.+?)\s*-\s*(\D+)$/, '$1');     // tira o local: "Fulana- Filial"
    return { f: f, t: _folhaTokens_(limpo) };
  });
  function somar(f, tipo, v, vinculado) {
    const o = porFunc[f.id] || (porFunc[f.id] = { com: null, man: null, comNomes: [], manNomes: [], vinculado: false });
    o[tipo] = Math.round(((o[tipo] || 0) + Number(v.valor || 0)) * 100) / 100;
    (tipo === 'com' ? o.comNomes : o.manNomes).push(v.nome);
    if (vinculado) o.vinculado = true;
  }
  function casar(lista, tipo) {
    (lista || []).forEach(function (v) {
      const chaves = [_folhaNorm_(v.nome)];
      if (v.cod !== undefined && v.cod !== null && String(v.cod).trim()) chaves.push(_folhaNorm_(v.cod));
      // 1) vínculo salvo no cadastro (nome exato ou código do Rel_0038)
      const salvo = func.filter(function (f) {
        const ap = tipo === 'com' ? f.apelidosCom : f.apelidosMan;
        return chaves.some(function (k) { return ap.indexOf(k) >= 0; });
      });
      if (salvo.length === 1) return somar(salvo[0], tipo, v, true);
      // 2) por semelhança de nome, só entre ativos
      const tv = _folhaTokens_(v.nome);
      const cands = tok.filter(function (x) { return x.f.ativo; })
        .map(function (x) { return { f: x.f, p: _folhaPontos_(tv, x.t) }; })
        .filter(function (x) { return x.p >= 4; })
        .sort(function (a, b) { return b.p - a.p; });
      const item = { tipo: tipo, nome: v.nome, cod: v.cod, valor: Number(v.valor || 0) };
      if (!cands.length) { semFuncionario.push(item); return; }
      if (cands.length > 1 && cands[1].p === cands[0].p) {
        item.opcoes = cands.filter(function (c) { return c.p === cands[0].p; }).map(function (c) { return c.f.id; });
        empates.push(item);
        return;
      }
      somar(cands[0].f, tipo, v, false);
    });
  }
  casar(com, 'com');
  casar(man, 'man');
  return { porFunc: porFunc, semFuncionario: semFuncionario, empates: empates };
}
function _folhaTokens_(s) {
  return _folhaNorm_(s)
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s-\s*\d+.*$|-\s*\d{3,}.*$/, ' ')                 // "- 0197", "-7115-CNPJ ..."
    .replace(/-\s*(MEI|MANIPULACAO|TT)\b.*$/, ' ')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\b(DE|DA|DO|DOS|DAS|E)\b/g, ' ')
    .split(/\s+/).filter(String);
}
function _folhaLev_(a, b) {
  let ant = [];
  for (let j = 0; j <= b.length; j++) ant[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const at = [i];
    for (let j = 1; j <= b.length; j++)
      at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = at;
  }
  return ant[b.length];
}
// 2 = igual; 1 = inicial ("M." x "MOREIRA"); 1,5 = erro de digitação
function _folhaTokIgual_(x, y) {
  if (x === y) return 2;
  if (x.length === 1 || y.length === 1) return x[0] === y[0] ? 1 : 0;
  const m = Math.min(x.length, y.length);
  if (m >= 5) { const l = _folhaLev_(x, y); if (l <= 1 || (m >= 8 && l <= 2)) return 1.5; }
  return 0;
}
// 1º nome igual (ou 1 letra de diferença) = 3 pontos + tokens que batem em qualquer ordem.
// Sem 1º nome igual, só aceita com 2+ sobrenomes iguais ("JUNIOR PADILHA" x "José Padilha Junior").
function _folhaPontos_(a, b) {
  if (!a.length || !b.length) return 0;
  const prim = a[0] === b[0] || (a[0].length >= 5 && b[0].length >= 5 && _folhaLev_(a[0], b[0]) <= 1);
  let p = prim ? 3 : 0, outros = 0;
  const usados = {};
  if (prim) usados[0] = true;
  (prim ? a.slice(1) : a).forEach(function (x) {
    for (let j = 0; j < b.length; j++) {
      if (usados[j]) continue;
      const t = _folhaTokIgual_(x, b[j]);
      if (t) { p += t; usados[j] = true; if (t >= 1.5) outros++; break; }
    }
  });
  if (!prim && outros < 2) return 0;
  if (prim && (b.length === 1 || a.length === 1)) return Math.max(p, 4);   // um dos lados só com o 1º nome ("Clari")
  return p;
}

// ---------- edição manual de um recibo (botão ✏ Editar no cartão) ----------
// "impressão digital" das linhas do recibo, na ordem — o navegador manda a que ele carregou
// e o servidor confere com a planilha antes de gravar (não sobrescreve edição de outra pessoa)
function _folhaDigital_(linhas) {
  return JSON.stringify(linhas.map(function (l) { return [l.tipo, l.rubrica, l.descricao, l.valor]; }));
}

// linhas = [{ tipo: 'P'|'D'|'I', rubrica?, descricao, valor? }] na ordem do recibo; antes = _folhaDigital_ das
// linhas que estavam na tela. Reescreve as linhas (mes, id) da aba Lancamentos: reaproveita as mesmas
// linhas da planilha, acrescenta no fim se sobrar e apaga as que faltarem.
function folhaSalvarRecibo_(ft, mes, id, linhas, antes) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    id = String(id || '').trim();
    if (!mes || !id) return _err_('Recibo inválido.');
    if (!Array.isArray(linhas)) return _err_('Nada para gravar.');
    const novas = [];
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i] || {};
      const tipo = String(l.tipo || '').trim().toUpperCase();
      if (['P', 'D', 'I'].indexOf(tipo) < 0) return _err_('Tipo de linha inválido: ' + tipo);
      const desc = String(l.descricao || '').trim().slice(0, 120);
      if (!desc) return _err_('Toda linha precisa de uma descrição.');
      let valor = null;
      if (tipo !== 'I' && l.valor !== null && l.valor !== '' && l.valor !== undefined) {
        valor = Math.round(Number(l.valor) * 100) / 100;
        if (!isFinite(valor) || valor < 0) return _err_('Valor inválido em "' + desc + '".');
      }
      novas.push({ tipo: tipo, rubrica: String(l.rubrica || '').trim() || 'MANUAL', descricao: desc, valor: valor });
    }
    if (!novas.length) return _err_('O recibo precisa de pelo menos uma linha.');

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const atuais = [];
      _folhaRows_(FOLHA_TAB.LANC).forEach(function (r, i) {
        if (_folhaMes_(r[FL.MES]) !== mes || String(r[FL.ID] || '').trim() !== id) return;
        atuais.push({ linha: i + 2, r: r, ordem: Number(r[FL.ORDEM]) || 0,
          tipo: String(r[FL.TIPO] || '').trim().toUpperCase(), rubrica: String(r[FL.RUB] || ''),
          descricao: String(r[FL.DESC] || ''), valor: _folhaNum_(r[FL.VALOR]) });
      });
      if (!atuais.length) return _err_('Recibo não encontrado na planilha.');
      const ordenadas = atuais.slice().sort(function (a, b) { return a.ordem - b.ordem; });
      if (antes && _folhaDigital_(ordenadas) !== String(antes))
        return _err_('Este recibo foi alterado na planilha depois que a tela carregou. Recarregue o mês e edite de novo.');

      const base = ordenadas[0].r;
      const valores = novas.map(function (l, i) {
        return [base[FL.MES], id, base[FL.FILIAL], base[FL.NOME], l.tipo, l.rubrica, l.descricao,
          l.valor === null ? '' : l.valor, i + 1];
      });
      const pos = atuais.map(function (a) { return a.linha; }).sort(function (a, b) { return a - b; });
      const usar = Math.min(pos.length, valores.length);
      for (let i = 0; i < usar; i++) sh.getRange(pos[i], 1, 1, valores[i].length).setValues([valores[i]]);
      if (valores.length > pos.length) {
        const resto = valores.slice(pos.length);
        sh.getRange(sh.getLastRow() + 1, 1, resto.length, resto[0].length).setValues(resto);
      }
      // apaga de baixo para cima para os números de linha não mudarem
      pos.slice(usar).sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });

      _folhaLog_(email, 'editar recibo', mes + ' · ' + id + ' · ' + String(base[FL.NOME] || '') + ' (' + novas.length + ' linhas)');
      return JSON.stringify({ success: true });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ---------- abrir o mês seguinte (botão 📅 Abrir novo mês) ----------
// Cria as linhas de `novo` (aaaa-mm) copiando o último mês anterior a ele, só para funcionários ATIVOS:
//  · rubrica com "Recorrente = Sim" na aba Rubricas → repete descrição E valor (salário, INSS…);
//  · as outras → repete a linha com o valor em branco (premiação, horas extras, conta farmácia…);
//  · anotações de férias (FERIAS_OBS) não vêm — o recibo mostra as férias do painel; OBS (pix, conta) vem;
//  · ativo sem recibo no mês anterior (admissão nova) → Salário, Premiação e INSS em branco.
// Recusa se o mês já tiver qualquer linha (não duplica).
function folhaAbrirMes_(ft, novo) {
  try {
    const email = _folhaSessao_(ft);
    novo = _folhaMes_(novo);
    if (!novo || _folhaEh13_(novo)) return _err_('Mês inválido.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const rows = _folhaRows_(FOLHA_TAB.LANC);
      const meses = {};
      rows.forEach(function (r) { const m = _folhaMes_(r[FL.MES]); if (m) meses[m] = 1; });
      if (meses[novo]) return _err_(_folhaNomeMes_(novo) + ' já existe na folha.');
      const anteriores = Object.keys(meses).filter(function (m) { return m < novo && !_folhaEh13_(m); }).sort();
      if (!anteriores.length) return _err_('Não há mês anterior a ' + _folhaNomeMes_(novo) + ' para copiar.');
      const origem = anteriores[anteriores.length - 1];

      const recorrente = {};
      _folhaRows_(FOLHA_TAB.RUBRICAS).forEach(function (r) {
        const cod = String(r[0] || '').trim();
        if (cod) recorrente[cod] = /^s/i.test(String(r[3] || '').trim());
      });
      const func = _folhaFuncionarios_();
      const porFunc = {};
      rows.forEach(function (r) {
        if (_folhaMes_(r[FL.MES]) !== origem) return;
        const id = String(r[FL.ID] || '').trim();
        (porFunc[id] = porFunc[id] || []).push(r);
      });

      const novas = [];
      let nFunc = 0, nNovos = 0;
      func.lista.forEach(function (f) {
        if (!f.ativo) return;
        const ls = (porFunc[f.id] || []).slice().sort(function (a, b) { return (Number(a[FL.ORDEM]) || 0) - (Number(b[FL.ORDEM]) || 0); });
        let ordem = 0;
        if (!ls.length) {
          [['P', 'SALARIO', 'Salário'], ['P', 'PREMIACAO', 'Premiação'], ['D', 'INSS', '(-) INSS']].forEach(function (x) {
            novas.push([novo, f.id, f.filial, f.nome, x[0], x[1], x[2], '', ++ordem]);
          });
          nFunc++; nNovos++;
          return;
        }
        ls.forEach(function (r) {
          const tipo = String(r[FL.TIPO] || '').trim().toUpperCase();
          const rub = String(r[FL.RUB] || '').trim();
          if (rub === 'FERIAS_OBS') return;
          const valor = tipo !== 'I' && recorrente[rub] && r[FL.VALOR] !== '' ? r[FL.VALOR] : '';
          novas.push([novo, f.id, f.filial || r[FL.FILIAL], f.nome || r[FL.NOME], tipo, rub, r[FL.DESC], valor, ++ordem]);
        });
        nFunc++;
      });
      if (!novas.length) return _err_('Nenhum funcionário ativo para lançar.');

      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const ini = sh.getLastRow() + 1;
      sh.getRange(ini, FL.MES + 1, novas.length, 1).setNumberFormat('@');   // "2026-11" como texto, não data
      sh.getRange(ini, 1, novas.length, novas[0].length).setValues(novas);
      _folhaLog_(email, 'abrir mês', novo + ' a partir de ' + origem + ': ' + nFunc + ' funcionários, ' + novas.length + ' linhas');
      return JSON.stringify({ success: true, mes: novo, origem: origem, funcionarios: nFunc, novos: nNovos, linhas: novas.length });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}
function _folhaNomeMes_(m) {
  const n = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const p = String(m).split('-');
  if (p[1] === '13') return '13º salário/' + p[0];
  return n[Number(p[1]) - 1] + '/' + p[0];
}

// ---------- cadastrar funcionário novo (botão + Novo funcionário) ----------
// d = { nome, filial, inicio (aaaa-mm-dd), salario?, matFerias?, piso? }. Grava na aba Funcionarios
// com o próximo ID (F###) e, se `mes` vier, já cria o recibo dele nesse mês (Salário, Premiação, INSS).
function folhaNovoFuncionario_(ft, mes, d) {
  try {
    const email = _folhaSessao_(ft);
    d = d || {};
    const nome = String(d.nome || '').replace(/\s+/g, ' ').trim();
    const filial = String(d.filial || '').trim();
    if (!nome) return _err_('Informe o nome.');
    if (!filial) return _err_('Informe a filial.');
    const inicio = d.inicio ? toDate_(d.inicio) : null;
    if (d.inicio && !inicio) return _err_('Data de início inválida.');
    const num = function (v, rot) {
      if (v === null || v === undefined || v === '') return '';
      const n = Math.round(Number(v) * 100) / 100;
      if (!isFinite(n) || n < 0) throw new Error(rot + ' inválido.');
      return n;
    };
    const salario = num(d.salario, 'Salário'), piso = num(d.piso, 'Piso');
    mes = mes ? _folhaMes_(mes) : '';
    if (_folhaEh13_(mes)) mes = '';   // no 13º o recibo vem do 🎄 Gerar 13º

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaFuncionarios_();
      const igual = func.lista.find(function (f) { return f.ativo && _folhaNorm_(f.nome) === _folhaNorm_(nome); });
      if (igual) return _err_('Já existe um funcionário ativo com esse nome (' + igual.id + ', ' + igual.filial + ').');
      let max = 0;
      func.lista.forEach(function (f) { const m = /^F(\d+)$/i.exec(f.id); if (m) max = Math.max(max, Number(m[1])); });
      const id = 'F' + String(max + 1).padStart(3, '0');

      const shF = _folhaAba_(FOLHA_TAB.FUNC);
      const nr = shF.getLastRow() + 1;
      shF.getRange(nr, 1, 1, FOLHA_HEADERS.Funcionarios.length).setValues([[
        id, nome, filial, inicio || '', 'Sim', String(d.matFerias || '').trim(), '', '',
        'Cadastrado no painel ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy'), piso, '']]);
      if (inicio) shF.getRange(nr, FU.INICIO + 1).setNumberFormat('dd/mm/yyyy');

      let linhas = [];
      if (mes) {
        const sal = 'Salário' + (salario !== '' ? ' (' + salario.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ')' : '');
        linhas = [['P', 'SALARIO', sal, salario], ['P', 'PREMIACAO', 'Premiação', ''], ['D', 'INSS', '(-) INSS', '']];
        const sh = _folhaAba_(FOLHA_TAB.LANC);
        const ini = sh.getLastRow() + 1;
        sh.getRange(ini, FL.MES + 1, linhas.length, 1).setNumberFormat('@');
        sh.getRange(ini, 1, linhas.length, 9).setValues(linhas.map(function (l, i) {
          return [mes, id, filial, nome, l[0], l[1], l[2], l[3], i + 1];
        }));
      }
      _folhaLog_(email, 'novo funcionário', id + ' · ' + nome + ' · ' + filial + (mes ? ' · recibo em ' + mes : ''));
      return JSON.stringify({ success: true, id: id, recibo: mes ? {
        id: id, nome: nome, filial: filial, inicio: inicio ? formatDateBR_(formatDate_(inicio)) : '', ativo: true, ferias: [],
        linhas: linhas.map(function (l, i) { return { tipo: l[0], rubrica: l[1], descricao: l[2], valor: l[3] === '' ? null : l[3], ordem: i + 1 }; }),
        proventos: salario || 0, descontos: 0, liquido: salario || 0 } : null });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// CADASTRAR NOVO FUNCIONÁRIO (botão 👤 Cadastrar novo funcionário)
//   Um formulário só para as duas planilhas:
//   · painel de férias (aba Func): matrícula, nome, filial, cargo, admissão, registrado, saldo inicial, CTPS
//     — e o 1º período aquisitivo, se registrado (addEmployee_). Ou liga a um cadastro de férias que já existe;
//   · folha (aba Funcionarios): próximo ID F###, "Matrícula (férias)" já ligada, Início = admissão;
//   · regras do funcionário (aba Regras): Fixo / Piso premiação / Bônus manipulação / Entra no 13º;
//   · recibo no mês aberto, no modelo da folha: Salário, linhas das regras Fixo, Premiação e (registrado) INSS.
//     Admitido dentro do mês aberto: salário e regras proporcionais = base × dias desde a admissão ÷ 30,
//     centavos cortados (mesma conta das regras). Admitido depois do mês aberto: não cria recibo.
// ============================================================
FOLHA_API.folhaCadastroDados = folhaCadastroDados_;
FOLHA_API.folhaCadastrar = folhaCadastrar_;

// Contrato de experiência (CLT art. 445: até 90 dias, 1 prorrogação). Aba "Experiencia" da planilha da folha,
// uma linha por contrato: 1º período (dias) e prorrogação (dias, 0 = sem). Fim = início + dias − 1.
FOLHA_TAB.EXPER = 'Experiencia';
FOLHA_HEADERS.Experiencia = ['ID', 'Nome', 'Filial', 'Início', '1º período (dias)', 'Fim do 1º período',
  'Prorrogação (dias)', 'Fim da experiência', 'Observação', 'Registrado em'];
function _folhaExpDatas_(inicio, d1, d2) {
  const fim1 = _plusDays_(inicio, d1 - 1), fim = _plusDays_(inicio, d1 + d2 - 1);
  return { fim1: fim1, fim: fim };
}
// { id: { inicio, d1, fim1, d2, fim, obs } } — vale a última linha de cada ID
function _folhaExperiencias_() {
  const out = {};
  const ss = _folhaSS_();
  if (!ss.getSheetByName(FOLHA_TAB.EXPER)) return out;
  _folhaRows_(FOLHA_TAB.EXPER).forEach(function (r) {
    const id = String(r[0] || '').trim(), ini = toDate_(r[3]);
    const d1 = Number(r[4]) || 0, d2 = Number(r[6]) || 0;
    if (!id || !ini || !d1) return;
    const dt = _folhaExpDatas_(ini, d1, d2);
    out[id] = { inicio: formatDate_(ini), d1: d1, fim1: formatDate_(dt.fim1), d2: d2, fim: formatDate_(dt.fim), obs: String(r[8] || '').trim() };
  });
  return out;
}

function folhaCadastroDados_(ft) {
  try {
    _folhaSessao_(ft);
    const func = _folhaFuncionarios_();
    const liga = _folhaLigarFerias_(func.lista.filter(function (f) { return f.ativo; }));
    const ligadas = {};
    Object.keys(liga).forEach(function (id) { ligadas[liga[id]] = id; });
    const filFolha = {}, filFerias = {};
    func.lista.forEach(function (f) { if (f.ativo && f.filial) filFolha[f.filial] = 1; });
    let maxMat = 0;
    const ferias = [];
    _rows_(TAB.FUNC).forEach(function (r) {
      const n = parseInt(String(r[F.MAT]).replace(/\D/g, ''), 10);
      if (!isNaN(n) && n > maxMat) maxMat = n;
      const mat = _mk_(r[F.MAT]);
      if (!mat) return;
      const fil = String(r[F.FILIAL] || '').trim();
      if (fil) filFerias[fil] = 1;
      if (String(r[F.SITUACAO] || '').trim().toLowerCase() === 'inativo') return;
      const adm = toDate_(r[F.ADMISSAO]);
      ferias.push({ mat: mat, nome: String(r[F.NOME] || '').trim(), filial: fil, cargo: String(r[F.CARGO] || '').trim(),
        admissao: adm ? formatDate_(adm) : '', registrado: String(r[F.REGISTRADO] || '').trim().toLowerCase() !== 'não',
        naFolha: ligadas[mat] || '' });
    });
    const rub = _folhaRows_(FOLHA_TAB.RUBRICAS).map(function (r) {
      return { cod: String(r[0] || '').trim(), nome: String(r[1] || '').trim(), tipo: String(r[2] || '').trim().toUpperCase() };
    }).filter(function (r) { return r.cod; });
    return JSON.stringify({
      success: true, proxMatricula: maxMat + 1, rubricas: rub, ferias: ferias,
      filiaisFolha: Object.keys(filFolha).sort(), filiaisFerias: Object.keys(filFerias).sort(),
    });
  } catch (e) { return _err_(e.message); }
}

// d = { nome, filial (folha), inicio (aaaa-mm-dd), salario, salarioProp, registrado, cargo,
//       ferias: { modo: 'novo'|'existente'|'nao', matricula, filial, saldoInicial, ctps },
//       regras: [{ tipo, rubrica, descricao, valor, proporcional, semFalta, obs }] }
function folhaCadastrar_(ft, mes, d) {
  try {
    const email = _folhaSessao_(ft);
    d = d || {};
    const nome = String(d.nome || '').replace(/\s+/g, ' ').trim();
    const filial = String(d.filial || '').trim();
    if (!nome) return _err_('Informe o nome.');
    if (!filial) return _err_('Informe a filial.');
    const inicio = toDate_(d.inicio);
    if (!inicio) return _err_('Informe a data de início (admissão).');
    const salario = Math.round(Number(d.salario) * 100) / 100;
    if (d.salario === '' || d.salario === null || d.salario === undefined || !isFinite(salario) || salario < 0) return _err_('Informe o salário.');
    const registrado = d.registrado !== false;
    const fe = d.ferias || { modo: 'nao' };
    if (['novo', 'existente', 'nao'].indexOf(fe.modo) < 0) return _err_('Escolha o que fazer no painel de férias.');
    if (fe.modo === 'novo' && !String(fe.filial || '').trim()) return _err_('Escolha a filial no painel de férias.');

    const rubs = {};
    _folhaRows_(FOLHA_TAB.RUBRICAS).forEach(function (r) { const c = String(r[0] || '').trim().toUpperCase(); if (c) rubs[c] = String(r[1] || '').trim() || c; });
    const regras = [];
    (Array.isArray(d.regras) ? d.regras : []).forEach(function (g, i) {
      const tipo = _folhaTipoRegra_(FOLHA_TIPOS_REGRA[g && g.tipo] || (g && g.tipo));
      const rub = String(g.rubrica || '').trim().toUpperCase() ||
        (tipo === 'bonus' ? 'BONUS_MANIPULACAO' : tipo === 'piso' ? 'PREMIACAO' : '');
      const valor = Math.round(Number(g.valor) * 100) / 100;
      if (!rub) throw new Error('Regra ' + (i + 1) + ': escolha a rubrica.');
      if (g.valor === '' || g.valor === null || g.valor === undefined || !isFinite(valor) || valor < 0) throw new Error('Regra ' + (i + 1) + ': valor inválido.');
      // Fixo sem descrição: usa o nome da rubrica (a mesma descrição da linha do recibo — é por ela que a regra acha a linha)
      const desc = String(g.descricao || '').trim().slice(0, 120) || (tipo === 'fixo' ? (rubs[rub] || rub) : '');
      regras.push({ tipo: tipo, rubrica: rub, descricao: desc, valor: valor,
        proporcional: !!g.proporcional, semFalta: tipo === 'bonus' && !!g.semFalta, obs: String(g.obs || '').trim().slice(0, 200) });
    });

    // contrato de experiência (opcional): d.experiencia = { d1, d2, obs } — total até 90 dias
    let exper = null;
    if (d.experiencia && Number(d.experiencia.d1) > 0) {
      const d1 = Math.round(Number(d.experiencia.d1)), d2 = Math.round(Number(d.experiencia.d2) || 0);
      if (!(d1 >= 1) || d2 < 0 || d1 + d2 > 90) return _err_('Experiência: o total (1º período + prorrogação) vai até 90 dias.');
      exper = { d1: d1, d2: d2, obs: String(d.experiencia.obs || '').trim().slice(0, 200) };
      Object.assign(exper, _folhaExpDatas_(inicio, d1, d2));
    }

    mes = mes ? _folhaMes_(mes) : '';
    if (_folhaEh13_(mes)) mes = '';   // no 13º o recibo vem do 🎄 Gerar 13º
    // dias no mês aberto (base 30): admitido no mês = do dia da admissão até 30; depois do mês = sem recibo
    let trab = 30, semRecibo = '';
    if (mes) {
      const ym = formatDate_(inicio).slice(0, 7);
      if (ym > mes) { semRecibo = 'admissão depois de ' + mes; mes = ''; }
      else if (ym === mes) trab = Math.max(0, 30 - Math.min(inicio.getDate(), 31) + 1);
    }
    const prop = function (v, sim) { return sim && trab < 30 ? _folhaProp_(v, trab) : v; };
    const fmt = function (v) { return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaFuncionarios_();
      const igual = func.lista.find(function (f) { return f.ativo && _folhaNorm_(f.nome) === _folhaNorm_(nome); });
      if (igual) return _err_('Já existe um funcionário ativo na folha com esse nome (' + igual.id + ', ' + igual.filial + ').');

      // 1) painel de férias
      let matFerias = '', periodoAviso = null;
      if (fe.modo === 'existente') {
        const mk = _mk_(fe.matricula);
        if (!mk || !_rows_(TAB.FUNC).some(function (r) { return _mk_(r[F.MAT]) === mk; }))
          return _err_('Matrícula ' + (fe.matricula || '') + ' não encontrada no painel de férias.');
        matFerias = mk;
      } else if (fe.modo === 'novo') {
        const jaFer = _rows_(TAB.FUNC).find(function (r) {
          return String(r[F.SITUACAO] || '').trim().toLowerCase() !== 'inativo' && _folhaNorm_(r[F.NOME]) === _folhaNorm_(nome);
        });
        if (jaFer) return _err_('Já existe "' + String(jaFer[F.NOME]).trim() + '" no painel de férias (matrícula ' + _mk_(jaFer[F.MAT]) +
          '). Escolha "Já está no painel de férias — só ligar".');
        const rf = JSON.parse(addEmployee_({
          matricula: fe.matricula, nome: nome, filial: String(fe.filial).trim(), cargo: d.cargo, admissao: formatDate_(inicio),
          registrado: registrado, saldoInicial: Number(fe.saldoInicial) || 0, ctps: fe.ctps,
        }));
        if (!rf.success) return _err_('Painel de férias: ' + rf.error);
        matFerias = rf.matricula; periodoAviso = rf.periodoAviso || null;
      }

      // 2) folha — cadastro
      let max = 0;
      func.lista.forEach(function (f) { const m = /^F(\d+)$/i.exec(f.id); if (m) max = Math.max(max, Number(m[1])); });
      const id = 'F' + String(max + 1).padStart(3, '0');
      const shF = _folhaAba_(FOLHA_TAB.FUNC);
      const nr = shF.getLastRow() + 1;
      const piso = '';   // piso vai como regra "Piso premiação" (a coluna J fica para os cadastros antigos)
      shF.getRange(nr, FU.MAT_FERIAS + 1).setNumberFormat('@');
      shF.getRange(nr, 1, 1, FOLHA_HEADERS.Funcionarios.length).setValues([[
        id, nome, filial, inicio, 'Sim', String(matFerias || ''), '', '',
        'Cadastrado no painel ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy'), piso, '']]);
      shF.getRange(nr, FU.INICIO + 1).setNumberFormat('dd/mm/yyyy');

      // 3) regras
      if (regras.length) {
        const shR = _folhaAba_(FOLHA_TAB.REGRAS);
        shR.getRange(shR.getLastRow() + 1, 1, regras.length, FOLHA_HEADERS.Regras.length).setValues(regras.map(function (g) {
          return [id, nome, FOLHA_TIPOS_REGRA[g.tipo], g.rubrica, g.descricao, g.valor,
            g.proporcional ? 'Sim' : 'Não', g.semFalta ? 'Sim' : 'Não', g.obs];
        }));
      }

      // 3b) contrato de experiência
      if (exper) {
        const shE = _folhaAba_(FOLHA_TAB.EXPER);
        const ne = shE.getLastRow() + 1;
        shE.getRange(ne, 1, 1, FOLHA_HEADERS.Experiencia.length).setValues([[id, nome, filial, inicio, exper.d1, exper.fim1,
          exper.d2, exper.fim, exper.obs, new Date()]]);
        [4, 6, 8].forEach(function (c) { shE.getRange(ne, c).setNumberFormat('dd/mm/yyyy'); });
      }

      // 4) recibo do mês aberto, no modelo da folha
      let linhas = [];
      if (mes) {
        const salV = prop(salario, d.salarioProp !== false);
        linhas.push(['P', 'SALARIO', 'Salário (' + fmt(salario) + ')' + (salV !== salario ? ' ' + trab + ' dias' : ''), salV]);
        regras.filter(function (g) { return g.tipo === 'fixo'; }).forEach(function (g) {
          linhas.push(['P', g.rubrica, g.descricao || rubs[g.rubrica] || g.rubrica, prop(g.valor, g.proporcional)]);
        });
        const temPrem = linhas.some(function (l) { return l[1] === 'PREMIACAO'; }) ||
          regras.some(function (g) { return g.tipo === 'piso' && g.rubrica !== 'PREMIACAO' && linhas.some(function (l) { return l[1] === g.rubrica; }); });
        if (!temPrem) {
          const pisoR = regras.filter(function (g) { return g.tipo === 'piso' && g.rubrica === 'PREMIACAO'; })[0];
          linhas.push(['P', 'PREMIACAO', pisoR && pisoR.descricao ? pisoR.descricao : 'Premiação', '']);
        }
        if (registrado) linhas.push(['D', 'INSS', '(-) INSS', '']);
        const sh = _folhaAba_(FOLHA_TAB.LANC);
        const ini = sh.getLastRow() + 1;
        sh.getRange(ini, FL.MES + 1, linhas.length, 1).setNumberFormat('@');
        sh.getRange(ini, 1, linhas.length, 9).setValues(linhas.map(function (l, i) {
          return [mes, id, filial, nome, l[0], l[1], l[2], l[3], i + 1];
        }));
      }
      _folhaLog_(email, 'cadastrar funcionário', id + ' · ' + nome + ' · ' + filial + (matFerias ? ' · férias ' + matFerias : '') +
        ' · ' + regras.length + ' regra(s)' + (mes ? ' · recibo em ' + mes : ''));
      const prov = linhas.reduce(function (s, l) { return s + (l[0] === 'P' && typeof l[3] === 'number' ? l[3] : 0); }, 0);
      const expOut = exper ? { inicio: formatDate_(inicio), d1: exper.d1, fim1: formatDate_(exper.fim1), d2: exper.d2, fim: formatDate_(exper.fim), obs: exper.obs } : null;
      return JSON.stringify({
        success: true, id: id, matFerias: matFerias, periodoAviso: periodoAviso, regras: regras.length, semRecibo: semRecibo, trab: trab,
        experiencia: expOut,
        recibo: mes ? {
          id: id, nome: nome, filial: filial, inicio: formatDateBR_(formatDate_(inicio)), ativo: true, ferias: [], experiencia: expOut || undefined,
          linhas: linhas.map(function (l, i) { return { tipo: l[0], rubrica: l[1], descricao: l[2], valor: l[3] === '' ? null : l[3], ordem: i + 1 }; }),
          proventos: _folhaR2_(prov), descontos: 0, liquido: _folhaR2_(prov) } : null,
      });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// REGRAS POR FUNCIONÁRIO (botão 📋 Regras por funcionário)
//   Aba "Regras": uma linha por regra. Tipos:
//   · Fixo              → a linha do recibo (rubrica + descrição) recebe o valor base; se "Proporcional",
//                         base × dias trabalhados / 30 (férias e atestados do mês descontam), cortando os centavos;
//   · Piso premiação    → mínimo garantido da premiação: ao importar comissões vale o MAIOR entre a
//                         comissão e o piso (proporcional, se marcado). A linha pode ser outra (ex.: Gratificação/Premiação);
//   · Bônus manipulação → só se a venda geral da manipulação do mês passar do limite (padrão 200.000);
//                         com "Exige sem falta/atestado", perde quem teve atestado ou falta informada no fechamento.
//   Regra geral: toda linha GRATIFICACAO sem regra própria e com o valor na descrição — "Gratificação (650,00)" —
//   também fica proporcional aos dias trabalhados.
// ============================================================
FOLHA_TAB.REGRAS = 'Regras';
FOLHA_HEADERS.Regras = ['ID', 'Nome', 'Tipo', 'Rubrica', 'Descrição no recibo', 'Valor base', 'Proporcional',
  'Exige sem falta/atestado', 'Observação'];
const FR = { ID: 0, NOME: 1, TIPO: 2, RUB: 3, DESC: 4, VALOR: 5, PROP: 6, SEMFALTA: 7, OBS: 8 };
const FOLHA_TIPOS_REGRA = { fixo: 'Fixo', piso: 'Piso premiação', bonus: 'Bônus manipulação', decimo: 'Entra no 13º' };
FOLHA_API.folhaRegras = folhaRegras_;
FOLHA_API.folhaRegrasSalvar = folhaRegrasSalvar_;
FOLHA_API.folhaRegrasPrevia = folhaRegrasPrevia_;
FOLHA_API.folhaRegrasAplicar = folhaRegrasAplicar_;

function _folhaTipoRegra_(v) {
  const s = _folhaNorm_(v);
  if (s.indexOf('PISO') === 0) return 'piso';
  if (s.indexOf('BONUS') === 0) return 'bonus';
  if (s.indexOf('ENTRA') === 0 || s.indexOf('DECIMO') === 0 || s.indexOf('13') === 0) return 'decimo';
  return 'fixo';
}
function _folhaSim_(v) { return v === true || /^s/i.test(String(v || '').trim()); }
function _folhaRegras_() {
  return _folhaRows_(FOLHA_TAB.REGRAS).map(function (r) {
    const id = String(r[FR.ID] || '').trim();
    if (!id) return null;
    return {
      id: id, nome: String(r[FR.NOME] || '').trim(), tipo: _folhaTipoRegra_(r[FR.TIPO]),
      rubrica: String(r[FR.RUB] || '').trim().toUpperCase(), descricao: String(r[FR.DESC] || '').trim(),
      valor: _folhaNum_(r[FR.VALOR]), proporcional: _folhaSim_(r[FR.PROP]), semFalta: _folhaSim_(r[FR.SEMFALTA]),
      obs: String(r[FR.OBS] || '').trim(),
    };
  }).filter(Boolean);
}
function _folhaDigitalRegras_(lista) {
  return JSON.stringify(lista.map(function (g) {
    return [g.id, g.tipo, g.rubrica, g.descricao, g.valor, g.proporcional, g.semFalta, g.obs];
  }));
}
function _folhaLimiteBonus_() {
  const v = Number(PropertiesService.getScriptProperties().getProperty('FOLHA_BONUS_LIMITE'));
  return v > 0 ? v : 200000;
}

// tela de regras: regras + funcionários ativos + rubricas
function folhaRegras_(ft) {
  try {
    const email = _folhaSessao_(ft);
    const regras = _folhaRegras_();
    const func = _folhaFuncionarios_();
    const rub = _folhaRows_(FOLHA_TAB.RUBRICAS).map(function (r) {
      return { cod: String(r[0] || '').trim(), nome: String(r[1] || '').trim(), tipo: String(r[2] || '').trim().toUpperCase() };
    }).filter(function (r) { return r.cod; });
    _folhaLog_(email, 'ver regras', regras.length + ' regras');
    return JSON.stringify({
      success: true, regras: regras, antes: _folhaDigitalRegras_(regras), limite: _folhaLimiteBonus_(), rubricas: rub,
      funcionarios: func.lista.filter(function (f) { return f.ativo; })
        .map(function (f) { return { id: f.id, nome: f.nome, filial: f.filial }; }),
    });
  } catch (e) { return _err_(e.message); }
}

// regras = lista completa (substitui a aba); antes = digital que a tela carregou
function folhaRegrasSalvar_(ft, regras, antes, limite) {
  try {
    const email = _folhaSessao_(ft);
    if (!Array.isArray(regras)) return _err_('Nada para gravar.');
    const func = _folhaFuncionarios_();
    const limpas = [];
    for (let i = 0; i < regras.length; i++) {
      const g = regras[i] || {};
      const f = func.porId[String(g.id || '').trim()];
      if (!f) return _err_('Funcionário não encontrado: ' + (g.id || g.nome || '(vazio)'));
      const tipo = _folhaTipoRegra_(FOLHA_TIPOS_REGRA[g.tipo] || g.tipo);
      const rub = String(g.rubrica || '').trim().toUpperCase() ||
        (tipo === 'bonus' ? 'BONUS_MANIPULACAO' : tipo === 'piso' ? 'PREMIACAO' : '');
      if (!rub) return _err_(f.nome + ': escolha a rubrica da regra.');
      const valor = Math.round(Number(g.valor) * 100) / 100;
      if (g.valor === '' || g.valor === null || !isFinite(valor) || valor < 0) return _err_(f.nome + ': valor inválido.');
      limpas.push({ id: f.id, nome: f.nome, tipo: tipo, rubrica: rub, descricao: String(g.descricao || '').trim().slice(0, 120),
        valor: valor, proporcional: !!g.proporcional, semFalta: !!g.semFalta, obs: String(g.obs || '').trim().slice(0, 200) });
    }
    const lim = Number(limite);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (antes && _folhaDigitalRegras_(_folhaRegras_()) !== String(antes))
        return _err_('As regras foram alteradas por outra pessoa depois que a tela abriu. Feche e abra de novo.');
      const sh = _folhaAba_(FOLHA_TAB.REGRAS);
      const n = FOLHA_HEADERS.Regras.length;
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, n).clearContent();
      if (limpas.length) sh.getRange(2, 1, limpas.length, n).setValues(limpas.map(function (g) {
        return [g.id, g.nome, FOLHA_TIPOS_REGRA[g.tipo], g.rubrica, g.descricao, g.valor,
          g.proporcional ? 'Sim' : 'Não', g.semFalta ? 'Sim' : 'Não', g.obs];
      }));
      if (lim > 0) PropertiesService.getScriptProperties().setProperty('FOLHA_BONUS_LIMITE', String(lim));
      _folhaLog_(email, 'salvar regras', limpas.length + ' regras');
      return JSON.stringify({ success: true, antes: _folhaDigitalRegras_(_folhaRegras_()) });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ---------- dias fora no mês (férias de gozo + atestados do painel de férias) ----------
// devolve { idFolha: { ferias, atestado, fora, trab } } — base de 30 dias (mês comercial)
function _folhaAusencias_(mes, funcFolha) {
  const p = mes.split('-').map(Number);
  const ini = new Date(p[0], p[1] - 1, 1), fim = new Date(p[0], p[1], 0);
  const dentro = function (a, b) {
    const s = a < ini ? ini : a, e = b > fim ? fim : b;
    return e < s ? 0 : Math.round((_midnight_(e) - _midnight_(s)) / 864e5) + 1;
  };
  const mat = _folhaLigarFerias_(funcFolha);
  const porMat = {};
  const soma = function (m, campo, d) { const o = porMat[m] || (porMat[m] = { ferias: 0, atestado: 0 }); o[campo] += d; };
  _rows_(TAB.LANC).forEach(function (r) {
    const m = _mk_(r[L.MAT]);
    if (!m || _statusLanc_(r) === ST.RECUS || String(r[L.TIPO] || 'Gozo').trim().toLowerCase() !== 'gozo') return;
    const a = toDate_(r[L.INICIO]), b = toDate_(r[L.TERMINO]);
    if (a && b) soma(m, 'ferias', dentro(a, b));
  });
  try {
    const sh = SpreadsheetApp.openById(MODEL_SHEET_ID).getSheetByName(TAB.ATESTADOS);
    if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, ATESTADOS_HEADERS.length).getValues().forEach(function (r) {
      const m = _mk_(r[AT.MAT]), a = toDate_(r[AT.INICIO]), b = toDate_(r[AT.FIM]);
      if (m && a && b) soma(m, 'atestado', dentro(a, b));
    });
  } catch (e) { /* sem aba de atestados */ }
  const out = {};
  funcFolha.forEach(function (f) {
    const o = porMat[mat[f.id]] || { ferias: 0, atestado: 0 };
    const fora = Math.min(30, o.ferias + o.atestado);
    out[f.id] = { ferias: o.ferias, atestado: o.atestado, fora: fora, trab: 30 - fora };
  });
  return out;
}
// base × dias trabalhados / 30, cortando (não arredondando) os centavos — como a folha já fazia
function _folhaProp_(base, trab) {
  return Math.floor(Number(base) * 100 * trab / 30 + 1e-6) / 100;
}
// 1º valor em reais escrito na descrição: "Gratificação (1.450,00) 10/2026" -> 1450
function _folhaValorDaDesc_(desc) {
  const m = String(desc || '').match(/(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?!\d)/);
  return m ? Number(m[1].replace(/\./g, '') + '.' + m[2]) : null;
}

// ---------- cálculo (função pura: testável fora do Apps Script) ----------
// recibos = { id: [{ tipo, rubrica, descricao, valor }] em ordem }; regras = _folhaRegras_();
// aus = _folhaAusencias_; opt = { bonusLiberado: bool, semDireito: { id: true } }
// devolve { id: { linhas: [...novas], mudancas: [{ acao, rubrica, descricao, de, para, origem }], bonus, aus } }
function _folhaRegrasPlano_(recibos, regras, aus, opt) {
  const porId = {};
  regras.forEach(function (g) { (porId[g.id] = porId[g.id] || []).push(g); });
  const out = {};
  Object.keys(recibos).forEach(function (id) {
    const a = aus[id] || { ferias: 0, atestado: 0, fora: 0, trab: 30 };
    const linhas = recibos[id].map(function (l) { return { tipo: l.tipo, rubrica: l.rubrica, descricao: l.descricao, valor: l.valor }; });
    const usada = linhas.map(function () { return false; });
    const remover = {};
    const mud = [];
    const minhas = (porId[id] || []).filter(function (g) { return g.tipo !== 'decimo'; });
    // 1ª passada: mesma rubrica e mesma descrição; 2ª: só a rubrica (1ª linha livre)
    const alvo = minhas.map(function () { return -1; });
    [true, false].forEach(function (exata) {
      minhas.forEach(function (g, k) {
        if (alvo[k] >= 0) return;
        for (let i = 0; i < linhas.length; i++) {
          if (usada[i] || String(linhas[i].rubrica).toUpperCase() !== g.rubrica) continue;
          if (exata && (!g.descricao || _folhaNorm_(linhas[i].descricao) !== _folhaNorm_(g.descricao))) continue;
          alvo[k] = i; usada[i] = true; break;
        }
      });
    });
    const novo = function (g, valor, origem) {
      linhas.push({ tipo: 'P', rubrica: g.rubrica, descricao: g.descricao || g.rubrica, valor: valor });
      usada.push(true);
      mud.push({ acao: 'incluir', rubrica: g.rubrica, descricao: g.descricao || g.rubrica, de: null, para: valor, origem: origem });
    };
    const trocar = function (i, valor, origem) {
      const de = linhas[i].valor === '' || linhas[i].valor === undefined ? null : linhas[i].valor;
      if (de !== null && Math.abs(Number(de) - valor) < 0.005) return;
      linhas[i].valor = valor;
      mud.push({ acao: 'alterar', rubrica: linhas[i].rubrica, descricao: linhas[i].descricao, de: de, para: valor, origem: origem });
    };
    let bonus = null;
    minhas.forEach(function (g, k) {
      const i = alvo[k];
      if (g.tipo === 'fixo') {
        const v = g.proporcional ? _folhaProp_(g.valor, a.trab) : g.valor;
        if (i >= 0) trocar(i, v, 'regra'); else novo(g, v, 'regra');
      } else if (g.tipo === 'bonus') {
        const falta = !!(opt.semDireito && opt.semDireito[id]);
        const perdeu = g.semFalta && (a.atestado > 0 || falta);
        const v = g.proporcional ? _folhaProp_(g.valor, a.trab) : g.valor;
        bonus = { valor: v, semFalta: g.semFalta, atestado: a.atestado, falta: falta, recebe: !!opt.bonusLiberado && !perdeu };
        if (bonus.recebe) { if (i >= 0) trocar(i, v, 'bônus'); else novo(g, v, 'bônus'); }
        else if (i >= 0) {
          remover[i] = true;
          mud.push({ acao: 'remover', rubrica: linhas[i].rubrica, descricao: linhas[i].descricao, de: linhas[i].valor, para: null, origem: 'bônus' });
        }
      }
      // piso: só reserva a linha (a premiação é calculada na importação de comissões)
    });
    // regra geral: Gratificação com valor na descrição
    linhas.forEach(function (l, i) {
      if (usada[i] || String(l.rubrica).toUpperCase() !== 'GRATIFICACAO') return;
      const base = _folhaValorDaDesc_(l.descricao);
      if (base !== null) trocar(i, _folhaProp_(base, a.trab), 'geral');
    });
    if (mud.length || bonus) out[id] = {
      linhas: linhas.filter(function (l, i) { return !remover[i]; }), mudancas: mud, bonus: bonus, aus: a };
  });
  return out;
}

// pisos de premiação do mês: { id: { base, valor, trab, rubrica, descricao } } (regras; senão coluna J)
function _folhaPisos_(func, regras, aus) {
  const out = {};
  regras.forEach(function (g) {
    if (g.tipo !== 'piso' || out[g.id]) return;
    const t = (aus[g.id] || { trab: 30 }).trab;
    out[g.id] = { base: g.valor, valor: g.proporcional ? _folhaProp_(g.valor, t) : g.valor, trab: t,
      rubrica: g.rubrica || 'PREMIACAO', descricao: g.descricao };
  });
  func.lista.forEach(function (f) {
    if (out[f.id] || !(f.piso > 0)) return;
    const t = (aus[f.id] || { trab: 30 }).trab;
    out[f.id] = { base: f.piso, valor: _folhaProp_(f.piso, t), trab: t, rubrica: 'PREMIACAO', descricao: '' };
  });
  return out;
}

function _folhaRegrasMontar_(mes, manip, semDireito) {
  mes = _folhaMes_(mes);
  if (!mes) throw new Error('Mês inválido.');
  if (_folhaEh13_(mes)) throw new Error('As regras do mês não se aplicam ao 13º salário — ele é gerado pelo botão 🎄 Gerar 13º.');
  const func = _folhaFuncionarios_();
  const rows = _folhaRows_(FOLHA_TAB.LANC);
  const recibos = {}, pos = {};
  rows.forEach(function (r, i) {
    if (_folhaMes_(r[FL.MES]) !== mes) return;
    const id = String(r[FL.ID] || '').trim();
    const f = func.porId[id];
    if (!f || !f.ativo) return;
    (pos[id] = pos[id] || []).push({ i: i, ordem: Number(r[FL.ORDEM]) || 0 });
  });
  Object.keys(pos).forEach(function (id) {
    pos[id].sort(function (a, b) { return a.ordem - b.ordem; });
    recibos[id] = pos[id].map(function (p) {
      const r = rows[p.i];
      return { tipo: String(r[FL.TIPO] || '').trim().toUpperCase(), rubrica: String(r[FL.RUB] || '').trim(),
        descricao: String(r[FL.DESC] || ''), valor: _folhaNum_(r[FL.VALOR]) };
    });
  });
  if (!Object.keys(recibos).length) throw new Error('Nenhum recibo em ' + _folhaNomeMes_(mes) + '.');
  const aus = _folhaAusencias_(mes, func.lista);
  const limite = _folhaLimiteBonus_();
  const m = Number(manip) || 0;
  const plano = _folhaRegrasPlano_(recibos, _folhaRegras_(), aus,
    { bonusLiberado: m > limite, semDireito: semDireito || {} });
  return { mes: mes, func: func, rows: rows, pos: pos, plano: plano, limite: limite, manip: m };
}

function folhaRegrasPrevia_(ft, mes, manip) {
  try {
    const email = _folhaSessao_(ft);
    const x = _folhaRegrasMontar_(mes, manip, {});
    const lista = Object.keys(x.plano).map(function (id) {
      const f = x.func.porId[id], p = x.plano[id];
      return { id: id, nome: f.nome, filial: f.filial, aus: p.aus, mudancas: p.mudancas, bonus: p.bonus };
    }).sort(function (a, b) { return a.filial.localeCompare(b.filial) || a.nome.localeCompare(b.nome); });
    _folhaLog_(email, 'regras (prévia)', x.mes + ': ' + lista.length + ' funcionários');
    return JSON.stringify({ success: true, mes: x.mes, limite: x.limite, manip: x.manip, bonusLiberado: x.manip > x.limite, lista: lista });
  } catch (e) { return _err_(e.message); }
}

// semDireito = [id] — quem perde o bônus por falta (informado pela gestora no fechamento)
function folhaRegrasAplicar_(ft, mes, manip, semDireito) {
  try {
    const email = _folhaSessao_(ft);
    const sd = {};
    (semDireito || []).forEach(function (id) { sd[String(id).trim()] = true; });
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const x = _folhaRegrasMontar_(mes, manip, sd);
      const rows = x.rows.slice();
      const tirar = {}, extras = [];
      let nRec = 0, nMud = 0;
      Object.keys(x.plano).forEach(function (id) {
        const p = x.plano[id];
        if (!p.mudancas.length) return;
        nRec++; nMud += p.mudancas.length;
        const ps = x.pos[id], base = rows[ps[0].i];
        const lin = p.linhas.map(function (l, k) {
          return [x.mes, id, base[FL.FILIAL], base[FL.NOME], l.tipo, l.rubrica, l.descricao,
            l.valor === null || l.valor === undefined ? '' : l.valor, k + 1];
        });
        const lugares = ps.map(function (q) { return q.i; }).sort(function (a, b) { return a - b; });
        lin.forEach(function (v, k) { if (k < lugares.length) rows[lugares[k]] = v; else extras.push(v); });
        lugares.slice(lin.length).forEach(function (i) { tirar[i] = true; });
      });
      if (!nRec) return JSON.stringify({ success: true, recibos: 0, mudancas: 0 });
      // reescreve a aba inteira de uma vez (mês sempre como texto "aaaa-mm")
      const novas = rows.filter(function (r, i) { return !tirar[i]; }).concat(extras)
        .map(function (r) { const c = r.slice(); c[FL.MES] = _folhaMes_(c[FL.MES]) || c[FL.MES]; return c; });
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const n = FOLHA_HEADERS.Lancamentos.length;
      sh.getRange(2, FL.MES + 1, novas.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, novas.length, n).setValues(novas);
      const sobra = x.rows.length - novas.length;
      if (sobra > 0) sh.getRange(2 + novas.length, 1, sobra, n).clearContent();
      _folhaLog_(email, 'aplicar regras', x.mes + ': ' + nRec + ' recibos, ' + nMud + ' mudanças; manipulação ' + x.manip
        + (Object.keys(sd).length ? '; sem bônus por falta: ' + Object.keys(sd).join(',') : ''));
      return JSON.stringify({ success: true, recibos: nRec, mudancas: nMud });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// 13º SALÁRIO (botão 🎄 Gerar 13º)
//   Parcela única em dezembro. Fica na aba Lancamentos como um "mês" especial "aaaa-13", e assim
//   lista, ✏ Editar, totais por filial e impressão funcionam como num mês comum.
//   Regras (modelo de 2025, confirmadas pelo RH):
//   · valor = salário do recibo de dezembro (ou do último mês do ano) × avos ÷ 12, centavos cortados;
//   · avos = meses do ano a partir da admissão; o mês da admissão conta se entrou até o dia 15.
//     Faltas não tiram avos. Desligados ficam de fora (recebem na rescisão) — só ativos;
//   · entram só as linhas SALARIO + as regras "Entra no 13º" (gratificações fixas, limpeza…);
//   · INSS e IR vêm da contabilidade: as linhas saem em branco (só para quem tem INSS/IR no recibo-base);
//   · afastamento pelo INSS (auxílio-doença) reduz avos — a prévia deixa trocar os avos e avisa
//     quem tem atestado longo no ano; licença-maternidade NÃO reduz (a empresa paga e compensa no INSS).
// ============================================================
FOLHA_API.folha13Previa = folha13Previa_;
FOLHA_API.folha13Gravar = folha13Gravar_;

function _folhaEh13_(mes) { return /-13$/.test(String(mes || '')); }

// avos do 13º: admissão antes do ano = 12; no ano = meses a partir da admissão (o mês conta se entrou até o dia 15)
function _folha13Avos_(adm, ano) {
  if (!(adm instanceof Date) || isNaN(adm.getTime())) return null;
  const y = adm.getFullYear();
  if (y < ano) return 12;
  if (y > ano) return 0;
  return Math.max(0, 12 - adm.getMonth() - (adm.getDate() > 15 ? 1 : 0));
}
function _folha13Valor_(base, avos) { return Math.floor(Number(base) * 100 * avos / 12 + 1e-6) / 100; }

// ---------- cálculo (função pura) ----------
// recibos = { id: [{ tipo, rubrica, descricao, valor }] } do mês-base; info = { id: { adm: Date|null, admTxt, atestadoMax } };
// regras = _folhaRegras_(); ajuste = { id: avos } (trocado na prévia)
// devolve { id: { avos, avosCalc, linhas: [{ tipo, rubrica, descricao, valor, base }], total, avisos: [] } }
function _folha13Plano_(ano, recibos, info, regras, ajuste) {
  const porId = {};
  regras.forEach(function (g) { if (g.tipo === 'decimo') (porId[g.id] = porId[g.id] || []).push(g); });
  const out = {};
  Object.keys(recibos).forEach(function (id) {
    const ls = recibos[id], inf = info[id] || {}, avisos = [];
    let avosCalc = _folha13Avos_(inf.adm, ano);
    if (avosCalc === null) { avosCalc = 12; avisos.push('sem data de admissão — contei 12 meses, confira'); }
    else if (avosCalc < 12) avisos.push('entrou em ' + inf.admTxt + ' — proporcional');
    const aj = ajuste && ajuste[id] !== undefined && ajuste[id] !== null && ajuste[id] !== '' ? Number(ajuste[id]) : null;
    const avos = aj !== null && isFinite(aj) && aj >= 0 && aj <= 12 ? Math.floor(aj) : avosCalc;
    if (avos !== avosCalc) avisos.push('meses trocados na prévia: ' + avosCalc + ' → ' + avos);
    if (inf.atestadoMax > 15) avisos.push('atestado de ' + inf.atestadoMax + ' dias no ano — se foi afastamento pelo INSS, diminua os meses');

    const prov = [];
    const usada = ls.map(function () { return false; });
    ls.forEach(function (l, i) {
      if (String(l.rubrica).toUpperCase() !== 'SALARIO' || !(Number(l.valor) > 0)) return;
      usada[i] = true;
      prov.push({ descricao: l.descricao || 'Salário', base: Number(l.valor), origem: 'salário' });
    });
    (porId[id] || []).forEach(function (g) {
      // acha a linha do recibo: descrição igual → mesmo começo da descrição (antes do "(", o valor pode ter mudado) → só a rubrica
      const inicio = function (s) { return _folhaNorm_(String(s || '').split('(')[0]); };
      let k = -1;
      ['exata', 'inicio', 'rubrica'].forEach(function (modo) {
        if (k >= 0) return;
        for (let i = 0; i < ls.length; i++) {
          if (usada[i] || String(ls[i].rubrica).toUpperCase() !== g.rubrica) continue;
          if (modo === 'exata' && (!g.descricao || _folhaNorm_(ls[i].descricao) !== _folhaNorm_(g.descricao))) continue;
          if (modo === 'inicio' && (!g.descricao || !inicio(g.descricao) || inicio(ls[i].descricao) !== inicio(g.descricao))) continue;
          k = i; break;
        }
      });
      if (k >= 0) usada[k] = true;
      // valor 0 na regra = usa o valor da linha no recibo-base (acompanha reajuste)
      const base = g.valor > 0 ? g.valor : (k >= 0 ? Number(ls[k].valor) || 0 : 0);
      if (!(base > 0)) { avisos.push('regra "' + (g.descricao || g.rubrica) + '" sem valor — ficou de fora'); return; }
      const desc = !(g.valor > 0) && k >= 0 ? ls[k].descricao : (g.descricao || (k >= 0 ? ls[k].descricao : g.rubrica));
      prov.push({ descricao: desc, base: base, origem: 'regra' });
    });
    if (!prov.length || avos === 0) { avisos.push(!prov.length ? 'sem salário no recibo-base — não gerei o 13º' : '0 meses no ano — sem 13º'); out[id] = { avos: avos, avosCalc: avosCalc, linhas: [], total: 0, avisos: avisos }; return; }

    const linhas = prov.map(function (p) {
      return { tipo: 'P', rubrica: 'DECIMO_TERCEIRO', descricao: p.descricao + (avos < 12 ? ' — ' + avos + '/12' : ''),
        valor: _folha13Valor_(p.base, avos), base: p.base, origem: p.origem };
    });
    const tem = function (rub) { return ls.some(function (l) { return String(l.rubrica).toUpperCase() === rub; }); };
    if (tem('INSS')) linhas.push({ tipo: 'D', rubrica: 'INSS', descricao: '(-) INSS 13º', valor: null });
    else avisos.push('sem INSS no recibo-base (sem registro?)');
    if (tem('IRRF')) linhas.push({ tipo: 'D', rubrica: 'IRRF', descricao: '(-) IR 13º', valor: null });
    const total = Math.round(linhas.reduce(function (s, l) { return s + (l.tipo === 'P' ? l.valor : 0); }, 0) * 100) / 100;
    out[id] = { avos: avos, avosCalc: avosCalc, linhas: linhas, total: total, avisos: avisos };
  });
  return out;
}

// monta tudo a partir da planilha: mês-base, admissões (painel de férias, senão "Início" da folha), atestados do ano
function _folha13Montar_(ano, ajuste) {
  ano = Number(ano);
  if (!(ano >= 2000 && ano <= 2100)) throw new Error('Ano inválido.');
  const mes13 = ano + '-13';
  const rows = _folhaRows_(FOLHA_TAB.LANC);
  const meses = {};
  rows.forEach(function (r) { const m = _folhaMes_(r[FL.MES]); if (m) meses[m] = 1; });
  const doAno = Object.keys(meses).filter(function (m) { return m.indexOf(ano + '-') === 0 && !_folhaEh13_(m); }).sort();
  if (!doAno.length) throw new Error('Não há nenhum mês de ' + ano + ' na folha para tirar os salários.');
  const base = doAno[doAno.length - 1];
  const func = _folhaFuncionarios_();
  const pos = {};
  rows.forEach(function (r, i) {
    if (_folhaMes_(r[FL.MES]) !== base) return;
    const id = String(r[FL.ID] || '').trim();
    const f = func.porId[id];
    if (!f || !f.ativo) return;
    (pos[id] = pos[id] || []).push({ i: i, ordem: Number(r[FL.ORDEM]) || 0 });
  });
  const recibos = {};
  Object.keys(pos).forEach(function (id) {
    recibos[id] = pos[id].sort(function (a, b) { return a.ordem - b.ordem; }).map(function (p) {
      const r = rows[p.i];
      return { tipo: String(r[FL.TIPO] || '').trim().toUpperCase(), rubrica: String(r[FL.RUB] || '').trim(),
        descricao: String(r[FL.DESC] || ''), valor: _folhaNum_(r[FL.VALOR]), filial: String(r[FL.FILIAL] || ''), nome: String(r[FL.NOME] || '') };
    });
  });
  // admissão: painel de férias (Func.Admissão) pela ligação de sempre; sem ela, "Início" da folha
  const info = {};
  let liga = {}, admFer = {}, atest = {};
  try {
    liga = _folhaLigarFerias_(func.lista);
    _rows_(TAB.FUNC).forEach(function (r) { const m = _mk_(r[F.MAT]); if (m) admFer[m] = toDate_(r[F.ADMISSAO]); });
  } catch (e) { liga = {}; }
  try {
    const ini = new Date(ano, 0, 1), fim = new Date(ano, 11, 31);
    const sh = SpreadsheetApp.openById(MODEL_SHEET_ID).getSheetByName(TAB.ATESTADOS);
    if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, ATESTADOS_HEADERS.length).getValues().forEach(function (r) {
      const m = _mk_(r[AT.MAT]), a = toDate_(r[AT.INICIO]), b = toDate_(r[AT.FIM]);
      if (!m || !a || !b || b < ini || a > fim) return;
      const d = Math.round((_midnight_(b > fim ? fim : b) - _midnight_(a < ini ? ini : a)) / 864e5) + 1;
      atest[m] = Math.max(atest[m] || 0, d);
    });
  } catch (e) { atest = {}; }
  Object.keys(recibos).forEach(function (id) {
    const f = func.porId[id], mat = liga[id];
    let adm = mat && admFer[mat] ? admFer[mat] : null, fonte = adm ? 'painel de férias' : '';
    if (!adm) { const v = f.row[FU.INICIO]; adm = v instanceof Date ? v : (v ? toDate_(v) : null); if (adm) fonte = 'início na folha'; }
    info[id] = { adm: adm, admTxt: adm ? formatDateBR_(formatDate_(adm)) : '', fonte: fonte, atestadoMax: mat ? (atest[mat] || 0) : 0 };
  });
  const plano = _folha13Plano_(ano, recibos, info, _folhaRegras_(), ajuste || {});
  return { ano: ano, mes13: mes13, base: base, existe: !!meses[mes13], rows: rows, func: func, recibos: recibos, info: info, plano: plano };
}

function folha13Previa_(ft, ano, ajuste) {
  try {
    const email = _folhaSessao_(ft);
    const x = _folha13Montar_(ano, ajuste);
    const lista = Object.keys(x.plano).map(function (id) {
      const f = x.func.porId[id], p = x.plano[id], inf = x.info[id];
      return { id: id, nome: f.nome, filial: f.filial || x.recibos[id][0].filial, admissao: inf.admTxt, fonte: inf.fonte,
        avos: p.avos, avosCalc: p.avosCalc, linhas: p.linhas, total: p.total, avisos: p.avisos };
    }).sort(function (a, b) { return a.filial.localeCompare(b.filial) || a.nome.localeCompare(b.nome); });
    const total = Math.round(lista.reduce(function (s, r) { return s + r.total; }, 0) * 100) / 100;
    _folhaLog_(email, '13º (prévia)', x.ano + ' a partir de ' + x.base + ': ' + lista.length + ' funcionários');
    return JSON.stringify({ success: true, ano: x.ano, mes: x.mes13, base: x.base, existe: x.existe, total: total, lista: lista });
  } catch (e) { return _err_(e.message); }
}

// ajuste = { id: avos }; excluir = [id] (não gera o 13º desses); substituir = true apaga o 13º já gerado e grava de novo
function folha13Gravar_(ft, ano, ajuste, excluir, substituir) {
  try {
    const email = _folhaSessao_(ft);
    const fora = {};
    (excluir || []).forEach(function (id) { fora[String(id).trim()] = true; });
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const x = _folha13Montar_(ano, ajuste);
      if (x.existe && !substituir) return _err_('O 13º de ' + x.ano + ' já foi gerado. Marque "substituir" para gerar de novo (as edições feitas nele se perdem).');
      const novas = [];
      let nFunc = 0, total = 0;
      Object.keys(x.plano).sort().forEach(function (id) {
        const p = x.plano[id];
        if (fora[id] || !p.linhas.length) return;
        const f = x.func.porId[id], r0 = x.recibos[id][0];
        const filial = f.filial || r0.filial, nome = f.nome || r0.nome;
        p.linhas.forEach(function (l, k) {
          novas.push([x.mes13, id, filial, nome, l.tipo, l.rubrica, l.descricao, l.valor === null ? '' : l.valor, k + 1]);
        });
        nFunc++; total += p.total;
      });
      if (!novas.length) return _err_('Nenhum 13º para gravar.');
      const manter = x.rows.filter(function (r) { return _folhaMes_(r[FL.MES]) !== x.mes13; });
      const todas = manter.concat(novas).map(function (r) { const c = r.slice(); c[FL.MES] = _folhaMes_(c[FL.MES]) || c[FL.MES]; return c; });
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const n = FOLHA_HEADERS.Lancamentos.length;
      sh.getRange(2, FL.MES + 1, todas.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, todas.length, n).setValues(todas);
      const sobra = x.rows.length - todas.length;
      if (sobra > 0) sh.getRange(2 + todas.length, 1, sobra, n).clearContent();
      total = Math.round(total * 100) / 100;
      _folhaLog_(email, 'gerar 13º', x.ano + ' a partir de ' + x.base + ': ' + nFunc + ' recibos, total ' + total
        + (x.existe ? ' (substituiu o anterior)' : '') + (Object.keys(fora).length ? '; fora: ' + Object.keys(fora).join(',') : ''));
      return JSON.stringify({ success: true, mes: x.mes13, base: x.base, recibos: nFunc, total: total });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// IMPORTAR RECIBOS DA CONTABILIDADE (⬇ INSS/IR da contabilidade)
// ============================================================
// O navegador lê os PDFs do Domínio ("Recibo de Pagamento", 1 por empresa) e manda só
// [{ nome, empresa, adm, inss, ir, cons }] — o INSS/IR de cada recibo já com a regra aplicada
// (mês normal: sem INSS/IRRF de férias e de 13º; no 13º: todos) e o consignado (DESC. EMP. CRED. TRAB).
// Grava nas linhas D INSS / D IRRF / D CONSIGNADO do recibo do mês (cria a linha se faltar). Vínculos de nome
// ficam na coluna "Nome na contabilidade" de Funcionarios.
FOLHA_API.folhaContabPrevia = folhaContabPrevia_;
FOLHA_API.folhaContabGravar = folhaContabGravar_;

function _folhaR2_(v) { return Math.round((Number(v) || 0) * 100) / 100; }
// agrupa os recibos pelo nome (pessoa em duas empresas = soma)
function _folhaContabGrupos_(lista) {
  const g = {};
  (lista || []).forEach(function (r) {
    const k = _folhaNorm_(r && r.nome);
    if (!k) return;
    const o = g[k] || (g[k] = { nome: String(r.nome).trim(), inss: 0, ir: 0, cons: 0, empresas: [], adm: '' });
    o.inss = _folhaR2_(o.inss + (Number(r.inss) || 0));
    o.cons = _folhaR2_(o.cons + (Number(r.cons) || 0));
    o.ir = _folhaR2_(o.ir + (Number(r.ir) || 0));
    if (r.empresa && o.empresas.indexOf(String(r.empresa)) < 0) o.empresas.push(String(r.empresa));
    if (!o.adm && r.adm) o.adm = String(r.adm);
  });
  return g;
}
// função pura: casa os recibos com os funcionários. func = lista de _folhaContabFunc_();
// atual = { id: { inss, ir, recibo } } do mês (_folhaContabAtual_)
function _folhaContabPlano_(func, lista, atual) {
  const grupos = _folhaContabGrupos_(lista);
  const fc = func.map(function (f) { return { id: f.id, nome: f.nome, ativo: f.ativo, filial: f.filial, apelidosCom: f.apelidosCont || [], apelidosMan: [] }; });
  const itens = Object.keys(grupos).map(function (k) { return { nome: grupos[k].nome, valor: 0 }; });
  const r = _folhaCasar_(fc, itens, []);
  const porId = {};
  func.forEach(function (f) { porId[f.id] = f; });
  const linhas = Object.keys(r.porFunc).map(function (id) {
    const f = porId[id], c = r.porFunc[id], a = atual[id] || { inss: null, ir: null, cons: null, recibo: false };
    let inss = 0, ir = 0, cons = 0, emp = [], adm = '';
    c.comNomes.forEach(function (n) {
      const gg = grupos[_folhaNorm_(n)];
      inss += gg.inss; ir += gg.ir; cons += gg.cons; emp = emp.concat(gg.empresas); if (!adm) adm = gg.adm;
    });
    return {
      id: id, nome: f.nome, filial: f.filial, nomesCont: c.comNomes, vinculado: c.vinculado, empresas: emp,
      inss: _folhaR2_(inss), ir: _folhaR2_(ir), cons: _folhaR2_(cons), inssAtual: a.inss, irAtual: a.ir, consAtual: a.cons, temRecibo: !!a.recibo, adm: adm,
      inicio: f.inicioTxt || '',
    };
  });
  const comValor = function (v) {
    const gg = grupos[_folhaNorm_(v.nome)];
    return { nome: v.nome, opcoes: v.opcoes, inss: gg.inss, ir: gg.ir, cons: gg.cons, empresas: gg.empresas, adm: gg.adm };
  };
  return { linhas: linhas, semFuncionario: r.semFuncionario.map(comValor), empates: r.empates.map(comValor) };
}
// INSS/IR/consignado atuais do mês por funcionário (soma das linhas D INSS / D IRRF / D CONSIGNADO)
function _folhaContabAtual_(mes, rows) {
  const out = {};
  rows.forEach(function (r) {
    if (_folhaMes_(r[FL.MES]) !== mes) return;
    const id = String(r[FL.ID] || '').trim();
    const o = out[id] || (out[id] = { inss: null, ir: null, cons: null, recibo: true });
    if (String(r[FL.TIPO]).trim() !== 'D') return;
    const rub = String(r[FL.RUB]).trim().toUpperCase(), v = _folhaNum_(r[FL.VALOR]);
    if (rub === 'INSS') o.inss = _folhaR2_((o.inss || 0) + (v || 0));
    else if (rub === 'IRRF') o.ir = _folhaR2_((o.ir || 0) + (v || 0));
    else if (rub === 'CONSIGNADO') o.cons = _folhaR2_((o.cons || 0) + (v || 0));
  });
  return out;
}
function _folhaContabFunc_() {
  const func = _folhaFuncionarios_();
  func.lista.forEach(function (f) {
    const v = f.row[FU.INICIO];
    f.inicioTxt = v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(v || '').trim();
  });
  return func;
}

function folhaContabPrevia_(ft, mes, lista) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    if (!Array.isArray(lista) || !lista.length) return _err_('Nenhum recibo lido.');
    const func = _folhaContabFunc_();
    const p = _folhaContabPlano_(func.lista, lista, _folhaContabAtual_(mes, _folhaRows_(FOLHA_TAB.LANC)));
    _folhaLog_(email, 'contabilidade (prévia)', mes + ': ' + lista.length + ' recibos, ' + p.linhas.length + ' funcionários');
    return JSON.stringify({
      success: true, mes: mes, linhas: p.linhas, semFuncionario: p.semFuncionario, empates: p.empates,
      funcionarios: func.lista.filter(function (f) { return f.ativo; }).map(function (f) { return { id: f.id, nome: f.nome, filial: f.filial, inicio: f.inicioTxt }; }),
    });
  } catch (e) { return _err_(e.message); }
}

// itens = [{ id, inss, ir, cons, adm }]; vinculos = [{ id, nome }]; adm = true para preencher o "Início" de quem está sem
function folhaContabGravar_(ft, mes, itens, vinculos, arquivos, adm) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    if (!Array.isArray(itens) || !itens.length) return _err_('Nada para gravar.');
    const eh13 = _folhaEh13_(mes);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaContabFunc_();
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const rows = _folhaRows_(FOLHA_TAB.LANC);
      const pos = {};   // id -> { INSS: [índices], IRRF: [índices], CONSIGNADO: [índices], ordem, filial, nome }
      rows.forEach(function (r, i) {
        if (_folhaMes_(r[FL.MES]) !== mes) return;
        const id = String(r[FL.ID] || '').trim();
        const o = pos[id] || (pos[id] = { INSS: [], IRRF: [], CONSIGNADO: [], ordem: 0, filial: r[FL.FILIAL], nome: r[FL.NOME] });
        o.ordem = Math.max(o.ordem, Number(r[FL.ORDEM]) || 0);
        const rub = String(r[FL.RUB]).trim().toUpperCase();
        if (String(r[FL.TIPO]).trim() === 'D' && (rub === 'INSS' || rub === 'IRRF' || rub === 'CONSIGNADO')) o[rub].push(i);
      });
      const vals = rows.map(function (r) { return [r[FL.VALOR]]; });
      const novas = [], semRecibo = [];
      let n = 0, tInss = 0, tIr = 0, tCons = 0, mudou = false;
      itens.forEach(function (it) {
        const id = String(it && it.id || '').trim();
        const f = func.porId[id], o = pos[id];
        if (!f) return;
        if (!o) { semRecibo.push(f.nome); return; }
        [['INSS', _folhaR2_(it.inss), eh13 ? '(-) INSS 13º' : '(-) INSS'], ['IRRF', _folhaR2_(it.ir), eh13 ? '(-) IR 13º' : '(-) IR'], ['CONSIGNADO', _folhaR2_(it.cons), '(-) Consignado (crédito do trabalhador)']].forEach(function (c) {
          const v = c[1];
          if (!isFinite(v) || v < 0) return;
          if (o[c[0]].length) {
            o[c[0]].forEach(function (i, k) { vals[i][0] = k === 0 && v > 0 ? v : ''; });   // 1ª linha recebe; as outras zeram
            mudou = true;
          } else if (v > 0) {
            o.ordem++;
            novas.push([mes, id, o.filial, o.nome, 'D', c[0], c[2], v, o.ordem]);
          }
        });
        tInss += _folhaR2_(it.inss); tIr += _folhaR2_(it.ir); tCons += _folhaR2_(it.cons); n++;
      });
      if (mudou && rows.length) sh.getRange(2, FL.VALOR + 1, rows.length, 1).setValues(vals);
      if (novas.length) {
        const ini = sh.getLastRow() + 1;
        sh.getRange(ini, FL.MES + 1, novas.length, 1).setNumberFormat('@');
        sh.getRange(ini, 1, novas.length, novas[0].length).setValues(novas);
      }
      // vínculos de nome e data de admissão no cadastro
      const shF = _folhaAba_(FOLHA_TAB.FUNC);
      (vinculos || []).forEach(function (vk) {
        const f = func.porId[String(vk && vk.id || '').trim()];
        const nome = String(vk && vk.nome || '').trim();
        if (!f || !nome || _folhaApelidos_(f.row[FU.NOME_CONT]).indexOf(_folhaNorm_(nome)) >= 0) return;
        const novo = [String(f.row[FU.NOME_CONT] || '').trim(), nome].filter(String).join(' ; ');
        shF.getRange(f.linha, FU.NOME_CONT + 1).setValue(novo);
        f.row[FU.NOME_CONT] = novo;
      });
      let nAdm = 0;
      if (adm) itens.forEach(function (it) {
        const f = func.porId[String(it && it.id || '').trim()];
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(it && it.adm || '').trim());
        if (!f || !m || f.inicioTxt) return;
        shF.getRange(f.linha, FU.INICIO + 1).setValue(new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).setNumberFormat('dd/mm/yyyy');
        f.inicioTxt = it.adm; nAdm++;
      });
      _folhaAba_(FOLHA_TAB.IMPORT).appendRow([new Date(), email, mes, String(arquivos || '').slice(0, 500), 'INSS/IR contabilidade', n, _folhaR2_(tInss + tIr + tCons),
        'INSS ' + _folhaR2_(tInss) + ' · IR ' + _folhaR2_(tIr) + (tCons ? ' · consignado ' + _folhaR2_(tCons) : '') + ((vinculos || []).length ? ' · ' + vinculos.length + ' vínculo(s)' : '') + (nAdm ? ' · ' + nAdm + ' admissão(ões)' : '')]);
      _folhaLog_(email, 'contabilidade (gravar)', mes + ': ' + n + ' recibos, INSS ' + _folhaR2_(tInss) + ', IR ' + _folhaR2_(tIr));
      return JSON.stringify({ success: true, gravados: n, inss: _folhaR2_(tInss), ir: _folhaR2_(tIr), cons: _folhaR2_(tCons), novas: novas.length, semRecibo: semRecibo, admissoes: nAdm });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// DESLIGAMENTO DE FUNCIONÁRIO (botão 🚪 Desligar funcionário)
// Dois motivos: pedido de demissão (o funcionário pediu para sair) ou dispensa sem justa causa
// (a empresa desligou). O CÁLCULO da rescisão é feito na tela (rescCalc no Folha.html, ao vivo,
// com os campos editáveis); aqui o servidor só junta os dados e grava:
//   · folhaDesligDados_(ft, '')  → lista dos ativos;
//   · folhaDesligDados_(ft, id)  → remuneração (salário + linhas de regra que entram no 13º, do último
//     recibo), média da premiação (12 meses), admissão, saldo de férias do painel, experiência, registro;
//   · folhaDesligar_(ft, d)      → aba Rescisoes + Ativo = "Não" + (opcional) troca o recibo dele no mês
//     da saída pelas verbas da rescisão + (opcional) inativa no painel de férias.
// A contabilidade confere/homologa: INSS e IR são estimativas, o FGTS (8% e multa) é pago por guia.
// ============================================================
FOLHA_TAB.RESC = 'Rescisoes';
FOLHA_HEADERS.Rescisoes = ['Registrado em', 'Por', 'ID', 'Nome', 'Filial', 'Motivo', 'Admissão', 'Data de saída',
  'Aviso prévio', 'Dias de aviso', 'Data projetada', 'Proventos', 'Descontos', 'Líquido', 'FGTS do mês (guia)',
  'Multa 40% FGTS (guia)', 'Mês na folha', 'Verbas', 'Observação'];
FOLHA_API.folhaDesligDados = folhaDesligDados_;
FOLHA_API.folhaDesligar = folhaDesligar_;

// linhas do funcionário por mês (sem 13º): { 'aaaa-mm': [{ tipo, rubrica, descricao, valor }] em ordem }
function _folhaLinhasDe_(rows, id) {
  const por = {};
  rows.forEach(function (r) {
    if (String(r[FL.ID] || '').trim() !== id) return;
    const m = _folhaMes_(r[FL.MES]);
    if (!m || _folhaEh13_(m)) return;
    (por[m] = por[m] || []).push({ tipo: String(r[FL.TIPO] || '').trim().toUpperCase(), rubrica: String(r[FL.RUB] || '').trim(),
      descricao: String(r[FL.DESC] || ''), valor: _folhaNum_(r[FL.VALOR]), ordem: Number(r[FL.ORDEM]) || 0 });
  });
  Object.keys(por).forEach(function (m) { por[m].sort(function (a, b) { return a.ordem - b.ordem; }); });
  return por;
}

// remuneração para a rescisão: salário cheio (se o recibo foi proporcional, o valor do "(1.400,00)" da descrição)
// + linhas fixas das regras "Entra no 13º" — o mesmo critério do 🎄 Gerar 13º
function _folhaRemunDe_(id, ls, regras) {
  const cheio = ls.map(function (l) {
    if (String(l.rubrica).toUpperCase() !== 'SALARIO') return l;
    const v = _folhaValorDaDesc_(l.descricao);
    return v && v > (Number(l.valor) || 0) ? Object.assign({}, l, { valor: v }) : l;
  });
  const rec = {}, inf = {};
  rec[id] = cheio; inf[id] = { adm: new Date(1990, 0, 1), admTxt: '' };
  const p = _folha13Plano_(2000, rec, inf, regras, {})[id];
  return (p ? p.linhas : []).filter(function (l) { return l.tipo === 'P'; })
    .map(function (l) {
      const nome = String(l.descricao || '').replace(/\s*\(\d[\d.]*,\d{2}\)/, '').replace(/\s+\d+\s+dias$/, '').trim();
      return { descricao: nome || 'Salário', valor: _folhaR2_(l.base) };
    });
}

function folhaDesligDados_(ft, id) {
  try {
    const email = _folhaSessao_(ft);
    const func = _folhaFuncionarios_();
    id = String(id || '').trim();
    if (!id) {
      const lista = func.lista.filter(function (f) { return f.ativo; })
        .map(function (f) { return { id: f.id, nome: f.nome, filial: f.filial }; })
        .sort(function (a, b) { return a.nome.localeCompare(b.nome); });
      return JSON.stringify({ success: true, lista: lista });
    }
    const f = func.porId[id];
    if (!f) return _err_('Funcionário não encontrado: ' + id);
    if (!f.ativo) return _err_(f.nome + ' já está desligado (Ativo = Não na aba Funcionarios).');

    const rows = _folhaRows_(FOLHA_TAB.LANC);
    const todos = {};
    rows.forEach(function (r) { const m = _folhaMes_(r[FL.MES]); if (m && !_folhaEh13_(m)) todos[m] = 1; });
    const por = _folhaLinhasDe_(rows, id);
    const seus = Object.keys(por).sort();
    const base = seus.length ? seus[seus.length - 1] : '';
    const ls = base ? por[base] : [];
    const componentes = base ? _folhaRemunDe_(id, ls, _folhaRegras_()) : [];

    // média da premiação nos últimos 12 meses com recibo (entra no 13º, nas férias e no aviso)
    const ult = seus.slice(-12);
    let somaPrem = 0;
    ult.forEach(function (m) {
      por[m].forEach(function (l) { if (l.tipo === 'P' && String(l.rubrica).toUpperCase() === 'PREMIACAO') somaPrem += Number(l.valor) || 0; });
    });
    const medias = { media: ult.length ? Math.floor(somaPrem * 100 / ult.length) / 100 : 0, meses: ult.length, total: _folhaR2_(somaPrem) };

    // admissão e férias: painel de férias (pela ligação de sempre); sem ele, "Início" da folha
    let mat = '', adm = null, admFonte = '', ferias = null;
    // registrado: o do painel de férias; sem ele, INSS em algum dos últimos 3 recibos
    let registrado = seus.slice(-3).some(function (m) { return por[m].some(function (l) { return String(l.rubrica).toUpperCase() === 'INSS'; }); });
    try { mat = _folhaLigarFerias_(func.lista)[id] || ''; } catch (e) { mat = ''; }
    if (mat) {
      try {
        const fx = JSON.parse(getEmployeeFicha_(mat));
        if (fx.success) {
          adm = toDate_(fx.func.admissao);
          if (adm) admFonte = 'painel de férias';
          registrado = !!fx.func.registrado;
          ferias = { mat: mat, saldo: Number(fx.saldo.atual) || 0, risco: Number(fx.saldo.risco) || 0, pendente: Number(fx.saldo.pendente) || 0,
            periodos: (fx.periodos || []).map(function (p) {
              return { periodo: p.periodo, iniAq: p.iniAq, fimAq: p.fimAq, concessao: p.concessao, direito: p.direito, situacao: p.situacao };
            }) };
        }
      } catch (e) { ferias = null; }
    }
    if (!adm) { const v = f.row[FU.INICIO]; adm = v instanceof Date ? v : (v ? toDate_(v) : null); if (adm) admFonte = 'início na folha'; }

    const exp = _folhaExperiencias_()[id] || null;
    _folhaLog_(email, 'desligamento (consulta)', id + ' · ' + f.nome);
    return JSON.stringify({ success: true, hoje: formatDate_(new Date()),
      func: { id: id, nome: f.nome, filial: f.filial }, admissao: adm ? formatDate_(adm) : '', admFonte: admFonte,
      base: base, componentes: componentes, medias: medias, registrado: registrado, ferias: ferias, experiencia: exp,
      meses: Object.keys(todos).sort().reverse(), mesesDele: seus });
  } catch (e) { return _err_(e.message); }
}

// d = { id, motivo: 'pedido'|'dispensa', admissao, saida, aviso, diasAviso, projetada,
//       linhas: [{ tipo, rubrica, descricao, valor }], fgtsMes, multa, mes ('' = não lançar), inativarFerias, obs }
function folhaDesligar_(ft, d) {
  try {
    const email = _folhaSessao_(ft);
    d = d || {};
    const id = String(d.id || '').trim();
    const motivo = d.motivo === 'dispensa' ? 'Dispensa sem justa causa' : d.motivo === 'pedido' ? 'Pedido de demissão' : '';
    if (!id || !motivo) return _err_('Escolha o funcionário e o motivo.');
    const saida = toDate_(d.saida);
    if (!saida) return _err_('Informe a data de saída.');
    if (!Array.isArray(d.linhas) || !d.linhas.length) return _err_('A rescisão não tem verbas.');
    const linhas = [];
    let prov = 0, desc = 0;
    for (let i = 0; i < d.linhas.length; i++) {
      const l = d.linhas[i] || {};
      const tipo = String(l.tipo || '').trim().toUpperCase();
      if (['P', 'D', 'I'].indexOf(tipo) < 0) return _err_('Tipo de linha inválido: ' + tipo);
      const ds = String(l.descricao || '').trim().slice(0, 120);
      if (!ds) return _err_('Toda verba precisa de descrição.');
      const v = tipo === 'I' ? null : _folhaR2_(l.valor);
      if (v !== null && (!isFinite(v) || v < 0)) return _err_('Valor inválido em "' + ds + '".');
      linhas.push({ tipo: tipo, rubrica: String(l.rubrica || '').trim().toUpperCase().slice(0, 30) || 'RESCISAO', descricao: ds, valor: v });
      if (tipo === 'P') prov += v;
      if (tipo === 'D') desc += v;
    }
    prov = _folhaR2_(prov); desc = _folhaR2_(desc);
    const mes = _folhaMes_(d.mes);

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaFuncionarios_();
      const f = func.porId[id];
      if (!f) return _err_('Funcionário não encontrado: ' + id);
      if (!f.ativo) return _err_(f.nome + ' já está desligado.');
      const rows = _folhaRows_(FOLHA_TAB.LANC);
      let lancado = '', depois = [];
      if (mes) {
        const existe = rows.some(function (r) { return _folhaMes_(r[FL.MES]) === mes; });
        if (!existe) return _err_(_folhaNomeMes_(mes) + ' ainda não está aberto na folha — escolha um mês aberto ou "não lançar".');
        const sh = _folhaAba_(FOLHA_TAB.LANC);
        const pos = [];
        let filial = f.filial;
        rows.forEach(function (r, i) {
          if (_folhaMes_(r[FL.MES]) === mes && String(r[FL.ID] || '').trim() === id) { pos.push(i + 2); filial = String(r[FL.FILIAL] || '') || filial; }
        });
        const valores = linhas.map(function (l, i) {
          return [mes, id, filial, f.nome, l.tipo, l.rubrica, l.descricao, l.valor === null ? '' : l.valor, i + 1];
        });
        valores.push([mes, id, filial, f.nome, 'I', 'RESCISAO_OBS', motivo + ' — saída em ' + formatDateBR_(formatDate_(saida)), '', valores.length + 1]);
        const usar = Math.min(pos.length, valores.length);
        for (let i = 0; i < usar; i++) sh.getRange(pos[i], 1, 1, valores[i].length).setValues([valores[i]]);
        if (valores.length > usar) {
          const resto = valores.slice(usar), ini = sh.getLastRow() + 1;
          sh.getRange(ini, FL.MES + 1, resto.length, 1).setNumberFormat('@');
          sh.getRange(ini, 1, resto.length, resto[0].length).setValues(resto);
        }
        pos.slice(usar).sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });
        lancado = mes;
        const dep = {};
        rows.forEach(function (r) {
          const m = _folhaMes_(r[FL.MES]);
          if (m > mes && !_folhaEh13_(m) && String(r[FL.ID] || '').trim() === id) dep[m] = 1;
        });
        depois = Object.keys(dep).sort();
      }
      _folhaAba_(FOLHA_TAB.FUNC).getRange(f.linha, FU.ATIVO + 1).setValue('Não');

      let ferias = '';
      if (d.inativarFerias) {
        let mat = '';
        try { mat = _folhaLigarFerias_(func.lista)[id] || ''; } catch (e) { mat = ''; }
        if (mat) {
          const r = JSON.parse(setEmployeeStatus_({ matricula: mat, ativo: false }));
          ferias = r.success ? 'inativado (matrícula ' + mat + ')' : 'não inativado: ' + r.error;
        } else ferias = 'sem ligação com o painel de férias';
      }

      const resumo = linhas.filter(function (l) { return l.tipo !== 'I'; })
        .map(function (l) { return (l.tipo === 'D' ? '-' : '+') + ' ' + l.descricao + ': ' + l.valor; }).join(' | ');
      _folhaAba_(FOLHA_TAB.RESC).appendRow([new Date(), email, id, f.nome, f.filial, motivo,
        toDate_(d.admissao) || '', saida, String(d.aviso || '').slice(0, 40), Number(d.diasAviso) || 0, toDate_(d.projetada) || '',
        prov, desc, _folhaR2_(prov - desc), _folhaR2_(d.fgtsMes), _folhaR2_(d.multa), lancado, resumo.slice(0, 2000), String(d.obs || '').slice(0, 300)]);
      _folhaLog_(email, 'desligamento', id + ' · ' + f.nome + ' · ' + motivo + ' · saída ' + formatDate_(saida) + ' · líquido ' + _folhaR2_(prov - desc));
      return JSON.stringify({ success: true, id: id, nome: f.nome, mes: lancado, liquido: _folhaR2_(prov - desc), ferias: ferias, mesesDepois: depois });
    } finally { lock.releaseLock(); }
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// DRE (botão 📊 Gerar DRE do painel) — mesma proteção da folha (_folhaSessao_)
//
// Busca o "Relatório PAI" do Trier novo (web-drogaria):
//   GET <TRIER_URL>/web-drogaria/financeiro/relatorio-pai?regime=COMPETENCIA|CAIXA&mes=&ano=&desconsiderarIcmsSt=&filial=
//   com "Authorization: Bearer <token>". A montagem no modelo da planilha (o que entra, total) é na tela (dreMontar).
// Token: 1º tenta POST /web-drogaria/oauth/token (login direto); se falhar, faz o login do sistema
// antigo (/sgfpod1/, como o controle-estoque/trier.js), cuja resposta traz o token_integracao.
//
// CONFIGURAÇÃO (Apps Script → Configurações do projeto → Propriedades do script). NUNCA no código/GitHub:
//   TRIER_SENHA   (obrigatória) senha do usuário do Trier
//   TRIER_USUARIO (padrão 33)   TRIER_FILIAL_LOGIN (padrão 99 = Central)
//   TRIER_URL     (padrão http://177.75.172.133:10100)
// Para conferir a ligação: no editor, rode a função dreTestarConexao e veja o Registro de execução.
// ============================================================

function _dreCfg_() {
  const p = PropertiesService.getScriptProperties();
  return {
    url: String(p.getProperty('TRIER_URL') || 'http://177.75.172.133:10100').replace(/\/+$/, ''),
    usuario: String(p.getProperty('TRIER_USUARIO') || '33'),
    filial: String(p.getProperty('TRIER_FILIAL_LOGIN') || '99'),
    senha: String(p.getProperty('TRIER_SENHA') || ''),
  };
}

function _dreForm_(o) {
  return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k] == null ? '' : o[k]); }).join('&');
}

// segundos até o JWT expirar (0 se não der para ler)
function _dreTokenSeg_(tok) {
  try {
    let p = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const j = JSON.parse(Utilities.newBlob(Utilities.base64Decode(p)).getDataAsString());
    return Math.max(0, Math.floor(Number(j.exp) - Date.now() / 1000));
  } catch (e) { return 0; }
}

function _dreToken_(novo) {
  const cache = CacheService.getScriptCache();
  if (!novo) { const t = cache.get('dre_trier_token'); if (t) return t; }
  const c = _dreCfg_();
  if (!c.senha) throw new Error('A senha do Trier ainda não foi cadastrada. No Apps Script: Configurações do projeto → Propriedades do script → adicionar TRIER_SENHA.');
  let tok = '', erroOauth = '';
  try {
    const r = UrlFetchApp.fetch(c.url + '/web-drogaria/oauth/token', {
      method: 'post', contentType: 'application/x-www-form-urlencoded', muteHttpExceptions: true,
      payload: _dreForm_({ grant_type: 'password', username: c.filial + '@' + c.usuario, password: c.senha, client_id: 'sgf', client_secret: 'secret' }),
    });
    if (r.getResponseCode() === 200) tok = String(JSON.parse(r.getContentText()).access_token || '');
    else erroOauth = 'HTTP ' + r.getResponseCode();
  } catch (e) { erroOauth = e.message; }
  if (!tok) {
    try { tok = _dreLoginSgf_(c); }
    catch (e) { throw new Error(e.message + (erroOauth ? ' (login direto: ' + erroOauth + ')' : '')); }
  }
  const seg = _dreTokenSeg_(tok);
  if (seg > 120) cache.put('dre_trier_token', tok, Math.min(21600, seg - 60));
  return tok;
}

// Login do sistema antigo (Podium): GET Login.pod -> httpStart -> save. O Referer é obrigatório.
function _dreLoginSgf_(c) {
  const base = c.url + '/sgfpod1/';
  const cookies = {};
  const guardar = function (r) {
    const h = r.getAllHeaders()['Set-Cookie'];
    (Array.isArray(h) ? h : h ? [h] : []).forEach(function (x) {
      const kv = String(x).split(';')[0], i = kv.indexOf('=');
      if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  };
  const cab = function () {
    return { Referer: base + 'Login.pod', Cookie: Object.keys(cookies).map(function (k) { return k + '=' + cookies[k]; }).join('; ') };
  };
  const g = UrlFetchApp.fetch(base + 'Login.pod', { muteHttpExceptions: true, followRedirects: false });
  guardar(g);
  const html = g.getContentText();
  const ctl = (/controllerSerial\s*=\s*'([^']+)'/.exec(html) || [])[1];
  if (!ctl) throw new Error('Não consegui abrir o login do Trier (HTTP ' + g.getResponseCode() + ').');
  let n = 0;
  const acao = function (params) {
    const id = Date.now() + '_' + (++n);
    const p = Object.assign({ actionId: id, controller: ctl }, params);
    const r = UrlFetchApp.fetch(base + 'PodiumAction?actionId=' + id, {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8', payload: _dreForm_(p),
      headers: cab(), muteHttpExceptions: true, followRedirects: false,
    });
    guardar(r);
    return r.getContentText();
  };
  acao({ action: 'httpStart', attributes: _dreAtributos_(html) });
  const r = acao({ action: 'save', id_cod_rede: '1', id_cod_filial: c.filial, nom_filial: '', id_cod_usuario: c.usuario, nom_senha: c.senha });
  const tok = (/token_integracao['"]\s*,\s*['"]([^'"]+)['"]/.exec(r) || [])[1];
  if (!tok) {
    const m = (/(?:alertMessage|showMessage)\('((?:[^'\\]|\\.)+)'/.exec(r) || [])[1];
    throw new Error('O Trier recusou o login' + (m ? ': ' + m.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '') + '. Confira TRIER_USUARIO / TRIER_SENHA.');
  }
  return tok;
}

// Descritor dos campos da página que o Podium pede no httpStart (igual ao montarAtributos do trier.js).
function _dreAtributos_(html) {
  const TIPOS = ['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time',
    'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'];
  const attr = function (tag, nome) {
    const m = new RegExp('\\s' + nome + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
    return !m ? null : m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  };
  const tem = function (tag, nome) {
    return new RegExp('\\s' + nome + '(?=[\\s=/>])', 'i').test(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
  };
  const limpo = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<textarea\b([^>]*)>[\s\S]*?<\/textarea>/gi, '<textarea$1>');
  const partes = [];
  const reForm = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let f, fi = 0;
  while ((f = reForm.exec(limpo))) {
    const reEl = /<(input|select|textarea|button|fieldset|output|object)\b[^>]*>/gi;
    let e;
    while ((e = reEl.exec(f[1]))) {
      const tag = e[0], tt = e[1].toLowerCase(), nome = attr(tag, 'name');
      if (!nome) continue;
      let tipo;
      if (tt === 'input') { const t = (attr(tag, 'type') || 'text').toLowerCase(); tipo = TIPOS.indexOf(t) >= 0 ? t : 'text'; }
      else if (tt === 'select') tipo = tem(tag, 'multiple') ? 'select-multiple' : 'select-one';
      else if (tt === 'button') { const t = (attr(tag, 'type') || '').toLowerCase(); tipo = ['submit', 'reset', 'button'].indexOf(t) >= 0 ? t : 'submit'; }
      else tipo = tt;
      const ro = (tt === 'input' || tt === 'textarea') && tem(tag, 'readonly') ? 1 : 0;
      partes.push(nome + '=ty-' + tipo + '!id-' + (attr(tag, 'id') || '') + '!ds-' + (tem(tag, 'disabled') ? 1 : 0) + '!ro-' + ro + '!fi-' + fi + '!');
    }
    fi++;
  }
  return partes.join('&');
}

// GET na API nova do Trier; token vencido/recusado (401/403) -> pega outro e tenta de novo uma vez
function _dreGet_(caminho, params) {
  const c = _dreCfg_();
  const q = params ? '?' + _dreForm_(params) : '';
  for (let tent = 0; tent < 2; tent++) {
    const r = UrlFetchApp.fetch(c.url + caminho + q, {
      headers: { Authorization: 'Bearer ' + _dreToken_(tent > 0), Accept: 'application/json' }, muteHttpExceptions: true,
    });
    const st = r.getResponseCode();
    if (st === 401 || st === 403) { CacheService.getScriptCache().remove('dre_trier_token'); continue; }
    if (st !== 200) throw new Error('O Trier respondeu HTTP ' + st + ' em ' + caminho + '.');
    return JSON.parse(r.getContentText());
  }
  throw new Error('O Trier não aceitou o login (sem permissão para o relatório PAI?).');
}

// filiais ativas (sem a Central) -> [{cod, nome}]
function dreFiliais_(ft) {
  try {
    _folhaSessao_(ft);
    const cache = CacheService.getScriptCache();
    const salvo = cache.get('dre_filiais');
    if (salvo) return JSON.stringify({ success: true, filiais: JSON.parse(salvo) });
    const lista = _dreGet_('/web-drogaria/filial/busca-filiais-ativas-exceto-central');
    const arr = Array.isArray(lista) ? lista : (lista && (lista.content || lista.filiais)) || [];
    const filiais = arr.map(function (f) {
      const cod = f.codFilial != null ? f.codFilial : f.codigo != null ? f.codigo : f.id;
      const nome = f.nomFilial || f.nomeFilial || f.nome || f.nomFantasia || f.nomeFantasia || '';
      return { cod: String(cod), nome: String(nome || ('Filial ' + cod)).trim() };
    }).filter(function (f) { return /^\d+$/.test(f.cod); })
      .sort(function (a, b) { return Number(a.cod) - Number(b.cod); });
    cache.put('dre_filiais', JSON.stringify(filiais), 21600);
    return JSON.stringify({ success: true, filiais: filiais });
  } catch (e) { return _err_(e.message); }
}

// p = { filial: '4' ou '' (todas), mes: 1-12, ano, regime: 'COMPETENCIA'|'CAIXA' } -> { grupos: [árvore do Trier] }
function dreGerar_(ft, p) {
  try {
    const email = _folhaSessao_(ft);
    p = p || {};
    const mes = Number(p.mes), ano = Number(p.ano);
    if (!(mes >= 1 && mes <= 12) || !(ano >= 2000 && ano <= 2100)) return _err_('Mês/ano inválido.');
    const regime = p.regime === 'CAIXA' ? 'CAIXA' : 'COMPETENCIA';
    const filial = /^\d+$/.test(String(p.filial || '')) ? String(p.filial) : '';
    const grupos = _dreGet_('/web-drogaria/financeiro/relatorio-pai',
      { regime: regime, mes: String(mes), ano: String(ano), desconsiderarIcmsSt: '', filial: filial });
    if (!Array.isArray(grupos)) return _err_('Resposta inesperada do Trier.');
    _folhaLog_(email, 'dre', (filial ? 'filial ' + filial : 'todas') + ' · ' + mes + '/' + ano + ' · ' + regime);
    return JSON.stringify({ success: true, grupos: grupos, filial: filial, mes: mes, ano: ano, regime: regime });
  } catch (e) { return _err_(e.message); }
}

FOLHA_API.dreFiliais = dreFiliais_;
FOLHA_API.dreGerar = dreGerar_;

// Rodar no editor do Apps Script para conferir a ligação com o Trier (não mostra a senha).
function dreTestarConexao() {
  const tok = _dreToken_(true);
  Logger.log('Login no Trier OK (token válido por ~' + Math.round(_dreTokenSeg_(tok) / 60) + ' min).');
  CacheService.getScriptCache().remove('dre_filiais');
  const lista = _dreGet_('/web-drogaria/filial/busca-filiais-ativas-exceto-central');
  Logger.log('Filiais recebidas: ' + (Array.isArray(lista) ? lista.length : JSON.stringify(lista).slice(0, 200)));
  if (Array.isArray(lista) && lista.length) Logger.log('Campos de uma filial: ' + Object.keys(lista[0]).join(', '));
}

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

function paginaFolha_() {
  _folhaSoRH_();
  return HtmlService.createHtmlOutputFromFile('Folha').getContent();
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
    _folhaLog_(email, 'ver mês', mes + ' (' + lista.length + ' recibos)');
    return JSON.stringify({ success: true, mes: mes, recibos: lista });
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

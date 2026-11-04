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
  Funcionarios: ['ID', 'Nome', 'Filial', 'Início', 'Ativo', 'Matrícula (férias)', 'Nome na comissão', 'Nome nos manipulados', 'Origem (planilha antiga)', 'Piso premiação'],
  Filiais: ['Filial', 'Código no sistema', 'Código nos manipulados'],
  Rubricas: ['Código', 'Nome', 'Tipo (P/D/I)', 'Recorrente', 'Origem'],
  Lancamentos: ['Mês', 'ID', 'Filial', 'Nome', 'Tipo', 'Rubrica', 'Descrição', 'Valor', 'Ordem'],
  Importacoes: ['Data', 'Por', 'Mês', 'Arquivo', 'Tipo', 'Linhas', 'Total', 'Observação'],
  AcessosFolha: ['Data', 'E-mail', 'Ação', 'Detalhe'],
};
const FU = { ID: 0, NOME: 1, FILIAL: 2, INICIO: 3, ATIVO: 4, MAT_FERIAS: 5, NOME_COM: 6, NOME_MAN: 7, PISO: 9 };
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
    try { ferias = _folhaFeriasDoMes_(mes, Object.keys(func).map(function (k) { return func[k]; })); }
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
function _folhaFeriasDoMes_(mes, funcFolha) {
  const nomes = {}, tokFerias = [];
  _rows_(TAB.FUNC).forEach(function (r) {
    const mat = _mk_(r[F.MAT]);
    if (!mat) return;
    nomes[mat] = String(r[F.NOME] || '').trim();
    if (String(r[F.SITUACAO] || '').trim().toLowerCase() !== 'inativo')
      tokFerias.push({ mat: mat, t: _folhaTokens_(nomes[mat]) });
  });
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
  const out = {};
  funcFolha.forEach(function (f) {
    let mat = f.matFerias;
    if (!mat) {
      const t = _folhaTokens_(String(f.nome).replace(/^(.+?)\s*-\s*(\D+)$/, '$1'));
      const cands = tokFerias.map(function (x) { return { mat: x.mat, p: _folhaPontos_(t, x.t) }; })
        .filter(function (x) { return x.p >= 4; }).sort(function (a, b) { return b.p - a.p; });
      if (cands.length === 1 || (cands.length > 1 && cands[0].p > cands[1].p)) mat = cands[0].mat;
    }
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
    const func = _folhaFuncionarios_();
    const atual = _folhaPremiacoes_(mes);
    const r = _folhaCasar_(func.lista, com || [], man || []);
    const linhas = func.lista.map(function (f) {
      const c = r.porFunc[f.id] || { com: null, man: null, comNomes: [], manNomes: [], vinculado: false };
      const temValor = c.com !== null || c.man !== null;
      if (!temValor && !(f.piso > 0)) return null;
      const soma = Math.round(((c.com || 0) + (c.man || 0)) * 100) / 100;
      const semCentavos = Math.floor(soma + 1e-9);
      const nova = Math.max(semCentavos, f.piso > 0 ? f.piso : 0);
      const at = atual[f.id];
      return {
        id: f.id, nome: f.nome, filial: f.filial, ativo: f.ativo,
        comissao: c.com, manipulados: c.man, soma: soma, piso: f.piso || null,
        usouPiso: f.piso > 0 && f.piso > semCentavos,
        nova: nova, atual: at ? at.valor : null, linhasPremiacao: at ? at.n : 0,
        comNomes: c.comNomes, manNomes: c.manNomes, vinculado: c.vinculado,
      };
    }).filter(Boolean);
    _folhaLog_(email, 'importar (prévia)', mes + ': ' + linhas.length + ' funcionários');
    return JSON.stringify({
      success: true, mes: mes, linhas: linhas, semFuncionario: r.semFuncionario, empates: r.empates,
      funcionarios: func.lista.filter(function (f) { return f.ativo; })
        .map(function (f) { return { id: f.id, nome: f.nome, filial: f.filial, piso: f.piso || null }; }),
    });
  } catch (e) { return _err_(e.message); }
}

// itens = [{ id, valor }]; vinculos = [{ id, tipo: 'com'|'man', nome }] (vendedor ligado à mão na tela)
function folhaImportarGravar_(ft, mes, itens, vinculos, arquivos) {
  try {
    const email = _folhaSessao_(ft);
    mes = _folhaMes_(mes);
    if (!mes) return _err_('Mês inválido.');
    if (!Array.isArray(itens) || !itens.length) return _err_('Nada para gravar.');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const func = _folhaFuncionarios_();
      // 1) premiação do mês na aba Lancamentos: atualiza a 1ª linha PREMIACAO ou cria uma
      const sh = _folhaAba_(FOLHA_TAB.LANC);
      const rows = _folhaRows_(FOLHA_TAB.LANC);
      const pos = {}, ordemMax = {};
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
      apelidosCom: _folhaApelidos_(r[FU.NOME_COM]), apelidosMan: _folhaApelidos_(r[FU.NOME_MAN]),
      piso: _folhaNum_(r[FU.PISO]) || 0, linha: i + 2, row: r,
    };
    lista.push(f); porId[id] = f;
  });
  return { lista: lista, porId: porId };
}
// premiação atual do mês por funcionário: { id: { valor, n } }
function _folhaPremiacoes_(mes) {
  const out = {};
  _folhaRows_(FOLHA_TAB.LANC).forEach(function (r) {
    if (_folhaMes_(r[FL.MES]) !== mes || String(r[FL.RUB]).trim() !== 'PREMIACAO') return;
    const id = String(r[FL.ID] || '').trim();
    const o = out[id] || (out[id] = { valor: 0, n: 0 });
    o.valor += _folhaNum_(r[FL.VALOR]) || 0; o.n++;
  });
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

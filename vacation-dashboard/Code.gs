// ============================================================
// DASHBOARD DE FÉRIAS — fonte única
// Lê a planilha "Ficha de Controle de Férias" (abas Func, Periodos,
// Lancamentos, Ajustes, Feriados) e entrega o mesmo JSON que o
// Dashboard.html já consome.
//
// A versão antiga (varredura das 27 planilhas de filial) está no
// histórico do Git / na cópia em Projects-Claude/vacation-dashboard.
// ============================================================

const MODEL_SHEET_ID = '1wLN9oZji-Uk6prHMcvav0CNg1u-tFMz_';

const TAB = {
  FUNC:        'Func',
  PERIODOS:    'Periodos',
  LANCAMENTOS: 'Lancamentos',
  AJUSTES:     'Ajustes',
  FERIADOS:    'Feriados',
  LOJAS:       'Lojas',     // opcional: Filial | Razão Social | CNPJ | Cidade
  ACESSOS:     'Acessos',   // E-mail | Filial | Perfil (RH | Gerente) | Senha — criada sozinha no 1º login
  PAGOS:       'Pagamentos', // Matrícula | Vencimento | Pago | Atualizado em | Por — criada sozinha na 1ª marcação
};
const PG = { MAT:0, VENC:1, PAGO:2, EM:3, POR:4 };
const PAGOS_HEADERS = ['Matrícula', 'Vencimento', 'Pago', 'Atualizado em', 'Por'];
const AC = { EMAIL:0, FILIAL:1, PERFIL:2, SENHA:3 };
const ACESSOS_HEADERS = ['E-mail', 'Filial', 'Perfil', 'Senha'];

// ---- LOGIN (e-mail + senha) ----
// Senha guardada na aba Acessos (coluna D) como hash "h1$<salt>$<sha256 iterado>".
// O RH pode digitar uma senha PROVISÓRIA em texto na coluna D: no 1º login ela é
// conferida e trocada pelo hash automaticamente.
// Usuário inicial: incluído na aba Acessos uma única vez (Script Property SEED_ACESSOS).
// A senha dele NÃO está aqui — só o hash.
const USUARIO_INICIAL = {
  email: 'rfolivo@gmail.com', perfil: 'RH',
  senha: 'h1$40b1c0833c57f2da$a6be05e85e18d113bab825a8f68ec99f25dfa4e7bec3d1c1b9bfab5f20c33e45',
};
const HASH_ITER     = 100;
const SESSAO_SEG    = 6 * 60 * 60;   // sessão expira após 6 h sem uso (máx. do CacheService)
const MAX_TENTATIVAS = 5;            // erros seguidos antes de bloquear o e-mail
const BLOQUEIO_SEG  = 15 * 60;

// Índice das colunas (base 0)
// Func: coluna I (CTPS) é opcional; coluna J (Vencimento) = mês/ano de vencimento
// das férias definido à mão (só usado quando não há período aquisitivo calculado)
const F  = { MAT:0, NOME:1, FILIAL:2, CARGO:3, ADMISSAO:4, SITUACAO:5, SALDO_INI:6, REGISTRADO:7, CTPS:8, VENC:9 };
const P  = { MAT:0, PERIODO:1, INI_AQ:2, FIM_AQ:3, FALTAS:4, DIREITO:5, CONCESSAO:6, CREDITADO:7, SITUACAO:8 };
// Lancamentos: colunas M..R (fase 3 — fluxo de aprovação) ficam DEPOIS de _seq/_chave
// (K/L) para não deslocar nada. São criadas sozinhas na 1ª gravação (_ensureLancCols_).
// Status vazio = linha antiga, conta como Aprovado.
const L  = { MAT:0, PERIODO:1, PARCELA:2, INICIO:3, TERMINO:4, DIAS:5, TIPO:6, RETORNO:7, RETORNO_UTIL:8, OBS:9,
             STATUS:12, SOLIC_POR:13, SOLIC_EM:14, DECID_POR:15, DECID_EM:16, MOTIVO:17 };
const LANC_COLS = 18;
const LANC_HEADERS_FASE3 = ['Status', 'Solicitado por', 'Solicitado em', 'Decidido por', 'Decidido em', 'Motivo'];
const ST = { PEND: 'Pendente', APROV: 'Aprovado', RECUS: 'Recusado' };

// E-mails do fluxo de aprovação (gerente pede → RH recebe; RH decide → gerente recebe).
// Desligado por padrão: conta Gmail comum tem limite de 100 e-mails/dia.
const NOTIFICAR_EMAIL = false;

// Alertas de conflito (3+ da mesma filial de férias juntos). Desligado até o RH
// definir a regra de cada filial — com o histórico importado, só gerava ruído.
const ALERTA_CONFLITOS = false;
const AJ = { MAT:0, DATA:1, DIAS:2, OBS:3 };
const LO = { FILIAL:0, RAZAO:1, CNPJ:2, CIDADE:3 };

// Dados da empresa para o Aviso de Férias.
// 1) Se existir a aba "Lojas" (Filial | Razão Social | CNPJ | Cidade), ela tem
//    prioridade e permite CNPJ diferente por filial.
// 2) Senão, usa o que estiver preenchido aqui embaixo.
// >>> AJUSTE a razão social e o CNPJ da sua empresa: <<<
const EMPRESA_PADRAO = {
  razao:  'FARMACIA E DROGARIA SOMENSI LTDA',
  cnpj:   '79.408.746/0001-99',
  cidade: '',   // em branco = usa o nome da filial em "Local e Data"
};

// Planilha legada de "sem registro". Deixe '' para usar somente a
// coluna "Registrado" da aba Func.
const PAYMENT_SHEET_ID = '';
const PAY_COL = { NOME:0, FILIAL:1, MES_VENC:2, PAGAR_30:3 };

const MONTHS_PT = ['janeiro','fevereiro','março','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro'];

// ============================================================
// PONTO DE ENTRADA DA WEB APP
//   Toda URL abre a página de LOGIN (Login.html). Depois de entrar, o Login
//   carrega no lugar a Home (.../exec) ou o painel (.../exec?page=painel).
//
// SEGURANÇA: só as funções SEM "_" no fim podem ser chamadas pelo navegador
// (regra do Apps Script). As públicas são: doGet, login, paginaLogin e api.
// Todo o resto passa pela api(), que confere a sessão antes.
// ============================================================
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Login');
  t.destino = (e && e.parameter && e.parameter.page) === 'painel' ? 'painel' : 'home';
  return t.evaluate()
    .setTitle('Controle de Férias')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// HTML da tela de login — usado para voltar a ela quando a sessão expira / no "Sair"
function paginaLogin() {
  const t = HtmlService.createTemplateFromFile('Login');
  t.destino = 'home';
  return t.evaluate().getContent();
}

// HTML do painel / da página inicial — abertos "no lugar" (document.write),
// sem trocar a URL (importante quando embutido no Google Sites). Só via api().
function paginaPainel_() {
  return HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
}
function paginaHome_() {
  const t = HtmlService.createTemplateFromFile('Home');
  t.scriptUrl = ScriptApp.getService().getUrl();
  return t.evaluate().getContent();
}

// ---- funções que o navegador pode pedir pela api() ----
const API = {
  paginaHome: paginaHome_, paginaPainel: paginaPainel_,
  sessaoAtual: sessaoAtual_, trocarSenha: trocarSenha_, logout: logout_,
  getResumoHome: getResumoHome_, getVacationData: getVacationData_,
  getEmployeeFicha: getEmployeeFicha_, getAvisoFeriasPdf: getAvisoFeriasPdf_,
  addVacationRecord: addVacationRecord_, updateVacationRecord: updateVacationRecord_,
  deleteVacationRecord: deleteVacationRecord_,
  addPeriodoAquisitivo: addPeriodoAquisitivo_, updatePeriodoAquisitivo: updatePeriodoAquisitivo_,
  deletePeriodoAquisitivo: deletePeriodoAquisitivo_,
  addEmployee: addEmployee_, updateEmployee: updateEmployee_, setEmployeeStatus: setEmployeeStatus_,
  updateLancamentoPeriodo: updateLancamentoPeriodo_,
  setEmployeeVencimento: setEmployeeVencimento_, setFeriasPaga: setFeriasPaga_,
  addAjuste: addAjuste_, updateAjuste: updateAjuste_, deleteAjuste: deleteAjuste_,
  getAprovacoes: getAprovacoes_, decidirFerias: decidirFerias_,
  importarLote: importarLote_,
};

// Sessão da execução atual (cada chamada do navegador é uma execução separada)
let _SESSAO = null;   // { email, token }

// Porta única: confere o token e chama a função pedida.
// Sessão inválida/expirada => lança 'SESSAO_EXPIRADA' (o navegador volta ao login).
function api(token, fn, args) {
  // FOLHA_API vem do FolhaPagamento.gs (módulo da folha de pagamento, só RH)
  const f = API[String(fn || '')]
    || (typeof FOLHA_API !== 'undefined' && Object.prototype.hasOwnProperty.call(FOLHA_API, String(fn || '')) ? FOLHA_API[fn] : null);
  if (!f) throw new Error('Função não permitida: ' + fn);
  const s = _lerSessao_(token);
  if (!s) throw new Error('SESSAO_EXPIRADA');
  _SESSAO = { email: s.email, token: String(token) };
  if (_scopeAtual_().perfil === 'nenhum') {          // acesso removido da aba Acessos
    _apagarSessao_(token);
    throw new Error('SESSAO_EXPIRADA');
  }
  return f.apply(null, Array.isArray(args) ? args : []);
}

// ---- login / sessão ----
function login(email, senha) {
  try {
    email = String(email || '').trim().toLowerCase();
    senha = String(senha || '');
    if (!email || !senha) return _err_('Informe e-mail e senha.');

    const cache = CacheService.getScriptCache();
    const kT = 'tent_' + email;
    const tent = Number(cache.get(kT)) || 0;
    if (tent >= MAX_TENTATIVAS)
      return _err_('Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.');

    const sh = _ensureAcessos_();
    const rows = _rows_(TAB.ACESSOS);
    let idx = -1;
    rows.forEach(function (r, i) {
      if (idx < 0 && String(r[AC.EMAIL] || '').trim().toLowerCase() === email
        && String(r[AC.SENHA] || '').trim()) idx = i;
    });
    const guardada = idx >= 0 ? String(rows[idx][AC.SENHA]).trim() : '';
    let ok = false;
    if (guardada.indexOf('h1$') === 0) {
      ok = _conferirSenha_(senha, guardada);
    } else if (guardada) {                          // senha provisória em texto
      ok = guardada === senha;
      if (ok) sh.getRange(idx + 2, AC.SENHA + 1).setValue(_hashSenha_(senha));
    }
    if (!ok) {
      cache.put(kT, String(tent + 1), BLOQUEIO_SEG);
      return _err_('E-mail ou senha incorretos.');
    }
    cache.remove(kT);

    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('sess_' + token, JSON.stringify({ email: email }), SESSAO_SEG);
    return JSON.stringify({ success: true, token: token, email: email });
  } catch (e) { return _err_(e.message); }
}

function sessaoAtual_() {
  const s = _scopeAtual_();
  return JSON.stringify({ success: true, email: s.email, perfil: s.perfil, filiais: s.filiais, aprova: s.aprova });
}

function logout_() {
  if (_SESSAO) _apagarSessao_(_SESSAO.token);
  return JSON.stringify({ success: true });
}

// payload = { atual, nova }
function trocarSenha_(payload) {
  try {
    const atual = String(payload && payload.atual || '');
    const nova  = String(payload && payload.nova  || '');
    if (nova.length < 8) return _err_('A nova senha precisa ter pelo menos 8 caracteres.');
    if (nova === atual) return _err_('A nova senha é igual à atual.');
    const email = _SESSAO.email;
    const sh = _sheet_(TAB.ACESSOS);
    const rows = _rows_(TAB.ACESSOS);
    let idx = -1;
    rows.forEach(function (r, i) {
      if (idx < 0 && String(r[AC.EMAIL] || '').trim().toLowerCase() === email
        && String(r[AC.SENHA] || '').trim()) idx = i;
    });
    if (idx < 0) return _err_('Usuário não encontrado.');
    const guardada = String(rows[idx][AC.SENHA]).trim();
    const ok = guardada.indexOf('h1$') === 0 ? _conferirSenha_(atual, guardada) : guardada === atual;
    if (!ok) return _err_('Senha atual incorreta.');
    sh.getRange(idx + 2, AC.SENHA + 1).setValue(_hashSenha_(nova));
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

function _lerSessao_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const cache = CacheService.getScriptCache();
  const v = cache.get('sess_' + token);
  if (!v) return null;
  cache.put('sess_' + token, v, SESSAO_SEG);         // renova a cada uso
  try { return JSON.parse(v); } catch (e) { return null; }
}
function _apagarSessao_(token) {
  try { CacheService.getScriptCache().remove('sess_' + String(token || '')); } catch (e) {}
}

// SHA-256 iterado com salt -> "h1$<salt>$<hex>"
function _hashSenha_(senha, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const arr = function (b) { return Array.prototype.slice.call(b); };   // byte[] -> array JS
  const saltB = arr(Utilities.newBlob(salt).getBytes());
  let h = arr(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + senha, Utilities.Charset.UTF_8));
  for (let i = 1; i < HASH_ITER; i++) {
    h = arr(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h.concat(saltB)));
  }
  const hex = h.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  return 'h1$' + salt + '$' + hex;
}
function _conferirSenha_(senha, guardada) {
  const p = String(guardada).split('$');
  if (p.length !== 3) return false;
  return _hashSenha_(senha, p[1]) === guardada;
}

// Garante a aba Acessos (cabeçalho + coluna Senha) e inclui o usuário inicial uma vez.
function _ensureAcessos_() {
  const ss = SpreadsheetApp.openById(MODEL_SHEET_ID);
  let sh = ss.getSheetByName(TAB.ACESSOS);
  if (!sh) sh = ss.insertSheet(TAB.ACESSOS);
  if (sh.getMaxColumns() < ACESSOS_HEADERS.length)
    sh.insertColumnsAfter(sh.getMaxColumns(), ACESSOS_HEADERS.length - sh.getMaxColumns());
  const head = sh.getRange(1, 1, 1, ACESSOS_HEADERS.length).getValues()[0];
  if (head.some(function (h) { return !String(h || '').trim(); })) {
    const novo = head.map(function (h, i) { return String(h || '').trim() || ACESSOS_HEADERS[i]; });
    sh.getRange(1, 1, 1, ACESSOS_HEADERS.length).setValues([novo]);
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SEED_ACESSOS')) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (!props.getProperty('SEED_ACESSOS')) {
        const existe = _rows_(TAB.ACESSOS).some(function (r) {
          return String(r[AC.EMAIL] || '').trim().toLowerCase() === USUARIO_INICIAL.email;
        });
        if (!existe) sh.appendRow([USUARIO_INICIAL.email, '', USUARIO_INICIAL.perfil, USUARIO_INICIAL.senha]);
        props.setProperty('SEED_ACESSOS', '1');
      }
    } finally { lock.releaseLock(); }
  }
  return sh;
}

// ============================================================
// ESCOPO DE ACESSO — quem está logado e o que pode ver
//   Sem login => sem acesso. Perfil e filiais vêm da aba Acessos.
// ============================================================
function _scopeAtual_() {
  const email = _SESSAO ? _SESSAO.email : '';
  if (!email) return { email: '', perfil: 'nenhum', filiais: [] };

  let rows = [];
  try { rows = _rows_(TAB.ACESSOS); } catch (e) { rows = []; }

  const meus = rows.filter(function (r) {
    return String(r[AC.EMAIL] || '').trim().toLowerCase() === email;
  });
  if (!meus.length) return { email: email, perfil: 'nenhum', filiais: [] };

  const ehRH = meus.some(function (r) { return _perfilAcesso_(r[AC.PERFIL]) === 'rh'; });
  if (ehRH) return { email: email, perfil: 'rh', filiais: null, aprova: null };

  // "Gerente Matriz" = gerente (mesmas restrições) que também APROVA férias das
  // filiais das linhas dele marcadas como Gerente Matriz.
  const filiais = [], aprova = [];
  meus.forEach(function (r) {
    const f = String(r[AC.FILIAL] || '').trim();
    if (!f) return;
    if (filiais.indexOf(f) < 0) filiais.push(f);
    if (_perfilAcesso_(r[AC.PERFIL]) === 'matriz' && aprova.indexOf(f) < 0) aprova.push(f);
  });
  return { email: email, perfil: 'gerente', filiais: filiais, aprova: aprova };
}

// Texto da coluna Perfil -> 'rh' | 'matriz' | 'gerente'
// ("Gerente Matriz", "gerente_matriz", "Matriz" contam como matriz)
function _perfilAcesso_(v) {
  const s = String(v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s === 'rh') return 'rh';
  if (s.indexOf('matriz') >= 0) return 'matriz';
  return 'gerente';
}

function _noEscopo_(scope, filial) {
  return !scope.filiais || scope.filiais.indexOf(String(filial || '').trim()) >= 0;
}

// Pode aprovar/recusar férias desta filial? (RH: todas; Gerente Matriz: as dele)
function _podeAprovar_(scope, filial) {
  if (scope.perfil === 'rh') return true;
  return !!(scope.aprova && scope.aprova.indexOf(String(filial || '').trim()) >= 0);
}

// E-mails de quem aprova uma filial: RH + Gerentes Matriz daquela filial
function _emailsAprovadores_(filial) {
  try {
    const f = String(filial || '').trim();
    const out = [];
    _rows_(TAB.ACESSOS).forEach(function (r) {
      const p = _perfilAcesso_(r[AC.PERFIL]);
      const e = String(r[AC.EMAIL] || '').trim().toLowerCase();
      if (!e) return;
      if ((p === 'rh' || (p === 'matriz' && String(r[AC.FILIAL] || '').trim() === f)) && out.indexOf(e) < 0) out.push(e);
    });
    return out;
  } catch (e) { return []; }
}

// Resumo para a página inicial
function getResumoHome_() {
  try {
    const scope = _scopeAtual_();
    const func = _rows_(TAB.FUNC);
    const hoje = _midnight_(new Date());
    const funcFil = {};
    let nFunc = 0; const fils = {};
    func.forEach(function (r) {
      const mat = _mk_(r[F.MAT]);
      if (!mat || !String(r[F.NOME] || '').trim()) return;
      const fil = String(r[F.FILIAL] || '').trim();
      funcFil[mat] = fil;
      if (scope.filiais && scope.filiais.indexOf(fil) < 0) return;
      nFunc++; if (fil) fils[fil] = 1;
    });
    let emFerias = 0, pendentes = 0;
    _rows_(TAB.LANCAMENTOS).forEach(function (r) {
      const s = toDate_(r[L.INICIO]), e = toDate_(r[L.TERMINO]);
      if (!s || !e) return;
      const fil = funcFil[_mk_(r[L.MAT])];
      if (scope.filiais && scope.filiais.indexOf(fil) < 0) return;
      const st = _statusLanc_(r);
      if (st === ST.PEND) pendentes++;
      if (st === ST.APROV && s <= hoje && hoje <= e) emFerias++;
    });
    return JSON.stringify({
      ok: true,
      perfil: scope.perfil,
      aprova: (scope.aprova || []).length > 0,
      email: scope.email,
      escopo: scope.filiais ? scope.filiais.join(', ') : 'Todas as filiais',
      funcionarios: nFunc,
      filiais: Object.keys(fils).length,
      emFerias: emFerias,
      pendentes: pendentes,
    });
  } catch (err) {
    return JSON.stringify({ ok: false, erro: String(err.message || err) });
  }
}

// ============================================================
// LEITURA E CONSOLIDAÇÃO
// ============================================================
function getVacationData_() {
  const scope = _scopeAtual_();
  if (scope.perfil === 'nenhum') {
    return JSON.stringify({
      data: [], conflicts: [], employees: [], paymentDue: [], paymentAll: [], paymentErrors: [],
      totals: { funcionarios: 0, registrados: 0, naoRegistrados: 0 },
      scope: scope,
      errors: [{ branch: 'Acesso', error: 'Seu e-mail (' + (scope.email || 'não identificado')
        + ') não está cadastrado na aba "Acessos". Fale com o RH.' }],
    });
  }

  const errors = [];
  let func = [], per = [], lan = [], aju = [];
  try { func = _rows_(TAB.FUNC); }        catch (e) { errors.push({ branch: TAB.FUNC, error: e.message }); }
  try { per  = _rows_(TAB.PERIODOS); }    catch (e) { errors.push({ branch: TAB.PERIODOS, error: e.message }); }
  try { lan  = _rows_(TAB.LANCAMENTOS); } catch (e) { errors.push({ branch: TAB.LANCAMENTOS, error: e.message }); }
  try { aju  = _rows_(TAB.AJUSTES); }     catch (e) { errors.push({ branch: TAB.AJUSTES, error: e.message }); }

  const today = _midnight_(new Date());

  // funcionários por matrícula
  const emp = {};
  func.forEach(r => {
    const mat = _mk_(r[F.MAT]);
    if (!mat) return;
    const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
    const sit = String(r[F.SITUACAO] || '').trim();
    emp[mat] = {
      mat: mat,
      name: String(r[F.NOME] || '').trim(),
      branch: String(r[F.FILIAL] || '').trim(),
      admissao: toDate_(r[F.ADMISSAO]),
      saldoIni: Number(r[F.SALDO_INI]) || 0,
      registrado: reg !== 'não' && reg !== 'nao',
      situacao: sit,
      ativo: sit.toLowerCase() !== 'inativo',
      vencManual: formatDate_(r[F.VENC]),
    };
  });

  // créditos e datas de concessão por período aquisitivo
  // (creditado = o fim do período aquisitivo já passou — calculado, não lê a coluna)
  const credit = {}, conc = {};
  per.forEach(r => {
    const mat = _mk_(r[P.MAT]);
    if (!mat) return;
    const iniAq = toDate_(r[P.INI_AQ]);
    const fimAq = toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
    const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
      ? r[P.DIREITO] : _diasDireito_(r[P.FALTAS]);
    if (fimAq && fimAq <= today) credit[mat] = (credit[mat] || 0) + dir;
    const c = toDate_(r[P.CONCESSAO]) || (fimAq ? _addMonths_(fimAq, 12) : null);
    if (c) (conc[mat] = conc[mat] || []).push(c);
  });

  // gozo / abono / ajustes — só lançamentos APROVADOS descontam do saldo;
  // os pendentes (fase 3) ficam separados em pend[], recusados não contam
  const goz = {}, abo = {}, adj = {}, pend = {};
  lan.forEach(r => {
    const mat = _mk_(r[L.MAT]);
    if (!mat) return;
    const tipo = String(r[L.TIPO] || '').trim().toLowerCase();
    const st = _statusLanc_(r);
    if (st === ST.RECUS) return;
    // dias: usa a célula se for número; senão calcula pelas datas (linha com fórmula quebrada)
    let d = (typeof r[L.DIAS] === 'number') ? r[L.DIAS] : 0;
    if (!d) {
      const s = toDate_(r[L.INICIO]), en = toDate_(r[L.TERMINO]);
      if (s && en) d = Math.round((en - s) / 864e5) + 1;
    }
    if (st === ST.PEND) { pend[mat] = (pend[mat] || 0) + d; return; }
    if (tipo === 'gozo')  goz[mat] = (goz[mat] || 0) + d;
    if (tipo === 'abono') abo[mat] = (abo[mat] || 0) + d;
  });
  aju.forEach(r => {
    const mat = _mk_(r[AJ.MAT]);
    if (mat) adj[mat] = (adj[mat] || 0) + (Number(r[AJ.DIAS]) || 0);
  });

  const saldoOf = function (mat) {
    const e = emp[mat];
    return (e ? e.saldoIni : 0) + (credit[mat] || 0)
      - (goz[mat] || 0) - (abo[mat] || 0) + (adj[mat] || 0);
  };
  // vencimento: data de concessão calculada do período aquisitivo; se não houver
  // nenhum período, cai para o vencimento definido à mão na aba Func (coluna J)
  const dueOf = function (mat) {
    const list = (conc[mat] || []).slice().sort(function (a, b) { return a - b; });
    if (!list.length) return (emp[mat] && emp[mat].vencManual) || '';
    const fut = list.filter(function (d) { return d >= today; });
    return formatDate_(fut.length ? fut[0] : list[0]);
  };

  // data[] : uma entrada por lançamento + placeholder p/ registrado sem lançamento
  const allData = [];
  const seen = {};
  lan.forEach(function (r, i) {
    const mat = _mk_(r[L.MAT]);
    const e = emp[mat];
    if (!e) return;
    const status = _statusLanc_(r);
    if (status === ST.RECUS) return;   // recusadas só aparecem na ficha e em Aprovações
    seen[mat] = true;
    const start = toDate_(r[L.INICIO]);
    const end   = toDate_(r[L.TERMINO]);
    if (!e.name && !start) return;
    // total: usa o valor da célula só se for número; senão calcula pelas datas
    let total = (typeof r[L.DIAS] === 'number')
      ? r[L.DIAS]
      : ((start && end) ? Math.round((end - start) / 864e5) + 1 : '');
    // retorno: usa a célula só se for data válida; senão fim + 1
    let ret = toDate_(r[L.RETORNO_UTIL]) || toDate_(r[L.RETORNO]);
    if (!ret && end) ret = _plusDays_(end, 1);
    allData.push({
      branch: e.branch,
      name: e.name,
      matricula: mat,
      startDate:  formatDate_(r[L.INICIO]),
      endDate:    formatDate_(r[L.TERMINO]),
      returnDate: formatDate_(ret),
      total: total == null ? '' : total,
      availableDays: saldoOf(mat),
      dueDate: dueOf(mat),
      ativo: e.ativo,
      rowIndex: i + 2,                 // linha na aba Lancamentos
      status: status,                  // Aprovado | Pendente
      pendingDays: pend[mat] || 0,
    });
  });
  Object.keys(emp).forEach(function (mat) {
    const e = emp[mat];
    if (seen[mat] || !e.registrado || !e.name) return;
    allData.push({
      branch: e.branch, name: e.name, matricula: mat,
      startDate: '', endDate: '', returnDate: '', total: '',
      availableDays: saldoOf(mat), dueDate: dueOf(mat), ativo: e.ativo, rowIndex: 0,
      status: '', pendingDays: pend[mat] || 0,
    });
  });

  const conflicts = ALERTA_CONFLITOS ? detectConflicts_(allData) : [];
  const payment = getPaymentData_(func, saldoOf);

  // contagens + lista completa do cadastro (aba Func)
  let nFunc = 0, nReg = 0, nNao = 0;
  const employees = [];
  func.forEach(function (r) {
    const mat = _mk_(r[F.MAT]);
    const nome = String(r[F.NOME] || '').trim();
    if (!mat || !nome) return;
    nFunc++;
    const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
    const registrado = reg !== 'não' && reg !== 'nao';
    if (registrado) nReg++; else nNao++;
    const sit = String(r[F.SITUACAO] || '').trim();
    const concISO = (conc[mat] || []).map(formatDate_).filter(function (x) { return x; }).sort();
    const temCalc = concISO.length > 0;
    const vencManual = formatDate_(r[F.VENC]);
    employees.push({
      matricula: mat,
      nome: nome,
      filial: String(r[F.FILIAL] || '').trim(),
      cargo: String(r[F.CARGO] || '').trim(),
      registrado: registrado,
      saldo: saldoOf(mat),
      pendente: pend[mat] || 0,
      vencimento: dueOf(mat),
      vencimentos: temCalc ? concISO : (vencManual ? [vencManual] : []),
      periodos: _periodosDe_(mat, per).map(function (p) {
        return { label: p.label, ini: formatDate_(p.ini), fim: formatDate_(p.fim) };
      }),
      vencManual: vencManual,
      vencCalc: temCalc,
      situacao: sit,
      ativo: sit.toLowerCase() !== 'inativo',
    });
  });

  // sem registro: usa o mês do vencimento do ano atual (mesma lista da aba
  // Vencimento Mensal); sem vencimento no ano, fica o mês da admissão
  const empPorMat = {};
  employees.forEach(function (e) { empPorMat[e.matricula] = e; });
  const anoPag = String(today.getFullYear()), mesPag = today.getMonth() + 1;
  payment.all.forEach(function (r) {
    const e = r.matricula && empPorMat[r.matricula];
    if (!e) return;
    const vencs = e.vencimentos.length ? e.vencimentos : (e.vencimento ? [e.vencimento] : []);
    const v = vencs.filter(function (x) { return x && x.substring(0, 4) === anoPag; }).pop();
    if (!v) return;
    r.monthNum = Number(v.substring(5, 7));
    r.month = _cap_(MONTHS_PT[r.monthNum - 1]);
    r.vencimento = v;
    r.isDue = r.monthNum === mesPag;
  });
  payment.due = payment.all.filter(function (r) { return r.isDue; });

  // registrados: 1/3 no mês do vencimento ou do fim do período aquisitivo
  _pagamentoTerco_(employees).forEach(function (r) {
    payment.all.push(r);
    if (r.isDue) payment.due.push(r);
  });

  // --- escopo por filial (gerente vê só as filiais dele) ---
  let outData = allData, outEmp = employees, outPayAll = payment.all, outPayDue = payment.due, outConf = conflicts;
  let tot = { funcionarios: nFunc, registrados: nReg, naoRegistrados: nNao };
  if (scope.filiais) {
    const inScope = function (b) { return scope.filiais.indexOf(String(b || '').trim()) >= 0; };
    outData   = allData.filter(function (r) { return inScope(r.branch); });
    outEmp    = employees.filter(function (e) { return inScope(e.filial); });
    outPayAll = payment.all.filter(function (r) { return inScope(r.branch); });
    outPayDue = payment.due.filter(function (r) { return inScope(r.branch); });
    outConf   = conflicts.filter(function (c) { return inScope(c.branch); });
    tot = {
      funcionarios: outEmp.length,
      registrados: outEmp.filter(function (e) { return e.registrado; }).length,
      naoRegistrados: outEmp.filter(function (e) { return !e.registrado; }).length,
    };
  }
  tot.pendentes = outData.filter(function (r) { return r.status === ST.PEND; }).length;

  return JSON.stringify({
    data: outData,
    conflicts: outConf,
    errors: errors,
    paymentDue: outPayDue,
    paymentAll: outPayAll,
    paymentErrors: payment.errors,
    totals: tot,
    employees: outEmp,
    feriasPagas: _feriasPagas_(outEmp),
    scope: { perfil: scope.perfil, filiais: scope.filiais, email: scope.email, aprova: scope.aprova },
  });
}

// ============================================================
// FICHA COMPLETA DE UM FUNCIONÁRIO — chamada pelo dashboard
// ============================================================
function getEmployeeFicha_(matricula) {
  try {
    const mat = _mk_(matricula);
    if (!mat) return _err_('Matrícula não informada.');

    const fr = _rows_(TAB.FUNC).find(function (r) {
      return _mk_(r[F.MAT]) === mat;
    });
    if (!fr) return _err_('Funcionário não encontrado: ' + mat);

    const scope = _scopeAtual_();
    if (scope.perfil === 'nenhum' || !_noEscopo_(scope, fr[F.FILIAL]))
      return _err_('Você não tem acesso à ficha deste funcionário.');

    const today = _midnight_(new Date());
    const per = [];
    _rows_(TAB.PERIODOS).forEach(function (r, i) {
      if (_mk_(r[P.MAT]) === mat) { r._ri = i + 2; per.push(r); }   // _ri = linha na aba Periodos
    });
    const lan = [];
    _rows_(TAB.LANCAMENTOS).forEach(function (r, i) {
      if (_mk_(r[L.MAT]) === mat) { r._ri = i + 2; lan.push(r); }   // _ri = linha na aba Lancamentos
    });
    const aju = [];
    _rows_(TAB.AJUSTES).forEach(function (r, i) {
      if (_mk_(r[AJ.MAT]) === mat) aju.push({ r: r, rowIndex: i + 2 });
    });

    const inicial = Number(fr[F.SALDO_INI]) || 0;
    let creditados = 0, gozadas = 0, abono = 0, ajustes = 0, riscoBase = 0;
    per.forEach(function (r) {
      const iniAq = toDate_(r[P.INI_AQ]);
      const fimAq = toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
      const concD = toDate_(r[P.CONCESSAO]) || (fimAq ? _addMonths_(fimAq, 12) : null);
      const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
        ? r[P.DIREITO] : _diasDireito_(r[P.FALTAS]);
      if (fimAq && fimAq <= today) creditados += dir;
      if (concD && concD < today && dir > 0) riscoBase += dir;
    });
    let pendente = 0;
    lan.forEach(function (r) {
      const t = String(r[L.TIPO] || '').trim().toLowerCase();
      const st = _statusLanc_(r);
      if (st === ST.RECUS) return;
      let d = (typeof r[L.DIAS] === 'number') ? r[L.DIAS] : 0;
      if (!d) {
        const s = toDate_(r[L.INICIO]), en = toDate_(r[L.TERMINO]);
        if (s && en) d = Math.round((en - s) / 864e5) + 1;
      }
      if (st === ST.PEND) { pendente += d; return; }
      if (t === 'gozo') gozadas += d;
      if (t === 'abono') abono += d;
    });
    aju.forEach(function (x) { ajustes += Number(x.r[AJ.DIAS]) || 0; });

    const risco = Math.max(0, riscoBase - gozadas - Math.max(0, -ajustes));
    const atual = inicial + creditados - gozadas - abono + ajustes;

    const fut = per.map(function (r) {
      const iniAq = toDate_(r[P.INI_AQ]);
      return toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
    }).filter(function (d) { return d && d > today; })
      .sort(function (a, b) { return a - b; });

    // vencimento das férias: concessão calculada dos períodos; senão o manual (Func.J)
    const concList = per.map(function (r) {
      const iniAq = toDate_(r[P.INI_AQ]);
      const fimAq = toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
      return toDate_(r[P.CONCESSAO]) || (fimAq ? _addMonths_(fimAq, 12) : null);
    }).filter(function (d) { return d; }).sort(function (a, b) { return a - b; });
    const vencCalc = concList.length
      ? formatDate_(concList.filter(function (d) { return d >= today; })[0] || concList[0])
      : '';
    const vencManual = formatDate_(fr[F.VENC]);

    const reg = String(fr[F.REGISTRADO] || '').trim().toLowerCase();

    return JSON.stringify({
      success: true,
      func: {
        matricula: mat,
        nome: String(fr[F.NOME] || '').trim(),
        filial: String(fr[F.FILIAL] || '').trim(),
        cargo: String(fr[F.CARGO] || '').trim(),
        admissao: formatDate_(fr[F.ADMISSAO]),
        ctps: String(fr[F.CTPS] || '').trim(),
        situacao: String(fr[F.SITUACAO] || '').trim(),
        ativo: String(fr[F.SITUACAO] || '').trim().toLowerCase() !== 'inativo',
        registrado: reg !== 'não' && reg !== 'nao',
        vencimento: vencCalc || vencManual,
        vencManual: vencManual,
        temCalculo: !!vencCalc,
      },
      saldo: {
        atual: atual, inicial: inicial, creditados: creditados,
        gozadas: gozadas, abono: abono, ajustes: ajustes, pendente: pendente,
        risco: risco, proximoCredito: fut.length ? formatDate_(fut[0]) : '',
      },
      periodos: per.map(function (r) {
        const iniAq = toDate_(r[P.INI_AQ]);
        const fimAq = toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
        const concD = toDate_(r[P.CONCESSAO]) || (fimAq ? _addMonths_(fimAq, 12) : null);
        const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
          ? r[P.DIREITO] : _diasDireito_(r[P.FALTAS]);
        return {
          periodo: String(r[P.PERIODO] || '').trim()
            || (iniAq && fimAq ? iniAq.getFullYear() + '/' + fimAq.getFullYear() : ''),
          iniAq: formatDate_(iniAq),
          fimAq: formatDate_(fimAq),
          concessao: formatDate_(concD),
          direito: dir,
          faltas: (typeof r[P.FALTAS] === 'number') ? r[P.FALTAS] : (Number(r[P.FALTAS]) || 0),
          creditado: (fimAq && fimAq <= today) ? 'Sim' : 'Não',
          situacao: _periodoSituacao_(fimAq, concD, today),
          rowIndex: r._ri,
        };
      }),
      lancamentos: lan.map(function (r) {
        const s = toDate_(r[L.INICIO]), en = toDate_(r[L.TERMINO]);
        let dias = (typeof r[L.DIAS] === 'number') ? r[L.DIAS]
          : ((s && en) ? Math.round((en - s) / 864e5) + 1 : '');
        let ret = toDate_(r[L.RETORNO_UTIL]) || toDate_(r[L.RETORNO]);
        if (!ret && en) ret = _plusDays_(en, 1);
        return {
          periodo: String(r[L.PERIODO] || '').trim(),
          parcela: r[L.PARCELA],
          inicio: formatDate_(r[L.INICIO]),
          termino: formatDate_(r[L.TERMINO]),
          retorno: formatDate_(ret),
          dias: dias,
          tipo: String(r[L.TIPO] || '').trim(),
          obs: String(r[L.OBS] || '').trim(),
          status: _statusLanc_(r),
          motivo: String(r[L.MOTIVO] || '').trim(),
          solicitadoPor: String(r[L.SOLIC_POR] || '').trim(),
          rowIndex: r._ri,
        };
      }),
      ajustes: aju.map(function (x) {
        return {
          data: formatDate_(x.r[AJ.DATA]), dias: x.r[AJ.DIAS],
          obs: String(x.r[AJ.OBS] || '').trim(), rowIndex: x.rowIndex,
        };
      }),
    });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// AVISO DE FÉRIAS (PDF) — chamado pelo dashboard
// Identifica o lançamento pela matrícula + data de início do gozo.
// Retorna { success, filename, bytesB64 }
// ============================================================
function getAvisoFeriasPdf_(matricula, gozoInicioISO) {
  try {
    const mat = _mk_(matricula);
    const gi  = String(gozoInicioISO || '').trim();
    if (!mat || !gi) return _err_('Parâmetros insuficientes para o aviso.');

    const fr = _rows_(TAB.FUNC).find(function (r) { return _mk_(r[F.MAT]) === mat; });
    if (!fr) return _err_('Funcionário não encontrado: ' + mat);

    const scope = _scopeAtual_();
    if (scope.perfil === 'nenhum' || !_noEscopo_(scope, fr[F.FILIAL]))
      return _err_('Você não tem acesso a este funcionário.');

    const cand = _rows_(TAB.LANCAMENTOS).filter(function (r) {
      return _mk_(r[L.MAT]) === mat
        && formatDate_(r[L.INICIO]) === gi
        && String(r[L.TIPO] || '').trim().toLowerCase() === 'gozo';
    });
    if (!cand.length) return _err_('Período de férias não encontrado (início ' + gi + ').');
    // aviso só sai para férias aprovadas (fase 3)
    const lr = cand.find(function (r) { return _statusLanc_(r) === ST.APROV; });
    if (!lr) return _err_(_statusLanc_(cand[0]) === ST.PEND
      ? 'Estas férias ainda aguardam aprovação do RH — o aviso só pode ser emitido depois de aprovadas.'
      : 'Estas férias foram recusadas pelo RH — não há aviso a emitir.');

    const admissao   = toDate_(fr[F.ADMISSAO]);
    const gozoIniDt  = toDate_(lr[L.INICIO]);

    // --- Período aquisitivo ---
    // 1º: linha correspondente na aba Periodos; 2º: calcula a partir da admissão
    const periodoLabel = String(lr[L.PERIODO] || '').trim();
    let pr = null;
    if (periodoLabel) {
      pr = _rows_(TAB.PERIODOS).find(function (r) {
        return _mk_(r[P.MAT]) === mat
          && String(r[P.PERIODO] || '').trim() === periodoLabel;
      });
    }
    if (!pr) {
      pr = _rows_(TAB.PERIODOS).filter(function (r) { return _mk_(r[P.MAT]) === mat; })
        .sort(function (a, b) { return (toDate_(a[P.INI_AQ]) || 0) - (toDate_(b[P.INI_AQ]) || 0); })
        .pop() || null;
    }
    let aqIniD = pr ? toDate_(pr[P.INI_AQ]) : null;
    let aqFimD = pr ? toDate_(pr[P.FIM_AQ]) : null;
    if ((!aqIniD || !aqFimD) && admissao && gozoIniDt) {
      const calc = _periodoAquisitivo_(admissao, gozoIniDt);
      if (calc) { aqIniD = calc.ini; aqFimD = calc.fim; }
    }

    // --- Empresa (razão social / CNPJ / cidade) ---
    const filial = String(fr[F.FILIAL] || '').trim();
    const loja = {
      razao:  String(EMPRESA_PADRAO.razao  || '').trim(),
      cnpj:   String(EMPRESA_PADRAO.cnpj   || '').trim(),
      cidade: String(EMPRESA_PADRAO.cidade || '').trim() || filial,
    };
    try {
      const lo = _rows_(TAB.LOJAS).find(function (r) {
        return String(r[LO.FILIAL] || '').trim().toLowerCase() === filial.toLowerCase();
      });
      if (lo) {
        if (String(lo[LO.RAZAO]  || '').trim()) loja.razao  = String(lo[LO.RAZAO]).trim();
        if (String(lo[LO.CNPJ]   || '').trim()) loja.cnpj   = String(lo[LO.CNPJ]).trim();
        if (String(lo[LO.CIDADE] || '').trim()) loja.cidade = String(lo[LO.CIDADE]).trim();
      }
    } catch (e) { /* aba Lojas ausente — segue com o padrão */ }

    const nome     = String(fr[F.NOME] || '').trim();
    const registro = mat;
    const funcao   = String(fr[F.CARGO] || '').trim();
    // CTPS: usa a coluna I da aba Func se preenchida; senão gera um nº de 7 dígitos
    // (determinístico por funcionário, para não mudar a cada emissão)
    const ctps     = String(fr[F.CTPS] || '').trim() || _ctpsFake_(mat + '|' + nome);
    const hoje     = _dataExtenso_(formatDate_(new Date()));

    const dados = {
      doc:      '______ / ' + registro,
      localData: (loja.cidade ? loja.cidade + ', ' : '') + hoje,
      razao:    loja.razao || '____________________________',
      cnpj:     loja.cnpj  || '____________________',
      nome:     nome,
      ctps:     ctps,
      registro: registro,
      funcao:   funcao || '—',
      rh:       registro,
      aqIni:    aqIniD ? _dataExtenso_(formatDate_(aqIniD)) : '________________',
      aqFim:    aqFimD ? _dataExtenso_(formatDate_(aqFimD)) : '________________',
      gzIni:    _dataExtenso_(formatDate_(lr[L.INICIO])),
      gzFim:    _dataExtenso_(formatDate_(lr[L.TERMINO])),
      retorno:  _dataExtenso_(formatDate_(lr[L.RETORNO_UTIL] || lr[L.RETORNO])),
    };

    const html = _avisoHtml_(dados);
    const pdf  = Utilities.newBlob(html, 'text/html', 'aviso.html').getAs('application/pdf');
    const safe = String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_');
    return JSON.stringify({
      success: true,
      filename: 'Aviso_Ferias_' + safe + '.pdf',
      bytesB64: Utilities.base64Encode(pdf.getBytes()),
    });
  } catch (e) { return _err_(e.message); }
}

function _dataExtenso_(iso) {
  if (!iso) return '';
  const m = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const p = String(iso).split('-');
  if (p.length !== 3) return String(iso);
  return parseInt(p[2], 10) + ' de ' + (m[parseInt(p[1], 10) - 1] || p[1]) + ' de ' + p[0];
}

// Nº de CTPS de 7 dígitos, determinístico a partir de um texto (mesma pessoa =
// mesmo número em toda emissão). Só é usado quando a coluna I da aba Func
// (CTPS) está vazia — preencha lá o número real para ele ser usado.
function _ctpsFake_(seed) {
  let h = 0;
  const s = String(seed || '') || 'x';
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return String(1000000 + (h % 9000000));   // 1000000–9999999
}

// Período aquisitivo (ciclo de 12 meses a partir da admissão) que já se
// completou antes da data de gozo. Usado quando não há linha na aba Periodos.
function _periodoAquisitivo_(admissao, ref) {
  if (!admissao || !ref) return null;
  let anos = ref.getFullYear() - admissao.getFullYear();
  const aniv = new Date(admissao); aniv.setFullYear(admissao.getFullYear() + anos);
  if (aniv > ref) anos--;                 // ainda não fez aniversário de admissão este ano
  const k = Math.max(1, anos);            // pelo menos o 1º período aquisitivo
  const ini = new Date(admissao); ini.setFullYear(admissao.getFullYear() + (k - 1));
  const fim = new Date(admissao); fim.setFullYear(admissao.getFullYear() + k);
  fim.setDate(fim.getDate() - 1);
  return { ini: ini, fim: fim };
}

function _avisoHtml_(d) {
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const bar = function (t) {
    return '<tr><td style="border:1px solid #000;text-align:center;font-weight:bold;'
      + 'background:#e9e9e9;letter-spacing:2px;padding:3px">' + t + '</td></tr>';
  };
  const lbl = 'font-size:8.5px;font-weight:bold;text-transform:uppercase;color:#000';
  const cell = 'border:1px solid #000;padding:4px 8px';

  return ''
  + '<html><head><meta charset="utf-8"></head>'
  + '<body style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;margin:0">'
  + '<table style="border-collapse:collapse;width:100%">'
  + '<tr><td style="' + cell + '">'
  +   '<table style="width:100%;border-collapse:collapse"><tr>'
  +     '<td style="border:0;width:24%;font-size:11px">' + esc(d.doc) + '</td>'
  +     '<td style="border:0;text-align:center;font-size:14px;font-weight:bold;letter-spacing:4px">A V I S O &nbsp; D E &nbsp; F É R I A S</td>'
  +     '<td style="border:0;width:24%"></td>'
  +   '</tr></table>'
  + '</td></tr>'
  + '<tr><td style="' + cell + '"><span style="' + lbl + '">Local e Data:</span> &nbsp;&nbsp;' + esc(d.localData) + '</td></tr>'
  + '<tr><td style="' + cell + '"><span style="' + lbl + '">Empregador:</span> &nbsp;&nbsp;' + esc(d.razao) + ' &nbsp;/&nbsp; CNPJ: ' + esc(d.cnpj) + '</td></tr>'
  + bar('NOTIFICAÇÃO')
  + '<tr><td style="' + cell + '">'
  +   '<table style="width:100%;border-collapse:collapse"><tr>'
  +     '<td style="border:0;width:70%"><span style="' + lbl + '">Nome do Empregado:</span><br><span style="font-size:13px;font-weight:bold">' + esc(d.nome) + '</span></td>'
  +     '<td style="border-left:1px solid #000;padding-left:8px"><span style="' + lbl + '">CTPS Nº / Série:</span><br>' + esc(d.ctps) + '</td>'
  +   '</tr></table>'
  + '</td></tr>'
  + '<tr><td style="' + cell + '">'
  +   '<table style="width:100%;border-collapse:collapse"><tr>'
  +     '<td style="border:0;width:22%"><span style="' + lbl + '">Nº Registro</span><br>' + esc(d.registro) + '</td>'
  +     '<td style="border-left:1px solid #000;padding-left:8px"><span style="' + lbl + '">Função</span><br>' + esc(d.funcao) + '</td>'
  +     '<td style="border-left:1px solid #000;padding-left:8px;width:28%"><span style="' + lbl + '">R / H</span><br>' + esc(d.rh) + '</td>'
  +   '</tr></table>'
  + '</td></tr>'
  + bar('TERMOS')
  + '<tr><td style="' + cell + ';padding:16px 12px;line-height:2">Pelo presente comunicamos-lhe, nos termos da legislação em vigor, a concessão de férias de acordo com o demonstrativo abaixo:</td></tr>'
  + bar('PERÍODOS')
  + '<tr><td style="' + cell + '"><span style="' + lbl + '">De Aquisição:</span> &nbsp;&nbsp;&nbsp;' + esc(d.aqIni) + ' &nbsp;&nbsp;&nbsp;a&nbsp;&nbsp;&nbsp; ' + esc(d.aqFim) + '</td></tr>'
  + '<tr><td style="' + cell + '"><span style="' + lbl + '">De Gozo:</span> &nbsp;&nbsp;&nbsp;' + esc(d.gzIni) + ' &nbsp;&nbsp;&nbsp;a&nbsp;&nbsp;&nbsp; ' + esc(d.gzFim) + '</td></tr>'
  + '<tr><td style="' + cell + '"><span style="' + lbl + '">Retorno ao Trabalho:</span> &nbsp;&nbsp;&nbsp;' + esc(d.retorno) + '</td></tr>'
  + '<tr><td style="' + cell + ';height:210px"></td></tr>'
  + '<tr><td style="' + cell + '">'
  +   '<table style="width:100%;border-collapse:collapse;margin-top:24px"><tr>'
  +     '<td style="border:0;border-top:1px solid #000;text-align:center;padding-top:4px;width:48%;font-size:10px">' + esc(d.razao) + '</td>'
  +     '<td style="border:0;width:4%"></td>'
  +     '<td style="border:0;border-top:1px solid #000;text-align:center;padding-top:4px;font-size:10px">' + esc(d.nome) + '</td>'
  +   '</tr></table>'
  + '</td></tr>'
  + bar('NOTA')
  + '<tr><td style="' + cell + ';height:64px"></td></tr>'
  + '</table></body></html>';
}

// ============================================================
// FUNCIONÁRIOS SEM REGISTRO — PAGAMENTO DE FÉRIAS
// Fonte: coluna "Registrado" = "Não" na aba Func (+ planilha legada
// opcional em PAYMENT_SHEET_ID).
// mês de vencimento = mês do vencimento no ano atual (como na aba Vencimento Mensal) ou, sem ele, da admissão;
// pagar 30 dias    = saldo atual >= 30.
// ============================================================
function getPaymentData_(func, saldoOf) {
  const currentMonth = new Date().getMonth() + 1;
  const all = [], due = [], errors = [];

  try {
    (func && func.length ? func : _rows_(TAB.FUNC)).forEach(function (r) {
      const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
      if (reg !== 'não' && reg !== 'nao') return;
      const name = String(r[F.NOME] || '').trim();
      if (!name) return;
      // mês da admissão; getVacationData_ troca pelo vencimento do ano atual, se houver
      const base = toDate_(r[F.ADMISSAO]);
      const monthNum = base ? base.getMonth() + 1 : null;
      const saldo = saldoOf ? saldoOf(_mk_(r[F.MAT])) : 0;
      const rec = {
        matricula: _mk_(r[F.MAT]),
        name: name,
        branch: String(r[F.FILIAL] || '').trim(),
        month: monthNum ? _cap_(MONTHS_PT[monthNum - 1]) : '',
        monthNum: monthNum,
        registrado: false,
        pay30: saldo >= 30,
        isDue: monthNum === currentMonth,
        saldo: saldo,
      };
      all.push(rec);
      if (rec.isDue) due.push(rec);
    });
  } catch (e) { errors.push(e.message); }

  if (PAYMENT_SHEET_ID) {
    try {
      const sh = SpreadsheetApp.openById(PAYMENT_SHEET_ID).getSheets()[0];
      const last = sh.getLastRow();
      if (last > 1) {
        sh.getRange(2, 1, last - 1, 4).getValues().forEach(function (row) {
          const name = String(row[PAY_COL.NOME] || '').trim();
          if (!name) return;
          const mStr = String(row[PAY_COL.MES_VENC] || '').toLowerCase().trim();
          const idx = MONTHS_PT.indexOf(mStr);
          const monthNum = idx >= 0 ? idx + 1 : null;
          const rec = {
            name: name,
            branch: String(row[PAY_COL.FILIAL] || '').trim(),
            month: String(row[PAY_COL.MES_VENC] || '').trim(),
            monthNum: monthNum,
            pay30: String(row[PAY_COL.PAGAR_30] || '').trim().toLowerCase() === 'sim',
            isDue: monthNum === currentMonth,
          };
          all.push(rec);
          if (rec.isDue) due.push(rec);
        });
      }
    } catch (e) { errors.push(e.message); }
  }

  return { all: all, due: due, errors: errors };
}

// Registrados ativos — pagamento de 1/3 no mês (ano atual) em que
// vence a concessão (mesma regra da aba Vencimento Mensal) OU termina
// um período aquisitivo. Uma linha por funcionário × mês.
function _pagamentoTerco_(employees) {
  const hoje = new Date();
  const ano = String(hoje.getFullYear()), mesAtual = hoje.getMonth() + 1;
  const out = [];
  employees.forEach(function (e) {
    if (!e.registrado || !e.ativo) return;
    const porMes = {};
    const mes = function (iso) { return iso && iso.substring(0, 4) === ano ? Number(iso.substring(5, 7)) : 0; };
    const vencs = e.vencimentos.length ? e.vencimentos : (e.vencimento ? [e.vencimento] : []);
    vencs.forEach(function (iso) {
      const m = mes(iso); if (m) (porMes[m] = porMes[m] || {}).venc = iso;
    });
    e.periodos.forEach(function (p) {
      const m = mes(p.fim); if (m) (porMes[m] = porMes[m] || {}).per = p;
    });
    Object.keys(porMes).forEach(function (k) {
      const m = Number(k), x = porMes[k];
      out.push({
        name: e.nome,
        branch: e.filial,
        month: _cap_(MONTHS_PT[m - 1]),
        monthNum: m,
        registrado: true,
        vencimento: x.venc || '',
        periodo: x.per ? x.per.label : '',
        periodoIni: x.per ? x.per.ini : '',
        periodoFim: x.per ? x.per.fim : '',
        pay30: false,
        isDue: m === mesAtual,
      });
    });
  });
  return out;
}

// ============================================================
// INCLUSÃO DE FÉRIAS — grava na aba Lancamentos
// payload = { branch, name, startDate, endDate }
// ============================================================
function addVacationRecord_(payload) {
  try {
    const name = String(payload.name || '').trim();
    if (!name) return _err_('Nome do funcionário é obrigatório.');
    const start = toDate_(payload.startDate);
    const end   = toDate_(payload.endDate);
    if (!start) return _err_('Data de início inválida.');
    if (!end)   return _err_('Data de fim inválida.');
    if (end < start) return _err_('Data de fim anterior ao início.');

    const branch = String(payload.branch || '').trim();
    const match = _rows_(TAB.FUNC).find(function (r) {
      return String(r[F.NOME] || '').trim().toLowerCase() === name.toLowerCase()
        && (!branch || String(r[F.FILIAL] || '').trim() === branch);
    });
    if (!match) return _err_('Funcionário não encontrado na aba Func: ' + name);

    const scope = _scopeAtual_();
    if (scope.perfil === 'nenhum' || !_noEscopo_(scope, match[F.FILIAL]))
      return _err_('Você não tem acesso para marcar férias nesta filial.');
    const matRaw = match[F.MAT];                       // grava com o MESMO tipo da aba Func
    const mat = _mk_(matRaw);
    if (!mat) return _err_('O funcionário "' + name + '" está sem matrícula na aba Func. Preencha a coluna Matrícula e tente de novo.');

    // período aquisitivo: o escolhido no formulário (payload.periodo) ou, automático,
    // o último período JÁ COMPLETO antes do início das férias (férias antecipadas,
    // sem nenhum completo => o 1º período). Antes usava sempre o mais recente,
    // o que ligava férias antigas a um período ainda em formação.
    let periodoRaw = '';
    const pers = _periodosDe_(mat);
    const escolhido = String(payload.periodo || '').trim();
    if (escolhido) {
      const pe = pers.find(function (p) { return p.label === escolhido; });
      if (!pe) return _err_('Período "' + escolhido + '" não existe para este funcionário.');
      periodoRaw = pe.raw;
    } else if (pers.length) {
      const completos = pers.filter(function (p) { return p.fim && p.fim < start; });
      periodoRaw = (completos.length ? completos[completos.length - 1] : pers[0]).raw;
    }

    const sh = _sheet_(TAB.LANCAMENTOS);
    _ensureLancCols_(sh);
    const existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, LANC_COLS).getValues() : [];
    const doFunc = existing.filter(function (r) { return _mk_(r[L.MAT]) === mat; });

    // não deixa marcar por cima de outras férias (aprovadas ou pendentes) da mesma pessoa
    const choque = doFunc.find(function (r) {
      if (_statusLanc_(r) === ST.RECUS) return false;
      const s = toDate_(r[L.INICIO]), e = toDate_(r[L.TERMINO]);
      return s && e && start <= e && end >= s;
    });
    if (choque) return _err_('Já existe férias de ' + name + ' de ' + formatDateBR_(formatDate_(choque[L.INICIO]))
      + ' a ' + formatDateBR_(formatDate_(choque[L.TERMINO])) + ' (' + _statusLanc_(choque).toLowerCase()
      + ') que se sobrepõe a este período.');

    const parcela = doFunc.filter(function (r) {
      return String(r[L.TIPO] || '').trim().toLowerCase() === 'gozo' && _statusLanc_(r) !== ST.RECUS;
    }).length + 1;

    const total = Math.round((end - start) / 864e5) + 1;
    const retSimples = _plusDays_(end, 1);
    const retUtil = _addWorkingDays_(end, 1);
    const seq = doFunc.length + 1;
    const chave = String(matRaw) + '-' + seq;
    const nr = sh.getLastRow() + 1;

    // fase 3: gerente SOLICITA (Pendente, não desconta saldo); RH e Gerente Matriz
    // (nas filiais que ele aprova) já lançam aprovado
    const agora = new Date();
    const status = _podeAprovar_(scope, match[F.FILIAL]) ? ST.APROV : ST.PEND;
    const quem = scope.email || (scope.perfil === 'gerente' ? 'gerente' : 'RH');

    // grava só VALORES (nada de fórmula — evita erro de separador/locale no Sheets).
    // limpa a validação herdada antes, para o setValues não ser recusado.
    sh.getRange(nr, 1, 1, LANC_COLS).setDataValidation(null);
    sh.getRange(nr, 1, 1, LANC_COLS).setValues([[
      matRaw, periodoRaw, parcela, start, end,
      total, 'Gozo', retSimples, retUtil, '', seq, chave,
      status, quem, agora,
      status === ST.APROV ? quem : '', status === ST.APROV ? agora : '', ''
    ]]);
    sh.getRange(nr, L.INICIO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.TERMINO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.RETORNO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.RETORNO_UTIL + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.SOLIC_EM + 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange(nr, L.DECID_EM + 1).setNumberFormat('dd/mm/yyyy hh:mm');

    if (status === ST.PEND) {
      _notificar_(_emailsAprovadores_(match[F.FILIAL]), 'Nova solicitação — ' + name + ' (' + String(match[F.FILIAL] || '').trim() + ')',
        quem + ' solicitou férias para ' + name + ' de ' + formatDateBR_(formatDate_(start))
        + ' a ' + formatDateBR_(formatDate_(end)) + ' (' + total + ' dias).\nAbra a aba "Aprovações" do painel para aprovar ou recusar.');
    }

    // devolve os dropdowns (Matrícula / Período / Tipo) copiando da linha 2
    try {
      [1, 2, 7].forEach(function (col) {
        const dv = sh.getRange(2, col).getDataValidation();
        if (dv) sh.getRange(nr, col).setDataValidation(dv);
      });
    } catch (e) { /* sem validação na linha 2 — ignora */ }

    return JSON.stringify({
      success: true, rowIndex: nr,
      returnDate: formatDate_(retUtil), total: total, status: status,
    });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// ATUALIZAÇÃO DE FÉRIAS — payload = { branch, rowIndex, startDate, endDate }
// rowIndex = linha na aba Lancamentos
// ============================================================
function updateVacationRecord_(payload) {
  try {
    if (_scopeAtual_().perfil === 'gerente')
      return _err_('Só o RH pode editar datas de férias já lançadas.');
    const row = Number(payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');
    const start = toDate_(payload.startDate);
    const end   = toDate_(payload.endDate);
    if (!start) return _err_('Data de início inválida.');
    if (!end)   return _err_('Data de fim inválida.');
    if (end < start) return _err_('Data de fim anterior ao início.');

    const sh = _sheet_(TAB.LANCAMENTOS);
    const total = Math.round((end - start) / 864e5) + 1;
    const retUtil = _addWorkingDays_(end, 1);

    // grava só VALORES (sem fórmula — evita erro de separador/locale)
    sh.getRange(row, L.INICIO + 1).setValue(start).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.TERMINO + 1).setValue(end).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.DIAS + 1).setValue(total);
    sh.getRange(row, L.RETORNO + 1).setValue(_plusDays_(end, 1)).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.RETORNO_UTIL + 1).setValue(retUtil).setNumberFormat('dd/mm/yyyy');

    return JSON.stringify({ success: true, returnDate: formatDate_(retUtil), total: total });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// INCLUSÃO DE PERÍODO AQUISITIVO — grava na aba Periodos
// payload = { matricula, inicioAquisitivo, faltas }
// ============================================================
function addPeriodoAquisitivo_(payload) {
  try {
    if (_scopeAtual_().perfil === 'gerente')
      return _err_('Só o RH pode incluir período aquisitivo.');
    const matIn = _mk_(payload && payload.matricula);
    if (!matIn) return _err_('Matrícula não informada.');
    const ini = toDate_(payload.inicioAquisitivo);
    if (!ini) return _err_('Data de início do período inválida.');
    const faltas = Number(payload.faltas) || 0;

    const fr = _rows_(TAB.FUNC).find(function (r) { return _mk_(r[F.MAT]) === matIn; });
    if (!fr) return _err_('Funcionário não encontrado na aba Func.');
    const matRaw = fr[F.MAT];

    const sh = _sheet_(TAB.PERIODOS);
    const existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues() : [];
    for (var i = 0; i < existing.length; i++) {
      if (_mk_(existing[i][P.MAT]) === matIn
        && formatDate_(existing[i][P.INI_AQ]) === formatDate_(ini))
        return _err_('Já existe um período aquisitivo iniciando em ' + formatDate_(ini) + '.');
    }
    const seq = existing.filter(function (r) { return _mk_(r[P.MAT]) === matIn; }).length + 1;

    const today = _midnight_(new Date());
    const fim  = _plusDays_(_addMonths_(ini, 12), -1);
    const conc = _addMonths_(fim, 12);
    const label = ini.getFullYear() + '/' + fim.getFullYear();
    const direito = _diasDireito_(faltas);
    const creditado = (fim <= today) ? 'Sim' : 'Não';
    const situacao = _periodoSituacao_(fim, conc, today);
    const chave = String(matRaw) + '-' + seq;
    const nr = sh.getLastRow() + 1;

    // grava só VALORES (sem fórmula — o servidor recalcula creditado/situação pelas datas)
    sh.getRange(nr, 1, 1, 11).setDataValidation(null);
    sh.getRange(nr, 1, 1, 11).setValues([[
      matRaw, label, ini, fim, faltas, direito, conc, creditado, situacao, seq, chave
    ]]);
    sh.getRange(nr, P.INI_AQ + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, P.FIM_AQ + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, P.CONCESSAO + 1).setNumberFormat('dd/mm/yyyy');
    try {
      const dv = sh.getRange(2, 1).getDataValidation();
      if (dv) sh.getRange(nr, 1).setDataValidation(dv);
    } catch (e) { /* sem validação na linha 2 */ }

    return JSON.stringify({
      success: true, periodo: label, direito: direito,
      fimAquisitivo: formatDate_(fim), concessao: formatDate_(conc),
    });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// EDITAR PERÍODO AQUISITIVO — recalcula e reescreve a linha na aba Periodos
// payload = { rowIndex, matricula (conferência), inicioAquisitivo, faltas }
// ============================================================
function updatePeriodoAquisitivo_(payload) {
  try {
    if (_scopeAtual_().perfil === 'gerente')
      return _err_('Só o RH pode editar período aquisitivo.');

    payload = payload || {};
    const row = Number(payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');
    const matIn = _mk_(payload.matricula);
    const ini = toDate_(payload.inicioAquisitivo);
    if (!ini) return _err_('Data de início do período inválida.');
    const faltas = Number(payload.faltas) || 0;

    const sh = _sheet_(TAB.PERIODOS);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue a ficha.');
    const cur = sh.getRange(row, 1, 1, Math.max(9, sh.getLastColumn())).getValues()[0];
    if (matIn && _mk_(cur[P.MAT]) !== matIn)
      return _err_('A linha mudou de posição na planilha. Recarregue a ficha e tente de novo.');

    // não pode colidir com OUTRO período do mesmo funcionário
    const matRow = _mk_(cur[P.MAT]);
    const rows = _rows_(TAB.PERIODOS);
    for (var i = 0; i < rows.length; i++) {
      if ((i + 2) === row) continue;
      if (_mk_(rows[i][P.MAT]) === matRow
        && formatDate_(rows[i][P.INI_AQ]) === formatDate_(ini))
        return _err_('Já existe outro período aquisitivo iniciando em ' + formatDate_(ini) + '.');
    }

    const today = _midnight_(new Date());
    const fim  = _plusDays_(_addMonths_(ini, 12), -1);
    const conc = _addMonths_(fim, 12);
    const label = ini.getFullYear() + '/' + fim.getFullYear();
    const direito = _diasDireito_(faltas);
    const creditado = (fim <= today) ? 'Sim' : 'Não';
    const situacao = _periodoSituacao_(fim, conc, today);

    // reescreve as colunas B..I (mantém Matrícula e _seq/_chave)
    sh.getRange(row, P.PERIODO + 1, 1, 8).setValues([[
      label, ini, fim, faltas, direito, conc, creditado, situacao
    ]]);
    sh.getRange(row, P.INI_AQ + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, P.FIM_AQ + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, P.CONCESSAO + 1).setNumberFormat('dd/mm/yyyy');

    return JSON.stringify({
      success: true, periodo: label, direito: direito,
      fimAquisitivo: formatDate_(fim), concessao: formatDate_(conc),
    });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// EXCLUIR PERÍODO AQUISITIVO — apaga a linha na aba Periodos (só RH)
// payload = { rowIndex, matricula (conferência) }
// ============================================================
function deletePeriodoAquisitivo_(payload) {
  try {
    if (_scopeAtual_().perfil === 'gerente')
      return _err_('Só o RH pode apagar período aquisitivo.');

    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');

    const sh = _sheet_(TAB.PERIODOS);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue a ficha.');
    const cur = sh.getRange(row, 1, 1, Math.max(9, sh.getLastColumn())).getValues()[0];
    if (payload.matricula && _mk_(cur[P.MAT]) !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue a ficha e tente de novo.');

    sh.deleteRow(row);
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// CADASTRO DE FUNCIONÁRIO — grava uma linha na aba Func (só RH)
// payload = { matricula?, nome, filial, cargo?, admissao (ISO),
//             registrado (bool), saldoInicial?, ctps?, situacao? }
// Se registrado, cria também o 1º período aquisitivo (admissão, 0 faltas).
// ============================================================
function addEmployee_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode cadastrar funcionário.');

    payload = payload || {};
    const nome   = String(payload.nome   || '').trim();
    const filial = String(payload.filial || '').trim();
    if (!nome)   return _err_('Nome é obrigatório.');
    if (!filial) return _err_('Filial é obrigatória.');
    const adm = toDate_(payload.admissao);
    if (!adm) return _err_('Data de admissão inválida.');

    const cargo = String(payload.cargo || '').trim();
    const ctps  = String(payload.ctps  || '').trim();
    const regStr = String(payload.registrado).toLowerCase();
    const registrado = payload.registrado !== false && regStr !== 'não' && regStr !== 'nao' && regStr !== 'false';
    const saldoN = Number(payload.saldoInicial);
    const saldoIni = isNaN(saldoN) ? 0 : saldoN;

    const rows = _rows_(TAB.FUNC);

    // matrícula: usa a informada ou sugere (maior número existente + 1)
    let maxNum = 0;
    rows.forEach(function (r) {
      const n = parseInt(String(r[F.MAT]).replace(/\D/g, ''), 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    });
    const matInput = String(payload.matricula || '').trim();
    const matToWrite = matInput
      ? (/^\d+$/.test(matInput) ? Number(matInput) : matInput)
      : (maxNum + 1);
    const matKey = _mk_(matToWrite);
    if (!matKey) return _err_('Matrícula inválida.');
    if (rows.some(function (r) { return _mk_(r[F.MAT]) === matKey; }))
      return _err_('Já existe um funcionário com a matrícula ' + matKey + '.');

    const sh = _sheet_(TAB.FUNC);
    const nr = sh.getLastRow() + 1;
    const width = F.VENC + 1;                 // A..J (inclui CTPS e Vencimento)
    const rowVals = new Array(width).fill('');
    rowVals[F.MAT]        = matToWrite;
    rowVals[F.NOME]       = nome;
    rowVals[F.FILIAL]     = filial;
    rowVals[F.CARGO]      = cargo;
    rowVals[F.ADMISSAO]   = adm;
    rowVals[F.SITUACAO]   = String(payload.situacao || 'Ativo').trim();
    rowVals[F.SALDO_INI]  = saldoIni;
    rowVals[F.REGISTRADO] = registrado ? 'Sim' : 'Não';
    if (ctps) rowVals[F.CTPS] = ctps;

    // grava só VALORES; limpa a validação herdada para o setValues não ser recusado
    sh.getRange(nr, 1, 1, width).setDataValidation(null);
    sh.getRange(nr, 1, 1, width).setValues([rowVals]);
    sh.getRange(nr, F.ADMISSAO + 1).setNumberFormat('dd/mm/yyyy');

    // devolve os dropdowns (Filial / Situação / Registrado) copiando da linha 2
    try {
      [F.FILIAL + 1, F.SITUACAO + 1, F.REGISTRADO + 1].forEach(function (col) {
        const dv = sh.getRange(2, col).getDataValidation();
        if (dv) sh.getRange(nr, col).setDataValidation(dv);
      });
    } catch (e) { /* sem validação na linha 2 — ignora */ }

    // 1º período aquisitivo (só se registrado)
    let periodo = null, periodoAviso = null;
    if (registrado) {
      try {
        const pr = JSON.parse(addPeriodoAquisitivo_({
          matricula: matKey,
          inicioAquisitivo: formatDate_(adm),
          faltas: 0,
        }));
        if (pr && pr.success) periodo = pr.periodo;
        else periodoAviso = (pr && pr.error) || 'não foi possível criar o período aquisitivo.';
      } catch (e) { periodoAviso = e.message; }
    }

    return JSON.stringify({
      success: true, matricula: matKey, rowIndex: nr,
      periodo: periodo, periodoAviso: periodoAviso,
    });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// EDITAR FUNCIONÁRIO — reescreve Nome/Filial/Cargo/Admissão/Saldo inicial/
// Registrado/CTPS da linha na aba Func (só RH). A matrícula NÃO muda (é a
// chave que liga Periodos/Lancamentos/Ajustes). Mudar a admissão não recalcula
// os períodos aquisitivos já cadastrados — eles são editados na ficha.
// payload = { matricula, nome, filial, cargo, admissao, saldoInicial, registrado, ctps }
// ============================================================
function updateEmployee_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode editar funcionário.');
    payload = payload || {};
    const mat = _mk_(payload.matricula);
    if (!mat) return _err_('Matrícula não informada.');
    const nome   = String(payload.nome   || '').trim();
    const filial = String(payload.filial || '').trim();
    if (!nome)   return _err_('Nome é obrigatório.');
    if (!filial) return _err_('Filial é obrigatória.');
    const adm = toDate_(payload.admissao);
    if (!adm) return _err_('Data de admissão inválida.');
    const saldoN = Number(payload.saldoInicial);
    if (isNaN(saldoN)) return _err_('Saldo inicial inválido.');
    const regStr = String(payload.registrado).toLowerCase();
    const registrado = payload.registrado !== false && regStr !== 'não' && regStr !== 'nao' && regStr !== 'false';

    const rows = _rows_(TAB.FUNC);
    const idx = rows.findIndex(function (r) { return _mk_(r[F.MAT]) === mat; });
    if (idx < 0) return _err_('Funcionário não encontrado: ' + mat);

    const sh = _sheet_(TAB.FUNC);
    const row = idx + 2;
    // B..E (Nome, Filial, Cargo, Admissão), G..H (Saldo inicial, Registrado), I (CTPS)
    sh.getRange(row, F.NOME + 1, 1, 4).setValues([[nome, filial, String(payload.cargo || '').trim(), adm]]);
    sh.getRange(row, F.ADMISSAO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, F.SALDO_INI + 1, 1, 2).setValues([[saldoN, registrado ? 'Sim' : 'Não']]);
    if (sh.getMaxColumns() > F.CTPS) sh.getRange(row, F.CTPS + 1).setValue(String(payload.ctps || '').trim());

    return JSON.stringify({ success: true, matricula: mat });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// TROCAR O PERÍODO AQUISITIVO de um lançamento de férias (só RH)
// payload = { rowIndex, matricula, inicio, periodo }  (matricula/inicio = conferência)
// ============================================================
function updateLancamentoPeriodo_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode alterar o período das férias.');
    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');
    const periodo = String(payload.periodo || '').trim();
    const sh = _sheet_(TAB.LANCAMENTOS);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue o painel.');
    const cur = sh.getRange(row, 1, 1, L.TERMINO + 1).getValues()[0];
    const mat = _mk_(cur[L.MAT]);
    if (payload.matricula && mat !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    if (payload.inicio && formatDate_(cur[L.INICIO]) !== String(payload.inicio))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    const pr = _periodosDe_(mat).find(function (p) { return p.label === periodo; });
    if (!pr) return _err_('Período "' + periodo + '" não existe para este funcionário.');
    sh.getRange(row, L.PERIODO + 1).setValue(pr.raw);
    return JSON.stringify({ success: true, periodo: pr.label });
  } catch (e) { return _err_(e.message); }
}

// Períodos aquisitivos de uma matrícula, em ordem: [{ label, raw, ini, fim }]
// label = texto da coluna Período (ou "aaaa/aaaa" calculado); raw = valor da célula
function _periodosDe_(mat, perRows) {
  return (perRows || _rows_(TAB.PERIODOS)).filter(function (r) { return _mk_(r[P.MAT]) === mat; })
    .map(function (r) {
      const ini = toDate_(r[P.INI_AQ]);
      const fim = toDate_(r[P.FIM_AQ]) || (ini ? _plusDays_(_addMonths_(ini, 12), -1) : null);
      const txt = String(r[P.PERIODO] || '').trim();
      const label = txt || (ini && fim ? ini.getFullYear() + '/' + fim.getFullYear() : '');
      return { label: label, raw: txt ? r[P.PERIODO] : label, ini: ini, fim: fim };
    })
    .filter(function (p) { return p.label; })
    .sort(function (a, b) { return (a.ini || 0) - (b.ini || 0); });
}

// ============================================================
// ATIVAR / INATIVAR FUNCIONÁRIO — grava a coluna Situação na aba Func (só RH)
// payload = { matricula, ativo: bool }   ativo=false => "Inativo" (desligado)
// ============================================================
function setEmployeeStatus_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode ativar ou inativar funcionário.');

    payload = payload || {};
    const mat = _mk_(payload.matricula);
    if (!mat) return _err_('Matrícula não informada.');

    const rows = _rows_(TAB.FUNC);
    let idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (_mk_(rows[i][F.MAT]) === mat) { idx = i; break; }
    }
    if (idx < 0) return _err_('Funcionário não encontrado na aba Func.');

    const situacao = (payload.ativo === false || String(payload.ativo).toLowerCase() === 'false')
      ? 'Inativo' : 'Ativo';
    const nr = idx + 2;                       // +1 cabeçalho, +1 base-1
    const cell = _sheet_(TAB.FUNC).getRange(nr, F.SITUACAO + 1);
    const dv = cell.getDataValidation();
    cell.setDataValidation(null).setValue(situacao);
    if (dv) cell.setDataValidation(dv);

    return JSON.stringify({ success: true, matricula: mat, situacao: situacao, ativo: situacao === 'Ativo' });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// VENCIMENTO DAS FÉRIAS (manual) — grava a coluna J da aba Func (só RH)
// payload = { matricula, vencimento }  vencimento = 'yyyy-mm' | 'yyyy-mm-dd' | '' (limpa)
// Só é usado quando o funcionário NÃO tem período aquisitivo calculado.
// ============================================================
function setEmployeeVencimento_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode definir o vencimento das férias.');

    payload = payload || {};
    const mat = _mk_(payload.matricula);
    if (!mat) return _err_('Matrícula não informada.');

    const rows = _rows_(TAB.FUNC);
    let idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (_mk_(rows[i][F.MAT]) === mat) { idx = i; break; }
    }
    if (idx < 0) return _err_('Funcionário não encontrado na aba Func.');

    const cell = _sheet_(TAB.FUNC).getRange(idx + 2, F.VENC + 1);
    const v = String(payload.vencimento || '').trim();
    if (!v) { cell.clearContent(); return JSON.stringify({ success: true, vencimento: '' }); }

    // pega ano/mês direto do texto (evita new Date(string), que parseia como UTC
    // e desloca o mês ao ler getMonth() no fuso local)
    const m = v.match(/^(\d{4})-(\d{2})/);
    if (!m) return _err_('Vencimento inválido (use mês/ano).');
    const ano = Number(m[1]), mes = Number(m[2]);
    if (mes < 1 || mes > 12) return _err_('Vencimento inválido (mês fora de 1–12).');
    const first = new Date(ano, mes - 1, 1);   // meia-noite local, 1º dia do mês
    cell.setValue(first).setNumberFormat('mm/yyyy');

    return JSON.stringify({ success: true, vencimento: m[1] + '-' + m[2] + '-01' });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// FÉRIAS PAGA? — marca Sim/Não por (matrícula × vencimento) na aba Pagamentos
// payload = { matricula, vencimento: 'yyyy-mm-dd', pago: 'Sim' | 'Não' | '' (limpa) }
// Só RH grava; o painel lê o mapa { 'mat|yyyy-mm-dd': 'Sim'|'Não' } em feriasPagas.
// ============================================================
function _ensurePagos_() {
  const ss = SpreadsheetApp.openById(MODEL_SHEET_ID);
  let sh = ss.getSheetByName(TAB.PAGOS);
  if (!sh) {
    sh = ss.insertSheet(TAB.PAGOS);
    sh.getRange(1, 1, 1, PAGOS_HEADERS.length).setValues([PAGOS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function _feriasPagas_(employees) {
  const out = {};
  try {
    const sh = SpreadsheetApp.openById(MODEL_SHEET_ID).getSheetByName(TAB.PAGOS);
    if (!sh || sh.getLastRow() <= 1) return out;
    const permitidas = {};
    (employees || []).forEach(function (e) { permitidas[e.matricula] = true; });
    sh.getRange(2, 1, sh.getLastRow() - 1, PAGOS_HEADERS.length).getValues().forEach(function (r) {
      const mat = _mk_(r[PG.MAT]), venc = formatDate_(r[PG.VENC]);
      const pago = String(r[PG.PAGO] || '').trim();
      if (mat && venc && pago && permitidas[mat]) out[mat + '|' + venc] = pago;
    });
  } catch (e) { /* aba ilegível não derruba o painel */ }
  return out;
}

function setFeriasPaga_(payload) {
  try {
    const scope = _scopeAtual_();
    if (scope.perfil !== 'rh') return _err_('Só o RH pode marcar férias como pagas.');

    payload = payload || {};
    const mat = _mk_(payload.matricula);
    const venc = toDate_(payload.vencimento);
    if (!mat || !venc) return _err_('Matrícula ou vencimento não informado.');
    const vencISO = formatDate_(venc);
    const p = String(payload.pago || '').trim().toLowerCase();
    const pago = p === 'sim' ? 'Sim' : (p === 'não' || p === 'nao') ? 'Não' : '';

    const sh = _ensurePagos_();
    const last = sh.getLastRow();
    let row = 0;
    if (last > 1) {
      const vals = sh.getRange(2, 1, last - 1, 2).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (_mk_(vals[i][PG.MAT]) === mat && formatDate_(vals[i][PG.VENC]) === vencISO) { row = i + 2; break; }
      }
    }
    if (!pago) {
      if (row) sh.deleteRow(row);
      return JSON.stringify({ success: true, pago: '' });
    }
    const linha = [[mat, venc, pago, new Date(), scope.email || 'RH']];
    if (!row) row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, PAGOS_HEADERS.length).setValues(linha);
    sh.getRange(row, PG.VENC + 1).setNumberFormat('dd/mm/aaaa');
    sh.getRange(row, PG.EM + 1).setNumberFormat('dd/mm/aaaa hh:mm');
    return JSON.stringify({ success: true, pago: pago });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// AJUSTE MANUAL / OBSERVAÇÃO — grava uma linha na aba Ajustes (só RH)
// payload = { matricula, data? (ISO, default hoje), dias? (+/-), obs }
// dias vazio/0  => só observação (não altera o saldo)
// dias com sinal => credita (+) ou desconta (−) do banco de dias
// ============================================================
function addAjuste_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode lançar ajuste ou observação.');

    payload = payload || {};
    const matIn = _mk_(payload.matricula);
    if (!matIn) return _err_('Matrícula não informada.');

    const obs = String(payload.obs || '').trim();
    const diasRaw = payload.dias;
    const dias = (diasRaw === '' || diasRaw == null) ? 0 : Number(diasRaw);
    if (isNaN(dias)) return _err_('Dias do ajuste inválido — use número (ex.: -2 ou 5).');
    if (!dias && !obs) return _err_('Informe os dias do ajuste e/ou uma observação.');

    const data = toDate_(payload.data) || _midnight_(new Date());

    const fr = _rows_(TAB.FUNC).find(function (r) { return _mk_(r[F.MAT]) === matIn; });
    if (!fr) return _err_('Funcionário não encontrado na aba Func.');
    const matRaw = fr[F.MAT];

    const sh = _sheet_(TAB.AJUSTES);
    const existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues() : [];
    const seq = existing.filter(function (r) { return _mk_(r[AJ.MAT]) === matIn; }).length + 1;
    const chave = String(matRaw) + '-' + seq;
    const nr = sh.getLastRow() + 1;

    // grava só VALORES (sem fórmula — locale pt-BR)
    sh.getRange(nr, 1, 1, 6).setDataValidation(null);
    sh.getRange(nr, 1, 1, 6).setValues([[
      matRaw, data, (dias || ''), obs, seq, chave
    ]]);
    sh.getRange(nr, AJ.DATA + 1).setNumberFormat('dd/mm/yyyy');
    try {
      const dv = sh.getRange(2, 1).getDataValidation();
      if (dv) sh.getRange(nr, 1).setDataValidation(dv);
    } catch (e) { /* sem validação na linha 2 */ }

    return JSON.stringify({ success: true, dias: dias, data: formatDate_(data), obs: obs });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// IMPORTAÇÃO EM LOTE (só RH) — períodos, ajustes e férias de vários
// funcionários de uma vez, a partir de um texto colado no painel:
//   @ Nome do funcionário (ou matrícula)
//   P 09/08/2024                  período aquisitivo (início) [faltas opcional]
//   A 13/06/2025 +12,5 Observação ajuste de saldo (dias com sinal)
//   F 03/11/2025 05/11/2025       férias (gozo), início e fim
//   = 29                          saldo esperado no fim (só para conferir)
//   # comentário
// simular=true só confere e calcula o saldo previsto, sem gravar nada.
// Grava pelas mesmas funções do painel (mesmas regras). Rodar de novo não
// duplica: período/férias/ajuste idênticos já existentes são pulados.
// ============================================================
function importarLote_(texto, simular) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode importar em lote.');
    const parsed = _parseLote_(String(texto || ''));
    if (parsed.erroGeral) return _err_(parsed.erroGeral);

    const func = _rows_(TAB.FUNC);
    const pers = _rows_(TAB.PERIODOS);
    const lancs = _rows_(TAB.LANCAMENTOS);
    const ajs = _rows_(TAB.AJUSTES);
    const today = _midnight_(new Date());
    const t0 = Date.now();
    const out = [];

    parsed.blocos.forEach(function (b) {
      const res = { ref: b.ref, linha: b.linha, itens: [], esperado: b.esperado };
      out.push(res);
      const fr = _acharFuncLote_(func, b.ref);
      if (fr.erro) { res.erro = fr.erro; return; }
      const r = fr.row, mat = _mk_(r[F.MAT]);
      res.nome = String(r[F.NOME] || '').trim();
      res.filial = String(r[F.FILIAL] || '').trim();
      res.matricula = String(r[F.MAT]);
      res.aviso = fr.aviso || '';
      const fichaAntes = JSON.parse(getEmployeeFicha_(mat));
      res.saldoAntes = fichaAntes.success === false ? null : fichaAntes.saldo.atual;

      const perIni = pers.filter(function (x) { return _mk_(x[P.MAT]) === mat; })
        .map(function (x) { return formatDate_(x[P.INI_AQ]); });
      const lancsF = lancs.filter(function (x) { return _mk_(x[L.MAT]) === mat && _statusLanc_(x) !== ST.RECUS; })
        .map(function (x) { return { s: toDate_(x[L.INICIO]), e: toDate_(x[L.TERMINO]) }; });
      const ajsF = ajs.filter(function (x) { return _mk_(x[AJ.MAT]) === mat; });
      let delta = 0;

      // ordem: períodos, ajustes, férias (o período automático das férias depende dos períodos)
      const ordem = { P: 0, A: 1, F: 2 };
      b.itens.slice().sort(function (x, y) {
        return (ordem[x.tipo] - ordem[y.tipo]) || ((x.d1 || 0) - (y.d1 || 0));
      }).forEach(function (it) {
        const item = { linha: it.linha, tipo: it.tipo, texto: it.texto };
        res.itens.push(item);
        if (it.erro) { item.status = 'erro'; item.msg = it.erro; return; }
        if (!simular && Date.now() - t0 > 300000) {
          item.status = 'erro'; item.msg = 'Tempo esgotado — rode a importação de novo para continuar.'; return;
        }
        if (it.tipo === 'P') {
          if (perIni.indexOf(formatDate_(it.d1)) >= 0) { item.status = 'existe'; item.msg = 'período já cadastrado'; return; }
          const fim = _plusDays_(_addMonths_(it.d1, 12), -1);
          const dir = _diasDireito_(it.faltas);
          if (fim <= today) delta += dir;
          item.msg = 'período ' + formatDateBR_(formatDate_(it.d1)) + ' a ' + formatDateBR_(formatDate_(fim))
            + ' — ' + dir + ' dias' + (fim <= today ? '' : ' (ainda em formação, não credita)');
          if (simular) { item.status = 'ok'; perIni.push(formatDate_(it.d1)); return; }
          const g = JSON.parse(addPeriodoAquisitivo_({ matricula: mat, inicioAquisitivo: formatDate_(it.d1), faltas: it.faltas }));
          item.status = g.success ? 'ok' : 'erro'; if (!g.success) item.msg = g.error;
          else perIni.push(formatDate_(it.d1));
        } else if (it.tipo === 'A') {
          const dup = ajsF.some(function (x) {
            return formatDate_(x[AJ.DATA]) === formatDate_(it.d1) && Number(x[AJ.DIAS] || 0) === it.dias
              && String(x[AJ.OBS] || '').trim() === it.obs;
          });
          if (dup) { item.status = 'existe'; item.msg = 'ajuste já lançado'; return; }
          delta += it.dias;
          item.msg = 'ajuste ' + (it.dias > 0 ? '+' : '') + it.dias + (it.obs ? ' — ' + it.obs : '');
          if (simular) { item.status = 'ok'; return; }
          const g = JSON.parse(addAjuste_({ matricula: mat, data: formatDate_(it.d1), dias: it.dias, obs: it.obs }));
          item.status = g.success ? 'ok' : 'erro'; if (!g.success) item.msg = g.error;
        } else {
          const igual = lancsF.some(function (x) {
            return x.s && x.e && formatDate_(x.s) === formatDate_(it.d1) && formatDate_(x.e) === formatDate_(it.d2);
          });
          if (igual) { item.status = 'existe'; item.msg = 'férias já lançadas'; return; }
          const choque = lancsF.find(function (x) { return x.s && x.e && it.d1 <= x.e && it.d2 >= x.s; });
          if (choque) {
            item.status = 'erro';
            item.msg = 'sobrepõe férias de ' + formatDateBR_(formatDate_(choque.s)) + ' a ' + formatDateBR_(formatDate_(choque.e));
            return;
          }
          const dias = Math.round((it.d2 - it.d1) / 864e5) + 1;
          delta -= dias;
          item.msg = 'férias ' + dias + ' dias';
          lancsF.push({ s: it.d1, e: it.d2 });
          if (simular) { item.status = 'ok'; return; }
          const g = JSON.parse(addVacationRecord_({
            name: res.nome, branch: res.filial,
            startDate: formatDate_(it.d1), endDate: formatDate_(it.d2),
          }));
          item.status = g.success ? 'ok' : 'erro'; if (!g.success) item.msg = g.error;
        }
      });

      if (simular) {
        res.saldoFinal = res.saldoAntes == null ? null : Math.round((res.saldoAntes + delta) * 100) / 100;
      } else {
        const fichaDepois = JSON.parse(getEmployeeFicha_(mat));
        res.saldoFinal = fichaDepois.success === false ? null : fichaDepois.saldo.atual;
      }
    });

    return JSON.stringify({ success: true, simulado: !!simular, funcionarios: out });
  } catch (e) { return _err_(e.message); }
}

// Texto da importação → blocos por funcionário (só leitura, sem planilha)
function _parseLote_(texto) {
  const blocos = [];
  let atual = null;
  const linhas = texto.split(/\r?\n/);
  for (var i = 0; i < linhas.length; i++) {
    const s = linhas[i].trim();
    if (!s || s.charAt(0) === '#') continue;
    const n = i + 1;
    if (s.charAt(0) === '@') {
      atual = { ref: s.slice(1).trim(), linha: n, itens: [], esperado: null };
      blocos.push(atual);
      continue;
    }
    if (!atual) return { erroGeral: 'Linha ' + n + ': comece cada funcionário com "@ Nome".' };
    const tipo = s.charAt(0).toUpperCase();
    const resto = s.slice(1).trim();
    if (tipo === '=') {
      const v = Number(resto.replace(',', '.'));
      atual.esperado = isNaN(v) ? null : v;
      continue;
    }
    const it = { linha: n, tipo: tipo, texto: s };
    const partes = resto.split(/\s+/);
    if (tipo === 'P') {
      it.d1 = _dataLote_(partes[0]);
      it.faltas = Number(partes[1] || 0) || 0;
      if (!it.d1) it.erro = 'data inválida';
    } else if (tipo === 'F') {
      it.d1 = _dataLote_(partes[0]);
      it.d2 = _dataLote_(partes[1]);
      if (!it.d1 || !it.d2) it.erro = 'datas inválidas (use dd/mm/aaaa dd/mm/aaaa)';
      else if (it.d2 < it.d1) it.erro = 'fim antes do início';
    } else if (tipo === 'A') {
      it.d1 = _dataLote_(partes[0]);
      it.dias = Number(String(partes[1] || '').replace(',', '.'));
      it.obs = partes.slice(2).join(' ');
      if (!it.d1) it.erro = 'data inválida';
      else if (isNaN(it.dias)) it.erro = 'dias inválido (ex.: -15 ou +12,5)';
    } else {
      it.erro = 'tipo desconhecido (use P, A, F ou =)';
    }
    atual.itens.push(it);
  }
  if (!blocos.length) return { erroGeral: 'Nenhum funcionário no texto (linhas "@ Nome").' };
  return { blocos: blocos };
}

// dd/mm/aaaa ou dd/mm/aa → Date local
function _dataLote_(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(ano, Number(m[2]) - 1, Number(m[1]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

// "@ ..." → linha da aba Func: matrícula, nome exato (sem acento/maiúscula) ou,
// se só um bater, nome que contém todas as palavras do outro
function _acharFuncLote_(func, ref) {
  const norm = function (v) {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  };
  const alvo = norm(ref);
  if (!alvo) return { erro: 'funcionário não informado' };
  if (/^\d+$/.test(alvo)) {
    const r = func.find(function (x) { return _mk_(x[F.MAT]) === _mk_(alvo); });
    return r ? { row: r } : { erro: 'matrícula ' + ref + ' não encontrada' };
  }
  const exatos = func.filter(function (x) { return norm(x[F.NOME]) === alvo; });
  if (exatos.length === 1) return { row: exatos[0] };
  if (exatos.length > 1) return { erro: 'mais de um funcionário com o nome "' + ref + '" — use a matrícula' };
  const pa = alvo.split(' ');
  const parecidos = func.filter(function (x) {
    const pc = norm(x[F.NOME]).split(' ');
    if (!pc[0]) return false;
    const contem = function (a, b) { return a.every(function (w) { return b.indexOf(w) >= 0; }); };
    return contem(pc, pa) || contem(pa, pc);
  });
  if (parecidos.length === 1)
    return { row: parecidos[0], aviso: 'no cadastro: "' + String(parecidos[0][F.NOME]).trim() + '"' };
  if (parecidos.length > 1) return { erro: '"' + ref + '" bate com mais de um funcionário — use a matrícula' };
  return { erro: '"' + ref + '" não encontrado no cadastro' };
}

// ============================================================
// EDITAR AJUSTE / OBSERVAÇÃO — reescreve a linha na aba Ajustes (só RH)
// payload = { rowIndex, matricula (conferência), data?, dias?, obs }
// ============================================================
function updateAjuste_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode editar ajuste ou observação.');

    payload = payload || {};
    const row = Number(payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');

    const sh = _sheet_(TAB.AJUSTES);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue a ficha.');
    const cur = sh.getRange(row, 1, 1, Math.max(4, sh.getLastColumn())).getValues()[0];
    if (payload.matricula && _mk_(cur[AJ.MAT]) !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue a ficha e tente de novo.');

    const obs = String(payload.obs || '').trim();
    const diasRaw = payload.dias;
    const dias = (diasRaw === '' || diasRaw == null) ? 0 : Number(diasRaw);
    if (isNaN(dias)) return _err_('Dias do ajuste inválido — use número (ex.: -2 ou 5).');
    if (!dias && !obs) return _err_('Informe os dias do ajuste e/ou uma observação.');
    const data = toDate_(payload.data) || cur[AJ.DATA] || _midnight_(new Date());

    sh.getRange(row, AJ.DATA + 1).setValue(data).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, AJ.DIAS + 1).setValue(dias || '');
    sh.getRange(row, AJ.OBS + 1).setValue(obs);

    return JSON.stringify({ success: true, dias: dias, data: formatDate_(data), obs: obs });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// EXCLUIR AJUSTE / OBSERVAÇÃO — apaga a linha na aba Ajustes (só RH)
// payload = { rowIndex, matricula (conferência) }
// ============================================================
function deleteAjuste_(payload) {
  try {
    if (_scopeAtual_().perfil !== 'rh')
      return _err_('Só o RH pode apagar ajuste ou observação.');

    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');

    const sh = _sheet_(TAB.AJUSTES);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue a ficha.');
    const cur = sh.getRange(row, 1, 1, Math.max(4, sh.getLastColumn())).getValues()[0];
    if (payload.matricula && _mk_(cur[AJ.MAT]) !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue a ficha e tente de novo.');

    sh.deleteRow(row);
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// EXCLUSÃO DE FÉRIAS — apaga a linha na aba Lancamentos
// payload = { rowIndex, matricula, inicio }  (matricula/inicio = conferência)
// ============================================================
function deleteVacationRecord_(payload) {
  try {
    const scope = _scopeAtual_();
    if (scope.perfil === 'nenhum') return _err_('Acesso não liberado.');
    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');

    const sh = _sheet_(TAB.LANCAMENTOS);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue o painel.');

    const cur = sh.getRange(row, 1, 1, Math.max(LANC_COLS, sh.getLastColumn())).getValues()[0];

    if (payload.matricula && _mk_(cur[L.MAT]) !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    if (payload.inicio && formatDate_(cur[L.INICIO]) !== String(payload.inicio))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');

    // gerente só pode CANCELAR uma solicitação ainda pendente, da filial dele
    if (scope.perfil === 'gerente') {
      if (_statusLanc_(cur) !== ST.PEND)
        return _err_('Só o RH pode apagar férias já aprovadas ou recusadas.');
      const fr = _rows_(TAB.FUNC).find(function (r) { return _mk_(r[F.MAT]) === _mk_(cur[L.MAT]); });
      if (!fr || !_noEscopo_(scope, fr[F.FILIAL]))
        return _err_('Você não tem acesso a este funcionário.');
    }

    sh.deleteRow(row);
    return JSON.stringify({ success: true });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// FASE 3 — FLUXO DE APROVAÇÃO
// ============================================================

// Fila de aprovação. RH vê todas as filiais; gerente vê as solicitações da(s)
// filial(is) dele (para acompanhar). Retorna pendentes + decididas nos últimos
// `dias` dias (padrão 90).
function getAprovacoes_(dias) {
  try {
    const scope = _scopeAtual_();
    if (scope.perfil === 'nenhum') return _err_('Acesso não liberado.');
    const janela = Math.max(1, Number(dias) || 90);
    const hoje = _midnight_(new Date());
    const corte = _plusDays_(hoje, -janela);

    const func = {};
    _rows_(TAB.FUNC).forEach(function (r) {
      const m = _mk_(r[F.MAT]);
      if (m) func[m] = { nome: String(r[F.NOME] || '').trim(), filial: String(r[F.FILIAL] || '').trim(),
        saldoIni: Number(r[F.SALDO_INI]) || 0 };
    });

    // saldo aprovado por matrícula (mesma regra do getVacationData_)
    const credit = {};
    _rows_(TAB.PERIODOS).forEach(function (r) {
      const m = _mk_(r[P.MAT]); if (!m) return;
      const iniAq = toDate_(r[P.INI_AQ]);
      const fimAq = toDate_(r[P.FIM_AQ]) || (iniAq ? _plusDays_(_addMonths_(iniAq, 12), -1) : null);
      const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0) ? r[P.DIREITO] : _diasDireito_(r[P.FALTAS]);
      if (fimAq && fimAq <= hoje) credit[m] = (credit[m] || 0) + dir;
    });
    const adj = {};
    _rows_(TAB.AJUSTES).forEach(function (r) {
      const m = _mk_(r[AJ.MAT]); if (m) adj[m] = (adj[m] || 0) + (Number(r[AJ.DIAS]) || 0);
    });

    const lan = _rows_(TAB.LANCAMENTOS);
    const diasDe = function (r) {
      let d = (typeof r[L.DIAS] === 'number') ? r[L.DIAS] : 0;
      if (!d) { const s = toDate_(r[L.INICIO]), e = toDate_(r[L.TERMINO]); if (s && e) d = Math.round((e - s) / 864e5) + 1; }
      return d;
    };
    const usado = {}, pend = {};
    lan.forEach(function (r) {
      const m = _mk_(r[L.MAT]); if (!m) return;
      const st = _statusLanc_(r);
      if (st === ST.APROV) usado[m] = (usado[m] || 0) + diasDe(r);
      if (st === ST.PEND)  pend[m]  = (pend[m]  || 0) + diasDe(r);
    });
    const saldoOf = function (m) {
      return ((func[m] && func[m].saldoIni) || 0) + (credit[m] || 0) - (usado[m] || 0) + (adj[m] || 0);
    };

    // férias (aprovadas + pendentes) por filial, para mostrar quem mais estará fora
    const porFilial = {};
    lan.forEach(function (r, i) {
      const m = _mk_(r[L.MAT]); const f = func[m]; if (!f) return;
      if (_statusLanc_(r) === ST.RECUS) return;
      const s = toDate_(r[L.INICIO]), e = toDate_(r[L.TERMINO]); if (!s || !e) return;
      (porFilial[f.filial] = porFilial[f.filial] || []).push({ row: i + 2, nome: f.nome, s: s, e: e });
    });

    const pendentes = [], decididas = [];
    lan.forEach(function (r, i) {
      const m = _mk_(r[L.MAT]); const f = func[m]; if (!f) return;
      if (!_noEscopo_(scope, f.filial)) return;
      const st = _statusLanc_(r);
      const temFluxo = String(r[L.STATUS] || '').trim() !== '';   // linhas antigas (sem status) não entram
      if (!temFluxo) return;
      const decEm = toDate_(r[L.DECID_EM]);
      if (st !== ST.PEND && (!decEm || decEm < corte)) return;
      if (st === ST.APROV && String(r[L.SOLIC_POR] || '').trim() === String(r[L.DECID_POR] || '').trim()
        && !String(r[L.MOTIVO] || '').trim()) return;   // lançada direto pelo RH — não passou pela fila

      const s = toDate_(r[L.INICIO]), e = toDate_(r[L.TERMINO]);
      const sobrepoe = (porFilial[f.filial] || []).filter(function (o) {
        return o.row !== i + 2 && s && e && s <= o.e && e >= o.s;
      }).map(function (o) { return o.nome; });
      const item = {
        rowIndex: i + 2, matricula: m, nome: f.nome, filial: f.filial,
        inicio: formatDate_(s), termino: formatDate_(e), dias: diasDe(r),
        status: st,
        solicitadoPor: String(r[L.SOLIC_POR] || '').trim(),
        solicitadoEm: r[L.SOLIC_EM] instanceof Date ? Utilities.formatDate(r[L.SOLIC_EM], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
        decididoPor: String(r[L.DECID_POR] || '').trim(),
        decididoEm: decEm ? Utilities.formatDate(decEm, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
        motivo: String(r[L.MOTIVO] || '').trim(),
        saldo: saldoOf(m),
        pendenteTotal: pend[m] || 0,
        sobrepoe: sobrepoe,
        podeAprovar: _podeAprovar_(scope, f.filial),
      };
      (st === ST.PEND ? pendentes : decididas).push(item);
    });
    pendentes.sort(function (a, b) { return a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0; });
    decididas.sort(function (a, b) { return a.decididoEm > b.decididoEm ? -1 : a.decididoEm < b.decididoEm ? 1 : 0; });

    return JSON.stringify({ success: true, perfil: scope.perfil, aprova: scope.aprova, pendentes: pendentes, decididas: decididas, janela: janela });
  } catch (e) { return _err_(e.message); }
}

// Aprova ou recusa uma solicitação pendente — só RH.
// payload = { rowIndex, matricula, inicio, decisao: 'aprovar'|'recusar', motivo }
function decidirFerias_(payload) {
  try {
    const scope = _scopeAtual_();
    if (scope.perfil !== 'rh' && !(scope.aprova && scope.aprova.length))
      return _err_('Só o RH ou o Gerente Matriz podem aprovar ou recusar férias.');
    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err_('Linha inválida.');
    const decisao = String(payload.decisao || '').toLowerCase();
    if (decisao !== 'aprovar' && decisao !== 'recusar') return _err_('Decisão inválida.');
    const motivo = String(payload.motivo || '').trim();
    if (decisao === 'recusar' && !motivo) return _err_('Informe o motivo da recusa.');

    const sh = _sheet_(TAB.LANCAMENTOS);
    _ensureLancCols_(sh);
    if (row > sh.getLastRow()) return _err_('Essa linha não existe mais. Recarregue o painel.');
    const cur = sh.getRange(row, 1, 1, LANC_COLS).getValues()[0];
    if (payload.matricula && _mk_(cur[L.MAT]) !== _mk_(payload.matricula))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    if (payload.inicio && formatDate_(cur[L.INICIO]) !== String(payload.inicio))
      return _err_('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    if (_statusLanc_(cur) !== ST.PEND)
      return _err_('Esta solicitação já foi decidida (' + _statusLanc_(cur).toLowerCase() + '). Recarregue o painel.');

    // Gerente Matriz só decide as filiais que ele aprova (confere pela filial do funcionário)
    const frDec = _rows_(TAB.FUNC).find(function (r) { return _mk_(r[F.MAT]) === _mk_(cur[L.MAT]); });
    if (scope.perfil !== 'rh' && (!frDec || !_podeAprovar_(scope, frDec[F.FILIAL])))
      return _err_('Você não pode aprovar férias desta filial.');

    const novo = decisao === 'aprovar' ? ST.APROV : ST.RECUS;
    const agora = new Date();
    sh.getRange(row, L.STATUS + 1).setValue(novo);
    sh.getRange(row, L.DECID_POR + 1, 1, 3).setValues([[scope.email || 'RH', agora, motivo]]);
    sh.getRange(row, L.DECID_EM + 1).setNumberFormat('dd/mm/yyyy hh:mm');

    const nome = frDec ? String(frDec[F.NOME] || '').trim() : String(cur[L.MAT]);
    _notificar_([String(cur[L.SOLIC_POR] || '').trim().toLowerCase()],
      'Férias ' + novo.toLowerCase() + 's — ' + nome,
      'As férias de ' + nome + ' (' + formatDateBR_(formatDate_(cur[L.INICIO])) + ' a '
      + formatDateBR_(formatDate_(cur[L.TERMINO])) + ') foram ' + novo.toLowerCase() + 's por ' + (scope.email || 'RH') + '.'
      + (motivo ? '\nMotivo: ' + motivo : ''));

    return JSON.stringify({ success: true, status: novo });
  } catch (e) { return _err_(e.message); }
}

// ============================================================
// DETECÇÃO DE CONFLITOS (3+ funcionários da mesma filial sobrepostos)
// ============================================================
function detectConflicts_(data) {
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
        if (startA <= endB && endA >= startB) overlapping.push(records[j].name);
      }

      if (overlapping.length >= 2) {
        const key = [branch, records[i].startDate, ...overlapping.sort()].join('|');
        if (!conflicts.find(c => c.key === key)) {
          conflicts.push({
            key: key,
            branch: branch,
            period: `${formatDateBR_(records[i].startDate)} a ${formatDateBR_(records[i].endDate)}`,
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
function _sheet_(name) {
  const sh = SpreadsheetApp.openById(MODEL_SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('Aba não encontrada: ' + name + ' (planilha ' + MODEL_SHEET_ID + ')');
  return sh;
}
function _rows_(name) {
  const sh = _sheet_(name);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, Math.max(1, sh.getLastColumn())).getValues();
}
function _err_(msg) { return JSON.stringify({ success: false, error: String(msg) }); }

// Status de um lançamento (aba Lancamentos). Vazio/desconhecido = Aprovado
// (linhas anteriores à fase 3 já valiam como férias confirmadas).
function _statusLanc_(r) {
  const s = String((r && r[L.STATUS]) || '').trim().toLowerCase();
  if (s.indexOf('pend') === 0) return ST.PEND;
  if (s.indexOf('recus') === 0) return ST.RECUS;
  return ST.APROV;
}

// Garante as colunas M..R (Status / auditoria) na aba Lancamentos, com cabeçalho.
function _ensureLancCols_(sh) {
  if (sh.getMaxColumns() < LANC_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), LANC_COLS - sh.getMaxColumns());
  const first = L.STATUS + 1;
  const head = sh.getRange(1, first, 1, LANC_HEADERS_FASE3.length).getValues()[0];
  if (head.some(function (h) { return !String(h || '').trim(); })) {
    sh.getRange(1, first, 1, LANC_HEADERS_FASE3.length).setValues([LANC_HEADERS_FASE3]);
  }
}

// Envia e-mail do fluxo de aprovação (só se NOTIFICAR_EMAIL). Nunca derruba a operação.
function _notificar_(destinos, assunto, corpo) {
  if (!NOTIFICAR_EMAIL) return;
  try {
    const to = (destinos || []).filter(function (x) { return x && x.indexOf('@') > 0; });
    if (!to.length) return;
    const url = ScriptApp.getService().getUrl();
    MailApp.sendEmail(to.join(','), '[Férias] ' + assunto, corpo + (url ? '\n\nPainel: ' + url + '?page=painel' : ''));
  } catch (e) { /* cota estourada / sem permissão — segue sem e-mail */ }
}

// E-mails com perfil RH na aba Acessos
function _emailsRH_() {
  try {
    return _rows_(TAB.ACESSOS).filter(function (r) {
      return String(r[AC.PERFIL] || '').trim().toLowerCase() === 'rh';
    }).map(function (r) { return String(r[AC.EMAIL] || '').trim().toLowerCase(); });
  } catch (e) { return []; }
}
function _cap_(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// Normaliza matrícula p/ comparação: aceita número ou texto, com ou sem
// zeros à esquerda ("02016", 2016 e "2016" viram a mesma chave).
function _mk_(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s.toLowerCase();
}
function _midnight_(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function _plusDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function _addMonths_(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function _diasDireito_(faltas) {
  const f = Number(faltas) || 0;
  return f <= 5 ? 30 : f <= 14 ? 24 : f <= 23 ? 18 : f <= 32 ? 12 : 0;
}
function _periodoSituacao_(fimAqD, concD, today) {
  if (!fimAqD) return '';
  if (fimAqD > today) return 'Em formação';
  if (concD && today > concD) return 'Vencido — risco de dobro';
  if (concD) {
    const dias = Math.round((concD - today) / 864e5);
    return (dias <= 90 ? 'Vence em ' : 'Em dia — vence em ') + dias + ' d';
  }
  return '';
}

function _feriadosSet_() {
  const set = {};
  try {
    _rows_(TAB.FERIADOS).forEach(function (r) {
      const d = toDate_(r[0]);
      if (d) set[formatDate_(d)] = true;
    });
  } catch (e) {}
  return set;
}
function _addWorkingDays_(date, n) {
  const hol = _feriadosSet_();
  let x = new Date(date), left = n;
  while (left > 0) {
    x = _plusDays_(x, 1);
    const wd = x.getDay();
    if (wd === 0) continue;
    if (hol[formatDate_(x)]) continue;
    left--;
  }
  return x;
}

// Date | ISO yyyy-mm-dd | dd/mm/yyyy  ->  Date | null
function toDate_(value) {
  if (!value || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return new Date(+br[3], +br[2] - 1, +br[1]);
  // yyyy-mm-dd puro: monta meia-noite LOCAL. new Date("yyyy-mm-dd") parseia como
  // UTC e, no fuso -03, a data "escorrega" para as 21h do dia anterior — o que
  // depois desloca o retorno / o dia útil em 1 dia.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function _pad2_(n) { return (n < 10 ? '0' : '') + n; }

// -> 'yyyy-mm-dd' pelos componentes de data LOCAIS (fuso do script).
// Nunca usar toISOString aqui: converte para UTC e, se a data carregar qualquer
// hora != 00:00 local, adianta o dia (era a causa do "retorno" sair +1 dia).
function formatDate_(value) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : toDate_(value);
  if (!d || isNaN(d.getTime())) return String(value);
  return d.getFullYear() + '-' + _pad2_(d.getMonth() + 1) + '-' + _pad2_(d.getDate());
}

function formatDateBR_(isoDate) {
  if (!isoDate) return '';
  const p = isoDate.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : isoDate;
}

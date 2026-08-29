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
  ACESSOS:     'Acessos',   // opcional: E-mail | Filial | Perfil (RH | Gerente)
};
const AC = { EMAIL:0, FILIAL:1, PERFIL:2 };

// Índice das colunas (base 0)
// Func: coluna I (CTPS) é opcional — deixe em branco se não usar
const F  = { MAT:0, NOME:1, FILIAL:2, CARGO:3, ADMISSAO:4, SITUACAO:5, SALDO_INI:6, REGISTRADO:7, CTPS:8 };
const P  = { MAT:0, PERIODO:1, INI_AQ:2, FIM_AQ:3, FALTAS:4, DIREITO:5, CONCESSAO:6, CREDITADO:7, SITUACAO:8 };
const L  = { MAT:0, PERIODO:1, PARCELA:2, INICIO:3, TERMINO:4, DIAS:5, TIPO:6, RETORNO:7, RETORNO_UTIL:8, OBS:9 };
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
// PONTO DE ENTRADA DA WEB APP  —  roteador
//   .../exec              -> Home.html (página inicial)
//   .../exec?page=painel  -> Dashboard.html (o painel; o escopo por filial
//                            é aplicado no servidor, pelo e-mail de quem acessa)
// ============================================================
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'home';
  if (page === 'painel') {
    return HtmlService.createHtmlOutputFromFile('Dashboard')
      .setTitle('Painel de Férias')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  const t = HtmlService.createTemplateFromFile('Home');
  t.scriptUrl = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('Controle de Férias')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// HTML do painel — usado pela Home para abrir o dashboard "no lugar",
// sem trocar a URL (importante quando embutido no Google Sites).
function paginaPainel() {
  return HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
}

// ============================================================
// ESCOPO DE ACESSO — quem está acessando e o que pode ver
//   Sem aba "Acessos" (ou vazia) => tudo liberado como RH (migração).
//   Com a aba: e-mail não cadastrado => sem acesso.
// ============================================================
function _scopeAtual() {
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) {}

  let rows = [];
  try { rows = _rows(TAB.ACESSOS); } catch (e) { rows = []; }

  if (!rows.length) return { email: email, perfil: 'rh', filiais: null };

  const meus = rows.filter(function (r) {
    return String(r[AC.EMAIL] || '').trim().toLowerCase() === email;
  });
  if (!email || !meus.length) return { email: email, perfil: 'nenhum', filiais: [] };

  const ehRH = meus.some(function (r) {
    return String(r[AC.PERFIL] || '').trim().toLowerCase() === 'rh';
  });
  if (ehRH) return { email: email, perfil: 'rh', filiais: null };

  const filiais = meus.map(function (r) { return String(r[AC.FILIAL] || '').trim(); })
    .filter(function (x) { return x; });
  return { email: email, perfil: 'gerente', filiais: filiais };
}

function _noEscopo(scope, filial) {
  return !scope.filiais || scope.filiais.indexOf(String(filial || '').trim()) >= 0;
}

// Resumo para a página inicial
function getResumoHome() {
  try {
    const scope = _scopeAtual();
    const func = _rows(TAB.FUNC);
    const hoje = _midnight(new Date());
    const funcFil = {};
    let nFunc = 0; const fils = {};
    func.forEach(function (r) {
      const mat = _mk(r[F.MAT]);
      if (!mat || !String(r[F.NOME] || '').trim()) return;
      const fil = String(r[F.FILIAL] || '').trim();
      funcFil[mat] = fil;
      if (scope.filiais && scope.filiais.indexOf(fil) < 0) return;
      nFunc++; if (fil) fils[fil] = 1;
    });
    let emFerias = 0;
    _rows(TAB.LANCAMENTOS).forEach(function (r) {
      const s = toDate(r[L.INICIO]), e = toDate(r[L.TERMINO]);
      if (!s || !e) return;
      const fil = funcFil[_mk(r[L.MAT])];
      if (scope.filiais && scope.filiais.indexOf(fil) < 0) return;
      if (s <= hoje && hoje <= e) emFerias++;
    });
    return JSON.stringify({
      ok: true,
      perfil: scope.perfil,
      email: scope.email,
      escopo: scope.filiais ? scope.filiais.join(', ') : 'Todas as filiais',
      funcionarios: nFunc,
      filiais: Object.keys(fils).length,
      emFerias: emFerias,
    });
  } catch (err) {
    return JSON.stringify({ ok: false, erro: String(err.message || err) });
  }
}

// ============================================================
// LEITURA E CONSOLIDAÇÃO
// ============================================================
function getVacationData() {
  const scope = _scopeAtual();
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
  try { func = _rows(TAB.FUNC); }        catch (e) { errors.push({ branch: TAB.FUNC, error: e.message }); }
  try { per  = _rows(TAB.PERIODOS); }    catch (e) { errors.push({ branch: TAB.PERIODOS, error: e.message }); }
  try { lan  = _rows(TAB.LANCAMENTOS); } catch (e) { errors.push({ branch: TAB.LANCAMENTOS, error: e.message }); }
  try { aju  = _rows(TAB.AJUSTES); }     catch (e) { errors.push({ branch: TAB.AJUSTES, error: e.message }); }

  const today = _midnight(new Date());

  // funcionários por matrícula
  const emp = {};
  func.forEach(r => {
    const mat = _mk(r[F.MAT]);
    if (!mat) return;
    const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
    emp[mat] = {
      mat: mat,
      name: String(r[F.NOME] || '').trim(),
      branch: String(r[F.FILIAL] || '').trim(),
      admissao: toDate(r[F.ADMISSAO]),
      saldoIni: Number(r[F.SALDO_INI]) || 0,
      registrado: reg !== 'não' && reg !== 'nao',
    };
  });

  // créditos e datas de concessão por período aquisitivo
  // (creditado = o fim do período aquisitivo já passou — calculado, não lê a coluna)
  const credit = {}, conc = {};
  per.forEach(r => {
    const mat = _mk(r[P.MAT]);
    if (!mat) return;
    const iniAq = toDate(r[P.INI_AQ]);
    const fimAq = toDate(r[P.FIM_AQ]) || (iniAq ? _plusDays(_addMonths(iniAq, 12), -1) : null);
    const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
      ? r[P.DIREITO] : _diasDireito(r[P.FALTAS]);
    if (fimAq && fimAq <= today) credit[mat] = (credit[mat] || 0) + dir;
    const c = toDate(r[P.CONCESSAO]) || (fimAq ? _addMonths(fimAq, 12) : null);
    if (c) (conc[mat] = conc[mat] || []).push(c);
  });

  // gozo / abono / ajustes
  const goz = {}, abo = {}, adj = {};
  lan.forEach(r => {
    const mat = _mk(r[L.MAT]);
    if (!mat) return;
    const tipo = String(r[L.TIPO] || '').trim().toLowerCase();
    // dias: usa a célula se for número; senão calcula pelas datas (linha com fórmula quebrada)
    let d = (typeof r[L.DIAS] === 'number') ? r[L.DIAS] : 0;
    if (!d) {
      const s = toDate(r[L.INICIO]), en = toDate(r[L.TERMINO]);
      if (s && en) d = Math.round((en - s) / 864e5) + 1;
    }
    if (tipo === 'gozo')  goz[mat] = (goz[mat] || 0) + d;
    if (tipo === 'abono') abo[mat] = (abo[mat] || 0) + d;
  });
  aju.forEach(r => {
    const mat = _mk(r[AJ.MAT]);
    if (mat) adj[mat] = (adj[mat] || 0) + (Number(r[AJ.DIAS]) || 0);
  });

  const saldoOf = function (mat) {
    const e = emp[mat];
    return (e ? e.saldoIni : 0) + (credit[mat] || 0)
      - (goz[mat] || 0) - (abo[mat] || 0) + (adj[mat] || 0);
  };
  const dueOf = function (mat) {
    const list = (conc[mat] || []).slice().sort(function (a, b) { return a - b; });
    if (!list.length) return '';
    const fut = list.filter(function (d) { return d >= today; });
    return formatDate(fut.length ? fut[0] : list[0]);
  };

  // data[] : uma entrada por lançamento + placeholder p/ registrado sem lançamento
  const allData = [];
  const seen = {};
  lan.forEach(function (r, i) {
    const mat = _mk(r[L.MAT]);
    const e = emp[mat];
    if (!e) return;
    seen[mat] = true;
    const start = toDate(r[L.INICIO]);
    const end   = toDate(r[L.TERMINO]);
    if (!e.name && !start) return;
    // total: usa o valor da célula só se for número; senão calcula pelas datas
    let total = (typeof r[L.DIAS] === 'number')
      ? r[L.DIAS]
      : ((start && end) ? Math.round((end - start) / 864e5) + 1 : '');
    // retorno: usa a célula só se for data válida; senão fim + 1
    let ret = toDate(r[L.RETORNO_UTIL]) || toDate(r[L.RETORNO]);
    if (!ret && end) ret = _plusDays(end, 1);
    allData.push({
      branch: e.branch,
      name: e.name,
      matricula: mat,
      startDate:  formatDate(r[L.INICIO]),
      endDate:    formatDate(r[L.TERMINO]),
      returnDate: formatDate(ret),
      total: total == null ? '' : total,
      availableDays: saldoOf(mat),
      dueDate: dueOf(mat),
      rowIndex: i + 2,                 // linha na aba Lancamentos
    });
  });
  Object.keys(emp).forEach(function (mat) {
    const e = emp[mat];
    if (seen[mat] || !e.registrado || !e.name) return;
    allData.push({
      branch: e.branch, name: e.name, matricula: mat,
      startDate: '', endDate: '', returnDate: '', total: '',
      availableDays: saldoOf(mat), dueDate: dueOf(mat), rowIndex: 0,
    });
  });

  const conflicts = detectConflicts(allData);
  const payment = getPaymentData(func, saldoOf);

  // contagens + lista completa do cadastro (aba Func)
  let nFunc = 0, nReg = 0, nNao = 0;
  const employees = [];
  func.forEach(function (r) {
    const mat = _mk(r[F.MAT]);
    const nome = String(r[F.NOME] || '').trim();
    if (!mat || !nome) return;
    nFunc++;
    const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
    const registrado = reg !== 'não' && reg !== 'nao';
    if (registrado) nReg++; else nNao++;
    employees.push({
      matricula: mat,
      nome: nome,
      filial: String(r[F.FILIAL] || '').trim(),
      cargo: String(r[F.CARGO] || '').trim(),
      registrado: registrado,
      saldo: saldoOf(mat),
      vencimento: dueOf(mat),
    });
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

  return JSON.stringify({
    data: outData,
    conflicts: outConf,
    errors: errors,
    paymentDue: outPayDue,
    paymentAll: outPayAll,
    paymentErrors: payment.errors,
    totals: tot,
    employees: outEmp,
    scope: { perfil: scope.perfil, filiais: scope.filiais, email: scope.email },
  });
}

// ============================================================
// FICHA COMPLETA DE UM FUNCIONÁRIO — chamada pelo dashboard
// ============================================================
function getEmployeeFicha(matricula) {
  try {
    const mat = _mk(matricula);
    if (!mat) return _err('Matrícula não informada.');

    const fr = _rows(TAB.FUNC).find(function (r) {
      return _mk(r[F.MAT]) === mat;
    });
    if (!fr) return _err('Funcionário não encontrado: ' + mat);

    const scope = _scopeAtual();
    if (scope.perfil === 'nenhum' || !_noEscopo(scope, fr[F.FILIAL]))
      return _err('Você não tem acesso à ficha deste funcionário.');

    const today = _midnight(new Date());
    const per = _rows(TAB.PERIODOS).filter(function (r) { return _mk(r[P.MAT]) === mat; });
    const lan = _rows(TAB.LANCAMENTOS).filter(function (r) { return _mk(r[L.MAT]) === mat; });
    const aju = _rows(TAB.AJUSTES).filter(function (r) { return _mk(r[AJ.MAT]) === mat; });

    const inicial = Number(fr[F.SALDO_INI]) || 0;
    let creditados = 0, gozadas = 0, abono = 0, ajustes = 0, riscoBase = 0;
    per.forEach(function (r) {
      const iniAq = toDate(r[P.INI_AQ]);
      const fimAq = toDate(r[P.FIM_AQ]) || (iniAq ? _plusDays(_addMonths(iniAq, 12), -1) : null);
      const concD = toDate(r[P.CONCESSAO]) || (fimAq ? _addMonths(fimAq, 12) : null);
      const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
        ? r[P.DIREITO] : _diasDireito(r[P.FALTAS]);
      if (fimAq && fimAq <= today) creditados += dir;
      if (concD && concD < today && dir > 0) riscoBase += dir;
    });
    lan.forEach(function (r) {
      const t = String(r[L.TIPO] || '').trim().toLowerCase();
      let d = (typeof r[L.DIAS] === 'number') ? r[L.DIAS] : 0;
      if (!d) {
        const s = toDate(r[L.INICIO]), en = toDate(r[L.TERMINO]);
        if (s && en) d = Math.round((en - s) / 864e5) + 1;
      }
      if (t === 'gozo') gozadas += d;
      if (t === 'abono') abono += d;
    });
    aju.forEach(function (r) { ajustes += Number(r[AJ.DIAS]) || 0; });

    const risco = Math.max(0, riscoBase - gozadas - Math.max(0, -ajustes));
    const atual = inicial + creditados - gozadas - abono + ajustes;

    const fut = per.map(function (r) {
      const iniAq = toDate(r[P.INI_AQ]);
      return toDate(r[P.FIM_AQ]) || (iniAq ? _plusDays(_addMonths(iniAq, 12), -1) : null);
    }).filter(function (d) { return d && d > today; })
      .sort(function (a, b) { return a - b; });

    const reg = String(fr[F.REGISTRADO] || '').trim().toLowerCase();

    return JSON.stringify({
      success: true,
      func: {
        matricula: mat,
        nome: String(fr[F.NOME] || '').trim(),
        filial: String(fr[F.FILIAL] || '').trim(),
        cargo: String(fr[F.CARGO] || '').trim(),
        admissao: formatDate(fr[F.ADMISSAO]),
        situacao: String(fr[F.SITUACAO] || '').trim(),
        registrado: reg !== 'não' && reg !== 'nao',
      },
      saldo: {
        atual: atual, inicial: inicial, creditados: creditados,
        gozadas: gozadas, abono: abono, ajustes: ajustes,
        risco: risco, proximoCredito: fut.length ? formatDate(fut[0]) : '',
      },
      periodos: per.map(function (r) {
        const iniAq = toDate(r[P.INI_AQ]);
        const fimAq = toDate(r[P.FIM_AQ]) || (iniAq ? _plusDays(_addMonths(iniAq, 12), -1) : null);
        const concD = toDate(r[P.CONCESSAO]) || (fimAq ? _addMonths(fimAq, 12) : null);
        const dir = (typeof r[P.DIREITO] === 'number' && r[P.DIREITO] > 0)
          ? r[P.DIREITO] : _diasDireito(r[P.FALTAS]);
        return {
          periodo: String(r[P.PERIODO] || '').trim()
            || (iniAq && fimAq ? iniAq.getFullYear() + '/' + fimAq.getFullYear() : ''),
          iniAq: formatDate(iniAq),
          fimAq: formatDate(fimAq),
          concessao: formatDate(concD),
          direito: dir,
          creditado: (fimAq && fimAq <= today) ? 'Sim' : 'Não',
          situacao: _periodoSituacao(fimAq, concD, today),
        };
      }),
      lancamentos: lan.map(function (r) {
        const s = toDate(r[L.INICIO]), en = toDate(r[L.TERMINO]);
        let dias = (typeof r[L.DIAS] === 'number') ? r[L.DIAS]
          : ((s && en) ? Math.round((en - s) / 864e5) + 1 : '');
        let ret = toDate(r[L.RETORNO_UTIL]) || toDate(r[L.RETORNO]);
        if (!ret && en) ret = _plusDays(en, 1);
        return {
          periodo: String(r[L.PERIODO] || '').trim(),
          parcela: r[L.PARCELA],
          inicio: formatDate(r[L.INICIO]),
          termino: formatDate(r[L.TERMINO]),
          retorno: formatDate(ret),
          dias: dias,
          tipo: String(r[L.TIPO] || '').trim(),
          obs: String(r[L.OBS] || '').trim(),
        };
      }),
      ajustes: aju.map(function (r) {
        return { data: formatDate(r[AJ.DATA]), dias: r[AJ.DIAS], obs: String(r[AJ.OBS] || '').trim() };
      }),
    });
  } catch (e) { return _err(e.message); }
}

// ============================================================
// AVISO DE FÉRIAS (PDF) — chamado pelo dashboard
// Identifica o lançamento pela matrícula + data de início do gozo.
// Retorna { success, filename, bytesB64 }
// ============================================================
function getAvisoFeriasPdf(matricula, gozoInicioISO) {
  try {
    const mat = _mk(matricula);
    const gi  = String(gozoInicioISO || '').trim();
    if (!mat || !gi) return _err('Parâmetros insuficientes para o aviso.');

    const fr = _rows(TAB.FUNC).find(function (r) { return _mk(r[F.MAT]) === mat; });
    if (!fr) return _err('Funcionário não encontrado: ' + mat);

    const scope = _scopeAtual();
    if (scope.perfil === 'nenhum' || !_noEscopo(scope, fr[F.FILIAL]))
      return _err('Você não tem acesso a este funcionário.');

    const lr = _rows(TAB.LANCAMENTOS).find(function (r) {
      return _mk(r[L.MAT]) === mat
        && formatDate(r[L.INICIO]) === gi
        && String(r[L.TIPO] || '').trim().toLowerCase() === 'gozo';
    });
    if (!lr) return _err('Período de férias não encontrado (início ' + gi + ').');

    const admissao   = toDate(fr[F.ADMISSAO]);
    const gozoIniDt  = toDate(lr[L.INICIO]);

    // --- Período aquisitivo ---
    // 1º: linha correspondente na aba Periodos; 2º: calcula a partir da admissão
    const periodoLabel = String(lr[L.PERIODO] || '').trim();
    let pr = null;
    if (periodoLabel) {
      pr = _rows(TAB.PERIODOS).find(function (r) {
        return _mk(r[P.MAT]) === mat
          && String(r[P.PERIODO] || '').trim() === periodoLabel;
      });
    }
    if (!pr) {
      pr = _rows(TAB.PERIODOS).filter(function (r) { return _mk(r[P.MAT]) === mat; })
        .sort(function (a, b) { return (toDate(a[P.INI_AQ]) || 0) - (toDate(b[P.INI_AQ]) || 0); })
        .pop() || null;
    }
    let aqIniD = pr ? toDate(pr[P.INI_AQ]) : null;
    let aqFimD = pr ? toDate(pr[P.FIM_AQ]) : null;
    if ((!aqIniD || !aqFimD) && admissao && gozoIniDt) {
      const calc = _periodoAquisitivo(admissao, gozoIniDt);
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
      const lo = _rows(TAB.LOJAS).find(function (r) {
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
    const ctps     = String(fr[F.CTPS] || '').trim() || _ctpsFake(mat + '|' + nome);
    const hoje     = _dataExtenso(formatDate(new Date()));

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
      aqIni:    aqIniD ? _dataExtenso(formatDate(aqIniD)) : '________________',
      aqFim:    aqFimD ? _dataExtenso(formatDate(aqFimD)) : '________________',
      gzIni:    _dataExtenso(formatDate(lr[L.INICIO])),
      gzFim:    _dataExtenso(formatDate(lr[L.TERMINO])),
      retorno:  _dataExtenso(formatDate(lr[L.RETORNO_UTIL] || lr[L.RETORNO])),
    };

    const html = _avisoHtml(dados);
    const pdf  = Utilities.newBlob(html, 'text/html', 'aviso.html').getAs('application/pdf');
    const safe = String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_');
    return JSON.stringify({
      success: true,
      filename: 'Aviso_Ferias_' + safe + '.pdf',
      bytesB64: Utilities.base64Encode(pdf.getBytes()),
    });
  } catch (e) { return _err(e.message); }
}

function _dataExtenso(iso) {
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
function _ctpsFake(seed) {
  let h = 0;
  const s = String(seed || '') || 'x';
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return String(1000000 + (h % 9000000));   // 1000000–9999999
}

// Período aquisitivo (ciclo de 12 meses a partir da admissão) que já se
// completou antes da data de gozo. Usado quando não há linha na aba Periodos.
function _periodoAquisitivo(admissao, ref) {
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

function _avisoHtml(d) {
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
// mês de vencimento = mês de aniversário da admissão;
// pagar 30 dias    = saldo atual >= 30.
// ============================================================
function getPaymentData(func, saldoOf) {
  const currentMonth = new Date().getMonth() + 1;
  const all = [], due = [], errors = [];

  try {
    (func && func.length ? func : _rows(TAB.FUNC)).forEach(function (r) {
      const reg = String(r[F.REGISTRADO] || '').trim().toLowerCase();
      if (reg !== 'não' && reg !== 'nao') return;
      const name = String(r[F.NOME] || '').trim();
      if (!name) return;
      const adm = toDate(r[F.ADMISSAO]);
      const monthNum = adm ? adm.getMonth() + 1 : null;
      const saldo = saldoOf ? saldoOf(_mk(r[F.MAT])) : 0;
      const rec = {
        name: name,
        branch: String(r[F.FILIAL] || '').trim(),
        month: monthNum ? _cap(MONTHS_PT[monthNum - 1]) : '',
        monthNum: monthNum,
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

// ============================================================
// INCLUSÃO DE FÉRIAS — grava na aba Lancamentos
// payload = { branch, name, startDate, endDate }
// ============================================================
function addVacationRecord(payload) {
  try {
    const name = String(payload.name || '').trim();
    if (!name) return _err('Nome do funcionário é obrigatório.');
    const start = toDate(payload.startDate);
    const end   = toDate(payload.endDate);
    if (!start) return _err('Data de início inválida.');
    if (!end)   return _err('Data de fim inválida.');
    if (end < start) return _err('Data de fim anterior ao início.');

    const branch = String(payload.branch || '').trim();
    const match = _rows(TAB.FUNC).find(function (r) {
      return String(r[F.NOME] || '').trim().toLowerCase() === name.toLowerCase()
        && (!branch || String(r[F.FILIAL] || '').trim() === branch);
    });
    if (!match) return _err('Funcionário não encontrado na aba Func: ' + name);

    const scope = _scopeAtual();
    if (scope.perfil === 'nenhum' || !_noEscopo(scope, match[F.FILIAL]))
      return _err('Você não tem acesso para marcar férias nesta filial.');
    const matRaw = match[F.MAT];                       // grava com o MESMO tipo da aba Func
    const mat = _mk(matRaw);
    if (!mat) return _err('O funcionário "' + name + '" está sem matrícula na aba Func. Preencha a coluna Matrícula e tente de novo.');

    // período aquisitivo mais recente
    let periodoRaw = '';
    const per = _rows(TAB.PERIODOS).filter(function (r) {
      return _mk(r[P.MAT]) === mat;
    });
    if (per.length) {
      per.sort(function (a, b) { return (toDate(a[P.INI_AQ]) || 0) - (toDate(b[P.INI_AQ]) || 0); });
      periodoRaw = per[per.length - 1][P.PERIODO];
    }

    const sh = _sheet(TAB.LANCAMENTOS);
    const existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues() : [];
    const parcela = existing.filter(function (r) {
      return _mk(r[L.MAT]) === mat
        && String(r[L.TIPO] || '').trim().toLowerCase() === 'gozo';
    }).length + 1;

    const total = Math.round((end - start) / 864e5) + 1;
    const retSimples = _plusDays(end, 1);
    const retUtil = _addWorkingDays(end, 1);
    const seq = existing.filter(function (r) { return _mk(r[L.MAT]) === mat; }).length + 1;
    const chave = String(matRaw) + '-' + seq;
    const nr = sh.getLastRow() + 1;

    // grava só VALORES (nada de fórmula — evita erro de separador/locale no Sheets).
    // limpa a validação herdada antes, para o setValues não ser recusado.
    sh.getRange(nr, 1, 1, 12).setDataValidation(null);
    sh.getRange(nr, 1, 1, 12).setValues([[
      matRaw, periodoRaw, parcela, start, end,
      total, 'Gozo', retSimples, retUtil, '', seq, chave
    ]]);
    sh.getRange(nr, L.INICIO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.TERMINO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.RETORNO + 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(nr, L.RETORNO_UTIL + 1).setNumberFormat('dd/mm/yyyy');

    // devolve os dropdowns (Matrícula / Período / Tipo) copiando da linha 2
    try {
      [1, 2, 7].forEach(function (col) {
        const dv = sh.getRange(2, col).getDataValidation();
        if (dv) sh.getRange(nr, col).setDataValidation(dv);
      });
    } catch (e) { /* sem validação na linha 2 — ignora */ }

    return JSON.stringify({
      success: true, rowIndex: nr,
      returnDate: formatDate(retUtil), total: total,
    });
  } catch (e) { return _err(e.message); }
}

// ============================================================
// ATUALIZAÇÃO DE FÉRIAS — payload = { branch, rowIndex, startDate, endDate }
// rowIndex = linha na aba Lancamentos
// ============================================================
function updateVacationRecord(payload) {
  try {
    if (_scopeAtual().perfil === 'gerente')
      return _err('Só o RH pode editar datas de férias já lançadas.');
    const row = Number(payload.rowIndex);
    if (!row || row < 2) return _err('Linha inválida.');
    const start = toDate(payload.startDate);
    const end   = toDate(payload.endDate);
    if (!start) return _err('Data de início inválida.');
    if (!end)   return _err('Data de fim inválida.');
    if (end < start) return _err('Data de fim anterior ao início.');

    const sh = _sheet(TAB.LANCAMENTOS);
    const total = Math.round((end - start) / 864e5) + 1;
    const retUtil = _addWorkingDays(end, 1);

    // grava só VALORES (sem fórmula — evita erro de separador/locale)
    sh.getRange(row, L.INICIO + 1).setValue(start).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.TERMINO + 1).setValue(end).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.DIAS + 1).setValue(total);
    sh.getRange(row, L.RETORNO + 1).setValue(_plusDays(end, 1)).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, L.RETORNO_UTIL + 1).setValue(retUtil).setNumberFormat('dd/mm/yyyy');

    return JSON.stringify({ success: true, returnDate: formatDate(retUtil), total: total });
  } catch (e) { return _err(e.message); }
}

// ============================================================
// INCLUSÃO DE PERÍODO AQUISITIVO — grava na aba Periodos
// payload = { matricula, inicioAquisitivo, faltas }
// ============================================================
function addPeriodoAquisitivo(payload) {
  try {
    if (_scopeAtual().perfil === 'gerente')
      return _err('Só o RH pode incluir período aquisitivo.');
    const matIn = _mk(payload && payload.matricula);
    if (!matIn) return _err('Matrícula não informada.');
    const ini = toDate(payload.inicioAquisitivo);
    if (!ini) return _err('Data de início do período inválida.');
    const faltas = Number(payload.faltas) || 0;

    const fr = _rows(TAB.FUNC).find(function (r) { return _mk(r[F.MAT]) === matIn; });
    if (!fr) return _err('Funcionário não encontrado na aba Func.');
    const matRaw = fr[F.MAT];

    const sh = _sheet(TAB.PERIODOS);
    const existing = sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues() : [];
    for (var i = 0; i < existing.length; i++) {
      if (_mk(existing[i][P.MAT]) === matIn
        && formatDate(existing[i][P.INI_AQ]) === formatDate(ini))
        return _err('Já existe um período aquisitivo iniciando em ' + formatDate(ini) + '.');
    }
    const seq = existing.filter(function (r) { return _mk(r[P.MAT]) === matIn; }).length + 1;

    const today = _midnight(new Date());
    const fim  = _plusDays(_addMonths(ini, 12), -1);
    const conc = _addMonths(fim, 12);
    const label = ini.getFullYear() + '/' + fim.getFullYear();
    const direito = _diasDireito(faltas);
    const creditado = (fim <= today) ? 'Sim' : 'Não';
    const situacao = _periodoSituacao(fim, conc, today);
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
      fimAquisitivo: formatDate(fim), concessao: formatDate(conc),
    });
  } catch (e) { return _err(e.message); }
}

// ============================================================
// EXCLUSÃO DE FÉRIAS — apaga a linha na aba Lancamentos
// payload = { rowIndex, matricula, inicio }  (matricula/inicio = conferência)
// ============================================================
function deleteVacationRecord(payload) {
  try {
    if (_scopeAtual().perfil === 'gerente')
      return _err('Só o RH pode apagar um período de férias.');
    const row = Number(payload && payload.rowIndex);
    if (!row || row < 2) return _err('Linha inválida.');

    const sh = _sheet(TAB.LANCAMENTOS);
    if (row > sh.getLastRow()) return _err('Essa linha não existe mais. Recarregue o painel.');

    const cur = sh.getRange(row, 1, 1, Math.max(9, sh.getLastColumn())).getValues()[0];

    if (payload.matricula && _mk(cur[L.MAT]) !== _mk(payload.matricula))
      return _err('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');
    if (payload.inicio && formatDate(cur[L.INICIO]) !== String(payload.inicio))
      return _err('A linha mudou de posição na planilha. Recarregue o painel e tente de novo.');

    sh.deleteRow(row);
    return JSON.stringify({ success: true });
  } catch (e) { return _err(e.message); }
}

// ============================================================
// DETECÇÃO DE CONFLITOS (3+ funcionários da mesma filial sobrepostos)
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
        if (startA <= endB && endA >= startB) overlapping.push(records[j].name);
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
function _sheet(name) {
  const sh = SpreadsheetApp.openById(MODEL_SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('Aba não encontrada: ' + name + ' (planilha ' + MODEL_SHEET_ID + ')');
  return sh;
}
function _rows(name) {
  const sh = _sheet(name);
  const last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, Math.max(1, sh.getLastColumn())).getValues();
}
function _err(msg) { return JSON.stringify({ success: false, error: String(msg) }); }
function _cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// Normaliza matrícula p/ comparação: aceita número ou texto, com ou sem
// zeros à esquerda ("02016", 2016 e "2016" viram a mesma chave).
function _mk(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s.toLowerCase();
}
function _midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function _plusDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function _addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function _diasDireito(faltas) {
  const f = Number(faltas) || 0;
  return f <= 5 ? 30 : f <= 14 ? 24 : f <= 23 ? 18 : f <= 32 ? 12 : 0;
}
function _periodoSituacao(fimAqD, concD, today) {
  if (!fimAqD) return '';
  if (fimAqD > today) return 'Em formação';
  if (concD && today > concD) return 'Vencido — risco de dobro';
  if (concD) {
    const dias = Math.round((concD - today) / 864e5);
    return (dias <= 90 ? 'Vence em ' : 'Em dia — vence em ') + dias + ' d';
  }
  return '';
}

function _feriadosSet() {
  const set = {};
  try {
    _rows(TAB.FERIADOS).forEach(function (r) {
      const d = toDate(r[0]);
      if (d) set[formatDate(d)] = true;
    });
  } catch (e) {}
  return set;
}
function _addWorkingDays(date, n) {
  const hol = _feriadosSet();
  let x = new Date(date), left = n;
  while (left > 0) {
    x = _plusDays(x, 1);
    const wd = x.getDay();
    if (wd === 0 || wd === 6) continue;
    if (hol[formatDate(x)]) continue;
    left--;
  }
  return x;
}

// Date | ISO | dd/mm/yyyy  ->  Date | null
function toDate(value) {
  if (!value || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return new Date(+br[3], +br[2] - 1, +br[1]);
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
  const p = isoDate.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : isoDate;
}

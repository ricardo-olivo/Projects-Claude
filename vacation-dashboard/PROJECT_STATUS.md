# STATUS DO PROJETO

## Data do checkpoint
2026-10-26 (fase 3 — fluxo de aprovação gerente → RH implementado; testado só no
preview local)

## Branch atual
`main` (repositório `Projects-Claude`, remote `https://github.com/ricardo-olivo/Projects-Claude.git`).
Os commits de setembro (até `fed02fe`, correção de fuso) **já foram pusheados**.
Locais, ainda **não pusheados**: `e3bf56c` (comparativo-vendas — contém
`data.json` com faturamento/custo real, conferir se o repo é público antes do push)
e o commit da fase 3.

## Último commit
Commit da fase 3 (HEAD de `main`) — "vacation-dashboard: phase 3 approval flow
(manager requests, HR approves/rejects)" (2026-10-26).

Commit anterior deste projeto: `fed02fe` — correção de fuso (retorno saía +1 dia;
sábado conta como dia útil) (2026-09-10).

Commits recentes do repositório (multi-projeto):
```
bcb0c82 vacation-dashboard: clickable summary cards, ficha adjustments edit/delete, manual due date  <-- este projeto
2beccb8 vacation-dashboard: group Tabela by employee/branch, add employee CRUD and active/inactive  <-- este projeto
efd4be2 docs: add project checkpoint and development context                          (este projeto)
c93b28c Rebuild vacation-dashboard on the single-spreadsheet "banco de dias" model   <-- este projeto
b84f09e Add Margem c/ Manipulados to the KPI row                                     (farmacias-dashboard)
fac376b Auto-classify store porte from faturamento instead of the sheet column        (farmacias-dashboard)
f896403 Add Node.js server for hosting the pharmacy dashboard on Render               (farmacias-dashboard)
7766fdf Add pharmacy results dashboard, plus existing sales/vacation dashboards
```

## Objetivo atual
Controle de férias da rede Líderfarma em Apps Script + Google Sheets: banco de
dias por funcionário, ficha individual, Aviso de Férias em PDF, e acesso
segmentado por filial (RH x Gerente).

## Fase atual
- **Fase 0 (núcleo)** — concluída.
- **Fase 1 (página inicial + roteador `doGet`)** — concluída no código.
- **Fase 2 (acesso por filial)** — concluída no **código**; falta configurar
  deploy + criar a aba `Acessos` e testar com login real (tarefa do usuário).
- **Fase 3 (fluxo de aprovação gerente→RH)** — **concluída no código** (2026-10-26),
  testada no preview local (RH e gerente simulados). Depende do deploy + da fase 2
  em produção para ter efeito (sem aba `Acessos`, todo mundo é RH → tudo entra
  aprovado direto e a fila fica vazia).

## Funcionalidades concluídas
- `doGet` roteador: `.../exec` → `Home.html`; `.../exec?page=painel` → `Dashboard.html`.
- `Home.html`: logo (recriação), 3 números de resumo (`getResumoHome`), identificação
  do acesso, botão que abre o painel "no lugar" (`paginaPainel()`).
- `getVacationData()`: consolida Func + Periodos + Lancamentos + Ajustes, calcula o
  banco de dias, monta `data[]` / `employees[]` / `conflicts[]` / `payment*` /
  `totals` e aplica o **escopo por filial no servidor**.
- Visão **Tabela**: abre numa **grade de cards por filial**; ao clicar num card,
  mostra a tabela **agrupada por funcionário** daquela filial (1 linha por pessoa;
  quem tem 2+ períodos vira uma linha-resumo recolhível que expande nas linhas de
  cada período), com botão "← Filiais". Ordenação por coluna, edição inline de datas
  (só RH), apagar linha (🗑, só RH), badge de status.
- Visão **Funcionários**: cadastro completo (registrados + sem registro), filtro
  Todos / Registrados / Sem registro, botão "Ver ficha".
- Visão **Calendário**: mensal, semestral e anual (timeline).
- Visão **Pagamentos do Mês**: funcionários sem registro por mês.
- Visão **Relatório Mensal** e **Vencimento Mensal** (com impressão dedicada).
- **Ficha individual** (modal): identificação + chips, quebra do saldo, tabela de
  períodos aquisitivos (situação colorida), histórico de gozo/abono, observações/ajustes.
  Botões: **Aviso PDF** por linha de gozo, **Imprimir**, **+ Incluir período** (só RH).
- **Incluir Férias** (modal): datalist de funcionários com filtro por digitação,
  auto-preenche filial, calcula retorno e dias, valida nome contra o cadastro.
- **Editar** datas de uma linha de férias (clique na célula, só RH).
- **Apagar** período de férias com confirmação e checagem de matrícula/data no servidor.
- **Incluir período aquisitivo** pela ficha: prévia (dias de direito, fim, concessão),
  grava valores na aba `Periodos` (só RH).
- **Cadastrar funcionário** pela aba Funcionários (só RH): grava na aba `Func`;
  matrícula sugerida (maior nº + 1) e editável; se "Registrado", já cria o 1º
  período aquisitivo a partir da admissão.
- **Ativar / inativar funcionário** (desligamento) pela ficha (só RH): grava
  `Func.Situação` = Ativo/Inativo. Inativo continua na Tabela/cards/ficha com selo
  "Inativo", some da lista de "Incluir Férias"; aba Funcionários tem filtro
  Ativos/Inativos/Todos (padrão Ativos).
- **Ajuste manual de saldo** e **observação/justificativa** pela ficha (só RH):
  incluir, **editar** e **excluir**; grava na aba `Ajustes`; ajuste com dias ±
  recalcula os dias disponíveis (prévia no modal), observação sem dias só registra
  o texto.
- **Cards de resumo do topo clicáveis**: cada um abre um modal com a lista por
  trás do número (funcionários, férias iniciando no mês, em férias agora, não
  registrados).
- **Vencimento das férias manual** pela ficha (só RH): define mês/ano de
  vencimento para quem não tem período aquisitivo; aparece na coluna Vencimento
  das listas/KPIs.
- **Aviso de Férias em PDF**: HTML → PDF via `Utilities.getAs('application/pdf')`,
  entregue como download base64. CNPJ/Razão Social por `Lojas` ou `EMPRESA_PADRAO`;
  período aquisitivo da aba `Periodos` ou calculado da admissão; CTPS real ou
  fake determinístico de 7 dígitos.
- **Detecção de conflitos** (3+ na mesma filial sobrepostos) + seção de alertas.
- **KPIs** no topo: Funcionários, Pagas este mês, Em férias agora, Não registrados.
- **Escopo (fase 2)** no servidor: `_scopeAtual()` (RH / Gerente / nenhum) e
  `_noEscopo()` em `getEmployeeFicha`, `getAvisoFeriasPdf`, `addVacationRecord`;
  `updateVacationRecord` / `deleteVacationRecord` / `addPeriodoAquisitivo` bloqueiam Gerente.
- Front adapta ao escopo (`aplicarScope`): trava o filtro de filial, esconde 🗑 / ✏ /
  "+ Incluir período" para Gerente, rótulo no cabeçalho, mensagem "acesso não liberado".
- Normalização de matrícula (`_mk`) em todo o `Code.gs`.
- Gravação sempre por **valores** (sem fórmula) para não quebrar em planilha pt-BR.
- `getVacationData` / `getEmployeeFicha` recalculam "creditado", "dias" e "retorno"
  quando a célula está vazia ou com `#ERROR!`.

## Funcionalidades em andamento
- **Fase 2 — colocar em produção**: depende do usuário
  (1) redeploy com "Executar como: Eu" + "Acesso: qualquer pessoa da organização";
  (2) criar a aba `Acessos` (E-mail | Filial | Perfil);
  (3) testar login real de RH e de Gerente.
  O código está pronto e foi testado só **localmente / simulado**.
- **Google Sites** para URL amigável: código pronto (`paginaPainel`, sem
  `<base target="_top">`); a página do Sites ainda não foi criada.

## Funcionalidades pendentes
1. ~~Fase 3 — fluxo de aprovação.~~ **Feito no código** (2026-10-26) — falta deploy
   + teste real. Opcional depois: ligar `NOTIFICAR_EMAIL`; RH editar datas de um
   pedido pendente antes de aprovar já funciona pela edição inline.
2. ~~Cadastrar funcionário (aba `Func`) pelo dashboard.~~ **Feito** (só RH) — falta deploy.
3. ~~Lançar ajuste manual (aba `Ajustes`) pelo dashboard.~~ **Feito** (pela ficha,
   só RH) — falta deploy.
4. **Reescrever o `README.md`** — está descrevendo a arquitetura antiga (28 planilhas).
5. **Trocar o logo recriado pelo PNG oficial** (`LOGO_DATA_URI` na `Home.html`).
6. Preencher `EMPRESA_PADRAO` / criar aba `Lojas` com CNPJ correto por filial
   (o CNPJ atual `79.408.746/0001-99` é da matriz e pode não valer para todas).
7. Confirmar/ajustar a regra de "Pagamentos do Mês" para sem-registro (mês =
   aniversário de admissão, pagar 30 = saldo ≥ 30) — precisa de validação do RH.

## Bugs conhecidos
- ~~**Retorno ao trabalho saía +1 dia.**~~ **Corrigido e commitado** (HEAD de
  `main`, 2026-09-10), **falta deploy**. `toDate`/`formatDate` no `Code.gs` tratavam `yyyy-mm-dd` como
  UTC (`new Date(s)` / `toISOString()`); no fuso −03 o retorno pulava um dia
  (gozo até 13/09/2026 → retorno 15/09 em vez de 14/09). Agora parseiam/formatam
  em horário **local**. Precisa de deploy; linhas antigas já exibem certo, mas
  convém reeditar as datas p/ limpar a fração de hora gravada na célula.
- **`README.md` desatualizado** (arquitetura antiga). Enganoso para quem ler primeiro.
- **Login vazio se o deploy estiver errado.** `Session.getActiveUser().getEmail()`
  retorna `''` se o Web App não estiver como "Executar como: Eu" + "Acesso: qualquer
  pessoa da organização" (Workspace). Com a aba `Acessos` presente e e-mail vazio,
  TODO MUNDO cai em `perfil: 'nenhum'` (bloqueado). Mitigação atual: manter a aba
  `Acessos` **inexistente/vazia** até o deploy estar certo (aí todos = RH).
- **Validação de dados da planilha bloqueia digitação manual** na coluna
  `Lancamentos!A` (lista de matrículas, "rejeitar"). `addVacationRecord` contorna
  (limpa a validação da linha antes de gravar e devolve o dropdown depois), mas para
  digitar direto na planilha o usuário precisa trocar a regra para "Mostrar aviso".
- **Matrícula inconsistente na planilha** (número x texto x zeros à esquerda).
  Mitigado por `_mk()`, mas recomendado padronizar a coluna como Texto simples.
- **Linha antiga quebrada da "Suele Correa"** em `Lancamentos` (gravada por versão
  antiga que usava fórmula → `#ERROR!` em Retorno/Dias). O código novo recalcula
  pelas datas, então o saldo já sai certo; **não confirmado** se o usuário apagou e
  refez a linha. Recomendado: apagar (🗑) e refazer a inclusão.
- **Logo da Home é recriação** (fonte web), não a imagem oficial.

## Problemas técnicos
- **Duas cópias do projeto que precisam ser sincronizadas à mão:**
  - `C:\Users\ricar\OneDrive\Área de Trabalho\Claude\vacation-dashboard\` — pasta de
    trabalho, **NÃO é repositório git**.
  - `C:\Users\ricar\OneDrive\Área de Trabalho\Claude\Projects-Claude\vacation-dashboard\` —
    versionada (é o que vai pro GitHub).
  Antes de commitar, copiar a primeira sobre a segunda. No checkpoint, as duas estão idênticas.
- **`Code.gs` não roda localmente** — só no Apps Script. O preview local (`serve.ps1`)
  serve o `Dashboard.html` com `MOCK_DATA` e `MOCK_PAYMENT_DATA`; nesse modo o `scope`
  fica no padrão RH.
- **Sem CI / sem testes automatizados.**
- **`Utilities.getAs('application/pdf')`** tem um renderer de HTML limitado (sem
  flexbox etc.) — o `_avisoHtml` usa tabelas + estilos inline de propósito.
- **Limite de e-mail** (`MailApp`): 100/dia em conta Gmail comum — relevante para a fase 3.
- **`git config` de identidade** foi setado (global): `ricardo.olivo` /
  `rfolivo@gmail.com` / `core.autocrlf=true`. Push HTTPS ainda pode pedir
  autenticação (PAT ou Git Credential Manager) na primeira vez.

## Decisões recentes
- Modelo de planilha única + "banco de dias" (substitui a varredura de 27 planilhas).
- "Creditado" e "Situação do prazo" calculados no servidor pelas datas (não lidos da coluna).
- Inserções na planilha gravam **valores**, nunca fórmulas (locale pt-BR).
- Roteador no `doGet` + `paginaPainel()` para funcionar embutido no Google Sites
  sem trocar a URL.
- Acesso por e-mail + aba `Acessos`; sem a aba, todo mundo é RH (migração suave).
- Gerente só marca férias; editar/apagar/incluir período é do RH (prepara a fase 3).
- `EMPRESA_PADRAO` pré-preenchido com os dados do exemplo do usuário (conferir).

## Arquivos modificados recentemente

### Commitado em `2beccb8` (2026-08-31) — `Code.gs` + `Dashboard.html` + docs

**1. Visão Tabela agrupada por funcionário + grade de cards de filial** (só front):
- A aba Tabela abre numa **grade de cards de filial** (`renderBranchCards`); clicar
  entra na filial. Estado `tableBranch` (null = cards; string = tabela da filial),
  botão "← Filiais", contador "N filial(is)".
- Dentro da filial, `renderTable()` agrupa por funcionário (`empKey` = matrícula ou
  `filial|nome`): 1 período → linha normal; 2+ → linha-resumo `grp-row` recolhível
  + `grp-child` (mantêm `data-idx` real → edição inline / 🗑 / ficha ok).
- Helpers: `empKey`, `groupFiltered`, `groupSummary`, `detailRow`, `toggleGroup`,
  `branchList`, `renderBranchCards`, `setTableBranch`, `clearTableBranch`.
  Estado: `expandedGroups`, `tableGroups`.
- CSS: `.grp-*`, `.branch-grid` / `.branch-card` / `.bc-*` / `.btn-back`.
- `MOCK_DATA` ganhou "Jeovany Fossatti" (5 períodos) e `matricula` por funcionário
  (preview).

**2. Cadastrar funcionário** (só RH):
- `Code.gs`: `addEmployee(payload)` — grava linha na aba `Func` (só VALORES);
  matrícula informada ou "maior nº + 1", unicidade por `_mk()`; se `registrado`,
  chama `addPeriodoAquisitivo` (admissão, 0 faltas).
- `Dashboard.html`: botão "+ Cadastrar Funcionário" (`rh-only`) na aba Funcionários,
  modal `#emp-overlay`, `openEmpModal`/`closeEmpModal`/`validateEmpModal`/
  `submitAddEmployee`/`nextMatriculaSuggestion`. CSS `body.perfil-gerente .rh-only`.

**3. Ativar / inativar funcionário** (só RH):
- `Code.gs`: `setEmployeeStatus({matricula, ativo})` — grava `Func.Situação`
  Ativo/Inativo. `getVacationData` devolve `ativo` em `data[]` e `employees[]`;
  `getEmployeeFicha` devolve `func.ativo`.
- `Dashboard.html`: botão "⊘ Marcar inativo / ✓ Reativar" na ficha
  (`#ficha-status-btn`, `rh-only`), `toggleEmpStatus()`, `_mkFront()`. Aba
  Funcionários com pills Ativos/Inativos/Todos (`empFiltroStatus`, padrão `ativos`),
  selo "Inativo" na aba e na Tabela; `currentEmployees()` (Incluir Férias) exclui
  inativos. CSS `.emp-fbtn2`, `.badge-inativo`, `.row-inativo`.

### Commitado em `bcb0c82` (2026-08-31) — `Code.gs` + `Dashboard.html` + docs

**a) Cards de resumo (KPIs) clicáveis** (só `Dashboard.html`): os 4 cards do topo
viraram botões; clicar abre o modal `#kpi-overlay` com a lista correspondente
(`openKpi(which)` / `closeKpi` / `kpiGoto`). O botão "Abrir aba" leva à aba/filtro
certos. CSS novo: `.card-click`, `.card-cta`, `.kpi-count`.

**c) Vencimento das férias manual pela ficha** (só RH):
- `Code.gs`: nova coluna **J** na aba `Func` (`F.VENC = 9`). `setEmployeeVencimento
  ({matricula, vencimento})` grava mês/ano (1º dia do mês) ou limpa. Monta a data
  por `new Date(ano, mes-1, 1)` a partir do texto `yyyy-mm` — **não** usa
  `new Date(string)` (parseava como UTC e deslocava o mês para trás em UTC−3). `dueOf()` e
  `getEmployeeFicha` caem para esse valor **só quando não há período aquisitivo**
  (concessão calculada tem prioridade). `employees[]` ganhou `vencManual` /
  `vencCalc`; `getEmployeeFicha.func` ganhou `vencimento` / `vencManual` /
  `temCalculo`. `addEmployee` reserva a coluna J.
- `Dashboard.html`: linha "Vencimento das férias" na ficha com botão
  "+ definir / ✏ alterar" (`rh-only`, só quando não é calculado), modal
  `#venc-overlay` (`<input type="month">`), `abrirVenc` / `fecharVenc` /
  `salvarVenc`. Preview: `demoVenc` por matrícula.
- `renderDueView()` (aba **Vencimento Mensal**) agora inclui **não registrados**
  com vencimento manual no mês (antes só varria `allData`, onde eles não entram);
  botão **"🔍 Pesquisar"** adicionado ao lado do seletor de mês.

**b) Ajuste manual / observação pela ficha** (só RH) — incluir, **editar** e **excluir**:
- `Code.gs`: `addAjuste({matricula, data?, dias?, obs})` grava linha na aba `Ajustes`
  (só VALORES). Dias vazio/0 → só observação (não altera saldo); dias ± credita/
  desconta do banco de dias. `updateAjuste({rowIndex, matricula, ...})` reescreve a
  linha; `deleteAjuste({rowIndex, matricula})` apaga (ambos conferem a matrícula da
  linha antes). `getEmployeeFicha` passou a devolver `rowIndex` em cada ajuste.
- `Dashboard.html`: seção "Observações / ajustes de saldo" ganhou "+ Lançar ajuste"
  e "+ Observação" (`rh-only`) + **✏ / 🗑 por linha**. Modal `#ajuste-overlay`
  compartilhado por incluir/editar (`abrirAjuste` / `editarAjuste` / `excluirAjuste`
  / `salvarAjuste` / `ajPreview` / `_aplicaDeltaSaldo`), estado `ajEditRow` /
  `ajEditIdx` / `ajEditOldDias`, prévia do novo saldo. CSS `.form-group textarea`.
  Preview: `demoAjustes` guarda os ajustes por matrícula no modo mock.

### Commitado em `836c247` (2026-09-01) — `Code.gs` + `Dashboard.html` + docs

**Editar / excluir período aquisitivo pela ficha** (só RH):
- `Code.gs`: `getEmployeeFicha` passou a devolver `rowIndex` e `faltas` em cada
  período. `updatePeriodoAquisitivo({rowIndex, matricula, inicioAquisitivo, faltas})`
  recalcula fim/concessão/direito/situação e reescreve as colunas B..I (mantém
  Matrícula e `_seq`/`_chave`); confere a matrícula da linha e a colisão de data
  com **outro** período. `deletePeriodoAquisitivo({rowIndex, matricula})` apaga.
- `Dashboard.html`: tabela "Períodos aquisitivos" ganhou **✏ / 🗑 por linha**
  (`rh-only`); o modal `#periodo-overlay` é compartilhado incluir/editar
  (`editarPeriodo` / `excluirPeriodo`, estado `perEditRow` / `perEditIdx`,
  `salvarNovoPeriodo` bifurca). `_calcPeriodo()` (prévia + preview), `demoPeriodos`
  por matrícula (agora add/editar/excluir período funcionam no preview local).

**Vencimento Mensal considera todos os períodos** (era só o "próximo"):
- `Code.gs`: `getVacationData.employees[]` ganhou `vencimentos` = **todas** as datas
  de concessão do funcionário (ISO, ordenadas), ou `[vencManual]` se não houver
  período. Antes o relatório usava `dueOf()`, que devolve só a próxima concessão
  futura — concessões já vencidas (mesmo neste mês) sumiam do relatório.
- `Dashboard.html`: `renderDueView()` reescrito — itera `allEmployees` e emite uma
  linha por (funcionário × concessão) que cai no mês; coluna "Situação" mostra
  "Vencido — risco de dobro" / "Vence em N d"; "Vencimento" agora é data cheia;
  contador em "vencimento(s)".

### Commitado em 2026-09-10 (HEAD de `main`) — `Code.gs` + docs

**Fuso horário no cálculo de datas** (`Code.gs`, só backend):
- `toDate()` ganhou um ramo para `yyyy-mm-dd` puro → `new Date(ano, mês-1, dia)`
  (meia-noite **local**). Antes caía em `new Date(s)`, que parseia string ISO só
  com data como **UTC**; no fuso −03 a data virava 21h do dia anterior.
- `formatDate()` não usa mais `toISOString()` (UTC) — monta `yyyy-mm-dd` pelos
  componentes **locais** (`getFullYear`/`getMonth`/`getDate`), com `_pad2()`.
- Efeito: o "Retorno ao trabalho" saía +1 dia (ex.: gozo até domingo 13/09/2026
  mostrava retorno 15/09 em vez de **14/09**). Vale para retorno simples, retorno
  útil (`_addWorkingDays`), chaves de `_feriadosSet`, datas gravadas na aba
  `Lancamentos` e o aviso em PDF. Linhas já gravadas com o valor errado passam a
  **exibir certo** (a célula arredonda p/ o dia local); para limpar a fração de
  hora, reeditar as datas pela ficha depois do deploy.
- `_addWorkingDays()` deixou de pular sábado — só domingo + aba `Feriados`
  contam como folga (sábado é dia trabalhado na rede).

### Commit da fase 3 (2026-10-26, HEAD de `main`) — `Code.gs` + `Dashboard.html` + docs

**Fluxo de aprovação gerente → RH** (regras completas no `CLAUDE.md`, seção
"Fluxo de aprovação (fase 3)"):
- `Code.gs`: `L.STATUS..L.MOTIVO` (colunas M..R de `Lancamentos`), `LANC_COLS`,
  `ST`, `NOTIFICAR_EMAIL`; helpers `_statusLanc`, `_ensureLancCols` (cria as colunas e
  o cabeçalho sozinho), `_notificar`, `_emailsRH`. `addVacationRecord` grava status
  pelo perfil + auditoria e bloqueia sobreposição com outras férias da pessoa.
  `getVacationData` / `getEmployeeFicha` / `getResumoHome` só descontam Aprovado;
  devolvem `status`, `pendingDays`, `employees[].pendente`, `totals.pendentes`,
  `saldo.pendente`, `lancamentos[].status/motivo/rowIndex`. Recusadas saem de `data[]`.
  `getAvisoFeriasPdf` só para Aprovado. `deleteVacationRecord` deixa gerente cancelar
  pedido Pendente. Novas: `getAprovacoes(dias)` e `decidirFerias(payload)`.
- `Dashboard.html`: aba **Aprovações** (RH: Aprovar / Recusar com modal de motivo,
  saldo restante e quem mais da filial estará fora; gerente: "Minhas solicitações"
  + Cancelar pedido) com contador; status `pending` em `getStatus` (badge "Aguardando
  aprovação", barra listrada no calendário, filtro de status, fora dos KPIs);
  linha-resumo do grupo mostra "+N pend."; ficha com coluna Status/motivo, PDF só
  para aprovada e linha "Solicitado, aguardando"; modal vira "Solicitar Férias /
  Enviar para aprovação" para gerente. Preview: `?perfil=gerente&filial=...`,
  pedidos pendentes de exemplo, `demoDecididas`.

### Deploy
Nada redeployado no Apps Script desde agosto — o próximo deploy precisa de
**`Code.gs` + `Dashboard.html`** (nova versão) e do cabeçalho da coluna **J
("Vencimento")** na aba `Func`. Inclui a correção de fuso, o sábado como dia útil e
toda a fase 3 (as colunas M..R de `Lancamentos` são criadas sozinhas na 1ª gravação).

## Banco de dados
"Banco" = uma planilha Google Sheets (`MODEL_SHEET_ID = 1wLN9oZji-Uk6prHMcvav0CNg1u-tFMz_`),
importada de um `.xlsx`. Abas usadas: `Func`, `Periodos`, `Lancamentos`, `Ajustes`,
`Feriados`, `Lojas` (opcional), `Acessos` (opcional). Colunas descritas no `CLAUDE.md`.

Alterações de schema pendentes:
- **Fase 3**: colunas M..R de `Lancamentos` (Status · Solicitado por · Solicitado em ·
  Decidido por · Decidido em · Motivo) — **automáticas** (`_ensureLancCols` na 1ª
  inclusão/decisão). Se a aba tiver validação/formatação nessas colunas, conferir.
- Criar a aba **`Acessos`** (E-mail | Filial | Perfil) para ligar a fase 2.
- Opcional: aba **`Lojas`** (Filial | Razão Social | CNPJ | Cidade) para o aviso.
- Opcional: coluna **I (CTPS)** na aba `Func`.
- Opcional: coluna **J (Vencimento das férias)** na aba `Func` — mês/ano manual,
  usado só para quem não tem período aquisitivo. O `Code.gs` trata a ausência
  (célula vazia = sem vencimento manual); `setEmployeeVencimento` grava nela.
Sem migrations formais — as abas/colunas são editadas manualmente na planilha; o
`Code.gs` trata a ausência delas.

## Testes
- **Não há testes automatizados.**
- Verificação foi **manual**, durante o desenvolvimento, via:
  - Preview local (`serve.ps1` → `http://localhost:8765`) com `MOCK_DATA`;
  - Inspeção do DOM no navegador (contagem de linhas, botões, filtros, abertura de modais);
  - Geração de PDF de prova pela build da planilha (fluxo separado, não faz parte do app).
- Fase 3 (2026-10-26): `Code.gs` validado só por sintaxe (`new Function` no navegador);
  fluxo testado no preview local — RH aprova (saldo desconta) e recusa (motivo
  obrigatório, some da Tabela); gerente solicita (vira Pendente, sem PDF), vê
  "Minhas solicitações" e cancela pedido; resumo do grupo "Em férias +1 pend.".
- **Não executados / não confirmados:** qualquer teste com a planilha real via
  `google.script.run`; login real de RH/Gerente; embed no Google Sites; download do
  PDF a partir do dashboard publicado.

## Próxima tarefa recomendada
**Colocar Fases 2 + 3 em produção e validar** (tarefa do usuário):
1. No Apps Script: adicionar o arquivo `Home` (HTML), colar `Code.gs` e `Dashboard.html`
   atuais, criar **nova versão** de implantação com "Executar como: Eu" e
   "Acesso: qualquer pessoa da [organização]".
2. Criar a aba `Acessos` na planilha com 1 linha de RH (e-mail | vazio | RH) e 1–2
   de Gerente (e-mail | filial | Gerente).
3. Abrir `.../exec` logado como RH e como Gerente; conferir que o Gerente só vê a
   filial dele e que os botões RH somem.
4. Como Gerente: "Solicitar Férias" → conferir linha Pendente na planilha (colunas
   M..R criadas). Como RH: aba Aprovações → aprovar uma, recusar outra; conferir
   saldo e Aviso PDF.

## Próximos passos (ordem de prioridade)
1. Deploy + aba `Acessos` + teste das Fases 2 e 3 (acima).
2. Reescrever o `README.md` para a arquitetura atual (instalação: planilha única,
   `MODEL_SHEET_ID`, arquivo `Home`, deploy, aba `Acessos`, fluxo de aprovação).
3. (Opcional) ligar `NOTIFICAR_EMAIL` depois do teste — exige autorizar `MailApp`.
4. Trocar o logo pelo PNG oficial (`LOGO_DATA_URI`); preencher `Lojas` / `EMPRESA_PADRAO`
   com CNPJ correto por filial; opcional coluna CTPS em `Func`.
5. Página no Google Sites embutindo `.../exec` (iframe) + domínio próprio (opcional).
6. Limpeza: padronizar a coluna Matrícula como Texto nas abas; trocar a validação de
   `Lancamentos!A` para "Mostrar aviso"; apagar/refazer a linha quebrada da Suele.

## Como continuar
1. **Abra o projeto** em `Projects-Claude/vacation-dashboard/` (é o que está no git).
   Leia primeiro `CLAUDE.md` e depois este arquivo.
2. **Sincronize as pastas**: os arquivos em
   `Área de Trabalho/Claude/vacation-dashboard/` e em
   `Projects-Claude/vacation-dashboard/` devem estar idênticos. Se editar, edite os
   dois (ou passe a trabalhar só na versão versionada). Commite sempre a de
   `Projects-Claude/`.
3. **Backend** = `Code.gs` (Apps Script, V8). **Front** = `Dashboard.html` +
   `Home.html`. Sem framework.
4. **Não roda local de verdade**: `Code.gs` só no Apps Script. Para ver o front,
   `powershell -ExecutionPolicy Bypass -File vacation-dashboard/serve.ps1` e abra
   `http://localhost:8765/Dashboard.html` (dados MOCK, perfil RH).
5. **Deploy**: cada mudança em `Code.gs`/`Dashboard.html`/`Home.html` → colar no
   projeto Apps Script → Implantar → Gerenciar implantações → editar → Nova versão.
   `Home.html` é um arquivo HTML separado chamado `Home`.
6. **Antes de implementar qualquer coisa nova**, reveja a seção **Cuidados** do
   `CLAUDE.md` (não voltar ao modelo de 27 planilhas; não usar `setFormula` nas
   inserções; não remover `_mk`; segurança de escopo no servidor; não apagar
   `_seq`/`_chave`; manter o contrato JSON do `getVacationData`).
7. **Se for mexer no schema da planilha** (fase 3), acrescente colunas **no fim** da
   aba para não deslocar os índices `L.*` / `P.*` do `Code.gs`.
8. A planilha real é `MODEL_SHEET_ID = 1wLN9oZji-Uk6prHMcvav0CNg1u-tFMz_`. O acesso a
   ela é do dono do script — peça ao usuário se precisar inspecionar dados.

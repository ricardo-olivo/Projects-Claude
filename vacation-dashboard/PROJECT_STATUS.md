# STATUS DO PROJETO

## Data do checkpoint
2026-08-31

## Branch atual
`main` (repositório `Projects-Claude`, remote `https://github.com/ricardo-olivo/Projects-Claude.git`).
`HEAD` == `origin/main` (sincronizado) no momento deste checkpoint, antes do commit da documentação.

## Último commit
`c93b28c` — "Rebuild vacation-dashboard on the single-spreadsheet \"banco de dias\" model"
Data: 2026-08-29 12:21 -0300. Autor: ricardo.olivo <rfolivo@gmail.com>.

Commits recentes do repositório (multi-projeto):
```
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
- **Fase 3 (fluxo de aprovação gerente→RH)** — **não iniciada** (só desenhada).

## Funcionalidades concluídas
- `doGet` roteador: `.../exec` → `Home.html`; `.../exec?page=painel` → `Dashboard.html`.
- `Home.html`: logo (recriação), 3 números de resumo (`getResumoHome`), identificação
  do acesso, botão que abre o painel "no lugar" (`paginaPainel()`).
- `getVacationData()`: consolida Func + Periodos + Lancamentos + Ajustes, calcula o
  banco de dias, monta `data[]` / `employees[]` / `conflicts[]` / `payment*` /
  `totals` e aplica o **escopo por filial no servidor**.
- Visão **Tabela**: lista, ordenação por coluna, edição inline de datas (só RH),
  apagar linha (🗑, só RH), badge de status.
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
1. **Fase 3 — fluxo de aprovação (gerente marca → RH aprova).** Não iniciada.
   Precisa: coluna `Status` (Pendente/Aprovado/Recusado) + colunas de auditoria na
   aba `Lancamentos`; `addVacationRecord` ciente do perfil (Gerente → Pendente);
   saldo separado (aprovado x pendente); `getAprovacoesPendentes()` + tela/aba
   "Aprovações"; `aprovarFerias(linha, "aprovar"|"recusar", motivo)`; Aviso PDF só
   para Aprovado; (opcional) e-mails via `MailApp` (limite 100/dia Gmail).
2. **Cadastrar funcionário (aba `Func`) pelo dashboard.** Hoje é manual na planilha.
3. **Lançar ajuste manual (aba `Ajustes`) pelo dashboard.** Hoje é manual.
4. **Reescrever o `README.md`** — está descrevendo a arquitetura antiga (28 planilhas).
5. **Trocar o logo recriado pelo PNG oficial** (`LOGO_DATA_URI` na `Home.html`).
6. Preencher `EMPRESA_PADRAO` / criar aba `Lojas` com CNPJ correto por filial
   (o CNPJ atual `79.408.746/0001-99` é da matriz e pode não valer para todas).
7. Confirmar/ajustar a regra de "Pagamentos do Mês" para sem-registro (mês =
   aniversário de admissão, pagar 30 = saldo ≥ 30) — precisa de validação do RH.

## Bugs conhecidos
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
No commit `c93b28c` (2026-08-29): `vacation-dashboard/Code.gs`,
`vacation-dashboard/Dashboard.html`, `vacation-dashboard/README.md` alterados;
`vacation-dashboard/Home.html` criado (4 arquivos, +1966 / −284).
Desde então, **nenhuma alteração de código** (só este checkpoint de documentação).

## Banco de dados
"Banco" = uma planilha Google Sheets (`MODEL_SHEET_ID = 1wLN9oZji-Uk6prHMcvav0CNg1u-tFMz_`),
importada de um `.xlsx`. Abas usadas: `Func`, `Periodos`, `Lancamentos`, `Ajustes`,
`Feriados`, `Lojas` (opcional), `Acessos` (opcional). Colunas descritas no `CLAUDE.md`.

Alterações de schema pendentes:
- **Fase 3**: adicionar em `Lancamentos` as colunas `Status`, `Solicitado por`,
  `Aprovado por`, `Data solicitação`, `Data decisão` (após a coluna `_chave`, para
  não deslocar os índices `L.*` do `Code.gs`).
- Criar a aba **`Acessos`** (E-mail | Filial | Perfil) para ligar a fase 2.
- Opcional: aba **`Lojas`** (Filial | Razão Social | CNPJ | Cidade) para o aviso.
- Opcional: coluna **I (CTPS)** na aba `Func`.
Sem migrations formais — as abas/colunas são editadas manualmente na planilha; o
`Code.gs` trata a ausência delas.

## Testes
- **Não há testes automatizados.**
- Verificação foi **manual**, durante o desenvolvimento, via:
  - Preview local (`serve.ps1` → `http://localhost:8765`) com `MOCK_DATA`;
  - Inspeção do DOM no navegador (contagem de linhas, botões, filtros, abertura de modais);
  - Geração de PDF de prova pela build da planilha (fluxo separado, não faz parte do app).
- **Não executados / não confirmados:** qualquer teste com a planilha real via
  `google.script.run`; login real de RH/Gerente; embed no Google Sites; download do
  PDF a partir do dashboard publicado.

## Próxima tarefa recomendada
**Colocar a Fase 2 em produção e validar** (antes de escrever a Fase 3):
1. No Apps Script: adicionar o arquivo `Home` (HTML), colar `Code.gs` e `Dashboard.html`
   atuais, criar **nova versão** de implantação com "Executar como: Eu" e
   "Acesso: qualquer pessoa da [organização]".
2. Criar a aba `Acessos` na planilha com 1 linha de RH (e-mail | vazio | RH) e 1–2
   de Gerente (e-mail | filial | Gerente).
3. Abrir `.../exec` logado como RH e como Gerente; conferir que o Gerente só vê a
   filial dele e que os botões RH somem.
4. Só depois disso, iniciar a **Fase 3 (aprovação)**.

## Próximos passos (ordem de prioridade)
1. Deploy + aba `Acessos` + teste da Fase 2 (acima).
2. Reescrever o `README.md` para a arquitetura atual (instalação: planilha única,
   `MODEL_SHEET_ID`, arquivo `Home`, deploy, aba `Acessos`).
3. **Fase 3 — fluxo de aprovação** (coluna `Status`, fila "Aprovações",
   `aprovarFerias`, saldo aprovado x pendente, aviso só para aprovado, e-mails opcionais).
4. Cadastrar funcionário (`Func`) e lançar ajuste (`Ajustes`) pelo dashboard.
5. Trocar o logo pelo PNG oficial (`LOGO_DATA_URI`); preencher `Lojas` / `EMPRESA_PADRAO`
   com CNPJ correto por filial; opcional coluna CTPS em `Func`.
6. Página no Google Sites embutindo `.../exec` (iframe) + domínio próprio (opcional).
7. Limpeza: padronizar a coluna Matrícula como Texto nas abas; trocar a validação de
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

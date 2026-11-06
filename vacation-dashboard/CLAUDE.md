# CLAUDE.md — Dashboard de Férias (Líderfarma)

> Contexto para retomar o desenvolvimento em uma nova conversa.
> Última atualização: 2026-10-26 (fase 3 — fluxo de aprovação).

---

## Visão geral do projeto

**Objetivo.** Centralizar o controle de férias dos funcionários de uma rede de
farmácias (Líderfarma). O RH acompanha saldos, agendamentos, vencimentos e
conflitos; cada gerente (fase 2) enxerga apenas a própria filial. O sistema
calcula um **"banco de dias"** por funcionário e gera o **Aviso de Férias em PDF**.

**Usuários.**
- **RH** — acesso total, todas as filiais, todas as ações.
- **Gerente de filial** — só a(s) filial(is) dele; pode marcar férias, ver fichas
  e gerar avisos; NÃO edita datas, não apaga, não inclui período aquisitivo.
- **Fase 3 (fluxo de aprovação)**: o gerente SOLICITA férias (ficam "Pendente"); o RH
  aprova ou recusa (com motivo) na aba "Aprovações". Férias lançadas pelo RH já
  entram aprovadas.

**Principais funcionalidades já implementadas.**
- Página inicial (`Home.html`) com logo, resumo e botão para o painel.
- Painel (`Dashboard.html`) com 7 visões: Tabela, Funcionários, Calendário
  (mensal/semestral/anual), Pagamentos do Mês, Relatório Mensal, Vencimento Mensal,
  Aprovações (fase 3).
- Saldo de férias por funcionário (banco de dias).
- Ficha individual (modal): identificação, quebra do saldo, períodos aquisitivos,
  histórico de gozo/abono, observações/ajustes.
- Incluir / editar / apagar período de férias pelo painel.
- Incluir / editar / excluir período aquisitivo pelo painel (na ficha, só RH).
- Cadastrar funcionário novo pelo painel (aba Funcionários, só RH).
- Ativar / inativar funcionário (desligamento) pela ficha, só RH — grava `Func.Situação`.
- Lançar / **editar** / **excluir** ajuste manual de saldo e observação/justificativa
  pela ficha, só RH (aba `Ajustes`).
- Definir o vencimento das férias (mês/ano) pela ficha, só RH — para quem não tem
  período aquisitivo (aba `Func`, coluna J).
- Aviso de Férias em PDF (download).
- Filtro por filial, status, mês, busca por nome; filtro Registrado/Sem registro
  na aba Funcionários.
- Detecção de conflitos (3+ pessoas da mesma filial com férias sobrepostas) — **desligada** (`ALERTA_CONFLITOS = false` no `Code.gs`, 2026-11-02) até o RH passar a regra de cada filial.
- Acesso por filial (fase 2) — implementado no código, ainda não testado em produção.
- Fluxo de aprovação (fase 3) — aba "Aprovações" (RH) / "Minhas solicitações" (gerente),
  status Pendente/Aprovado/Recusado na aba `Lancamentos`, e-mails opcionais
  (`NOTIFICAR_EMAIL`). Testado só no preview local.

---

## Stack tecnológica

| Camada | Tecnologia |
|---|---|
| **Backend** | Google Apps Script (V8) — arquivo `Code.gs` |
| **Frontend** | HTML + CSS + JavaScript puro (sem framework) — `Dashboard.html`, `Home.html` |
| **"Banco de dados"** | Uma planilha Google Sheets (abas como tabelas) |
| **Hospedagem** | Apps Script Web App (`doGet`) — gratuito, sem servidor |
| **Bibliotecas** | Nenhuma no runtime. Fontes Google (Nunito) só na `Home.html` |
| **APIs internas** | `google.script.run` (cliente → funções do `Code.gs`) |
| **Autenticação** | Login próprio (e-mail + senha) — `Login.html`, hash SHA-256 com salt na aba `Acessos` (col. D), sessão em `CacheService` (token de 6 h) |
| **Geração de PDF** | `Utilities.newBlob(html, 'text/html').getAs('application/pdf')` |
| **Preview local** | `serve.ps1` (servidor estático PowerShell, porta 8765) com dados MOCK |
| **Versionamento** | Git — repositório `Projects-Claude` (multi-projeto) no GitHub |

O arquivo `xlsx` de origem foi importado para o Google Sheets; **`MODEL_SHEET_ID`
no `Code.gs` aponta para essa planilha** (`1wLN9oZji-Uk6prHMcvav0CNg1u-tFMz_`).

---

## Arquitetura

```
Navegador do usuário
   │  (Google Sites embute o Web App em um iframe — opcional/planejado)
   ▼
doGet(e)  ──► sem parâmetro  → Home.html  (página inicial)
          └─► ?page=painel   → Dashboard.html
   │
   │  google.script.run.<função>()      (chamadas assíncronas cliente→servidor)
   ▼
Code.gs  ── _scopeAtual() decide RH / Gerente / sem acesso (pelo e-mail + aba Acessos)
   │        toda função de leitura/escrita respeita esse escopo NO SERVIDOR
   ▼
Google Sheets  (MODEL_SHEET_ID)
   abas: Func | Periodos | Lancamentos | Ajustes | Feriados | Lojas? | Acessos?
```

**Contrato de dados** — `getVacationData()` devolve um JSON com:
`data[]` (1 linha por lançamento + placeholder por funcionário registrado sem
lançamento), `employees[]` (cadastro), `conflicts[]`, `paymentDue[]`,
`paymentAll[]`, `totals{}`, `errors[]`, `scope{perfil,filiais,email}`.
O front guarda tudo em variáveis globais e re-renderiza cada visão.

**Fluxo Home → Painel dentro do Sites:** o botão da `Home.html` chama
`google.script.run.paginaPainel()` (que retorna o HTML do dashboard) e faz
`document.write` no lugar — **não navega a URL**, para não "escapar" do iframe do
Sites. Fora do Apps Script (preview local) ele navega para `?page=painel`.

---

## Regras de negócio

### Banco de dias (saldo por funcionário)
```
SALDO ATUAL = Saldo inicial (Func.G)
            + Σ dias de direito dos períodos aquisitivos JÁ CREDITADOS
            − Σ férias gozadas (Lancamentos, tipo "Gozo")
            − Σ abono pecuniário (Lancamentos, tipo "Abono")
            + Σ ajustes manuais (Ajustes, coluna Dias, com sinal)
```
- **"Creditado"** é calculado pela data: o período está creditado quando
  `Fim aquisitivo <= hoje` (não lê a coluna "Creditado" da planilha).
- Se a célula "Dias de direito" não for número, cai para a faixa de faltas.

### Período aquisitivo (ciclo de 12 meses a partir da admissão)
- Dias de direito por faltas injustificadas (CLT art. 130):
  `≤5→30 · 6–14→24 · 15–23→18 · 24–32→12 · >32→0`.
- Fim aquisitivo = início + 12 meses − 1 dia. Concessão até = fim + 12 meses.
- Situação do prazo: `Em formação` (fim no futuro) · `Vencido — risco de dobro`
  (hoje > concessão) · `Vence em N d` (≤90) · `Em dia — vence em N d` (>90).

### Férias gozadas
- Dias corridos = término − início + 1.
- Retorno = término + 1; **Retorno útil** = próximo dia útil (sábado conta como
  dia trabalhado; só pula domingo e a aba `Feriados`).
- `addVacationRecord` grava **valores** (nunca fórmulas) — planilha em pt-BR
  rejeita fórmula com vírgula e vira `#ERROR!`.

### "Dias vencidos — risco de dobro" (aproximação FIFO)
```
max(0,  Σ direito dos períodos com concessão já vencida
      − Σ férias gozadas
      − (deduções de ajuste, se houver))
```

### Funcionário sem registro (Registrado = "Não")
- Aparece na aba Funcionários e em "Pagamentos do Mês".
- Não tem período aquisitivo; saldo = saldo inicial + ajustes.
- Mês de vencimento (Pagamentos) = mês de aniversário da admissão;
  "pagar 30 dias" = saldo ≥ 30. (Regra provisória — confirmar com o RH.)

### Aviso de Férias (PDF)
- Empresa (Razão Social / CNPJ / Cidade): aba `Lojas` por filial (tem prioridade)
  ou a constante `EMPRESA_PADRAO` no `Code.gs`.
- Período aquisitivo do aviso: linha da aba `Periodos` correspondente; se não
  houver, é **calculado** a partir da admissão (`_periodoAquisitivo`).
- CTPS: coluna I da aba `Func` se preenchida; senão um número de 7 dígitos
  **determinístico** por funcionário (`_ctpsFake`) — placeholder, trocar pelo real.
- Nº Registro e R/H = matrícula. Nº do documento sai como `______ / <matrícula>`.

### Login e acesso
- **Toda URL abre `Login.html`** (`doGet`). Depois de entrar, o Login carrega no lugar
  (`document.write`) a Home ou o painel (`?page=painel`). Não usa mais
  `Session.getActiveUser` — o e-mail vem da sessão.
- **Só 4 funções são públicas**: `doGet`, `login`, `paginaLogin`, `api`. Todas as outras
  terminam em `_` (o Apps Script não deixa o navegador chamá-las). O navegador chama
  `api(token, "nomeDaFuncao", [args])`, que confere o token (`_lerSessao_`), preenche
  `_SESSAO` e despacha pela tabela `API`. Sessão inválida → erro `SESSAO_EXPIRADA` →
  front volta ao login. **Função nova chamada pelo front = acrescentar na tabela `API`.**
- Front: `gsRun()` (Dashboard) / `chamar()` (Home) imitam `google.script.run` e injetam
  o token (`localStorage.ferias_token`, com fallback `window.__FERIAS_TOKEN`).
- Aba `Acessos`: E-mail · Filial · Perfil · **Senha**. Senha = `h1$salt$hex` (SHA-256
  iterado 100x). O RH pode digitar uma **senha provisória em texto** — no 1º login vira
  hash. Trocar senha: link na Home (`trocarSenha`, mín. 8 caracteres).
- `_ensureAcessos_` cria a aba / cabeçalho e inclui `USUARIO_INICIAL` (rfolivo@gmail.com,
  RH) **uma única vez** (Script Property `SEED_ACESSOS`).
- 5 senhas erradas → e-mail bloqueado 15 min. Sessão expira após 6 h sem uso.
- **Perfis (coluna C)**: `RH` (todas as filiais, tudo) · `Gerente` (só as filiais das linhas
  dele, só solicita) · **`Gerente Matriz`** (como Gerente — mesmas travas de editar/apagar —
  mas **aprova/recusa** férias das filiais das linhas marcadas como Gerente Matriz, e o que
  ele lança nelas já entra Aprovado). No servidor o Matriz é `perfil: "gerente"` +
  `scope.aprova = [filiais]` (`_perfilAcesso_`, `_podeAprovar_`); assim todas as checagens
  `perfil === "gerente"` continuam bloqueando edição. Pedido novo notifica RH + Matriz da
  filial (`_emailsAprovadores_`). Preview: `?perfil=matriz&filial=Filial 05,Filial 06`.
- E-mail sem linha na aba `Acessos` → **sem acesso** (`perfil: "nenhum"`); se a linha for
  removida, a sessão cai na próxima chamada.
- `RH` = filiais `null` (todas). `Gerente` = lista de filiais das linhas dele.
- Filtro por filial é aplicado **no servidor** (nunca confiar no navegador).

### Fluxo de aprovação (fase 3)
- `addVacationRecord`: perfil **Gerente** grava `Status = Pendente`; **RH** grava `Aprovado`
  (com Decidido por/em = ele mesmo — não passa pela fila).
- **Status vazio = Aprovado** (linhas anteriores à fase 3 continuam valendo).
- **Só Aprovado desconta do saldo**, conta em "Em férias agora"/"Pagas este mês" e libera
  o Aviso em PDF. Pendente aparece na Tabela/Calendário (listrado amarelo) e no saldo
  como "solicitado, aguardando" (`pendingDays` / `saldo.pendente`), mas não desconta.
  **Recusado** some de `data[]` (Tabela, calendário, conflitos) e fica só na ficha e
  na aba Aprovações, com o motivo.
- Conflitos (`detectConflicts`) consideram pendentes + aprovadas.
- Não deixa lançar férias sobrepostas a outra (pendente ou aprovada) da mesma pessoa.
- Gerente pode **cancelar** (apagar) uma solicitação **ainda Pendente** da filial dele;
  aprovada/recusada só o RH apaga.
- Recusar exige motivo. Decisão só sobre linha Pendente (confere matrícula + início).
- E-mails (`_notificar`) só se `NOTIFICAR_EMAIL = true`: pedido → e-mails RH da aba
  `Acessos`; decisão → e-mail de quem pediu. Falha de e-mail nunca derruba a operação.

---

## Estrutura do projeto

Repositório: `Projects-Claude` (contém vários projetos). Este projeto vive em
`vacation-dashboard/`.

```
vacation-dashboard/
├── Code.gs          Backend Apps Script (~1690 linhas). TODA a lógica de negócio.
├── Dashboard.html   Painel (~4090 linhas): HTML + CSS + JS. 7 visões + modais.
├── Login.html       Tela de login (e-mail + senha) — abre antes de tudo.
├── Home.html        Página inicial (170 linhas): logo, resumo, botão. Sair / Trocar senha.
├── serve.ps1        Servidor estático local (porta 8765) p/ preview com MOCK.
├── README.md        ⚠️ DESATUALIZADO — descreve a arquitetura ANTIGA (28 planilhas).
├── CLAUDE.md        Este arquivo.
└── PROJECT_STATUS.md Estado atual / roadmap.
```

### `Code.gs` — mapa das funções

> Desde o login (2026-10-26) **todas** as funções abaixo têm `_` no fim no código
> (ex.: `getVacationData_`) — só são chamáveis pela `api()`. Públicas: `doGet`, `login`,
> `paginaLogin`, `api`. Novas: `paginaHome_`, `sessaoAtual_`, `logout_`, `trocarSenha_`,
> `_hashSenha_`, `_conferirSenha_`, `_lerSessao_`, `_apagarSessao_`, `_ensureAcessos_`.

| Função | Papel |
|---|---|
| `doGet(e)` | roteador: `?page=painel` → Dashboard, senão → Home |
| `paginaPainel()` | devolve o HTML do Dashboard (abertura "no lugar" pela Home) |
| `_scopeAtual()` | RH / Gerente / nenhum, pelo e-mail + aba Acessos |
| `_noEscopo(scope, filial)` | filial permitida para o escopo? |
| `getResumoHome()` | números da página inicial |
| `getVacationData()` | **principal** — consolida tudo, filtra por escopo, devolve JSON |
| `getEmployeeFicha(matricula)` | dados completos de 1 funcionário (ficha) |
| `getAvisoFeriasPdf(matricula, gozoInicioISO)` | gera o PDF, devolve base64 |
| `addVacationRecord(payload)` | grava férias na aba Lancamentos (Gerente → Pendente, RH → Aprovado); recusa sobreposição com outras férias da pessoa |
| `updateVacationRecord(payload)` | edita início/término (só RH) |
| `deleteVacationRecord(payload)` | apaga a linha (RH; gerente só cancela pedido Pendente da filial dele) |
| `getAprovacoes(dias)` | fase 3 — pendentes + decididas nos últimos `dias` (90), com saldo, dias pendentes e quem mais da filial estará fora; escopo por filial |
| `decidirFerias(payload)` | fase 3 — `{rowIndex, matricula, inicio, decisao:'aprovar'\|'recusar', motivo}`; só RH, só linha Pendente |
| `_statusLanc(r)` / `_ensureLancCols(sh)` / `_notificar` / `_emailsRH` | helpers da fase 3 (status normalizado; cria colunas M..R com cabeçalho; e-mail opcional) |
| `addPeriodoAquisitivo(payload)` | grava período na aba Periodos (só RH) |
| `updatePeriodoAquisitivo(payload)` / `deletePeriodoAquisitivo(payload)` | edita / apaga uma linha da aba Periodos pelo `rowIndex` (confere a matrícula, recalcula fim/concessão/direito/situação) — só RH. `getEmployeeFicha` devolve `rowIndex` e `faltas` em cada período |
| `addEmployee(payload)` | cadastra funcionário na aba Func (só RH); matrícula sugerida/editável; se registrado, cria o 1º período aquisitivo |
| `updateEmployee(payload)` | edita Nome/Filial/Cargo/Admissão/Saldo inicial/Registrado/CTPS na aba Func (só RH). Matrícula não muda. Admissão nova **não** recalcula períodos já cadastrados. Front: botão "✏ Editar" na ficha (mesmo modal do cadastro, `empEditMat`) |
| `updateLancamentoPeriodo(payload)` | troca a coluna Período de um lançamento (`{rowIndex, matricula, inicio, periodo}`) — só RH; ✏ no histórico da ficha. Não mexe no saldo, só no Aviso PDF |
| `_periodosDe_(mat)` | períodos de uma matrícula `[{label, raw, ini, fim}]`. `getVacationData.employees[].periodos` usa isso p/ o select do "Incluir Férias". **Período automático do `addVacationRecord`** = último período já completo antes do início das férias (antes: sempre o mais recente); `payload.periodo` força um período |
| `setEmployeeStatus(payload)` | grava `Func.Situação` = Ativo/Inativo (desligamento) — só RH. `getVacationData`/`getEmployeeFicha` devolvem `ativo` |
| `addAjuste(payload)` | grava linha na aba `Ajustes` (Data · Dias ± · Observação) — só RH. Dias vazio/0 = só observação (não mexe no saldo) |
| `updateAjuste(payload)` / `deleteAjuste(payload)` | edita / apaga uma linha da aba `Ajustes` pelo `rowIndex` (confere a matrícula) — só RH. `getEmployeeFicha` devolve `rowIndex` em cada ajuste |
| `importarLote(texto, simular)` | Importação em lote (só RH; botão "⇪ Importar em lote" na aba Funcionários). Texto: `@ Nome ou matrícula` · `P dd/mm/aaaa [faltas]` (período) · `A dd/mm/aaaa ±dias obs` (ajuste) · `F dd/mm/aaaa dd/mm/aaaa` (férias) · `= saldo esperado` · `#` comentário. `simular=true` só confere e projeta o saldo. Grava por `addPeriodoAquisitivo_`/`addAjuste_`/`addVacationRecord_` (mesmas regras); período/férias/ajuste idênticos já existentes são pulados (rodar de novo não duplica). Helpers `_parseLote_`, `_dataLote_`, `_acharFuncLote_` (nome sem acento/maiúscula; se só um cadastro contiver todas as palavras, usa e avisa) |
| `addAtestado(payload)` / `deleteAtestado(payload)` | **Atestados** (2026-11-04): aba `Atestados` (criada sozinha; Matrícula · Nome · Filial · Início · Fim · Dias · Observação · Registrado por · em). `{name, branch, startDate, endDate}` — **só RH** (botão rh-only + checagem no servidor), sem aprovação; recusa sobreposição com outro atestado da pessoa. Excluir só RH (`{rowIndex, matricula, startDate}`). **NÃO desconta do banco de dias** — `getVacationData.atestados[]` (filtrado por escopo) só alimenta o Relatório Mensal (selo roxo "Atestado", 🩺). Front: botão "+ Incluir Atestado" reaproveita o modal de férias (`openAddModal('atestado')`, `modalModo`) |
| `setEmployeeVencimento(payload)` | grava o vencimento das férias (mês/ano) na coluna J da aba `Func` — só RH. Só é usado quando **não** há período aquisitivo (concessão calculada tem prioridade) |
| `getPaymentData(func, saldoOf)` | funcionários sem registro (aba Func + planilha legada opcional) |
| `detectConflicts(data)` | 3+ sobreposições na mesma filial |
| `_avisoHtml(d)` / `_dataExtenso` / `_periodoAquisitivo` / `_ctpsFake` | helpers do aviso |
| `_mk(v)` | **normaliza matrícula** (número/texto/zeros à esquerda → mesma chave) |
| `_diasDireito` / `_periodoSituacao` / `_addWorkingDays` / `_feriadosSet` | regras |
| `_sheet` / `_rows` / `toDate` / `formatDate` / `formatDateBR` / `_midnight` / `_plusDays` / `_addMonths` | utilidades |

### `Dashboard.html` — variáveis globais de estado

`allData`, `filteredData`, `allEmployees`, `conflicts`, `paymentAll`, `paymentDue`,
`totals`, `scope`, `selectedBranches`, `empFiltroReg`, `empFiltroStatus`
(`ativos`/`inativos`/`todos`), `fichaMat` / `fichaNome` / `fichaData`,
`calYear` / `calMonth` / `calView`, `sortCol` / `sortDir`.
Visão Tabela: `tableBranch` (null = grade de cards de filial; string = tabela da
filial), `expandedGroups` (grupos de funcionário abertos), `tableGroups`.
`ehRH()` = `scope.perfil !== 'gerente'`. Registros/funcionários trazem `ativo`
(false = "Inativo"/desligado): some da lista de "Incluir Férias" e ganha selo.

### Abas da planilha (colunas base-0 no `Code.gs`)

- **Func**: Matrícula · Nome · Filial · Cargo · Admissão · Situação · Saldo inicial
  de férias · Registrado · CTPS (I, opcional) · Vencimento das férias
  (J, opcional — mês/ano manual, só vale sem período aquisitivo)
- **Periodos**: Matrícula · Período · Início aquisitivo · Fim aquisitivo · Faltas ·
  Dias de direito · Concessão até · Creditado ao banco · Situação do prazo ·
  _seq · _chave
- **Lancamentos**: Matrícula · Período · Parcela nº · Início · Término · Dias ·
  Tipo (Gozo/Abono) · Retorno · Retorno (dia útil) · Observação · _seq · _chave ·
  **Status · Solicitado por · Solicitado em · Decidido por · Decidido em · Motivo**
  (M..R, fase 3 — criadas automaticamente por `_ensureLancCols` na 1ª gravação)
- **Ajustes**: Matrícula · Data · Dias (+/−) · Observação · _seq · _chave
- **Feriados**: Data · Descrição
- **Lojas** (opcional): Filial · Razão Social · CNPJ · Cidade
- **Acessos** (opcional): E-mail · Filial · Perfil (RH | Gerente)
- **Ficha** (aba da planilha, não usada pelo dashboard — visão de impressão)
- **Instrucoes** (aba de ajuda dentro da planilha)

Colunas `_seq` / `_chave` (cinza) ligam as abas e **não devem ser apagadas**.

---

## Convenções de desenvolvimento

- **Backend em `Code.gs`, front em `Dashboard.html`/`Home.html`.** Nada de framework.
- **Toda regra de negócio fica no servidor.** O front só renderiza.
- **Escrever VALORES na planilha, nunca fórmulas** (locale pt-BR → `#ERROR!` com vírgula).
- **Matrícula sempre pela `_mk()`** ao comparar/indexar (número vs texto vs "0004").
- **Escopo (`_scopeAtual`) é verificado no servidor em toda função sensível.**
  O front esconde botões (`ehRH()`), mas isso é só UX.
- Datas ISO `yyyy-mm-dd` entre servidor↔cliente; `dd/mm/yyyy` na tela; formato de
  número de data na planilha = `dd/mm/aaaa` (não `dd/mm/yyyy` — no Sheets pt-BR o
  token de ano é `a`).
- **Nunca `new Date("yyyy-mm-dd")` nem `.toISOString()` para datas de calendário**
  no `Code.gs` (roda em fuso −03): string ISO só com data é parseada como UTC e
  "escorrega" 1 dia. Use `toDate()` (tem ramo `yyyy-mm-dd` → meia-noite local) e
  `formatDate()` (monta pelos componentes locais). Foi o que fazia o "Retorno ao
  trabalho" sair +1 dia; mesmo motivo do fix em `setEmployeeVencimento`.
- `google.script.run` retorna **string JSON**; o front dá `JSON.parse` com try/catch.
- Preview local: `powershell -ExecutionPolicy Bypass -File vacation-dashboard/serve.ps1`
  → `http://localhost:8765/Home.html` ou `/Dashboard.html`. Usa `MOCK_DATA`
  (sem Apps Script). `Code.gs` **não roda localmente**. Simular gerente:
  `/Dashboard.html?perfil=gerente&filial=Filial%2005`. No mock, Diego Carvalho e
  Priscila Torres vêm como pedidos Pendentes.
- Checar sintaxe do `Code.gs` sem Node: com o preview aberto,
  `new Function(await (await fetch('/Code.gs')).text())` no console do navegador.
- Toda alteração de `Code.gs` / `Dashboard.html` / `Home.html` exige **novo deploy**
  no Apps Script (colar o arquivo → Implantar → Gerenciar implantações → Nova versão).
- **`Home.html` é um arquivo HTML separado no projeto Apps Script, com o nome `Home`.**

---

## Cuidados (não alterar sem análise)

- **Funções do `Code.gs` chamadas pelo navegador NÃO podem ficar públicas** (sem `_` no
  fim) — passam pela `api()`. Uma função pública nova fura o login.
- **Script do `Dashboard.html` usa `var`/`function` no topo, não `let`/`const`**: a página
  é reescrita por `document.write` (sair → entrar de novo) e `let`/`const` no topo dão
  "already declared" e o painel não carrega. `Login.html`/`Home.html` ficam dentro de IIFE.

- **Não voltar para o modelo antigo** de varrer 27/28 planilhas de filial — foi
  substituído de propósito pelo modelo de planilha única.
- **Não trocar `setValues` por `setFormula`** em `addVacationRecord` /
  `updateVacationRecord` / `addPeriodoAquisitivo` — quebra em planilha pt-BR (`#ERROR!`).
- **Não remover a normalização `_mk()`** — os dados da planilha têm matrícula
  inconsistente (número, texto, com/sem zero à esquerda).
- **Não confiar no filtro de filial do front** — a segurança está no `_scopeAtual`
  do servidor. Manter os `_noEscopo(...)` nas funções.
- **Não apagar as colunas `_seq` / `_chave`** das abas da planilha.
- **Colunas novas em `Lancamentos` vão DEPOIS de R (Motivo)** — os índices `L.*` são fixos.
- **Somar dias de `Lancamentos` sempre filtrando por `_statusLanc`** (só Aprovado
  desconta) — vale para qualquer cálculo novo de saldo.
- **Contrato JSON do `getVacationData`** (nomes dos campos) — o `Dashboard.html`
  inteiro depende deles.
- **`setXFrameOptionsMode(ALLOWALL)`** nos dois ramos do `doGet` — necessário para
  embutir no Google Sites.
- **Manter as duas cópias em sincronia**: `Área de Trabalho/Claude/vacation-dashboard/`
  (pasta de trabalho, **não** é repo git) e
  `Projects-Claude/vacation-dashboard/` (versionada). Commitar sempre a segunda.

---

## Decisões técnicas

| Decisão | Motivo |
|---|---|
| Apps Script + Google Sheets | Custo zero, sem servidor, RH já vive no Google. |
| Planilha única (Func/Periodos/Lancamentos/Ajustes) em vez de 27 planilhas | Muito mais simples de manter; saldo calculado num lugar só. |
| "Banco de dias" (saldo corrente único) em vez de saldo por período | É como o RH pensa: um pote que sobe no aniversário e desce no gozo. |
| "Creditado" calculado pela data no servidor, não lido da coluna | Linhas gravadas pelo dashboard são valores estáticos; a coluna não "vira" sozinha no aniversário. |
| Escrever valores, não fórmulas, ao inserir linhas | `setFormula` com vírgula quebra na planilha pt-BR (`#ERROR!`). |
| `_mk()` normaliza matrícula | Dados reais têm `0004`, `4`, `"0004"` misturados. |
| PDF via `Utilities.newBlob(...).getAs('application/pdf')` | Único jeito nativo de HTML→PDF no Apps Script, sem libs. |
| Roteador no `doGet` (`?page=painel`) + `paginaPainel()` | Uma implantação serve Home e Painel; abre "no lugar" dentro do Sites. |
| Acesso por e-mail + aba `Acessos` (sem senha) | Aproveita o login Google Workspace; nada de senha para gerenciar. |
| Sem aba `Acessos` → todo mundo é RH | Permite implantar já e ligar o controle depois (migração suave). |
| Perfil Gerente só marca férias (não edita/apaga/inclui período) | Abre espaço para o fluxo de aprovação (fase 3). |
| Logo oficial embutido em base64 (`logo-liderfarma.png`) na Home e no Login | Apps Script não serve arquivos de imagem soltos; o data URI vai dentro do HTML. |

---

## Módulo Folha de Pagamento (2026-11-04)

Módulo **isolado** dentro deste projeto (pode virar projeto próprio depois). Plano e decisões:
`Área de Trabalho/Claude/folha-de-pagamento/PLANO.md`.

- Arquivos: `FolhaPagamento.gs` (servidor, `FOLHA_API`) e `Folha.html` (tela). No Apps Script: criar
  o script **FolhaPagamento** e o HTML **Folha**. Única ligação com o resto: `api()` também procura
  em `FOLHA_API`, e o botão **💼 Folha** (rh-only) no header do Dashboard (`abrirFolha()` → `paginaFolha`).
- Planilha própria `FOLHA_SHEET_ID` (Google Sheets **sem compartilhamento**); abas Funcionarios, Filiais,
  Rubricas, Lancamentos (formato rubricas: 1 linha por item do recibo), Importacoes, AcessosFolha.
- Segurança: perfil RH + **segunda senha** (hash, Script Properties `FOLHA_CRED_<email>`) + **TOTP**
  (Google Authenticator, RFC 6238, testado com os vetores da RFC) + sessão da folha de 15 min
  (`folha_<token>` no CacheService) + bloqueio 5 erros/30 min + log em AcessosFolha.
  Toda função de dados recebe o `folhaToken` e chama `_folhaSessao_` (erro `FOLHA_BLOQUEADA`).
  Reset de acesso: apagar a propriedade `FOLHA_CRED_<email>` no editor.
- Preview: `/Folha.html` com servidor de mentira (senha 10+ caracteres, código `123456`).
- **Editar recibo** (2026-11-04): botão ✏ Editar em cada cartão (um por vez) → descrição/valor por linha, + provento/desconto/observação, ↑↓, ✕, totais ao vivo. `folhaSalvarRecibo_(ft, mes, id, linhas, antes)` reescreve as linhas (mês, ID) da aba Lancamentos (reaproveita as linhas da planilha, acrescenta/apaga o que sobrar); `antes` = `_folhaDigital_` das linhas carregadas — se a planilha mudou no meio, recusa. Linha nova = rubrica `MANUAL`; as existentes mantêm a rubrica (a PREMIACAO continua sendo achada pela importação). Registra em AcessosFolha.
- **Abrir novo mês** (`folhaAbrirMes_(ft, novo)`, botão 📅): cria o mês seguinte ao último copiando o último mês anterior, só funcionários ativos; rubrica com "Recorrente = Sim" (aba Rubricas, col. D) repete o valor, as outras vêm em branco; FERIAS_OBS não copia, OBS copia; ativo sem recibo anterior ganha Salário/Premiação/INSS em branco. Recusa mês que já existe. Coluna Mês gravada como texto (`@`).
- **Novo funcionário** (`folhaNovoFuncionario_(ft, mes, d)`, botão + Novo funcionário): próximo ID `F###`, recusa nome igual a um ativo, grava em Funcionarios (Origem = "Cadastrado no painel …") e cria o recibo no mês aberto (Salário com valor, Premiação e INSS em branco). Desligar = Ativo "Não" na planilha (ainda sem botão).
- **Regras por funcionário** (botão 📋, aba `Regras` da planilha da folha: ID · Nome · Tipo · Rubrica · Descrição no recibo · Valor base · Proporcional · Exige sem falta/atestado · Obs). Tipos: **Fixo** (a linha casada por rubrica+descrição, senão 1ª da rubrica, recebe o valor; proporcional = base × dias trabalhados ÷ 30, centavos cortados — `_folhaProp_`); **Piso premiação** (usado só no ⬆ Importar comissões: premiação = maior entre comissão sem centavos e piso proporcional; a linha pode ser outra rubrica, ex. GRATIFICACAO "Gratificação/Premiação" — `_folhaAlvosPremiacao_`; coluna J de Funcionarios vira piso proporcional na PREMIACAO se não houver regra); **Bônus manipulação** (só se a venda geral da manipulação digitada no fechamento passar do limite, Script Property `FOLHA_BONUS_LIMITE`, padrão 200.000; "sem falta" perde com atestado no mês ou falta marcada na prévia; abaixo do limite a linha sai). Regra geral: GRATIFICACAO sem regra e com "(n,nn)" na descrição também fica proporcional. Dias fora = férias de gozo (não recusadas) + atestados do painel de férias dentro do mês (`_folhaAusencias_`, ligação por `_folhaLigarFerias_`). Aplicar: `folhaRegrasPrevia_` / `folhaRegrasAplicar_(ft, mes, manip, semDireito[])` reescrevem a aba Lancamentos inteira de uma vez (mês como texto). Editor salva tudo com `folhaRegrasSalvar_(ft, regras, antes, limite)` (recusa se a aba mudou). "📋 Colar lista" aceita TSV nas colunas da aba (quem vem na lista tem as regras substituídas). A lista inicial com nomes reais fica em `folha-de-pagamento/regras-iniciais.txt` (fora do git).
- **13º salário** (botão 🎄 Gerar 13º, `folha13Previa_(ft, ano, ajuste)` / `folha13Gravar_(ft, ano, ajuste{id:avos}, excluir[], substituir)`): parcela única em dezembro, gravada na aba Lancamentos como o "mês" `aaaa-13` (lista/✏ Editar/totais/impressão funcionam igual; `_folhaEh13_`). Valor = cada linha SALARIO do último mês do ano (dezembro) + regras **Entra no 13º** (valor base, ou o da linha se base 0) × avos ÷ 12, centavos cortados (`_folha13Plano_`, função pura). Avos pela admissão (painel de férias via `_folhaLigarFerias_`; senão "Início" da folha; sem nenhuma = 12 com aviso): mês da admissão conta se entrou até o dia 15; faltas não tiram avos; só ativos (desligado recebe na rescisão). INSS/IR saem em branco (só para quem tem INSS/IRRF no recibo-base) — vêm da contabilidade. Prévia deixa trocar os meses (auxílio-doença: empresa paga só os meses trabalhados; licença-maternidade não desconta) e avisa atestado > 15 dias no ano. "Abrir novo mês" ignora o `-13` como origem; importar comissões e aplicar regras recusam o 13º. Regra Entra no 13º acha a linha pela descrição igual → mesmo começo da descrição (antes do "(") → só a rubrica.
- **INSS/IR da contabilidade** (botão ⬇ INSS/IR da contabilidade, `folhaContabPrevia_(ft, mes, lista)` / `folhaContabGravar_(ft, mes, itens[{id,inss,ir,adm}], vinculos[{id,nome}], arquivos, adm)`): o navegador lê os PDFs "Recibo de Pagamento" do Domínio (1 por empresa; `pdfObjetos` → `pdfPaginas` → `dominioRecibo`: Flate + fontes Type0 com ToUnicode, 1 letra por Tm/Tj; usa a última via da página; provento/desconto pela posição x entre as colunas Vencimentos e Descontos; arquivo/recibo repetido conta uma vez) e manda só `{nome, empresa, adm, inss, ir}`. Regra (`ctImpostos`): mês normal = INSS (I.N.S.S., diferença de férias, INSS empregador/pró-labore) e IRRF **sem** os de férias e de 13º; no `-13` entram todos. Pessoa em duas empresas = soma. Casa nomes com `_folhaCasar_` (vínculos manuais na coluna K "Nome na contabilidade" de Funcionarios). Grava na 1ª linha D INSS / D IRRF do recibo do mês (as outras zeram; cria "(-) INSS"/"(-) IR" — no 13º "(-) INSS 13º"/"(-) IR 13º" — se faltar) e pode preencher o "Início" de quem está sem (data de admissão do recibo; usada no 13º). Avisa competência/tipo de folha diferente do mês aberto. **Consignado** (2026-11-06): evento "DESC. EMP. CRED. TRAB" (ou CONSIGN…) vira a linha D `CONSIGNADO` "(-) Consignado (crédito do trabalhador)" — mesma regra de gravação (1ª linha recebe, outras zeram, cria se faltar). Pró-labore da Elaine e do Ricardo fica 0 no painel de propósito (decisão do usuário). Conferido com outubro/2026: INSS igual ao do painel em 64 de 66 (os 2 diferentes = pró-labore zerado no painel).

# Dashboard de Férias — Google Apps Script

Painel centralizado de férias para 28 filiais, preenchido pelos gerentes no Google Sheets
e visualizado pelo RH via URL pública (sem custo de hospedagem).

---

## Como funciona

```
Gerente de filial  →  Preenche a planilha Google Sheets
                             ↓
                     Google Apps Script lê todas as 28 planilhas
                             ↓
                      Dashboard web (URL pública)  →  RH visualiza
```

---

## Pré-requisitos

- Conta Google (a mesma que é dono das planilhas de filiais)
- Acesso ao [Google Apps Script](https://script.google.com)

---

## Passo a passo — Deploy em ~5 minutos

### 1. Crie o projeto no Apps Script

1. Acesse [script.google.com](https://script.google.com)
2. Clique em **"Novo projeto"**
3. Renomeie o projeto para `Dashboard Férias RH`

### 2. Cole os arquivos

**Arquivo `Code.gs`** (já existe por padrão, substitua o conteúdo):
- Copie todo o conteúdo de `Code.gs` deste repositório e cole no editor

**Arquivo `Dashboard.html`** (crie novo arquivo HTML):
- Clique em **"+"** → **"HTML"** → nomeie como `Dashboard`
- Copie todo o conteúdo de `Dashboard.html` e cole

### 3. Configure as 28 filiais

No `Code.gs`, edite o objeto `BRANCHES` adicionando todas as filiais:

```javascript
const BRANCHES = {
  'Filial 01': '10YBsWrKGOPWTn_Zcph2K1bJZmsI68cEbPxwNizVIdKg',
  'Filial 02': '1qMt8Iwe1Iotjr1fBtlhxF-q4KptkoPEN1q9urOX4Sqg',
  'Filial 03': 'ID_DA_PLANILHA_03',
  // ... adicione todas as 28 filiais
};
```

> **Como encontrar o ID da planilha:**
> Abra a planilha → copie o trecho entre `/d/` e `/edit` na URL.
> `https://docs.google.com/spreadsheets/d/**[ID_AQUI]**/edit`

### 4. Deploy como Web App

1. Clique em **"Implantar"** → **"Nova implantação"**
2. Tipo: **"Aplicativo da Web"**
3. Configurações:
   - **Executar como:** `Eu (seu email)`
   - **Quem tem acesso:** `Qualquer pessoa na organização` (ou `Qualquer pessoa` para acesso público)
4. Clique em **"Implantar"**
5. Copie a **URL gerada** — este é o link do dashboard para o RH

### 5. Autorize as permissões

Na primeira execução o Google pedirá permissão para acessar as planilhas.
Clique em "Avançado" → "Acessar [projeto]" → "Permitir".

---

## Estrutura das planilhas de filiais

Cada planilha de filial deve ter **exatamente estas colunas** (na ordem):

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| Nome | Período Inicial | Período Final | Retorno | Total | Dias Disponíveis | Vencimento |

- **Linha 1:** cabeçalho (ignorado)
- **Linha 2 em diante:** um funcionário por linha
- Datas no formato `DD/MM/AAAA` ou qualquer formato que o Sheets reconheça como data
- **Dias Disponíveis (F):** número de dias de férias que o funcionário ainda tem
  a receber/tirar. Preenchido manualmente pelo gerente — não é calculado pelo
  script.
- **Vencimento (G):** data (qualquer dia do mês) indicando o mês/ano em que o
  período aquisitivo de férias do funcionário vence. O dashboard exibe apenas
  mês/ano (ex: "Agosto/2026").

> **Configuração inicial das colunas F e G:** no editor do Apps Script, selecione
> a função `setupHeaderColumns` no menu suspenso ao lado de "Executar" e clique
> em **Executar**. Isso adiciona os cabeçalhos "Dias Disponíveis" e "Vencimento"
> em todas as planilhas de filiais automaticamente (não sobrescreve cabeçalhos
> já preenchidos). Depois, cada gerente preenche os valores manualmente.

---

## Funcionalidades do Dashboard

| Recurso | Descrição |
|---------|-----------|
| Cards de resumo | Total de registros, em férias agora, retornando em 7 dias, conflitos, férias futuras, filiais ativas |
| Alertas de conflito | Detecta automaticamente quando 3+ funcionários da mesma filial têm férias sobrepostas |
| Tabela consolidada | Todos os funcionários de todas as filiais em uma tabela ordenável |
| Calendário | Visualização em linha do tempo por mês com navegação |
| Filtros | Por filial, status (em férias / agendado / concluído), mês de início, nome |
| Botão Atualizar | Relê todas as planilhas em tempo real |
| Relatório Mensal | Seleciona um mês e lista todos os funcionários com férias sobrepondo aquele mês, agrupados por filial, com período e total de dias. Tem botão de impressão dedicado. |
| Vencimento Mensal | Seleciona um mês e lista os funcionários cujo período aquisitivo de férias vence naquele mês (coluna Vencimento), agrupados por filial. Tem botão de impressão dedicado. |

---

## Atualizar o dashboard após mudanças

Quando os gerentes atualizarem as planilhas, o RH clica em **"↻ Atualizar"**
no dashboard para recarregar os dados em tempo real.

Para atualizar o **código** do dashboard após modificações:
1. No Apps Script → "Implantar" → "Gerenciar implantações"
2. Edite a versão atual e salve

---

## Adicionar novas filiais

1. Crie a planilha da nova filial no formato padrão
2. Abra o `Code.gs` no Apps Script
3. Adicione uma linha em `BRANCHES`:
   ```javascript
   'Filial 29': 'ID_DA_NOVA_PLANILHA',
   ```
4. Salve e faça um novo deploy

---

## Permissões necessárias

O Apps Script precisa de acesso de **leitura** às planilhas de filiais.
Se as planilhas não são do mesmo domínio Google, compartilhe cada uma
com o email da conta que executa o script (configurado no deploy).

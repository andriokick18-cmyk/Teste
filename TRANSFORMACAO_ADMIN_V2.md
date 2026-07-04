# 🚀 H2BApply — Painel Administrativo V2 ("Central de Comando")

## O que foi entregue (v932)

**3 mudanças no projeto — zero risco para o que está em produção:**

| Arquivo | O que é |
|---|---|
| `admin-v2.html` (**NOVO**) | Painel administrativo totalmente novo, servido em **`/admin-v2`** |
| `mod-admin-v2.js` (**NOVO**) | Backend do painel: rotas `/api/admin/v2/*` no padrão modular do projeto |
| `server.js` (3 patches cirúrgicos) | Serve `/admin-v2`, carrega e despacha o módulo v2 |

O painel clássico continua 100% intacto em `/admin` — rollback é simplesmente não abrir o `/admin-v2`.

## Funcionalidades novas

### 🔎 Auditoria permanente (nunca apaga)
Toda alteração feita por qualquer administrador grava em `/data/audit_v2.json`:
admin responsável, data/hora, campo, valor anterior, valor novo, motivo, IP e dispositivo.
Consultável na aba **Auditoria** (busca + paginação) e no perfil de cada usuário.

### ✏️ Edição universal do usuário — sem senha
No perfil do usuário, clique em **editar ✎** em qualquer campo (nome, e-mail, telefone,
plano, datas de VIP manual/auto, flag admin, observações…). O sistema pede apenas o
**nome do administrador responsável** (uma vez por navegador) e registra tudo na auditoria.
Renomear e-mail migra automaticamente todas as stores (usuário, histórico, robô, logs).

### 💰 Correção de pagamento com propagação total
Cenário "pagou 150, registrou 300": abra Financeiro (ou o perfil do usuário) →
**Corrigir valor** → digite 150 → salvar. O sistema atualiza na hora: livro-caixa,
pedido de origem, receita do dashboard, relatórios e grava a auditoria. Testado.

### ◧ Dashboard inteligente
Usuários (total/online/novos/VIPs), receita dia/semana/mês/ano, pedidos pendentes e
críticos, bots ativos/pausados/erro, e-mails hoje/mês, vagas extras, CPU/RAM/disco,
status da IA, gráficos de receita (30d) e envios (7d), fluxo de auditoria ao vivo,
últimos envios e central de alertas. Farol de saúde no topo (verde/âmbar/vermelho).

### ⚙ Centro de Bots (tudo numa única área)
Motor automático (todos os jobs, status, fila, fonte, último envio, ações
reiniciar/pausar/parar), Coleta DOL, Enriquecimento e Sentinel — numa única tela.

### ✳ Central de IA
Status do Gemini, modelos em uso, tamanho da base de conhecimento (memória
permanente da IA) e sonda de latência com um clique.

### ≡ Central de Logs
Envios, financeiro, pedidos e auditoria — com filtro, busca, paginação e **export CSV**.

### ▥ Relatórios inteligentes
Conversão (visitou→pagou), pagantes únicos, ticket médio, usuários por plano.

### ⛃ Backup
Backup manual de todos os JSONs de `/data` para `/data/backups/<timestamp>`,
listagem e restauração (com snapshot automático de segurança antes de restaurar
e confirmação digitada).

### ⚒ Configurações centrais
Todos os `admin_settings` editáveis num único lugar, auditados. Senhas de editor
nunca são expostas nem editáveis por essa via.

## Qualidade / segurança
- Todas as rotas v2 exigem sessão + `isAdminVip` (mesmo padrão do sistema).
- `node --check` no server.js, no módulo e no bloco `<script>` do painel (lição KB-021).
- Suíte de testes funcional executada: 20 verificações, todas aprovadas
  (dashboard, edição, bloqueio sem adminName, correção de valor com propagação,
  rename de e-mail com migração, ações de bot, logs, finance, reports, backup,
  config mascarando senhas, auditoria persistida em disco).
- Boot real testado: módulo carrega, `/admin-v2` responde 200, API nega sem sessão,
  painel clássico intacto.

## Como usar
1. Suba esta versão (deploy normal via GitHub → Render).
2. Acesse **`/admin-v2`** logado com conta de admin.
3. Na primeira edição, informe seu nome de operador (fica salvo no navegador).

## Próximos passos sugeridos (quando quiser)
- Migrar aprovação de pedidos (com Gemini Vision) para o V2.
- Mover comprovantes do localStorage do admin para o servidor.
- Backup automático agendado (o watchdog já tem infra de `setInterval`).
- Aposentar o painel clássico quando o V2 cobrir 100% do fluxo diário.

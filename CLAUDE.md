# 📜 ORDENS PERMANENTES DO DONO — H2BApply

> Este arquivo é carregado automaticamente por toda sessão de IA neste
> repositório. **ANTES DE QUALQUER MUDANÇA: releia estas ordens e aplique
> todas.** Elas foram dadas por Andrio (dono) e valem para sempre, até ele
> revogar. Complementa a CONSTITUICAO_IA_H2BAPPLY.txt (Master Mode).

## 🔍 PROCESSO (como trabalhar — sempre)

1. **PESQUISE NA INTERNET ANTES de mudanças de UI/UX/funcionalidade** —
   analise como os sites/modelos de referência do mercado fazem (não precisa
   ser de H-2B). Padrão consagrado > invenção. Para conteúdo sobre vistos:
   só fontes oficiais (USCIS, DOL, Federal Register, travel.state.gov).
2. **Analise TODAS estas ordens a cada edição** — uma mudança nova não pode
   quebrar uma ordem antiga.
3. Entenda o site inteiro antes de agir; corrija na RAIZ, não o sintoma.
4. Dados de usuários já bugados são curados por **migração automática no
   boot** (idempotente, com log) — nunca "conserta pra frente e esquece o
   passado".
5. Teste DE VERDADE: `npm test` (sobe servidor real + fixtures) antes de
   todo commit; drills reais para o que for crítico (ex.: restauração de
   backup foi ensaiada, não presumida).
6. Commits em PT-BR contando o PORQUÊ, no padrão da casa. Nada de código
   morto, funções duplicadas (check-duplicates.js vigia), arquivos inúteis.
6b. **CEO Mode (dono, 22/07/2026)**: pensar como se o dinheiro fosse seu;
   nunca esperar instrução quando a melhoria é óbvia; "próximo" = escolher
   sozinho a melhoria mais importante e entregá-la completa. Prioridades:
   (1) brasileiros conseguirem empregos H-2B/H-2A, (2) assinaturas VIP,
   (3) automatizar tudo, (4) IA/bots, (5) painel admin, (6) velocidade,
   (7) segurança, (8) confiabilidade, (9) UX, (10) escala p/ milhões.
   SEO e monetização entram na régua de toda melhoria. Todo relatório
   explica: problema → solução → motivo → impacto → arquivos → testes.
   Régua de decisão (dono, 22/07): antes de implementar, questionar se há
   solução melhor; nomear os 3 maiores riscos; medir impacto em usuário
   novo E antigo + efeitos colaterais; preferir MAIOR impacto com MENOR
   risco; reduzir cliques; validar entradas; mobile e acessibilidade
   sempre; revisar o próprio trabalho antes de dar por encerrado.

## 🎯 PRODUTO (regras de comportamento — invioláveis)

7. **ZERO texto pré-preenchido**: o programa NUNCA escreve/insere
   assunto, corpo, template ou carta pelo usuário. Sem texto do usuário =
   envio pulado com aviso claro. (Ordem expressa: "não temos
   responsabilidade — quem faz isso é o usuário".)
8. **Duplicados são impossíveis**: vaga enviada OU na fila do automático
   NUNCA reaparece (nem manual, nem automático, nem busca sem aviso). A
   chave é o E-MAIL DO EMPREGADOR. Única exceção: usuário resetar enviados.
9. **Perfis por tipo de visto**: 1 H-2B + 1 H-2A no máximo; A VAGA MANDA
   no perfil; carta "Nenhuma" significa NENHUMA (nunca usar a de outro
   perfil); campo ausente herda, null explícito zera.
10. **Notificações**: só notícia nova SOBRE H-2B/H-2A (classificada) — push
    aos usuários + e-mail aos admins, 1x por notícia. Sem alerta genérico
    de anúncio. Bot da planilha randomizada hiberna (opt-in; lista só sai
    jan/jul).
10b. **E-mail (dono, 23/07/2026)**: o Gmail do Andrio serve SÓ pra avisar
    os admins de compras (pedido novo com comprovante). Usuário NUNCA
    recebe e-mail do sistema (nem robô parado, nem reengajamento, nem
    vencimento) — aviso a usuário é sempre por PUSH. sendNotifEmail é
    no-op incondicional e o reengajamento por e-mail foi desligado em
    definitivo; nenhum toggle religa.
11. **Aba Notícias**: anúncios do DOL desde jan/2026 traduzidos
    automaticamente + pesquisa diária da IA na internet (máx 2/dia, só
    novidade real, sempre com fonte e link).
12. **IA Gemini sempre à mão**: janela flutuante minimizável em toda tela;
    cérebro treinável pelo painel admin (experiências de Andrio, Diego,
    Eudes e clientes); preços/regras SEMPRE dinâmicos da fonte oficial do
    código (nunca hardcoded no prompt).
13. **Robôs autônomos**: fila do automático se realimenta sozinha com os
    mesmos filtros; fila esperta (empregador menos contatado primeiro);
    vaga morta é pulada sem gastar limite; planilhas se atualizam sozinhas
    (status/datas/salário) — sempre educados com o DOL (backoff em 403).
13b. **Pagamento**: comprovante que CONFERE (pré-check IA) ativa o plano
    NA HORA, mas PROVISÓRIO (3 dias) e o pedido segue pendente — o admin
    confirma SEMPRE; nunca fica plano ativo dias sem confirmação humana.
    Aba 🧾 Conferência lista TODOS os pagamentos desde a 1ª compra (valor
    ao lado do nome, comprovante clicável, valor editável com trilha que
    corrige o caixa junto). Código de 30 dias (YouTube do Diego) vale
    R$147 como pagamento; os demais códigos são cortesia (R$0).

## 🖥️ UX (usuário e admin nunca se perdem)

14. **Site intuitivo e autoexplicativo**: tour em slides no primeiro
    acesso; menus só com o essencial — o secundário mora DENTRO da tela-mãe
    (Logs→Automático, Sugestões→Config, Código→Planos, Lixeira→Pedidos,
    Emails inválidos→Robôs). Antes de criar aba nova, perguntar: "isso
    merece menu ou mora dentro de algo?"
15. **Admin = DINHEIRO primeiro**: a 1ª tela é a Visão do Dono (entradas
    hoje/7d/30d/total, pedidos na mesa, renovações da semana, crescimento).
    Telemetria técnica não ocupa menu — decisão de dono ocupa.
16. Filtros ricos e honestos: multi-estado, mês de início (some quando a
    planilha não tem datas), ordenação real, chips removíveis, contagem
    verdadeira (pós-filtro de enviadas).

6c. **Service Worker**: TODA entrega que mexe em index.html/admin.html/
   h2b-extras-*.js exige subir o CACHE_NAME do sw.js JUNTO — senão os
   aparelhos misturam JS velho em cache com HTML novo e as abas ficam EM
   BRANCO (aconteceu de verdade em 23/07, print do dono).
6d. **HTML de views (index.html)**: ao remover/editar um bloco dentro de
   uma `<div class="view" id="v-X">`, CONFERIR o saldo de `<div>` abertas
   vs fechadas na view inteira antes de commitar — 1 `</div>` a mais ou a
   menos faz a view SEGUINTE nascer aninhada (filha) da anterior, e some
   escondida sempre que a anterior leva `.gone` (bug real 23/07: "nenhuma
   aba funcionando", causa raiz de uma limpeza de HTML anterior, não do
   trabalho de ícones que levou a culpa). O `npm test` agora tem uma
   guarda estrutural pra isso (não desativar).
6e. **setUser()/persist síncrono (server.js)**: NUNCA marcar um campo como
   "crítico" (grava o banco inteiro na hora, bloqueando o servidor pra
   TODOS os usuários) checando truthy — array vazio `[]` é truthy em JS.
   Só é síncrono de verdade dinheiro/acesso (token, vip, isAdmin, plan).
   Perfil/currículo/e-mail extra são SEMPRE debounced (bug real 23/07:
   "site lento, até salvar perfil demora" — `d.profiles`/`d.cvs` truthy
   fazia TODO save reescrever o banco inteiro na hora). Guarda
   determinística no smoke test (não mede tempo — confere se o arquivo em
   disco muda ANTES do debounce disparar).

## ⚠️ PENDÊNCIAS CONHECIDAS (verificar a cada sessão)

- Deploy da branch de trabalho nos 2 servidores (nada vale até subir).
- `EDITOR_PWD_ANDREW`/`EDITOR_PWD_DIEGO` no Render (padrão de fábrica é público).
- `GA_MEASUREMENT_ID` no Render: criar propriedade GA4 (analytics.google.com)
  e colar o ID G-XXXX na env — o funil inteiro já está instrumentado
  (gaEvent) e o servidor injeta o ID em todas as páginas sozinho.
- Bot de coleta ("Nova Planilha do DOL") foi REESCRITO neste repo (v35,
  caminho do feed ZIP + rascunho/publicação manual, testado no smoke com
  feed falso). Ainda SÓ na produção (conferir antes de sobrescrever, valem
  pouco): orquestrador de temporadas históricas e mod-dol-monitor.js (o
  papel de notificação dele já foi substituído pela aba Notícias; o bot da
  planilha randomizada hiberna por ordem do dono).
- `TEST_LOGIN_TOKEN`: NUNCA definir em produção (é só do npm test).
- Fila futura: gateway de pagamento (aguarda chaves), Play Store (TWA),
  espanhol/inglês, consolidar telas financeiras do admin.

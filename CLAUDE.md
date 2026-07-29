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
13a. **🌱 Aquecimento de Gmail (dono, 27/07/2026 — "gente sendo bloqueada
    pelo Google")**: toda conta Gmail nova (principal ou extra) tem um
    teto de referência que sobe aos poucos (dias 1-3: 15/dia · 4-7:
    40/dia · 8-14: 100/dia · 15+: limite cheio do plano) — cada conta tem
    seu PRÓPRIO relógio (created_at do usuário / addedAt do extra). Sem
    dado de quando a conta nasceu, NUNCA bloqueia por falta de informação
    (fail-open). **v76 (dono, 27/07/2026 — "eu quero nao nunca pare o
    automático", cliente pago travado em `waiting_warmup`): esse teto
    NUNCA MAIS pausa o automático.** É só preferência de rodízio — com
    mais de 1 conta, o round-robin PREFERE a que ainda está dentro do
    teto; se todas já bateram o teto de hoje, usa a menos carregada
    mesmo assim e segue no intervalo humanizado normal (a proteção real
    contra rajada súbita). Proibido reintroduzir um status que pausa o
    automático (`waiting_warmup` ou equivalente) esperando o teto zerar —
    só bloqueio de verdade do Google (conta suspensa/desativada) pausa.
    Uma conta SUSPENSA pelo Google é ISOLADA (blocked:true) e o
    automático CONTINUA pelas outras — nunca pausa tudo por causa de 1
    conta doente. Selo visível no Perfil (🌱 Aquecendo X/Y hoje) — nunca
    esconder esse throttling do usuário, mesmo não bloqueando mais.
13a2. **Regra geral (dono, 27/07/2026, duas vezes no mesmo dia — rate
    limit do Google em v75 e aquecimento em v76): o envio automático só
    pausa de verdade por BLOQUEIO REAL do Google (conta suspensa,
    envio desativado) ou por falta de autenticação/token. Qualquer
    proteção interna nossa (rate limit, aquecimento, etc.) deve
    DESACELERAR ou preferir outra conta, nunca ENTRAR EM ESTADO DE PAUSA
    esperando o problema sumir sozinho — o automático sempre segue
    tentando no intervalo humanizado normal.
13b. **Pagamento**: comprovante que CONFERE (pré-check IA) ativa o plano
    NA HORA, mas PROVISÓRIO (3 dias) e o pedido segue pendente — o admin
    confirma SEMPRE; nunca fica plano ativo dias sem confirmação humana.
13c. **💎 DIAMANTES (dono, 26/07/2026 — substitui a compra de plano)**: NÃO
    existe mais compra direta. Doação PIX (mesmo fluxo de comprovante; SEM
    ativação provisória — admin confirma SEMPRE) credita DIAMANTES REAIS
    (1 💎 = R$ 1,50; env DIAMOND_PRICE_BRL). Plano é TROCADO por 💎 NA HORA,
    sem aprovação e SEM lançar caixa de novo (o dinheiro entrou na doação).
    💎 real pode ser doado a outro usuário DO MESMO servidor; 💎 bônus
    (brinde do admin) é intransferível e é gasto PRIMEIRO na troca. Preço em
    💎 deriva SEMPRE de PLANO_PRECO_TAB (nunca hardcoded em 2º lugar).
    Cancelou doação aprovada → estorna os 💎 (parcial se já gastou, com log).
    LINGUAGEM (v66): NENHUM texto visível do site fala em compra/pagamento/
    contratar/renovar — sempre doação, diamantes, troca e recompensas.
    Preços exibidos ao usuário são em 💎; o R$ só aparece na calculadora da
    doação, DEPOIS que a pessoa escolhe a quantidade. Packs de doação
    mostram só a quantidade de 💎 (nunca o valor junto).
    Aba 🧾 Conferência lista TODOS os pagamentos desde a 1ª compra (valor
    ao lado do nome, comprovante clicável, valor editável com trilha que
    corrige o caixa junto). Código de 30 dias (YouTube do Diego) vale
    R$147 como pagamento; os demais códigos são cortesia (R$0).
13d. **📧 SÓ-ENVIO PERMANENTE (dono, 26/07/2026 — substitui o toggle do
    v55)**: o app SÓ ENVIA e-mail pela API do Google — NUNCA mais pede
    escopo de leitura (gmail.readonly/modify), em NENHUM dos 3 servidores.
    GMAIL_SEND_ONLY é hardcoded `true` em server.js (não é mais env por
    servidor). A aba Respostas foi REMOVIDA do site — não existe mais em
    lugar nenhum. Nenhuma rotina do servidor lê/abre a caixa de entrada de
    ninguém (bounce-scan no boot e o polling de push por resposta foram
    desligados de propósito — dependiam do escopo de leitura). Se um
    e-mail bounça, o sistema só descobre por dado JÁ conhecido
    (DB_INVALID_EMAILS histórico + ajuste manual do admin) — não há mais
    descoberta automática de novos bounces por leitura de inbox. PROIBIDO
    reintroduzir gmail.readonly/gmail.modify, a aba Respostas, ou qualquer
    leitura de caixa de entrada sem ordem EXPRESSA e NOVA do dono.
13e. **🎯 RESPOSTAS CERTAS — exceção isolada e ADMIN-ONLY ao 13d (dono,
    27/07/2026)**: essa foi a ordem EXPRESSA e NOVA que o 13d previa. Aba
    só-admin (painel /admin) onde a IA lê em tempo real as caixas de
    entrada QUE O PRÓPRIO ADMIN conectou (separado do login normal) e
    classifica cada resposta nova: entrevista/pergunta real aparece num
    ranking (topo = e-mail enviado, baixo = resposta já traduzida, conta
    usada); automático/rejeição/spam a IA ignora sozinha. Botão 👎 quando
    a IA erra vira treino (DB_REPLY_FEEDBACK, por admin — NUNCA se mistura
    com o DB_AI_KB do IA Chat, que é visto por TODOS os usuários). Varre
    sozinha o dia todo (setInterval). Isso NÃO reabre leitura de inbox
    pros usuários comuns nem pro CLIENT_ID público de envio — usa um
    CLIENT_ID/SECRET SEPARADO (ADMIN_REPLY_CLIENT_ID/SECRET), de um
    projeto Google Cloud próprio, em modo "Testing" com só e-mails de
    admin como test user (nunca passa por verificação pública, nunca
    aparece pra usuário comum). Sem essas envs configuradas, a aba fica
    100% inerte (banner de setup, zero chamada ao Google) — ver passo a
    passo em README_SERVIDORES.txt. O 13d continua valendo por inteiro
    pros 3 servidores e pros usuários comuns; esta é a ÚNICA exceção, e é
    só do admin lendo a própria caixa.
13f. **💎 Arredondamento de diamantes — REGRA ÚNICA (dono, 28/07/2026, bug
    real: "comprou 250 reais, ativou DoublePro, mas não aparece que ele
    tem")**: causa raiz achada — doação creditava 💎 com `Math.floor`
    enquanto o preço de cada plano em 💎 usa `Math.round`
    (`planoPrecoDiamantes`). Pra planos cujo preço em R$ não é múltiplo
    exato de `DIAMOND_PRICE_BRL`, doar EXATAMENTE o valor de tabela do
    plano deixava o usuário 1💎 curto, sem aviso claro — parecia "não
    funciona". Corrigido para `Math.round` nos dois lados. PROIBIDO
    usar `Math.floor`/`Math.ceil` em qualquer conversão nova de R$↔💎 —
    é SEMPRE `Math.round`, os dois lados da mesma conta (crédito e
    preço) TÊM que usar a mesma função de arredondamento, senão volta o
    mesmo bug de "faltou 1💎" pra quem doou o valor certinho.
13g. **💎 Painel completo de Diamantes (dono, 28/07/2026)**: aba admin
    "💎 Diamantes" (`/api/admin/diamonds/overview` +
    `/api/admin/diamonds/user/:email`) — ranking de quem tem mais/menos/
    zero 💎, extrato COMPLETO por usuário (o que comprou/trocou/recebeu,
    quando, saldo depois de cada lançamento), 20+ métricas agregadas
    (circulação total, total doado em R$, gasto por plano, top
    doadores, atividade recente de todo mundo). Fonte única: o mesmo
    `diamondLedger` por usuário que já existia desde o v64 — nenhuma
    segunda verdade nova. Admin-only, dado financeiro sensível.
13h. **💎 Corrigir valor de doação REAJUSTA os diamantes (29/07/2026)**:
    achado revisando o v77 — corrigir o R$ de uma doação já aprovada
    (`corrigirValor` na Conferência OU `/api/admin/pedido-set-valor` nos
    Pedidos) atualizava o caixa mas nunca os 💎 já creditados. As duas
    rotas agora chamam `reconciliarDiamantesCorrecao()` (função única,
    nunca duplicada) — credita a diferença pra cima sempre; pra baixo,
    remove o que der do saldo real (nunca negativo) e ACUSA no log
    quanto já foi gasto e não pôde ser recuperado.
13i. **⚠️ Classe de bug real (29/07/2026): rota sem try/catch que referencia
    variável inexistente TRAVA A REQUISIÇÃO PRA SEMPRE, não dá erro.**
    Achado no `/api/admin/pedido-set-valor` (referenciava um `body` que
    nunca foi lido/parseado — nem `readBody`, nem `JSON.parse`). Sem
    try/catch ao redor, a exceção estoura DENTRO do callback assíncrono
    do request handler; os handlers globais `uncaughtException`/
    `unhandledRejection` só logam (não têm acesso a `res`), então a
    resposta HTTP NUNCA sai — o admin via a tela girando pra sempre, sem
    erro nenhum pra reportar. Toda rota nova PRECISA: (1) ler o body só
    via `JSON.parse(await readBody(req))`, nunca reaproveitar uma
    variável de outro escopo; (2) ter try/catch cobrindo isso, com o
    catch sempre devolvendo uma resposta JSON de erro — nunca deixar um
    caminho onde a exceção pode escapar sem que `json(res,...)` seja
    chamado.
13j. **⚠️ Classe de bug real (Diego, 29/07/2026, áudio: "ativei DoublePro
    pro Esdras várias vezes e não entra, volta pro VipPro"): snapshot de
    ANTES de uma função auxiliar reaproveitado DEPOIS dela apaga o que
    ela acabou de gravar.** `/api/admin/set-plan` lia `tgt=getUser(email)`,
    chamava `addManualVipDays`/`addAutoVipDays` (que leem e gravam
    `vip.manualExpires`/`autoExpires` atualizados de verdade) e DEPOIS
    fazia `setUser(email,{vip:{...tgt.vip, ...}})` usando o `tgt` ANTIGO
    — sobrescrevendo o vip inteiro com o snapshot de antes, apagando os
    dias que as duas funções tinham acabado de gravar (no caso de um
    usuário novo, `tgt.vip` nem existia — o resultado virava `plan:free`
    na cara). Regra geral: se uma função auxiliar já lê+grava o mesmo
    registro, PROIBIDO guardar esse registro numa variável ANTES dela e
    reusar essa variável DEPOIS — sempre reler (`getUser`) depois de
    qualquer helper que possa ter mudado o mesmo dado, ou não guardar
    snapshot nenhum. Sem teste algum cobria essa rota antes disso.
13k. **⬆️ Upgrade de plano (dono, 29/07/2026)**: quem já tem plano PAGO
    ativo pode subir de tier (VIP→VIPro→DoublePro) pagando só a
    DIFERENÇA em 💎 entre o plano atual e o novo, no MESMO período
    (`vip.days`) que já tinha assinado — `/api/plans/upgrade`. Regra
    inegociável: **os dias NUNCA reiniciam nem somam** — quem tinha 20
    dias restantes continua com exatamente 20 dias restantes, só que
    num tier melhor. Única exceção: se o upgrade destrava automático
    pela 1ª vez (vinha de VIP só-manual), o automático passa a valer até
    a MESMA data que o manual já tinha (nunca ganha um +30d novo). Upgrade
    é 100% pago em diamantes — NUNCA lança entrada nova no livro-caixa
    (a mesma regra "troca não duplica o caixa" do v64 vale aqui). Downgrade
    e "upgrade" pro mesmo tier são recusados (400). Sem plano pago ativo
    (ou saldo insuficiente) também é recusado, nunca ativa de graça.

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

- 🔴 URGENTE — DNS de applyh2b.com aponta pro parking da Namecheap
  (162.255.119.149, sem HTTPS → ERR_CONNECTION_TIMED_OUT, print do dono
  25/07). Corrigir na Namecheap + Custom Domain no Render — passo a passo
  em README_SERVIDORES.txt (Caso 1).
- ESTE repo (Applyh2b.com) é a FONTE ÚNICA dos 3 servidores (ordem do
  dono, 25/07): toda mudança daqui vale pros 3. 1º espelho FEITO em
  26/07 (v65b → main de New-repository e Teste), com o estado antigo
  preservado no branch backup-pre-espelho-20260726 de cada repo (lá está
  o mod-dol-monitor.js e os arquivos removidos de propósito). TODA
  entrega nova precisa reespelhar: push --force do main daqui pros mains
  dos 2 repos (comandos em README_SERVIDORES.txt).
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
- `ADMIN_REPLY_CLIENT_ID`/`ADMIN_REPLY_CLIENT_SECRET` no Render (os 3
  servidores): pendente de criação pelo dono — projeto Google Cloud
  SEPARADO do OAuth público, OAuth consent screen em modo "Testing",
  e-mails de admin como test users, escopo gmail.readonly. Sem isso a
  aba 🎯 Respostas Certas fica inerte (banner de setup). Passo a passo em
  README_SERVIDORES.txt.
- Fila futura: gateway de pagamento (aguarda chaves), Play Store (TWA),
  espanhol/inglês, consolidar telas financeiras do admin.

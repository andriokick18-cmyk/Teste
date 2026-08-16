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
12. **IA Gemini sempre à mão (dono, 02/08/2026 — substitui a janela
    flutuante do v25)**: o chat mora FIXO e SEMPRE ABERTO na sidebar
    (#ia-side, abaixo das abas — abaixo de Painel Admin pro admin, abaixo
    de MENU pro usuário comum). O botão flutuante 🤖 foi REMOVIDO de vez
    (ordem expressa). No celular (sem sidebar) o acesso é pelo MENU ☰ e
    pela aba IA Chat. Balões-convite rotativos (54 frases, ~2min, só pra
    quem nunca usou o chat, nunca enquanto digita) chamam pro chat sem
    atrapalhar. "Ver tudo" na sidebar virou MENU com destaque roxo;
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
    **🎁 Missões (dono, 31/07/2026, vendo o painel real — "isso aqui é
    muito importante")**: 💎 de missão/tarefa é BÔNUS, pago 1 ÚNICA VEZ
    por conta (`u.missoes` nunca é apagado — nem reset de enviados
    re-paga) e NUNCA pode ser doado a ninguém — só serve pra troca/
    upgrade de plano. A rota de transferência debita SÓ do saldo real
    (nunca do bônus) e recusa com 402 quem só tem bônus — guarda de
    regressão v84b no smoke test prova o cenário exato.
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
13e. **🎯 RESPOSTAS CERTAS — REVOGADA (dono, 13/08/2026: "exclua a aba
    respostas")**: a exceção admin-only ao 13d foi EXCLUÍDA por inteiro
    no v135 — aba do painel, rotas /api/admin/reply-triage/*, OAuth de
    leitura isolado (ADMIN_REPLY_*), scanner e guardas de teste. O 13d
    volta a ser ABSOLUTO: NINGUÉM (nem admin) lê caixa de entrada por
    este sistema, em nenhum dos 3 servidores. Os arquivos de dados
    antigos (admin_reply_*.json) ficam inertes no disco. Não recriar
    sem ordem EXPRESSA e NOVA do dono.
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
    **🔒 v84 (auditoria de segurança, 29/07/2026)**: "plano PAGO" tinha
    esquecido `vip.source==="code"` na lista de exclusão (só excluía
    trial/auto-provisorio) — quem resgatasse um código de cortesia
    (R$0, nunca gera pagamento — regra 13c) conseguia chamar upgrade e
    pagar só a DIFERENÇA de diamantes pra virar DoublePro, descontando
    o preço inteiro de um plano nunca pago. Provado com reversão real do
    fix (o teste falhou mostrando a cobrança de 67💎 em vez de recusar).
    Corrigido: `code` entra na mesma lista de exclusão que TODO o resto
    do financeiro já usa (`computeEntradasJanelas`, dono-resumo) —
    trial E code NUNCA contam como plano pago, em lugar nenhum.
13l. **💎 Diamante infinito pra admin/DM (dono, 29/07/2026 — "eu e o Diego
    temos limite infinito")**: toda conta admin (`isAdminVip` — dono, Diego
    e os demais e-mails de `ADMIN_EMAILS_EXTRA`) pode testar troca/upgrade
    de plano SEM gastar diamante de verdade — `debitDiamonds` (função
    única usada por troca E upgrade) nunca desconta do saldo real do
    admin e NUNCA gera lançamento no extrato dele; por isso nenhum
    agregado do painel 💎 Diamantes (`totalGastoEmTrocasPorPlano` etc.)
    é afetado por teste de admin. Diferente disso: se o admin DOAR
    diamantes pra um usuário de verdade (`/api/diamonds/transfer`), a
    doação NUNCA sai do saldo do admin (poço infinito, nunca bloqueia
    por saldo insuficiente) mas CONTA de verdade — o destinatário recebe
    💎 REAIS de verdade (pode gastar/repassar) e o extrato mostra a
    doação atribuída certinho ao e-mail do admin, entrando nos agregados
    do site (`totalTransferidoEntreUsuarios`) igual qualquer doação real.
    Isso não é um poder novo — admin já podia creditar qualquer saldo pra
    qualquer usuário via `/api/admin/diamonds`; a doação por transferência
    só dá o mesmo resultado com a cara de "doação entre pessoas" no extrato.
13m. **🎯 Match de vaga (dono, 29/07/2026 — "IA sugerindo as vagas com mais
    chance pra cada um", prioridade #1 da casa)**: toda vaga ganha uma nota
    0-100 (`computeJobMatchScore`, server.js) de encaixe com o perfil do
    candidato — categoria preferida (`h2bProfile.preferredArea`), estado e
    categorias do perfil de vaga (`profiles[].state/.categories`), e o
    texto da vaga batendo com experiência (`experiencedH2B`/`h2bSeasons`) e
    nível de inglês (`englishLevel`). Heurística local, NUNCA IA externa —
    roda instantâneo em toda busca manual (`/api/sheet-meta`, `/api/jobs`)
    e em toda fila automática (`orderQueueSmart`). Sempre devolve o
    "porquê" (`matchWhy`) — proibido virar caixa preta. NUNCA bloqueia:
    sem perfil preenchido a nota fica neutra (50), sem sessão a nota some
    (null) — a vaga continua 100% visível e candidatável do jeito de
    sempre. Na fila automática, o score só reordena DENTRO da mesma faixa
    de "quanto o app já contatou esse empregador" (regra 13, fila esperta)
    com jitter aleatório — nunca substitui essa proteção contra usuários
    simultâneos baterem no mesmo empregador. Uma função de pontuação só
    (`computeJobMatchScore` + `_matchSignalFromRow`/`_matchSignalFromJob`
    convergindo os 2 formatos de vaga pro mesmo sinal) — nunca duplicada
    por endpoint. **v139 (14/08)**: a nota ganhou prateleira própria na
    Home — "🎯 Vagas pra você" (`/api/jobs/pra-voce` + `#home-pravoce`):
    top 8 empregadores AINDA disponíveis, ranking cacheado 10min por
    usuário MAS o corte da regra 8 (enviado/na fila) roda FRESCO em toda
    resposta; vaga morta/encerrada fica de fora; matchWhy traduzido no
    front por mapa de chaves (9 frases fixas → pv_w1..pv_w9). Snapshot de
    vaga tem fonte única `_vagaSnapshot()` (Salvas + Pra Você).
13n. **💰 Janelas de entradas — fonte única (dono, 29/07/2026 — fila futura
    "consolidar telas financeiras do admin")**: achado revisando a régua —
    Visão do Dono (`/api/admin/dono-resumo`) e o resumo usado no
    Faturamento Global/rota peer (`_entradasResumo`, `/api/servers/
    financeiro`) reimplementavam CADA UM sua própria cópia do cálculo
    hoje/7d/30d/total (mesma classe de risco do bug real do v77b — 2
    verdades sobre o mesmo dinheiro que podem divergir, só que no caixa em
    vez de diamantes). Unificado em `computeEntradasJanelas()` — fonte
    única, com a MESMA correção que `computeFinanceCanonico` já aplica pras
    outras telas (pedido corrigido depois vence sobre o lançamento cru do
    caixa, se algum dia divergirem). PROIBIDO reintroduzir um 2º cálculo
    dessas janelas em qualquer tela nova — sempre chamar
    `computeEntradasJanelas()`.

13o. **📋 Novas regras de planos v118 (dono, 02/08/2026 — áudio confirmado
    por escrito)**: tabela NOVA só pra ativação nova — VIP R$100 = 100
    manuais/dia (sem automático) · VIPro R$150 = 100 manual + 100 auto ·
    DoublePro R$250 = 200 manual + 200 auto. **Contrato congelado**: toda
    ativação (troca 💎, upgrade, set-plan do admin, código) carimba
    `vip.limits {manual,auto}` na hora; getManualLimit/getAutoLimit
    preferem esse carimbo enquanto o respectivo lado do VIP está ativo.
    Quem pagou ANTES não tem `vip.limits` e cai na tabela LEGADA
    (PLAN_LIMITS: vip 200 · vipro 200/200 · doublepro 400/400) até
    expirar — **nenhum pagante perde nada, nunca** — e vê o aviso
    `planRulesNotice` (/api/status → toast 1x por sessão) com a data de
    garantia e os limites de hoje. Ritmo: automático ~7min/envio
    (calcSmartInterval 6,5–7,5min; custom de admin continua); manual tem
    cooldown de 1 minuto (429 + cooldownLeft no /api/send, espelhado no
    front via _manualCdUntil; admin isento). **v120 (dono, 05/08)**: o
    cooldown do MANUAL é o padrão mas o usuário pode DESLIGAR — pill no
    modal de envio (#m-cd-pill → manualCdModal) com aceite de risco
    obrigatório (checkbox "meu Gmail pode ser bloqueado para sempre";
    carimbo manualCdOffAt no servidor); religar é 1 clique. `manualCdOff`
    vive no usuário via /api/settings e é espelhado no /api/status. O
    intervalo do AUTOMÁTICO não é editável por usuário comum — 7min
    sempre (só o custom de admin existe). PROIBIDO mudar limite de
    plano mexendo só na tabela — mudança nova = tabela nova + carimbo na
    ativação, mantendo os carimbos antigos intocados (mesma filosofia).
    Atenção à ordem do histórico: addHist usa unshift — o envio mais
    recente está no ÍNDICE 0 (o scan do cooldown varre do começo).

13p. **🌾 Planilha H-2A MENSAL (dono, 08/08/2026 — "pode fazer o robô
    publicar sozinho"; mudou de bimestral pra mensal no MESMO dia:
    "daqui 1 mês gera outra em setembro")**: TODO MÊS o robô
    `_runH2aBimestral` (nome interno mantido; cadência é 1 mês) monta
    sozinho a planilha "H-2A <Mês> <Ano>" (chave `h2a-YYYYMM`) com as
    vagas dos últimos 90 dias — 6 feeds ZIP escalonados de 18 dias (cada
    feed do datahub cobre ~20 dias pra trás), MESMA esteira das outras
    (dedupe por case number, filtro de qualidade, integridade) via
    `_runDolColeta` (que agora aceita `feedDates[]`/`visaStrict`/
    `autoPublishMin`). AUTO-PUBLICA — exceção autorizada por escrito à
    regra KB-078 de rascunho, SÓ deste robô — quando coleta ≥
    `H2A_BIM_MIN_PUBLICAR` (padrão 200) vagas válidas; abaixo disso fica
    em RASCUNHO e os admins recebem push pra revisar. Agenda: checa 8min
    após o boot (cria a 1ª sozinho) e a cada 12h; roda de verdade quando
    MUDA O MÊS do calendário (estado em `h2a_bimestral.json`; guarda no
    smoke prova que 1 mês de diferença JÁ roda). Disparo
    manual: POST `/api/admin/sheet/h2a-bimestral-run` (`force:true` refaz
    a do mês). A coleta real só roda em PRODUÇÃO (sandbox não alcança o
    DOL) — o smoke prova a esteira inteira com o feed falso.

13p2. **🧊 Planilha H-2B MENSAL (CEO mode, 14/08/2026 — o site chama
    H2BApply e a planilha H-2B mais nova era de janeiro, em plena época
    de contratação da temporada de inverno)**: mesmo núcleo mensal do
    13p (`_runPlanilhaMensal`, função ÚNICA usada pelos 2 robôs;
    `_runH2aBimestral` e `_runH2bMensal` são só wrappers de config) monta
    todo mês a "H-2B <Mês> <Ano>" (chave `h2b-YYYYMM`, estado em
    `h2b_mensal.json`, boot+20min e ciclo 12h — defasado do H-2A pra
    nunca colidir na `_dolColeta`). DIFERENÇA INEGOCIÁVEL: o H-2B fica
    SEMPRE em RASCUNHO (KB-078) — a auto-publicação continua exceção
    autorizada por escrito SÓ do robô H-2A; os admins recebem push e
    publicam com 1 clique (coleta-publish). Se o dono autorizar por
    escrito o auto-publicar do H-2B, é trocar `autoPublish:false` no
    wrapper — nunca mexer no núcleo. Disparo manual: POST
    `/api/admin/sheet/h2b-mensal-run`. Publicar um rascunho dispara o
    📡 Radar (v134) na 1ª publicação — mesma regra da auto-publicação.
13q. **🚫 INDICAÇÃO PREMIADA — NUNCA (dono, 13/08/2026)**: programa de
    indicação com recompensa (💎/dias por convidar amigo) está PROIBIDO
    para sempre — "as pessoas ficam criando e-mails falsos em
    indicação". Não implementar, não sugerir, não reintroduzir o que
    existir de resquício. 📡 Radar de Vagas (v134) foi APROVADO por
    escrito: push opt-in (só quem criou radar), máx 1/dia por usuário,
    radar vazio recusado — é a única exceção nova de push além das
    já regradas (10/10b).
13r. **💳 Auditoria Financeira por usuário — caso Cleiton (dono,
    15/08/2026: "esse Cleiton e também o outro ali, eu sei que nenhum dos
    2 tem todos esses dias de plano. algo deu errado!")**: causa raiz
    achada — `/api/admin/set-plan` era a ÚNICA rota que soma dias de VIP
    sem trava de clique duplo/retry (`vip/activate` já tinha desde o
    v18-FIX). Corrigido com a mesma trava de 5s, mas a CHAVE inclui o
    PLANO (admin+email+plano) — upgrade legítimo e imediato pro plano
    seguinte (caso real do Diego, v79) continua passando; só repetir o
    MESMO plano é bloqueado. `detectarConcessoesDuplicadas()` varre
    `DB_ADMIN_AUDIT` e acha sozinho 2+ concessões pro mesmo usuário em
    ≤15min terminando no MESMO plano final (não flagra escaladas
    legítimas) — aparece como divergência `concessoes_duplicadas` na
    Conferência. Nova aba principal da sidebar **"💳 Pagantes & Dias
    VIP"** (antes só acessível pela régua 💰) e nova aba do CCC **"💳
    Auditoria"** (`GET /api/admin/financeiro-usuario/:email`, fonte
    única — sem duplicar armazenamento) juntam o que antes vivia em 5
    rotas espalhadas: plano+reconciliação, comprovante de cada pedido,
    extrato de dias concedidos (`vip.creditos` — `set-plan` passou a
    alimentar também, lacuna que existia), trilha de auditoria
    administrativa com reversão em 1 clique, extrato de diamantes, uso
    real (envios hoje/limite/histórico) e sinais de risco (comprovante
    reusado, Gmail bloqueado, missão já paga). Ações rápidas
    diferenciam explicitamente **somar dias** (`vip/activate`) de
    **definir vencimento exato** (`vip/set-expiry`) — a ambiguidade
    entre as duas semânticas era um dos riscos identificados na
    auditoria do código.
13s. **🎟️ Código Promo com limite avançado (dono, 15/08/2026 — usuário
    perdeu acesso ao Gmail, admin recria a conta e quer "repor os 15
    dias dele que sobraram do Google Pro... 15 dias doublepro 400
    manual e 400 automático")**: até aqui todo código resgatado caía
    cego na tabela NOVA (v118, `limitesDoPlanoNovo` por nome do plano)
    — no máximo vipro 100/100, nunca reproduzia um contrato LEGADO
    (ex.: doublepro 400/400) numa conta recriada do zero. Campos
    OPCIONAIS `manualLimit`/`autoLimit` na criação do código (painel
    Códigos Promo → "Limite avançado", vazio = comportamento de sempre):
    se preenchidos, o resgate usa ESSES números diretamente em
    `vip.limits`, ignorando a tabela — funciona porque
    `getManualLimit`/`getAutoLimit` já liam `vip.limits` primeiro,
    antes de qualquer tabela por nome. Propagado no resgate local E no
    caminho cross-servidor (`/api/servers/code-redeem`). Continua
    valendo a regra 13c: origem do plano fica `source:"code"` sempre
    (cortesia, NUNCA pagamento), mesmo com limite legado.
13t. **📝 Rascunho do Editor de Perfil (dono, 15/08/2026 — print via
    WhatsApp: "o usuário não consegue completar o perfil dele", caso real
    da Keyla no Servidor 3)**: causa raiz investigada e NÃO é bug de
    front nem de validação — é consequência de uma decisão deliberada
    já existente (KB-078): o servidor derruba TODAS as sessões de login
    a cada reinício do processo Node (deploy OU Render "acordando" no
    plano free/starter). Servidor 3 é a fonte deste repo e recebe
    deploy a cada commit, então reinicia com muito mais frequência que
    os espelhos — quem está no meio de escrever um perfil novo (a parte
    mais chata de digitar do site: 3+ assuntos, 3+ corpos de e-mail)
    recebia "Sessão expirada" e perdia tudo, sem aviso. **NÃO revertemos
    o KB-078** (a decisão de segurança continua valendo) — só garantimos
    que o TEXTO nunca se perde: `_peSaveDraftNow()`/`_peLoadDraft()`
    (app.js) fazem autosave debounced (500ms) do que está sendo digitado
    no editor de perfil pro `localStorage` (nunca servidor), com
    snapshot extra garantido no instante do clique em "Salvar". Ao
    reabrir o MESMO perfil (mesmo tipo de visto + mesmo id, nunca mistura
    rascunho de perfis diferentes), oferece restaurar. Mensagem de erro
    também ficou mais clara (`_peSessionMsg`) quando é sessão caída.
    Lição geral pra qualquer formulário longo do site: um 401 real do
    servidor não é bug — mas perder o trabalho da pessoa por causa dele
    é, e a correção certa é preservar o rascunho no aparelho, não tentar
    evitar o 401 (ele é intencional).

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
6f. **🇧🇷 Português por padrão (dono, 01/08/2026 — "site 100% bom pros
   olhos do usuário")**: público é 100% brasileiro. O app abre SEMPRE em
   português — o idioma NUNCA é decidido pelo `navigator.language` (celular
   em inglês fazia muitos brasileiros caírem no inglês). `_curLang` só sai
   do PT se a pessoa TROCOU de propósito pra EN/ES (escolha guardada no
   aparelho + no servidor via `/api/settings`). Normaliza sempre o código
   de região pra 2 letras (`pt-BR`→`pt`) — antes a preferência salva
   `pt-BR` nunca casava com a chave `pt` do dicionário e era ignorada.
   Toda string visível NOVA precisa passar pelo dicionário `LANG_DICT`
   (via `t('chave')` no `applyLang()`), nunca texto fixo em inglês no
   markup — senão fica em inglês pra sempre, mesmo em modo PT (foi o caso
   de "Stats", "Seasonal Jobs" e "Free", corrigidos no v86). Guarda no
   smoke test trava a detecção por navegador (não deixa reintroduzir).

## ⚠️ PENDÊNCIAS CONHECIDAS (verificar a cada sessão)

- ✅ REGISTRO (02/08/2026, v95–v108): reestruturação total aos olhos do
  usuário CONCLUÍDA (12 partes + extras): subtabs do Perfil em cards
  grandes; Currículos em 3 caminhos (sidebar/drawer/bottom-nav); nº de
  caso falso removido do detalhe de Enviadas; wizard nunca cobre o
  checkout de doação; MENU roxo; chat IA fixo na sidebar (regra 12
  nova) c/ 54 balões; 3 MODOS DE TELA (Auto/Tela pequena/Tela cheia,
  force-cel pro PC) c/ slide no tour + gaEvent; 30 botões só-ícone com
  aria-label; telas financeiras do admin consolidadas (régua 💰,
  _renderMoneyNav); guia /como-usar re-fotografado. Deploys conferidos
  por hash idêntico nos 3 repos. ATENÇÃO: a rede do sandbox de IA NÃO
  alcança os domínios de produção (proxy 403) — confirmação visual de
  produção é sempre do dono.

- DNS de applyh2b.com (parking Namecheap), EDITOR_PWD_*, GA_MEASUREMENT_ID:
  **ADIADOS pelo dono (13/08/2026 — "esqueça, não vou fazer agora")**.
  NÃO relembrar em relatórios; passo a passo continua em
  README_SERVIDORES.txt pra quando ele quiser.
- ESTE repo (Applyh2b.com) é a FONTE ÚNICA dos 3 servidores (ordem do
  dono, 25/07): toda mudança daqui vale pros 3. 1º espelho FEITO em
  26/07 (v65b → main de New-repository e Teste), com o estado antigo
  preservado no branch backup-pre-espelho-20260726 de cada repo (lá está
  o mod-dol-monitor.js e os arquivos removidos de propósito). TODA
  entrega nova precisa reespelhar: push --force do main daqui pros mains
  dos 2 repos (comandos em README_SERVIDORES.txt).
- Bot de coleta ("Nova Planilha do DOL") foi REESCRITO neste repo (v35,
  caminho do feed ZIP + rascunho/publicação manual, testado no smoke com
  feed falso). Ainda SÓ na produção (conferir antes de sobrescrever, valem
  pouco): orquestrador de temporadas históricas e mod-dol-monitor.js (o
  papel de notificação dele já foi substituído pela aba Notícias; o bot da
  planilha randomizada hiberna por ordem do dono).
- `TEST_LOGIN_TOKEN`: NUNCA definir em produção (é só do npm test).
- Fila futura: gateway de pagamento (aguarda chaves), Play Store (TWA),
  espanhol/inglês, consolidar telas financeiras do admin.

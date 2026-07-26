════════════════════════════════════════════════════════════════════
 H2BApply — 1 CÓDIGO, 3 SERVIDORES (guia mestre — 25/07/2026)
 Substitui o README_SERVIDOR2.txt. ESTE repositório (Applyh2b.com) é a
 FONTE ÚNICA: tudo que for editado aqui vale para os 3 servidores.
════════════════════════════════════════════════════════════════════

OS 3 SERVIDORES
------------------------------------------------
  Servidor 1 → https://h2bapply.com            (repo antigo: New-repository)
  Servidor 2 → https://h2b-teste.onrender.com  (repo antigo: Teste)
  Servidor 3 → https://applyh2b.com            (repo: Applyh2b.com ← FONTE)

O código é IDÊNTICO nos três. Quem diz "quem sou eu" são as ENVS do
Render (e, como rede de segurança, o HOST da requisição — _selfId no
server.js corrige sozinho se a env estiver errada, gritando no log).

Em QUALQUER servidor o visitante tem a escolha do servidor dele:
  • Landing → pill "🌐 Servidores" abre o seletor com os 3.
  • Login → digita o e-mail e o /api/auth/where LOCALIZA em qual
    servidor a conta existe, com botão direto pra lá (?entrar=1).
  • v61: o card de login também tem "🌐 Ver todos os servidores" —
    inclusive quando a conta "não foi encontrada" (se um servidor
    irmão estiver fora do ar, a busca é fail-open e pode não achar;
    a pessoa ainda consegue navegar até o servidor certo à mão).
  • Cadastro novo: só em servidor com status "aberto" (hoje, só o 3;
    a trava de conta única impede segunda conta em outro servidor).
  • Admin: e-mail de admin vê os 3 servidores e entra em qualquer um.

════════════════════════════════════════════════════════════════════
 COMO ATUALIZAR OS SERVIDORES 1 E 2 COM O CÓDIGO DAQUI (espelho)
════════════════════════════════════════════════════════════════════
🤖 ESPELHO AUTOMÁTICO (26/07): existe uma GitHub Action
(.github/workflows/espelho.yml) que replica TODO push do main daqui
pros repos dos Servidores 1 e 2 sozinha — os 3 Renders publicam juntos.
Pra ela funcionar, o dono precisa criar UMA vez o secret MIRROR_TOKEN
(passo a passo no topo do próprio arquivo espelho.yml). Enquanto o
secret não existir, a Action falha com aviso e o espelho é manual
(comandos abaixo).

O fluxo antigo era o contrário (New-repository → espelho aqui). AGORA
A FONTE É ESTE REPO. Para levar o código daqui para os outros dois:

  git clone https://github.com/andriokick18-cmyk/Applyh2b.com.git
  cd Applyh2b.com
  git remote add srv1 https://github.com/<owner>/<repo-do-servidor-1>.git
  git push srv1 main --force        # sobrescreve TUDO no repo do srv 1
  git remote add srv2 https://github.com/<owner>/<repo-do-servidor-2>.git
  git push srv2 main --force        # idem para o srv 2

O Render de cada serviço (que continua ligado ao repo antigo dele)
faz o deploy sozinho ao receber o push. ⚠️ ANTES do primeiro espelho:
conferir se os repos antigos têm algo que só existe lá (orquestrador
de temporadas históricas e mod-dol-monitor.js — ver PENDÊNCIAS no
CLAUDE.md) — o push --force APAGA o que não estiver aqui.

Alternativa sem --force (mais trabalho): apagar os arquivos antigos no
repo destino e subir os daqui — subir por cima NÃO apaga sobras (ex.:
admin-3.html, index-1.html, mod-dol-monitor.js, removidos de propósito).

════════════════════════════════════════════════════════════════════
 MATRIZ DE ENVS (Render → Environment de cada serviço)
════════════════════════════════════════════════════════════════════
                        SERVIDOR 1        SERVIDOR 2           SERVIDOR 3
  SERVER_ID             1                 2                    3
  APP_URL               https://h2bapply.com
                                          https://h2b-teste.onrender.com
                                                               https://applyh2b.com
  GMAIL_SEND_ONLY       (vazio)           (vazio)              1
  GOOGLE_CLIENT_ID/     projeto OAuth     projeto OAuth        projeto OAuth
  GOOGLE_CLIENT_SECRET  próprio           próprio (ou o do 1)  PRÓPRIO (só-envio)

IGUAIS NOS TRÊS (cada um com seus valores):
  ADMIN_EMAIL / ADMIN_EMAIL_2 / ADMIN_EMAILS_EXTRA
  DATA_DIR=/data  + Persistent Disk montado em /data (sem disco o
    sistema liga, mas usa /tmp e PERDE tudo a cada restart)
  DATA_ENC_KEY (frase forte — cifra os tokens Gmail no disco)
  NODE_OPTIONS=--max-old-space-size=360   (em plano de 512 MB — ver 502 abaixo)
  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (push)
  GEMINI_API_KEY (IA) · EDITOR_PWD_ANDREW / EDITOR_PWD_DIEGO
  TEST_LOGIN_TOKEN: NUNCA em produção (só do npm test)

⚠️ OAUTH de cada servidor: no Google Cloud Console, o Client ID usado
precisa autorizar os DOIS redirects daquele host:
  https://<host>/oauth/callback
  https://<host>/oauth/add-sender/callback
Senão o login Google falha só naquele servidor.

CONFIGURAÇÃO DO SERVIÇO (conferir no Render → Settings)
  Build Command: npm install
  Start Command: node server.js   (ou npm start)
  Branch:        main

════════════════════════════════════════════════════════════════════
 🔴 SITE FORA DO AR? DIAGNÓSTICOS REAIS (2 casos já vividos)
════════════════════════════════════════════════════════════════════

CASO 1 — ERR_CONNECTION_TIMED_OUT em applyh2b.com (print 25/07/2026)
------------------------------------------------
Sintoma: "Não é possível acessar esse site / demorou muito para
responder". Isso é ANTES do HTTP — o navegador nem conectou.
Causa encontrada: o DNS de applyh2b.com aponta para 162.255.119.149,
que é o IP do "URL Redirect/parking" da NAMECHEAP (registrador) — e
esse serviço NÃO responde HTTPS: conexão na porta 443 morre em
timeout. Compare: h2bapply.com aponta para 216.24.57.1 (Render) e abre.
Ou seja: o domínio nunca foi apontado para o Render.

CORREÇÃO (Namecheap + Render, ~10 min + propagação):
  1. Render → serviço do Servidor 3 → Settings → Custom Domains →
     adicionar applyh2b.com e www.applyh2b.com. O Render mostra os
     valores exatos de DNS a usar (A record e CNAME).
  2. Namecheap → Domain List → applyh2b.com → Advanced DNS:
     • REMOVER o "URL Redirect Record" do host @ (é ele o vilão).
     • Adicionar  A Record     @    216.24.57.1   (valor que o Render mostrar)
     • Adicionar  CNAME Record www  <serviço>.onrender.com
  3. Esperar o Render emitir o certificado (fica "Verified") —
     propagação de DNS pode levar de minutos a algumas horas.
  4. Conferir: applyh2b.com deve resolver para IP do Render
     (216.24.57.x), NUNCA mais 162.255.119.x.
  5. DEPOIS que o domínio abrir com cadeado: nos 3 painéis admin
     (Admin → Configurações → 🌐 Servidores), trocar a URL do
     Servidor 3 de https://h2b-server-3.onrender.com para
     https://applyh2b.com (v66b deixou o onrender como URL provisória
     porque o domínio estava morto — seletor e ranking global usam
     essa URL pra alcançar o Servidor 3). E no Render do Servidor 3,
     voltar APP_URL=https://applyh2b.com.
Enquanto isso, o site continua acessível pelo endereço
<serviço>.onrender.com do Servidor 3.

CASO 2 — 502 EM LOOP (Servidor 2, 18/07/2026)
------------------------------------------------
Render mostrou "Instance failed: Ran out of memory (used over 512MB)"
a cada 1-2 min: plano Starter dá 512 MB; o Node passa, o Render mata o
processo e reinicia — quem acessa durante o loop vê 502.
  A) GRÁTIS: env NODE_OPTIONS=--max-old-space-size=360 (obriga o GC a
     limpar antes de estourar) + Manual Deploy → Clear build cache.
  B) DEFINITIVA: plano com 1 GB+ de RAM (o sistema carrega as
     planilhas de vagas inteiras na memória; 512 MB é apertado).
Vale para os 3 servidores — se der 502 "às vezes", abrir EVENTS do
serviço e procurar a mensagem de memória.

COMO LER O PROBLEMA SOZINHO
------------------------------------------------
Render → serviço → EVENTS: diz POR QUE caiu (memória, crash, deploy).
Render → serviço → LOGS:  console do Node (o boot imprime [sheet],
[storage], [reconciliar] etc. — se parar no meio, a última linha diz
onde morreu). Deploy reinicia o processo: 502 de ~1 min é normal.
════════════════════════════════════════════════════════════════════

════════════════════════════════════════════════════════════════════
 H2BApply — SERVIDOR 2 (h2b-teste.onrender.com) — GUIA COMPLETO
 Escrito em 18/07/2026 depois do 502 em loop (print do Render:
 "Ran out of memory (used over 512MB)")
════════════════════════════════════════════════════════════════════

O QUE ESTAVA ACONTECENDO (diagnóstico do print)
------------------------------------------------
O 502 Bad Gateway NÃO era erro no código. O Render mostrou:
  "Instance failed: Ran out of memory (used over 512MB)"
repetindo a cada 1-2 minutos. Tradução: o plano Starter dá 512 MB de
RAM; o Node passou disso, o Render MATA o processo e reinicia — e
enquanto está morto, quem acessa vê 502. É um loop: sobe → estoura →
morre → sobe de novo.

A CORREÇÃO (2 opções — faça a A; a B é a definitiva)
------------------------------------------------
A) GRÁTIS — limitar a memória do Node (faça AGORA):
   No Render do H2bapply2 → Environment → adicionar variável:

     NODE_OPTIONS = --max-old-space-size=360

   Isso obriga o Node a fazer faxina de memória (GC) antes de chegar
   perto dos 512 MB, em vez de crescer até ser morto. Depois de salvar,
   fazer Manual Deploy → Clear build cache & deploy.

B) DEFINITIVA — subir o plano do serviço para um com 1 GB+ de RAM
   (Render → Settings → Instance Type). O sistema carrega as
   planilhas de vagas inteiras na memória; 512 MB é apertado.

⚠️ SERVIDOR 1 TAMBÉM: se o site principal às vezes dá 502 "para
algumas pessoas em alguns momentos", abra os EVENTS do serviço do
servidor 1 no Render e procure a MESMA mensagem "Ran out of memory".
Se aparecer, aplique a mesma correção lá (NODE_OPTIONS e/ou plano
maior). Os outros 502 momentâneos do servidor 1 são normais: cada
deploy reinicia o processo e quem acessa naquele exato minuto vê 502.

COMO ATUALIZAR O SERVIDOR 2 COM O CÓDIGO DO SERVIDOR 1
------------------------------------------------
1. Baixe o ZIP do repositório do servidor 1 (New-repository, branch main).
2. No repositório do servidor 2 (Teste), APAGUE os arquivos antigos
   antes de subir os novos. Subir o zip por cima NÃO apaga o que já
   estava lá — sobra arquivo velho misturado (ex.: admin-3.html,
   index-1.html, mod-dol-monitor.js, que já foram REMOVIDOS do
   código atual de propósito).
3. Suba todos os arquivos do zip (incluindo .gitignore e .env.example).
4. O Render do servidor 2 faz o deploy sozinho do branch main.

VARIÁVEIS DE AMBIENTE DO SERVIDOR 2 (Render → Environment)
------------------------------------------------
  SERVER_ID            = 2
  APP_URL              = https://h2b-teste.onrender.com
  GOOGLE_CLIENT_ID     = (o mesmo do servidor 1, OU um próprio)
  GOOGLE_CLIENT_SECRET = (par do de cima)
  ADMIN_EMAIL          = (seu e-mail)
  ADMIN_EMAIL_2        = (e-mail do Diego, opcional)
  DATA_DIR             = /data
  DATA_ENC_KEY         = (qualquer frase forte — cifra os tokens Gmail)
  GEMINI_API_KEY       = (se quiser IA no servidor 2)
  NODE_OPTIONS         = --max-old-space-size=360   ← A CORREÇÃO DO 502
  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (push, opcional)

⚠️ OAUTH: no Google Cloud Console, o redirect
  https://h2b-teste.onrender.com/oauth/callback
precisa estar autorizado no MESMO Client ID usado aqui — senão o
login Google falha só no servidor 2.

⚠️ DISCO: o serviço precisa de um Persistent Disk montado em /data
(Render → Disk). Sem ele o sistema LIGA mesmo assim, mas avisa no log
e usa /tmp — aí usuários/tokens somem a cada restart.

CONFIGURAÇÃO DO SERVIÇO (conferir no Render → Settings)
------------------------------------------------
  Build Command: npm install
  Start Command: node server.js   (ou npm start)
  Branch:        main

COMO LER O PROBLEMA SOZINHO DA PRÓXIMA VEZ
------------------------------------------------
Render → serviço → EVENTS: diz POR QUE caiu (memória, crash, deploy).
Render → serviço → LOGS:  mostra o console do Node (o boot imprime
[sheet], [storage], [reconciliar] etc. — se parar no meio, a última
linha diz onde morreu).
════════════════════════════════════════════════════════════════════

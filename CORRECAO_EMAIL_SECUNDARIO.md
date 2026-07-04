# 🔧 Correção: E-mail secundário não reativava (relato do Diego, 03/07)

## O problema (traduzido do áudio)
Quando o usuário adiciona um e-mail secundário e, depois de um tempo, o
Google pede novo login, o "toquinho" (toggle de ativar) NÃO reativava.
O usuário não conseguia religar o envio pelo e-mail secundário.

## A causa raiz (2 bugs no fluxo /oauth/add-sender)
1. **Callback só sabia CRIAR, não RENOVAR**: se o e-mail já existia, o código
   retornava o erro "Este Gmail já está adicionado" e descartava o token novo.
   O token velho/expirado continuava salvo → toggle nunca reativava.
2. **Bloqueio de limite atrapalhava a reconexão**: quem já estava no máximo de
   e-mails não conseguia nem reautenticar os que já tinha (batia em "Limite atingido").

## A correção
1. O callback agora DETECTA e-mail já existente e faz **re-autenticação**:
   atualiza access_token + refresh_token, e força `tokenExpired:false,
   blocked:false, active:true` → o toquinho religa sozinho.
   (Mantém o refresh_token antigo se o Google não reenviar um novo.)
2. `/oauth/add-sender?reauth=1` ignora o limite (é renovação, não adição).
3. **Front**: senders com token expirado/inativo ganham botão azul
   "🔄 Reconectar" que leva ao fluxo de reauth. Toast de sucesso ao voltar.

## Resultado
Fluxo do usuário agora: vê "⚠️ Precisa reconectar" → toca em "Reconectar" →
escolhe a conta Google → volta com "Gmail reconectado e reativado ✓" → robô volta.

Testado: 74/74 testes passando + boot OK nas duas versões (normal e celular).

# ✅ Google OAuth Verification Checklist — H2BApply

**Gerado em:** Junho 2026 · **Atualizado em:** 26/07/2026 (Servidor 3)  
**App:** H2BApply (h2bapply.com) · **Servidor 3:** applyh2b.com (só-envio)  
**OAuth Client:** Google Cloud Console → APIs & Services → Credentials

---

## 🚀 SERVIDOR 3 (applyh2b.com) — PLANO DE ATAQUE 26/07/2026

É AQUI que todo cadastro novo entra — e o app não verificado tem teto de
~100 usuários no consentimento. A verificação DERRUBA o teto e tira o
aviso amarelo assustador do login. Com o modo SÓ-ENVIO (1 escopo:
gmail.send), este é o caminho mais fácil que o app já teve.

**PRÉ-REQUISITO (bloqueia tudo):** o DNS de applyh2b.com precisa apontar
pro Render e abrir com cadeado (README_SERVIDORES, Caso 1). O Google
visita o site do domínio durante a análise — domínio morto = reprovação.

**PASSO A PASSO (conta suporteh2bapply@gmail.com, ~30 min + espera):**
1. search.google.com/search-console → adicionar propriedade
   `applyh2b.com` → verificar (DNS TXT na Namecheap ou HTML tag).
2. Google Cloud Console (projeto do Servidor 3) → OAuth consent screen:
   - App name: `H2BApply` · Support email: suporteh2bapply@gmail.com
   - App logo: ícone 120x120 (usar o icon-512.png reduzido)
   - App domain: `https://applyh2b.com` · Privacy: `https://applyh2b.com/privacy`
     · Terms: `https://applyh2b.com/terms`
   - Authorized domains: `applyh2b.com` (e `onrender.com` NÃO — remova se estiver)
3. Mesma tela → Scopes → confirmar que só existe:
   `openid`, `email`, `profile`, `.../auth/gmail.send`
4. Publishing status → **Publish app** → botão **Prepare for verification**.
5. JUSTIFICATIVA DO ESCOPO gmail.send (colar em inglês):
   > H2BApply helps Brazilian workers apply to U.S. seasonal jobs (H-2B/H-2A
   > visas) listed publicly by the U.S. Department of Labor. The user writes
   > their own application e-mails and attaches their own resume; the app
   > sends these applications FROM the user's own Gmail account, one by one,
   > only to employers the user selected. gmail.send is the only Gmail scope
   > requested: the app cannot read, modify or delete any mailbox content.
   > Each send is user-initiated (manually or via a queue the user starts,
   > pauses and stops at any time).
6. VÍDEO de demonstração (roteiro pronto em
   GOOGLE_VERIFICATION_VIDEO_SCRIPT.md — gravar em applyh2b.com,
   mostrando: login → consent com 1 escopo só → usuário escreve os
   próprios textos → envio → o e-mail aparece em "Enviados" DO GMAIL DO
   USUÁRIO). Subir como link não listado no YouTube.
7. Enviar e responder os e-mails do time de verificação (chegam no
   suporteh2bapply@gmail.com — responder SEMPRE em inglês, rápido).

**Enquanto a verificação não sai:** o aviso amarelo continua (normal) e o
teto de 100 vale — se apertar, os primeiros ~100 são os early users e a
verificação vira urgência máxima.

---

## 🟢 JÁ ESTÁ CORRETO

| Item | Status | Detalhes |
|------|--------|----------|
| **Escopos mínimos** | ✅ | Apenas: `openid`, `email`, `profile`, `gmail.send` |
| **Sem escopos desnecessários** | ✅ | Sem `gmail.readonly`, `gmail.modify`, `mail.google.com` |
| **Página de Privacidade** | ✅ | `/privacy` e `/privacidade` — completa e atualizada |
| **Página de Termos** | ✅ | `/terms` e `/termos` |
| **Página de Exclusão de Conta** | ✅ | `/delete-account` — exigida pelo Google |
| **Verificação de domínio** | ✅ | `google380652ea59ad95e1.html` presente |
| **HTTPS** | ✅ | Render.com fornece SSL automático |
| **Email de suporte** | ✅ | suporte@h2bapply.com |
| **Domínio oficial** | ✅ | h2bapply.com |
| **robots.txt** | ✅ | Adicionado — `/robots.txt` |
| **sitemap.xml** | ✅ | Adicionado — `/sitemap.xml` |
| **Página google-data-usage** | ✅ | `/google-data-usage` — explica uso dos dados |
| **Página oauth-explanation** | ✅ | `/oauth-explanation` — para usuários entenderem |
| **Política de Limited Use** | ✅ | Declarada na `/privacy` e `/google-data-usage` |
| **Revogação de token** | ✅ | Tokens revogados ao excluir conta |
| **State parameter no OAuth** | ✅ | CSRF protection implementada |
| **Rate limit no OAuth** | ✅ | 15 tentativas por 15 minutos |

---

## 🔴 AINDA PRECISA FAZER (fora do código)

| Item | Prioridade | Ação Necessária |
|------|-----------|-----------------|
| **Verificar domínio no Google Search Console** | 🔴 CRÍTICO | Acesse search.google.com/search-console → adicionar h2bapply.com → verificar via HTML tag |
| **Verificar domínio no Google Cloud Console** | 🔴 CRÍTICO | GCC → OAuth consent screen → Authorized domains → adicionar h2bapply.com |
| **Logo do app** | 🟡 IMPORTANTE | Fazer upload de ícone 120x120px no GCC → OAuth consent screen |
| **Nome do app na consent screen** | 🟡 IMPORTANTE | GCC → "H2BApply" (exatamente) |
| **Homepage URL** | 🟡 IMPORTANTE | GCC → https://h2bapply.com |
| **Privacy Policy URL** | 🟡 IMPORTANTE | GCC → https://h2bapply.com/privacy |
| **Terms of Service URL** | 🟡 IMPORTANTE | GCC → https://h2bapply.com/terms |
| **Mover de "Testing" para "Production"** | 🔴 CRÍTICO | GCC → OAuth consent screen → PUBLISH APP |
| **Submeter para verificação** | 🔴 CRÍTICO | GCC → OAuth consent screen → Submit for verification |
| **Gravar vídeo de verificação** | 🟡 IMPORTANTE | Ver GOOGLE_VERIFICATION_VIDEO_SCRIPT.md |
| **Criar email privacidade@h2bapply.com** | 🟡 RECOMENDADO | Para contato DPO |

---

## ⚠️ RISCOS IDENTIFICADOS

| Risco | Severidade | Mitigação |
|-------|-----------|-----------|
| App em modo "Testing" com limite de 100 usuários | 🔴 BLOQUEANTE | Publicar app no GCC |
| Usuários vendo "App não verificado" | 🔴 BLOQUEANTE | Submeter para verificação Google |
| Sem logo na consent screen | 🟡 MÉDIO | Upload de logo 120x120 |
| `gmail.send` é escopo sensível | 🟡 MÉDIO | Requer verificação formal + vídeo + justificativa |

---

## 📋 PASSOS FINAIS EM ORDEM

1. Fazer deploy deste código no Render
2. Confirmar que https://h2bapply.com/privacy funciona
3. Confirmar que https://h2bapply.com/google-data-usage funciona
4. Confirmar que https://h2bapply.com/robots.txt funciona
5. Acessar console.cloud.google.com
6. APIs & Services → OAuth consent screen
7. Preencher: App name = "H2BApply", Support email, Homepage, Privacy URL, Terms URL
8. Fazer upload do logo (120x120 PNG)
9. Adicionar domínio h2bapply.com em "Authorized domains"
10. Clicar em "PUBLISH APP" (sair do modo Testing)
11. Clicar em "Submit for verification"
12. Preencher justificativa dos escopos (ver GOOGLE_OAUTH_MASTER_AUDIT.md)
13. Enviar o vídeo gravado (ver GOOGLE_VERIFICATION_VIDEO_SCRIPT.md)
14. Aguardar aprovação (tipicamente 4-6 semanas para gmail.send)

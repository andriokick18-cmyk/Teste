# ✅ Google OAuth Verification Checklist — H2BApply

**Gerado em:** Junho 2026  
**App:** H2BApply (h2bapply.com)  
**OAuth Client:** Google Cloud Console → APIs & Services → Credentials

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

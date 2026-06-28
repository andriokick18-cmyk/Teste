════════════════════════════════════════════════════════════
  H2BApply — GUIA RÁPIDO DE DEPLOY (Render.com)
  Versão: v9.7 · 28/06/2026
════════════════════════════════════════════════════════════

O QUE MUDOU NESTA VERSÃO (v9.7)
- Gemini do site mais completo: o dossiê ganhou a seção "Arquitetura
  Técnica & Regras de Desenvolvimento" (ele já sabe tudo a cada auditoria).
- Mantém tudo das versões anteriores (Pagantes, cadastro limpo, etc.).

────────────────────────────────────────────────────────────
COMO SUBIR (escolha o seu jeito)
────────────────────────────────────────────────────────────

IMPORTANTE: use os arquivos de DENTRO desta pasta (server.js, index.html,
admin.html, guia.html, etc.). NÃO suba a pasta "work19" inteira — os
arquivos têm que ficar na RAIZ do projeto, onde estão os atuais.

OPÇÃO A — GitHub → Render (recomendado, seu fluxo normal):
  1. Substitua os arquivos no seu repositório pelos desta pasta.
  2. Commit + push.
  3. O Render builda e reinicia sozinho. Pronto.

OPÇÃO B — Upload direto no Render:
  1. Envie os arquivos novos (no mínimo server.js e index.html).
  2. Deixe o serviço reiniciar.

────────────────────────────────────────────────────────────
SOBRE OS DADOS E O "TREINAMENTO" DO GEMINI
────────────────────────────────────────────────────────────
- O disco /data NÃO é apagado no deploy. Usuários, pagamentos, pedidos e a
  base de conhecimento (knowledge_base.json) continuam intactos.
- O "treinamento" do Gemini é a Base de Conhecimento (KB-001…KB-029) embutida
  no server.js. Ao reiniciar, as entradas novas entram sozinhas (merge — só
  soma, nunca apaga). Você não precisa fazer nada manual.
- O Gemini usa esse conhecimento quando você roda o "Robô de Auditoria" no
  painel admin. A cada auditoria ele relê toda a memória acumulada.

────────────────────────────────────────────────────────────
CHECAGEM PÓS-DEPLOY (30 segundos)
────────────────────────────────────────────────────────────
  [ ] Site abre normal (login Google funciona).
  [ ] Admin: aba "Pagantes" carrega quem pagou + dias de VIP.
  [ ] Admin: "Central de Incidentes" abre e baixa relatório.
  [ ] Cadastro novo: avatares do ranking aparecem como círculos pequenos.

Se algo falhar, me avise com o erro exato (print/console) que eu corrijo.
════════════════════════════════════════════════════════════

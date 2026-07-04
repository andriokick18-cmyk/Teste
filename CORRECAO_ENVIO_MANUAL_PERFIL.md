# 🔧 Correção: "Perfil preenchido mas envio manual diz que não existe currículo"
### Relato do cliente (03/07): perfil "Landscaping" com currículo E cover letter vinculados, mas ao enviar manual dava erro de perfil/currículo inexistente.

## Causa raiz (bug de dessincronização de cache)
O app guardava a lista de perfis em DUAS variáveis: `U.profiles` e `UPROFILES`.
Diferentes partes do código liam em ordens DIFERENTES:
- `renderModalProfiles()` (desenha os perfis no modal) → lia `UPROFILES` primeiro
- `applyModalProfileById()` (aplica o perfil escolhido) → lia `U.profiles` primeiro

Quando as duas listas divergiam (acontece após salvar/editar perfil em certos fluxos),
o modal DESENHAVA o perfil "Landscaping", mas ao clicar nele o código procurava o ID
na outra lista, não achava (`if(!p)return`) e **saía sem carregar o currículo, assunto
e corpo** — dando a impressão de "perfil não existe / sem currículo".

## Correções aplicadas
1. **Fonte única de perfis**: TODOS os pontos agora leem na mesma ordem canônica
   (`UPROFILES` primeiro). Padronizados 4 locais divergentes.
2. **Currículo do perfil sempre anexável**: ao selecionar um perfil no modal, se o CV
   dele não estiver na lista DOCS (cache dessincronizado), o app injeta a referência a
   partir do próprio perfil — o currículo nunca mais "some".
3. **Bug do índice 0 (`0`-falsy)**: `activeResIdx || undefined` transformava um índice
   0 válido em "sem currículo". Trocado por `!= null` em 4 pontos (2 no front, 2 no
   servidor: `getAtt` e a montagem de anexos). Defensivo — evita a classe inteira do bug.

## Resultado
O cliente seleciona "Landscaping" → assunto, corpo e currículo carregam corretamente →
envio manual anexa o PDF certo. Sem mais falso "não existe no seu perfil".

Testado: 74/74 testes + boot OK nas duas versões (normal e celular).

# O que foi apagado — sistema de busca/coleta de planilhas do DOL

Pedido do dono (07/07/2026): apagar tudo que foi criado nos últimos dias para
buscar/identificar planilhas novas na DOL (Julho 2026, temporadas anteriores),
mantendo **só** o robô original de enriquecimento.

## O que CONTINUA existindo (não foi tocado)

**`_enrichBot`** — o primeiro robô, o de enriquecimento de planilha.
- Arquivo: `server.js` — `_enrichBot`, `_enrichLog`, `_runEnrichBot`,
  `_saveEnrichedSheet`, `_autoEnrichCycle`.
- Rotas: `/api/admin/enrich/*`.
- Painel: aba "Planilhas & Enriquecimento" → botão "Re-enriquecer" em cada
  planilha, log em tempo real (`#enrich-log`).
- Upload manual de planilha pronta (`Upload JSON`) — também intacto.
- Planilhas built-in (Jan 2026, Jul 2025, H-2A) — carregamento estático
  intacto, sem mudança.

## O que foi APAGADO por completo

### 1. Bot de Construção via DOL Advanced Search (`_dolBuildBot`)
Buscava vagas direto da API do DOL a partir de um link "Advanced Search"
colado pelo admin, com filtro de data (`begin_date`).
- `server.js`: `_dolBuildBot`, `_dolBuildLog`, `_parseDolAdvancedUrl`,
  `_runDolBuildBot` (incluindo a versão mais recente de 2 fases: listar case
  numbers → buscar cada vaga individualmente por case number).
- Rotas: `/api/admin/sheet/build-from-dol`, `build-status`, `build-stop`,
  `build-publish`.
- Painel: card verde "Criar Planilha via DOL Advanced Search" + modal "Nova
  Planilha do DOL" (link, visto, nome, chave, quantidade).
- JS: `dolBuildOpenModal`, `dolSetQty`, `dolPrefillJul2026`,
  `dolBuildLogLine`, `dolBuildStart`, `dolBuildShowProgress`,
  `dolBuildStartPoll`, `dolBuildStopPoll`, `dolBuildPoll`, `dolBuildStop`,
  `dolBuildPublish`, `dolBuildReset`.

### 2. Coleta de Temporadas Históricas (Jan 2025 / FY23–25)
Reusava o bot acima para reconstruir temporadas passadas (Jul 2022 → Jan
2025) uma de cada vez.
- `server.js`: `HISTORICAL_SEASONS`, `_histSearchUrl`,
  `_REMOVED_HISTORICAL_KEYS`, `_cleanupRemovedHistoricalSeasons`,
  `_runHistoricoOrchestrator`, `_histBuild`, `_histLog`.
- Rotas: `/api/admin/sheet/historico-status`, `historico-collect-all`,
  `historico-refazer`, `historico-refazer-todas`.
- Painel: card azul "Coletar Verão 2025 (Jan 2025)".
- JS: `histBuildStart`, `histBuildPoll`, `histRefazer`, `histRefazerTodas`.

### 3. Vigia de Julho 2026 (`NEXT_SEASON`)
Sondava o DOL a cada 5 minutos e, ao achar a temporada, coletava e publicava
sozinho.
- `server.js`: `NEXT_SEASON`, `_nextSeasonWatch`,
  `_probeNextSeasonAvailable`, `_nextSeasonWatchTick` (+ `setInterval`/
  `setTimeout` que ligavam o vigia no boot).
- Rotas: `/api/admin/sheet/next-season-status`, `next-season-check-now`.
- Painel: card roxo "Vigia de Julho 2026".
- JS: `nextSeasonPoll`, `nextSeasonCheckNow`, `_timeAgo`.

### 4. UI de "Temporadas Anteriores" e placeholder "Em Breve"
- `index.html`: seção recolhível `#hist-seasons-wrap` (Manual) e
  `#hist-seasons-wrap-auto` (Automático), botões placeholder
  `#stab-jul2026-placeholder` / `#source-btn-jul2026-placeholder` com efeito
  brilhante (`.em-breve`), funções `toggleHistSeasons` /
  `toggleHistSeasonsAuto`.
- A barra principal de abas voltou a ser exatamente como era antes: Seasonal
  Jobs, Jan 2026, Jul 2025, H-2A Agricultura — 4 abas fixas, sem seção extra.

## O que NÃO foi tocado (mesmo estando por perto)

- **Monitor DOL (Anúncios)** (`mod-dol-monitor.js`, aba "📰 Monitor DOL") —
  isso é outra coisa: fica de olho nos comunicados/anúncios públicos da DOL
  (não busca vaga nenhuma). Não é um dos bots que você mandou criar pra
  planilha, então deixei como estava.
- `/api/sheets-list` — endpoint genérico que lista qualquer planilha
  publicada (built-in + extras). Isso já existia antes da sua sequência de
  pedidos recentes (serve o Upload JSON manual e o H-2A também), então
  mantive — só removi o campo `historico` que não tem mais uso.

## Estado herdado no seu servidor ao vivo

O código que gerava as planilhas "Jan 2025" e "Julho 2026 (2.673 vagas
erradas)" foi apagado, mas os **arquivos/registros que já foram publicados**
continuam no seu servidor até você mandar removê-los — o próprio painel já
tem o botão "Remover" em cada card de planilha extra. Recomendo:
1. Subir este código.
2. No painel, clicar em "Remover" nas planilhas "Jan 2025" e "Julho 2026"
   que sobraram da coleta antiga (se ainda estiverem lá).

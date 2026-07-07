/* ═══════════════════════════════════════════════════════════════════════
   📰 mod-dol-monitor.js — Robô Monitor de Anúncios DOL (Parte 2)

   O QUE FAZ:
   Fica checando https://www.dol.gov/agencies/eta/foreign-labor/news a cada
   5 minutos. Quando o DOL publica um novo "PublicFacingReport" (o relatório
   oficial de grupos de randomização A–H do H-2B — o mesmo tipo de arquivo
   que hoje é subido manualmente em Monitor ETA → Importar report), o robô:
     1) acha o link novo (padrão de nome sempre .../..PublicFacingReport.xlsx)
     2) baixa o .xlsx sozinho
     3) lê o .xlsx (sem depender de nenhuma lib externa — parser próprio
        de ZIP/XLSX, só com módulos nativos do Node: zlib/https)
     4) converte pras mesmas linhas que o upload manual usa e chama as
        MESMAS funções já existentes (etaParseGruposCSV, persistGruposOficiais,
        etaAplicarGruposOficiais) — zero duplicação de lógica de negócio.
     5) marca aquele link como "já importado" (não importa de novo)
     6) tudo fica visível numa janela de log em tempo real no admin.

   Contrato (mesmo padrão dos outros mod-*.js do projeto):
     createDolMonitorRouter(ctx) → async (req,res,pathname) → true/false
     startDolMonitor(ctx)        → liga o setInterval de 5 em 5 minutos

   ═══════════════════════════════════════════════════════════════════════
   🩹 V3 (06/07/2026) — pedido do dono, 3 correções nesta edição:

   (A) HTTP 403 no download ao vivo — reforçado ainda mais o disfarce de
       navegador real (V2 já tinha corrigido o Accept-Encoding; agora
       adicionamos: Agent keep-alive reaproveitando conexão TCP/TLS — sites
       .gov com WAF (Akamai/Cloudflare) desconfiam de conexão nova a cada
       request —, o conjunto completo de headers Sec-Fetch-(Dest/Mode/Site)
       e sec-ch-ua que um Chrome real sempre manda, Referer apontando pra página de
       anúncios de onde o link "foi clicado", e RETRY automático (até 3
       tentativas com backoff) especificamente para 403/429/5xx/timeout,
       que costumam ser bloqueios momentâneos de rate-limit. Se mesmo
       assim falhar, agora o log mostra o STATUS + um pedaço do corpo da
       resposta do WAF (antes só dizia "HTTP 403" sem contexto nenhum —
       impossível diagnosticar às cegas).
   (B) BUG CRÍTICO ENCONTRADO NA AUDITORIA (não pedido explicitamente, mas
       bloqueava o objetivo do dono): como o arquivo dol_monitor_state.json
       ainda não existe em produção (robô novo), na primeíssima vez que o
       ciclo de 5 em 5 min rodasse de verdade, ele ia encontrar o link de
       Janeiro/2026 (que já está na página hoje) como "nunca visto" e ia
       IMPORTAR E AVISAR OS PAGANTES DE VERDADE dizendo que "a lista saiu"
       — sendo notícia velha de janeiro. Agora a PRIMEIRA checagem real só
       faz um "baseline": marca tudo que já está publicado como "já
       conhecido" (sem baixar, sem notificar ninguém) e loga isso
       claramente. Daí em diante, só um relatório GENUINAMENTE NOVO (o de
       Julho/2026, quando sair) aciona o fluxo completo de importar +
       avisar pagantes.
   (C) SEPARAÇÃO TOTAL DE JANELAS — pedido explícito do dono: "quero os
       dois separados, duas janelas". Antes, o log do botão de teste
       (Janeiro) e o log do robô de produção (roda sozinho a cada 5min,
       vai pegar Julho) se misturavam no MESMO array/janela. Agora são
       dois arrays independentes (state.log = produção · state.testLog =
       teste) com duas caixas de log distintas no admin. E para nenhuma
       lógica de negócio divergir entre os dois caminhos (o pedido do
       dono: "toda vez que editar um, edita o outro igual"), o download+
       parse+merge de grupos foi extraído para UMA função única
       (runGruposPipeline) chamada tanto pelo ciclo real quanto pelo botão
       de teste — daqui pra frente qualquer ajuste nessa função vale pros
       dois automaticamente, é fisicamente a mesma linha de código.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const https = require("https");
const zlib  = require("zlib");
const fs    = require("fs");
const path  = require("path");

const ANNOUNCEMENTS_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos, como pedido

// URL real e estável do relatório de Janeiro/2026 (já publicado pelo DOL) —
// usada SÓ pelo botão de teste, pra provar que o robô consegue acessar,
// baixar e processar o mesmo tipo de arquivo que a produção vai buscar em
// Julho/2026, sem esperar a de Julho sair.
const JAN_TEST_URL = "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY26_JanPeak_PublicFacingReport.xlsx";

// Pool pequeno de User-Agents reais e recentes de Chrome/Edge desktop —
// usado só pra variar entre tentativas de retry (alguns WAFs de sites .gov
// penalizam requests repetidos com a MESMA assinatura exata em sequência).
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

// ────────────────────────────────────────────────────────────────────────
//  RANKING CRONOLÓGICO — V4 (06/07/2026), correção de INCIDENTE REAL:
//  a página de anúncios lista TAMBÉM relatórios históricos (FY23, FY24,
//  FY25...), não só o mais recente. Antes da V4, qualquer link "nunca
//  visto" era tratado como "notícia nova" e disparava e-mail real pros
//  pagantes — o que causou, em produção, 5 alertas reais (17 pagantes
//  cada) sobre relatórios de 2023/2024/2025. reportRank() dá um número
//  comparável (FY*2 + 0=Jan/1=Jul) pra só considerar "notícia nova de
//  verdade" o relatório com rank MAIOR que o mais recente já conhecido.
//
//  🔒 V5 (07/07/2026) — SEGUNDO INCIDENTE REAL: mesmo com a V4, chegou um
//  alerta falso de "planilha de 2024" pros pagantes. Causa-raiz encontrada
//  em auditoria: (a) reportRank() só entendia ano com 2 dígitos ("FY24") —
//  se o DOL nomeia esse arquivo específico com 4 dígitos ("FY2024"), o
//  regex ainda casa (\d+ aceita qualquer quantidade de dígitos), mas
//  parseInt("2024") vira um rank ABSURDAMENTE alto (2024*2=4048) comparado
//  ao rank de 2 dígitos usado pra tudo mais (FY26=52) — parece "o relatório
//  mais novo do universo" sem ser. (b) MAIS GRAVE: se o nome do arquivo não
//  bate com o padrão NENHUM jeito (rank=null), o código tick() tratava isso
//  como "notícia nova por segurança" — ou seja, qualquer nome fora do
//  padrão dispara e-mail de verdade. Essas duas falhas juntas tornavam
//  IMPOSSÍVEL confiar 100% no auto-aviso. Corrigido: (1) normaliza ano de 4
//  dígitos pros últimos 2 (2024→24), então nunca mais infla o rank; (2)
//  rank=null NUNCA mais aciona aviso automático — importa em silêncio e
//  pede confirmação manual do admin (botão "Avisar agora" já existente).
// ────────────────────────────────────────────────────────────────────────
function reportRank(urlOrName) {
  const name = String(urlOrName || "").split("/").pop() || "";
  const m = /FY(\d+)_?(Jan|July|Jul)Peak/i.exec(name);
  if (!m) return null;
  let fy = parseInt(m[1], 10);
  if (fy > 100) fy = fy % 100; // normaliza "2024" → 24 (nunca deixa o ano de 4 dígitos inflar o rank)
  const half = /^jan/i.test(m[2]) ? 0 : 1;
  return fy * 2 + half;
}

// Candidatos históricos conhecidos (FY23–FY26 Jan). FY26_Jul propositalmente
// FORA daqui — esse é o alvo real da produção (Julho/2026), não histórico.
// Nome do arquivo de Julho variou entre anos (JulPeak vs JulyPeak) — por
// isso cada período de julho tem 2 variações tentadas em ordem.
const HIST_CANDIDATES = [
  { label: "FY23 Jan", icon: "☀️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY23_JanPeak_PublicFacingReport.xlsx"] },
  { label: "FY23 Jul", icon: "❄️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY23_JulyPeak_PublicFacingReport.xlsx", "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY23_JulPeak_PublicFacingReport.xlsx"] },
  { label: "FY24 Jan", icon: "☀️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY24_JanPeak_PublicFacingReport.xlsx"] },
  { label: "FY24 Jul", icon: "❄️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY24_JulyPeak_PublicFacingReport.xlsx", "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY24_JulPeak_PublicFacingReport.xlsx"] },
  { label: "FY25 Jan", icon: "☀️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY25_JanPeak_PublicFacingReport.xlsx"] },
  { label: "FY25 Jul", icon: "❄️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY25_JulyPeak_PublicFacingReport.xlsx", "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY25_JulPeak_PublicFacingReport.xlsx"] },
  { label: "FY26 Jan", icon: "☀️", urls: ["https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY26_JanPeak_PublicFacingReport.xlsx"] },
];

// ────────────────────────────────────────────────────────────────────────
//  ESTADO (em memória + persistido em disco pra sobreviver a restart)
// ────────────────────────────────────────────────────────────────────────
const state = {
  enabled: true,
  checking: false,
  phase: "idle",           // idle | verificando | baixando | processando | concluido | erro
  lastCheckAt: null,
  nextCheckAt: null,
  lastReport: null,        // {url, importedAt, rows, added, fonte}
  imported: [],            // urls já importadas (não repete)
  baselined: false,        // V3: true depois da 1ª checagem real (evita notificar sobre relatórios antigos)
  latestKnownRank: null,   // V4: rank (reportRank) do relatório mais recente já confirmado — só um rank MAIOR vira "notícia nova" de verdade
  log: [],                 // {ts,msg,type} — janela de PRODUÇÃO (ciclo automático de 5min)
  testLog: [],             // {ts,msg,type} — janela de TESTE (botão manual, Janeiro/2026)
  histLog: [],             // {ts,msg,type} — janela do BACKFILL HISTÓRICO (FY23–FY26)
};

function log(msg, type = "info") {
  state.log.unshift({ ts: Date.now(), msg: String(msg).slice(0, 500), type });
  if (state.log.length > 250) state.log.length = 250;
  console.log(`[dol-monitor] ${msg}`);
}

// Janela separada do teste — reiniciada a cada novo "Rodar teste completo"
// pra sempre mostrar só os passos da última rodada (pedido do dono: janelas
// separadas e claras, sem se misturar com o robô de produção).
function logTest(msg, type = "info") {
  state.testLog.unshift({ ts: Date.now(), msg: String(msg).slice(0, 500), type });
  if (state.testLog.length > 150) state.testLog.length = 150;
  console.log(`[dol-monitor:TESTE] ${msg}`);
}

// Janela separada do backfill histórico (FY23–FY26) — 3ª janela independente.
function logHist(msg, type = "info") {
  state.histLog.unshift({ ts: Date.now(), msg: String(msg).slice(0, 500), type });
  if (state.histLog.length > 200) state.histLog.length = 200;
  console.log(`[dol-monitor:HISTÓRICO] ${msg}`);
}

// ────────────────────────────────────────────────────────────────────────
//  PERSISTÊNCIA (sobrevive a deploy/restart — mesma convenção do resto)
// ────────────────────────────────────────────────────────────────────────
function stateFile(DATA_DIR) { return path.join(DATA_DIR, "dol_monitor_state.json"); }

function loadState(DATA_DIR) {
  try {
    const f = stateFile(DATA_DIR);
    const existiaAntes = fs.existsSync(f);
    if (existiaAntes) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      state.enabled = d.enabled !== false;
      state.imported = Array.isArray(d.imported) ? d.imported : [];
      state.lastReport = d.lastReport || null;
      state.lastCheckAt = d.lastCheckAt || null;
      // Se o arquivo já existia mas é de uma versão anterior a V3 (sem o
      // campo baselined), considera que já rodou antes de verdade — não
      // precisa fazer baseline retroativo (evita reprocessar histórico).
      state.baselined = d.baselined !== false;
      // V4: recupera latestKnownRank. Se o arquivo é de uma versão anterior
      // a V4 (campo ainda não existia), RECONSTRÓI a partir do maior rank
      // entre os relatórios já importados — protege quem já estava em
      // produção antes desta correção (evita re-notificar sobre o que já
      // foi importado como "histórico" por engano antes do fix).
      if (typeof d.latestKnownRank === "number") {
        state.latestKnownRank = d.latestKnownRank;
      } else {
        const ranks = state.imported.map(reportRank).filter((r) => r != null);
        state.latestKnownRank = ranks.length ? Math.max(...ranks) : null;
        if (ranks.length) log(`🩹 Migração V4: latestKnownRank reconstruído a partir do histórico já importado (${state.latestKnownRank})`, "info");
      }
      log(`Estado carregado do disco (${state.imported.length} relatório(s) já importado(s))`, "info");
    } else {
      // Primeiro boot desse robô nesse servidor: NÃO baselined ainda —
      // a 1ª checagem real vai marcar os relatórios já publicados hoje
      // como "conhecidos" sem notificar ninguém (ver tick()).
      state.baselined = false;
      state.latestKnownRank = null;
    }
  } catch (e) { console.warn("[dol-monitor] loadState:", e.message); }
}

function persistState(DATA_DIR) {
  try {
    const tmp = stateFile(DATA_DIR) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      enabled: state.enabled, imported: state.imported,
      lastReport: state.lastReport, lastCheckAt: state.lastCheckAt,
      baselined: state.baselined, latestKnownRank: state.latestKnownRank,
    }, null, 2));
    fs.renameSync(tmp, stateFile(DATA_DIR));
  } catch (e) { console.warn("[dol-monitor] persistState:", e.message); }
}

// ────────────────────────────────────────────────────────────────────────
//  HTTP: baixar texto (a página de anúncios) e binário (o .xlsx)
//  Não reaproveita o httpsReq() do resto do sistema de propósito: aquele
//  helper converte tudo pra string/JSON, o que corrompe um arquivo binário
//  como o .xlsx. Aqui mantemos o Buffer intacto.
// ────────────────────────────────────────────────────────────────────────
// Agent com keep-alive: reaproveita a MESMA conexão TCP/TLS entre requests
// — sites .gov atrás de WAF (Akamai etc.) tendem a desconfiar mais de
// conexões novas em rajada do que de uma sessão contínua, como um
// navegador real faz.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 30000 });

function pickUA(attempt) { return UA_POOL[attempt % UA_POOL.length]; }

// 🩹 V2 (06/07/2026): corrigido o HTTP 403 visto em produção. Causa provável:
// "Accept-Encoding: identity" é uma bandeira vermelha pra WAF de site .gov
// (navegador de verdade SEMPRE anuncia gzip/deflate/br) — sozinho isso já é
// suficiente pra alguns firewalls (Akamai etc.) bloquearem como bot. Agora
// pedimos compressão real (como um navegador) e decodificamos a resposta.
// 🩹 V3 (06/07/2026): + Agent keep-alive, + headers Sec-Fetch-*/sec-ch-ua
// completos (um Chrome real sempre manda), + Referer, + retry automático
// com backoff pra 403/429/5xx/timeout, + corpo da resposta anexado ao erro
// quando falha de vez (pra dar pra diagnosticar em vez de só "HTTP 403").
function httpGetOnce(urlStr, { asBuffer, referer, uaIndex, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("URL inválida: " + urlStr)); }
    const headers = {
      "User-Agent": pickUA(uaIndex),
      "Accept": asBuffer
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*;q=0.8"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": referer ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
    };
    if (referer) headers["Referer"] = referer;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      agent: keepAliveAgent, headers,
    }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        const next = new URL(resp.headers.location, urlStr).toString();
        resolve({ redirectTo: next });
        return;
      }
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        if (resp.statusCode !== 200) {
          const snippet = rawBuf.slice(0, 300).toString("utf8").replace(/\s+/g, " ").trim();
          const err = new Error("HTTP " + resp.statusCode + " em " + urlStr + (snippet ? ` — corpo: "${snippet}"` : ""));
          err.status = resp.statusCode;
          err.bodySnippet = snippet;
          reject(err);
          return;
        }
        let buf = rawBuf;
        try {
          const enc = String(resp.headers["content-encoding"] || "").toLowerCase();
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
        } catch (e) { reject(new Error("Falha ao descomprimir resposta (" + e.message + ")")); return; }
        resolve({ data: asBuffer ? buf : buf.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Wrapper com redirect (até 5 saltos) + retry (até 3 tentativas) pra erros
// tipicamente transitórios (403/429/5xx/timeout/erro de rede). onRetry é
// opcional, usado só pra logar a tentativa no lugar certo (produção x teste).
async function httpGet(urlStr, { asBuffer = false, referer = null, timeoutMs = 30000, maxRetries = 3, onRetry = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let current = urlStr, redirects = 0;
      while (true) {
        const r = await httpGetOnce(current, { asBuffer, referer, uaIndex: attempt, timeoutMs });
        if (r.redirectTo) {
          if (++redirects > 5) throw new Error("Excesso de redirecionamentos em " + urlStr);
          current = r.redirectTo;
          continue;
        }
        return r.data;
      }
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
      if (!retryable || attempt === maxRetries - 1) throw e;
      if (onRetry) onRetry(attempt + 1, maxRetries, e);
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1) + Math.random() * 400));
    }
  }
  throw lastErr;
}

// ────────────────────────────────────────────────────────────────────────
//  DETECÇÃO: acha links de PublicFacingReport na página de anúncios
//  Padrão estável observado em todos os relatórios (Jan/2025, Jul/2025,
//  Jan/2026...): .../ETA/oflc/pdfs/FY##_[Jan|Jul]Peak_PublicFacingReport.xlsx
// ────────────────────────────────────────────────────────────────────────
function extractReportLinks(html) {
  const re = /href=["']([^"'\s]*PublicFacingReport\.xlsx)["']/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    if (href.startsWith("//")) href = "https:" + href;
    else if (href.startsWith("/")) href = "https://www.dol.gov" + href;
    out.add(href);
  }
  return [...out];
}

// ────────────────────────────────────────────────────────────────────────
//  PARSER XLSX SEM DEPENDÊNCIAS (zero libs externas — igual ao resto do
//  projeto). Um .xlsx é um .zip com XML dentro. Extrai só o que precisamos:
//  xl/sharedStrings.xml (textos) + a 1ª worksheet (linhas/colunas).
// ────────────────────────────────────────────────────────────────────────
function unzipEntries(buf) {
  const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;
  const maxBack = Math.min(buf.length, 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Arquivo não é um .xlsx/.zip válido (EOCD não encontrado)");
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) break;
    const compMethod  = buf.readUInt16LE(offset + 10);
    const compSize    = buf.readUInt32LE(offset + 20);
    const nameLen     = buf.readUInt16LE(offset + 28);
    const extraLen    = buf.readUInt16LE(offset + 30);
    const commentLen  = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) {
      if (buf.readUInt32LE(localOffset) === LFH_SIG) {
        const lhNameLen = buf.readUInt16LE(localOffset + 26);
        const lhExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
        const compData = buf.slice(dataStart, dataStart + compSize);
        entries[name] = compMethod === 0 ? compData
                       : compMethod === 8 ? zlib.inflateRawSync(compData)
                       : (() => { throw new Error("Compressão não suportada no xlsx: " + compMethod); })();
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseSharedStrings(xmlBuf) {
  if (!xmlBuf) return [];
  const xml = xmlBuf.toString("utf8");
  const strings = [];
  const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = "", t, tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    while ((t = tRe.exec(inner))) text += t[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function colLetterToIndex(cellRef) {
  const m = /^([A-Z]+)/.exec(cellRef || "");
  if (!m) return -1;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

function parseSheetRows(xmlBuf, sharedStrings) {
  const xml = xmlBuf.toString("utf8");
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowXml = rm[1];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const cells = [];
    let cm, autoIdx = 0;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : autoIdx;
      autoIdx = colIdx + 1;
      const type = typeMatch ? typeMatch[1] : null;
      let value = "";
      if (type === "s") {
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const idx = vM ? parseInt(vM[1], 10) : -1;
        value = (idx >= 0 && sharedStrings[idx] !== undefined) ? sharedStrings[idx] : "";
      } else if (type === "inlineStr") {
        const tM = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = tM ? decodeXmlEntities(tM[1]) : "";
      } else {
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        value = vM ? decodeXmlEntities(vM[1]) : "";
      }
      cells[colIdx] = value;
    }
    // 🩹 V4 (06/07/2026): DENSIFICA a linha antes de devolver. cells[] é
    // esparso quando uma coluna fica sem <c> no XML (célula vazia — comum
    // em relatórios mais antigos do DOL, ex.: FY23_JulyPeak, que tem menos
    // colunas preenchidas que o de FY26). Array.prototype.map/filter PULAM
    // buracos, mas findIndex NÃO pula — chama o callback com `undefined`,
    // e `undefined.includes(...)` é exatamente o crash "Cannot read
    // properties of undefined (reading 'includes')" visto em produção.
    for (let ci = 0; ci < cells.length; ci++) if (cells[ci] === undefined) cells[ci] = "";
    rows.push(cells);
  }
  return rows;
}

// Excel guarda datas como número serial (dias desde 1899-12-30), sem
// atributo t="..." (é numérico "puro"). Converte pra YYYY-MM-DD; se o valor
// não parecer um serial plausível (ex.: já é texto), devolve como veio.
function excelSerialToISODate(raw) {
  const s = String(raw || "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s; // não é número puro — já deve ser texto/data formatada
  const serial = parseFloat(s);
  if (serial < 20000 || serial > 60000) return s; // fora da faixa plausível (~1954–2064) — não arrisca conversão errada
  const utcDays = Math.floor(serial - 25569);
  const d = new Date(utcDays * 86400 * 1000);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// Extrai TODAS as colunas úteis do PublicFacingReport oficial do DOL:
// Case Number + Randomization Group (obrigatórios, formato mínimo já usado
// pelo upload manual) + Business Name/Worksite State/Begin Date/Case Status
// (OPCIONAIS — enriquecem o registro ETA, mas relatórios mais antigos podem
// não ter alguma dessas colunas; nesse caso o campo fica vazio, sem quebrar
// nada). Cabeçalho tolerante (substring, case-insensitive) igual ao resto.
function xlsxExtractFullReport(fileBuffer) {
  const entries = unzipEntries(fileBuffer);
  const sharedStrings = parseSharedStrings(entries["xl/sharedStrings.xml"]);
  const sheetKey = Object.keys(entries).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetKey) throw new Error("Nenhuma planilha (worksheet) encontrada dentro do .xlsx");
  const rows = parseSheetRows(entries[sheetKey], sharedStrings);
  if (rows.length < 2) throw new Error("Planilha sem linhas de dados");
  const header = (rows[0] || []).map((h) => String(h || "").toLowerCase().trim());
  const iCase = header.findIndex((h) => h.includes("case") && h.includes("number"));
  const iGrupo = header.findIndex((h) => h.includes("randomization") && h.includes("group"));
  if (iCase < 0 || iGrupo < 0) {
    throw new Error('Cabeçalho não tem "Case Number"/"Randomization Group" — formato inesperado (DOL pode ter mudado o layout)');
  }
  const iEmpresa = header.findIndex((h) => h.includes("business") && h.includes("name"));
  const iEstado  = header.findIndex((h) => h.includes("worksite") && h.includes("state"));
  const iBegin   = header.findIndex((h) => h.includes("begin") && h.includes("date"));
  const iStatus  = header.findIndex((h) => h.includes("case") && h.includes("status"));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const cn = String(r[iCase] || "").trim();
    if (!cn) continue;
    out.push({
      cn, gr: String(r[iGrupo] || "").trim(),
      empresa: iEmpresa >= 0 ? String(r[iEmpresa] || "").trim() : "",
      estado: iEstado >= 0 ? String(r[iEstado] || "").trim() : "",
      begin: iBegin >= 0 ? excelSerialToISODate(r[iBegin]) : "",
      status: iStatus >= 0 ? String(r[iStatus] || "").trim() : "",
    });
  }
  return out;
}

function rowsToCsv(rows) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ["Case Number,Randomization Group"];
  for (const r of rows) lines.push(`${esc(r.cn)},${esc(r.gr)}`);
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
//  PIPELINE ÚNICO DE GRUPOS — usado tanto pelo ciclo real (produção) quanto
//  pelo botão de teste (Janeiro). Fisicamente a MESMA função: qualquer
//  correção/ajuste feito aqui vale pros dois automaticamente, exatamente
//  como o dono pediu ("toda vez que editar um, edita o outro igual").
//  NÃO decide se marca como importado nem se notifica pagantes — isso é
//  responsabilidade de quem chama (importReport = produção decide sim;
//  test-run = teste decide não).
// ────────────────────────────────────────────────────────────────────────
function runGruposPipeline(buf, ctx, logFn) {
  const rows = xlsxExtractFullReport(buf);
  logFn(`📊 ${rows.length} linhas lidas da planilha — processando...`, "info");
  const csv = rowsToCsv(rows);
  const r = ctx.etaParseGruposCSV(csv);
  if (r.err) throw new Error(r.err);
  // V5 (07/07/2026): o PublicFacingReport tem MUITO mais que Case+Grupo —
  // também tem Business Name/Worksite State/Begin Date/Case Status pra TODO
  // case H-2B do período, direto do DOL. Mescla isso no registro ETA (não
  // sobrescreve o que o robô de verificação já atualizou — mesma regra de
  // sempre). Não quebra se essa função não existir (compatibilidade).
  if (typeof ctx.etaSeedFromPublicFacingReport === "function") {
    const seedResult = ctx.etaSeedFromPublicFacingReport(rows);
    if (seedResult && (seedResult.added || seedResult.updated)) {
      logFn(`📇 Registro ETA enriquecido: ${seedResult.added} caso(s) novo(s), ${seedResult.updated} enriquecido(s) (empresa/estado/data)`, "info");
    }
  }
  return { rows, addResult: r };
}

// ────────────────────────────────────────────────────────────────────────
//  CICLO PRINCIPAL (roda a cada 5 minutos) — JANELA DE PRODUÇÃO
// ────────────────────────────────────────────────────────────────────────
async function importReport(url, ctx, DATA_DIR, notify = true) {
  log(`📰 ${notify ? "Novo relatório encontrado" : "Relatório histórico encontrado"} no site do DOL: ${url.split("/").pop()}`, "ok");
  state.phase = "baixando";
  let buf;
  try {
    buf = await httpGet(url, {
      asBuffer: true, referer: ANNOUNCEMENTS_URL,
      onRetry: (n, max, e) => log(`⏳ Tentativa ${n}/${max} falhou (${e.message}) — tentando de novo...`, "warn"),
    });
  } catch (e) {
    log("❌ Falha ao baixar o arquivo (esgotou as tentativas): " + e.message, "error");
    state.phase = "erro";
    return;
  }
  log(`⬇️ Download concluído (${(buf.length / 1024).toFixed(0)} KB)`, "ok");

  state.phase = "processando";
  let rows, r;
  try {
    ({ rows, addResult: r } = runGruposPipeline(buf, ctx, log));
  } catch (e) {
    log("❌ Falha ao processar o .xlsx: " + e.message, "error");
    state.phase = "erro";
    return;
  }

  const fonte = (notify ? "Robô automático — " : "Robô automático (histórico, sem aviso) — ") + url.split("/").pop();
  ctx.persistGruposOficiais(fonte);
  ctx.etaAplicarGruposOficiais();

  state.imported.push(url);
  state.lastReport = { url, importedAt: Date.now(), rows: rows.length, added: r.add, fonte };
  state.phase = "concluido";
  persistState(DATA_DIR);

  const totalGrupos = ctx.getGruposCount ? ctx.getGruposCount() : "?";
  log(`✅ Importado com sucesso! ${r.add} grupos novos/atualizados (total ${totalGrupos} cases)${notify ? "" : " — HISTÓRICO, pagantes NÃO avisados"}`, "ok");
  if (typeof ctx.etaLog === "function") {
    ctx.etaLog("info", `Robô de monitoramento importou automaticamente: ${url.split("/").pop()} — ${r.add} grupos novos/atualizados${notify ? "" : " (histórico)"}`);
  }

  if (!notify) return; // V4: relatório histórico — nunca avisa pagantes

  // 🚨 Avisa todos os pagantes ativos que a lista randomizada saiu (pedido do
  // dono, 06/07/2026) — 1x por pagante, por relatório. Não trava o robô: roda
  // em paralelo e só loga o resultado quando terminar.
  if (typeof ctx.notifyPayingUsersReportReady === "function") {
    const reportLabel = url.split("/").pop().replace(/\.xlsx$/i, "");
    log(`📧 Avisando usuários pagantes que a lista saiu...`, "info");
    ctx.notifyPayingUsersReportReady(url, reportLabel)
      .then((res) => {
        if (res?.skipped) { log("🔕 Alerta de pagantes está desativado em Configurações — ninguém foi avisado.", "warn"); return; }
        if (res?.error) { log("❌ Não deu pra avisar os pagantes: " + res.error, "error"); return; }
        log(`📧 Pagantes avisados: ${res.sent} enviados, ${res.failed} falhas (de ${res.total} elegíveis)`, res.failed ? "warn" : "ok");
      })
      .catch((e) => log("❌ Erro ao avisar pagantes: " + e.message, "error"));
  }
}

async function tick(ctx, DATA_DIR) {
  if (state.checking || !state.enabled) return;
  state.checking = true;
  state.phase = "verificando";
  state.lastCheckAt = Date.now();
  log("🔍 Verificando anúncios do DOL...", "info");
  try {
    const html = await httpGet(ANNOUNCEMENTS_URL, {
      asBuffer: false,
      onRetry: (n, max, e) => log(`⏳ Tentativa ${n}/${max} de checar a página falhou (${e.message}) — tentando de novo...`, "warn"),
    });
    const found = extractReportLinks(html);

    // ── V3: BASELINE DA 1ª CHECAGEM REAL ────────────────────────────────
    // Primeira vez que este robô roda neste servidor (sem estado salvo em
    // disco ainda): tudo que já está publicado HOJE é "notícia velha" —
    // marca como conhecido SEM baixar e SEM avisar pagantes. A partir daqui
    // só um link genuinamente novo (ex.: Julho/2026) aciona o fluxo real.
    if (!state.baselined) {
      const jaConhecidos = found.filter((u) => !state.imported.includes(u));
      state.imported.push(...jaConhecidos);
      const ranksBaseline = found.map(reportRank).filter((r) => r != null);
      if (ranksBaseline.length) {
        state.latestKnownRank = state.latestKnownRank == null ? Math.max(...ranksBaseline) : Math.max(state.latestKnownRank, ...ranksBaseline);
      }
      state.baselined = true;
      log(`📋 Baseline inicial: ${found.length} relatório(s) já publicado(s) no site (ex.: ${found.map(u=>u.split('/').pop()).join(', ') || 'nenhum'}) marcado(s) como conhecido(s) — NINGUÉM foi avisado. A partir de agora só relatório REALMENTE NOVO (ex.: Julho 2026) vai importar e avisar os pagantes de verdade.`, "ok");
      state.phase = "idle";
      return;
    }

    const novos = found.filter((u) => !state.imported.includes(u));
    if (novos.length === 0) {
      log(`Nada novo (${found.length} relatório(s) na página, todos já importados)`, "info");
      state.phase = "idle";
    } else {
      // V4: processa do mais antigo pro mais novo (rank crescente) — assim,
      // se a página trouxer VÁRIOS de uma vez (ex.: histórico nunca visto),
      // só o de rank mais alto no final vira "notícia nova" de verdade.
      novos.sort((a, b) => (reportRank(a) ?? Infinity) - (reportRank(b) ?? Infinity));
      if (novos.length > 1) log(`📋 ${novos.length} relatório(s) novo(s) de uma vez — processando em ordem cronológica, só o mais recente de todos vai avisar pagantes`, "info");
      for (const url of novos) {
        const rank = reportRank(url);
        // 🔒 V5: SEM rank reconhecível (nome fora do padrão FYxx_.../FYxxxx_...)
        // NUNCA aciona aviso automático — antes da V5 isso disparava e-mail
        // real "por segurança", e foi exatamente essa regra que causou um
        // alerta falso em produção. Agora: importa em SILÊNCIO (o dado fica
        // salvo, nada se perde) e pede confirmação manual do admin — o botão
        // "Avisar agora" (POST /api/admin/dolmonitor/notify-now) continua lá
        // pra quando o admin conferir visualmente que é a novidade de verdade.
        // Com rank reconhecível, só é "notícia nova de verdade" se for MAIOR
        // que o mais recente já confirmado E o salto for de no máximo 2 (1
        // temporada = Jan→Jul ou Jul→Jan seguinte) — um salto maior é sinal
        // de nome mal-parseado/ano estranho, não de notícia genuína.
        const jumpTooBig = rank != null && state.latestKnownRank != null && (rank - state.latestKnownRank) > 2;
        const isNewest = rank != null && !jumpTooBig && (state.latestKnownRank == null || rank > state.latestKnownRank);
        if (rank == null) {
          log(`⚠️ Relatório com nome fora do padrão esperado (${url.split("/").pop()}) — importado em SILÊNCIO, pagantes NÃO avisados automaticamente. Confira manualmente e use "Avisar agora" se for a novidade real.`, "warn");
        } else if (jumpTooBig) {
          log(`⚠️ Rank calculado (${rank}) salta demais em relação ao último conhecido (${state.latestKnownRank}) — parece nome mal-formatado, não notícia genuína. Importado em SILÊNCIO; confira manualmente e use "Avisar agora" se for real.`, "warn");
        }
        await importReport(url, ctx, DATA_DIR, isNewest);
        if (rank != null && !jumpTooBig && (state.latestKnownRank == null || rank > state.latestKnownRank)) state.latestKnownRank = rank;
      }
    }
  } catch (e) {
    log("❌ Erro ao checar a página de anúncios (esgotou as tentativas): " + e.message, "error");
    state.phase = "erro";
  } finally {
    state.checking = false;
    state.nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
    persistState(DATA_DIR);
  }
}

// ────────────────────────────────────────────────────────────────────────
//  ROUTER (mesmo contrato dos outros mod-*.js: retorna true se tratou)
// ────────────────────────────────────────────────────────────────────────
function createDolMonitorRouter(ctx) {
  const { getSess, getUser, isAdminVip, json, readBody, DATA_DIR } = ctx;

  return async function handleDolMonitorRoutes(req, res, pathname) {
    if (pathname === "/api/admin/dolmonitor/status" && req.method === "GET") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;
      json(res, 200, {
        ok: true,
        enabled: state.enabled, checking: state.checking, phase: state.phase,
        lastCheckAt: state.lastCheckAt, nextCheckAt: state.nextCheckAt,
        lastReport: state.lastReport, importedCount: state.imported.length,
        baselined: state.baselined, latestKnownRank: state.latestKnownRank,
        log: state.log.slice(0, 100),         // janela de PRODUÇÃO
        testLog: state.testLog.slice(0, 100), // janela de TESTE (separada)
        histLog: state.histLog.slice(0, 150), // janela do BACKFILL HISTÓRICO (separada)
        historico: HIST_CANDIDATES.map((p2) => ({
          label: p2.label, icon: p2.icon,
          imported: p2.urls.some((u) => state.imported.includes(u)),
        })),
      });
      return true;
    }

    if (pathname === "/api/admin/dolmonitor/toggle" && req.method === "POST") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;
      let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
      state.enabled = b.enabled !== false;
      log(state.enabled ? "▶️ Robô ligado pelo admin" : "⏸️ Robô pausado pelo admin", "warn");
      persistState(DATA_DIR);
      json(res, 200, { ok: true, enabled: state.enabled });
      return true;
    }

    if (pathname === "/api/admin/dolmonitor/check-now" && req.method === "POST") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;
      if (state.checking) { json(res, 200, { ok: true, alreadyRunning: true }); return true; }
      tick(ctx, DATA_DIR).catch((e) => log("❌ Erro inesperado: " + e.message, "error"));
      json(res, 200, { ok: true, started: true });
      return true;
    }

    // POST /api/admin/dolmonitor/test-run — TESTE do dono: roda o pipeline
    // INTEIRO DE VERDADE — incluindo o DOWNLOAD AO VIVO do dol.gov — usando
    // a URL real do relatório de Janeiro/2026 (já publicado, estável) no
    // lugar do de Julho (que ainda não saiu). Testa exatamente o mesmo
    // caminho que vai rodar em julho: MESMA função de download (httpGet),
    // MESMO parser, MESMA mesclagem (runGruposPipeline — código físicamente
    // compartilhado com a produção). Só NÃO marca como importado e NÃO
    // notifica pagantes. Log 100% separado da produção (janela própria).
    if (pathname === "/api/admin/dolmonitor/test-run" && req.method === "POST") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;

      // Janela de teste sempre "limpa" a cada rodada — pedido do dono de
      // ter uma janela separada e clara, só com o que aconteceu AGORA.
      state.testLog = [];
      logTest(`🧪 [TESTE] Admin ${s.user_email} disparou o teste completo — vai baixar de verdade o relatório de Janeiro/2026 do dol.gov (mesmo pipeline que vai rodar em Julho)`, "info");

      let buf, fonte;
      try {
        logTest(`🧪 [TESTE] ⬇️ Baixando ao vivo: ${JAN_TEST_URL}`, "info");
        buf = await httpGet(JAN_TEST_URL, {
          asBuffer: true, referer: ANNOUNCEMENTS_URL,
          onRetry: (n, max, e) => logTest(`🧪 [TESTE] ⏳ Tentativa ${n}/${max} falhou (${e.message}) — tentando de novo...`, "warn"),
        });
        fonte = "download ao vivo do dol.gov";
        logTest(`🧪 [TESTE] ✅ Download ao vivo funcionou! (${(buf.length / 1024).toFixed(0)} KB) — prova que o robô consegue acessar o DOL agora`, "ok");
      } catch (e) {
        logTest(`🧪 [TESTE] ⚠️ Download ao vivo falhou depois de várias tentativas (${e.message}) — tentando cópia de backup local pra não travar o teste todo`, "warn");
        const fixturePath = path.join(__dirname, "test-fixtures", "FY26_JanPeak_PublicFacingReport.xlsx");
        if (!fs.existsSync(fixturePath)) {
          logTest(`🧪 [TESTE] ❌ Não há cópia de backup no servidor (${fixturePath}). O download ao vivo é quem precisa ser resolvido — o motivo exato do bloqueio está no erro acima (status + corpo da resposta do dol.gov).`, "error");
          json(res, 502, { error: "Download ao vivo falhou (" + e.message + ") e não há cópia de backup no servidor." });
          return true;
        }
        buf = fs.readFileSync(fixturePath);
        fonte = "cópia local (download ao vivo falhou: " + e.message + ")";
      }
      try {
        const { rows, addResult: r } = runGruposPipeline(buf, ctx, logTest);
        ctx.persistGruposOficiais("TESTE manual — " + fonte);
        ctx.etaAplicarGruposOficiais();
        const totalGrupos = ctx.getGruposCount ? ctx.getGruposCount() : "?";
        logTest(`🧪 [TESTE] ✅ Concluído! ${r.add} grupos novos/atualizados (total ${totalGrupos} cases) — pagantes NÃO foram avisados (isto é só teste)`, "ok");
        json(res, 200, { ok: true, rows: rows.length, added: r.add, totalGrupos, viaLiveDownload: fonte === "download ao vivo do dol.gov" });
      } catch (e) {
        logTest("🧪 [TESTE] ❌ Erro ao processar: " + e.message, "error");
        json(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /api/admin/dolmonitor/import-historico — pedido do dono (06/07/2026):
    // baixa e mescla TODO o histórico conhecido (FY23 Jan/Jul até FY26 Jan) de
    // uma vez, em ordem, com ícone de estação (❄️ Jan / ☀️ Jul). Usa o MESMO
    // runGruposPipeline da produção e do teste (nunca diverge). NUNCA avisa
    // pagantes (histórico não é notícia). Pula o que já foi importado antes
    // (idempotente — pode clicar de novo sem duplicar).
    if (pathname === "/api/admin/dolmonitor/import-historico" && req.method === "POST") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;

      state.histLog = [];
      logHist(`📚 Admin ${s.user_email} disparou a importação histórica completa (FY23–FY26 Jan) — pagantes NÃO serão avisados`, "info");

      const resultados = [];
      for (const periodo of HIST_CANDIDATES) {
        const jaImportado = periodo.urls.some((u) => state.imported.includes(u));
        if (jaImportado) {
          logHist(`${periodo.icon} ${periodo.label}: já estava importado — pulando.`, "info");
          resultados.push({ label: periodo.label, icon: periodo.icon, status: "ja-existia" });
          continue;
        }
        let ok = false;
        for (const url of periodo.urls) {
          try {
            logHist(`${periodo.icon} ${periodo.label}: baixando ${url.split("/").pop()}...`, "info");
            const buf = await httpGet(url, {
              asBuffer: true, referer: ANNOUNCEMENTS_URL, maxRetries: 2,
              onRetry: (n, max, e) => logHist(`${periodo.icon} ${periodo.label}: ⏳ tentativa ${n}/${max} falhou (${e.message})`, "warn"),
            });
            const { rows, addResult: r } = runGruposPipeline(buf, ctx, (m, t) => logHist(`${periodo.icon} ${periodo.label}: ${m}`, t));
            ctx.persistGruposOficiais(`Histórico — ${periodo.label}`);
            ctx.etaAplicarGruposOficiais();
            state.imported.push(url);
            logHist(`${periodo.icon} ${periodo.label}: ✅ importado — ${r.add} grupos novos/atualizados (${rows.length} linhas)`, "ok");
            resultados.push({ label: periodo.label, icon: periodo.icon, status: "ok", rows: rows.length, added: r.add });
            ok = true;
            break;
          } catch (e) {
            logHist(`${periodo.icon} ${periodo.label}: variação "${url.split("/").pop()}" falhou (${e.message})`, "warn");
          }
        }
        if (!ok) {
          logHist(`${periodo.icon} ${periodo.label}: ❌ não encontrado em nenhuma variação de nome testada`, "error");
          resultados.push({ label: periodo.label, icon: periodo.icon, status: "erro" });
        }
      }
      persistState(DATA_DIR);
      logHist(`📚 Importação histórica concluída. Pagantes NÃO foram avisados (isto é histórico, não notícia nova).`, "ok");
      json(res, 200, { ok: true, resultados });
      return true;
    }

    // POST /api/admin/dolmonitor/notify-now — dispara manualmente o alerta de
    // pagantes pro último relatório importado (útil pra testar sem esperar
    // sair um relatório novo de verdade). Respeita o mesmo "1x por pagante".
    if (pathname === "/api/admin/dolmonitor/notify-now" && req.method === "POST") {
      const s = getSess(req); if (!s?.user_email) return json(res, 401, { error: "Não autenticado" }), true;
      const p = getUser(s.user_email); if (!isAdminVip(p)) return json(res, 403, { error: "Não autorizado" }), true;
      if (!state.lastReport?.url) { json(res, 400, { error: "Nenhum relatório importado ainda." }); return true; }
      if (typeof ctx.notifyPayingUsersReportReady !== "function") { json(res, 500, { error: "Função de alerta não disponível." }); return true; }
      try {
        const label = state.lastReport.url.split("/").pop().replace(/\.xlsx$/i, "");
        log(`📧 [manual] Admin ${s.user_email} disparou o alerta de pagantes pro relatório ${label}`, "info");
        const result = await ctx.notifyPayingUsersReportReady(state.lastReport.url, label);
        json(res, 200, { ok: true, ...result });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false;
  };
}

// ────────────────────────────────────────────────────────────────────────
//  START (liga o setInterval de 5min — chamado 1x no boot do server.js)
// ────────────────────────────────────────────────────────────────────────
function startDolMonitor(ctx) {
  const DATA_DIR = ctx.DATA_DIR;
  loadState(DATA_DIR);
  state.nextCheckAt = Date.now() + 30_000; // 1ª checagem 30s após o boot
  setTimeout(() => tick(ctx, DATA_DIR), 30_000);
  setInterval(() => tick(ctx, DATA_DIR), CHECK_INTERVAL_MS);
  log("🤖 Robô Monitor de Anúncios DOL iniciado — checando a cada 5 minutos", "ok");
}

module.exports = { createDolMonitorRouter, startDolMonitor };

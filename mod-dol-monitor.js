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
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const https = require("https");
const zlib  = require("zlib");
const fs    = require("fs");
const path  = require("path");

const ANNOUNCEMENTS_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos, como pedido
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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
  log: [],                 // {ts,msg,type}
};

function log(msg, type = "info") {
  state.log.unshift({ ts: Date.now(), msg: String(msg).slice(0, 500), type });
  if (state.log.length > 250) state.log.length = 250;
  console.log(`[dol-monitor] ${msg}`);
}

// ────────────────────────────────────────────────────────────────────────
//  PERSISTÊNCIA (sobrevive a deploy/restart — mesma convenção do resto)
// ────────────────────────────────────────────────────────────────────────
function stateFile(DATA_DIR) { return path.join(DATA_DIR, "dol_monitor_state.json"); }

function loadState(DATA_DIR) {
  try {
    const f = stateFile(DATA_DIR);
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      state.enabled = d.enabled !== false;
      state.imported = Array.isArray(d.imported) ? d.imported : [];
      state.lastReport = d.lastReport || null;
      state.lastCheckAt = d.lastCheckAt || null;
      log(`Estado carregado do disco (${state.imported.length} relatório(s) já importado(s))`, "info");
    }
  } catch (e) { console.warn("[dol-monitor] loadState:", e.message); }
}

function persistState(DATA_DIR) {
  try {
    const tmp = stateFile(DATA_DIR) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      enabled: state.enabled, imported: state.imported,
      lastReport: state.lastReport, lastCheckAt: state.lastCheckAt,
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
function httpGet(urlStr, { asBuffer = false, redirectsLeft = 5, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("URL inválida: " + urlStr)); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity" },
    }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        const next = new URL(resp.headers.location, urlStr).toString();
        resolve(httpGet(next, { asBuffer, redirectsLeft: redirectsLeft - 1, timeoutMs }));
        return;
      }
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        if (resp.statusCode !== 200) { reject(new Error("HTTP " + resp.statusCode + " em " + urlStr)); return; }
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString("utf8"));
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
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
    rows.push(cells);
  }
  return rows;
}

// Extrai só as colunas que interessam ("Case Number" e "Randomization Group")
// — mesmo contrato de cabeçalho tolerante que etaParseGruposCSV já usa.
function xlsxExtractCaseAndGroup(fileBuffer) {
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
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const cn = String(r[iCase] || "").trim();
    const gr = String(r[iGrupo] || "").trim();
    if (cn) out.push({ cn, gr });
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
//  CICLO PRINCIPAL (roda a cada 5 minutos)
// ────────────────────────────────────────────────────────────────────────
async function importReport(url, ctx, DATA_DIR) {
  log(`📰 Novo relatório encontrado no site do DOL: ${url.split("/").pop()}`, "ok");
  state.phase = "baixando";
  let buf;
  try {
    buf = await httpGet(url, { asBuffer: true });
  } catch (e) {
    log("❌ Falha ao baixar o arquivo: " + e.message, "error");
    state.phase = "erro";
    return;
  }
  log(`⬇️ Download concluído (${(buf.length / 1024).toFixed(0)} KB)`, "ok");

  state.phase = "processando";
  let rows;
  try {
    rows = xlsxExtractCaseAndGroup(buf);
  } catch (e) {
    log("❌ Falha ao ler o .xlsx: " + e.message, "error");
    state.phase = "erro";
    return;
  }
  log(`📊 ${rows.length} linhas lidas da planilha — processando...`, "info");

  const csv = rowsToCsv(rows);
  const r = ctx.etaParseGruposCSV(csv);
  if (r.err) {
    log("❌ " + r.err, "error");
    state.phase = "erro";
    return;
  }
  const fonte = "Robô automático — " + url.split("/").pop();
  ctx.persistGruposOficiais(fonte);
  ctx.etaAplicarGruposOficiais();

  state.imported.push(url);
  state.lastReport = { url, importedAt: Date.now(), rows: rows.length, added: r.add, fonte };
  state.phase = "concluido";
  persistState(DATA_DIR);

  const totalGrupos = ctx.getGruposCount ? ctx.getGruposCount() : "?";
  log(`✅ Importado com sucesso! ${r.add} grupos novos/atualizados (total ${totalGrupos} cases)`, "ok");
  if (typeof ctx.etaLog === "function") {
    ctx.etaLog("info", `Robô de monitoramento importou automaticamente: ${url.split("/").pop()} — ${r.add} grupos novos/atualizados`);
  }
}

async function tick(ctx, DATA_DIR) {
  if (state.checking || !state.enabled) return;
  state.checking = true;
  state.phase = "verificando";
  state.lastCheckAt = Date.now();
  log("🔍 Verificando anúncios do DOL...", "info");
  try {
    const html = await httpGet(ANNOUNCEMENTS_URL, { asBuffer: false });
    const found = extractReportLinks(html);
    const novos = found.filter((u) => !state.imported.includes(u));
    if (novos.length === 0) {
      log(`Nada novo (${found.length} relatório(s) na página, todos já importados)`, "info");
      state.phase = "idle";
    } else {
      for (const url of novos) {
        await importReport(url, ctx, DATA_DIR);
      }
    }
  } catch (e) {
    log("❌ Erro ao checar a página de anúncios: " + e.message, "error");
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
        log: state.log.slice(0, 100),
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

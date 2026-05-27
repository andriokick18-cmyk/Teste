// ═══════════════════════════════════════════════════════════
//  H2BApply v15 — Motor de envio automático para vagas H-2B/H-2A
//
//  PLANOS:
//    free  → 20 manual + 10 auto /dia   (Grátis)
//    vip   → 300 manual + 50 auto /dia  (R$89,90)
//    vipro → 300 manual + 200 auto /dia (R$149,90)
//    pro   → igual vipro (legado — não vender mais)
//
//  TRIAL: 5 dias VIPro para novos usuários
//  (permite testar o automático com 200 envios/dia)
// ═══════════════════════════════════════════════════════════
"use strict";
const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const zlib = require("zlib");

// ── Config ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const APP_URL       = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const REDIRECT_URI  = APP_URL + "/oauth/callback";
const PORT          = parseInt(process.env.PORT || "3000", 10);
const IS_PROD       = APP_URL.startsWith("https://");
const CONFIGURED    = !!(CLIENT_ID && CLIENT_SECRET);
const ADMIN_EMAIL   = (process.env.ADMIN_EMAIL || "andrio.kick18@gmail.com").trim().toLowerCase();
const ADMIN_EMAIL_2 = (process.env.ADMIN_EMAIL_2 || "").trim().toLowerCase();
const ADMIN_EMAILS  = new Set([ADMIN_EMAIL, ADMIN_EMAIL_2].filter(Boolean));
const isAdminEmail  = (e) => ADMIN_EMAILS.has((e||"").trim().toLowerCase());

// ── VAPID — Web Push Notifications ───────────────────────
// Gere suas chaves com: npx web-push generate-vapid-keys
// Configure as variáveis de ambiente VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY
const VAPID_PUBLIC_KEY  = (process.env.VAPID_PUBLIC_KEY  || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || `mailto:${ADMIN_EMAIL}`;
const PUSH_ENABLED      = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
console.log(`[boot] Push VAPID: ${PUSH_ENABLED?"✅ configurado":"⚠️  desativado (configure VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY)"}`);

// ── Planos ────────────────────────────────────────────────
// Planos ativos:
//   free  → 20 manual + 10 auto /dia (Grátis)
//   vip   → 300 manual + 50 auto /dia  (R$89,90)
//   vipro → 300 manual + 200 auto /dia (R$149,90)
// Plano "pro" = legado, mesmo limite do vipro. Não vender mais.
const PLAN_LIMITS = {
  free:  { manual: 20,  auto: 10  },  // Grátis
  vip:   { manual: 300, auto: 50  },  // R$89,90
  pro:   { manual: 300, auto: 200 },  // Legado — mesmo do vipro
  vipro: { manual: 300, auto: 200 },  // R$149,90 — completo
};
// Intervalos base (substituídos pelo cálculo inteligente)
const AUTO_INTERVAL_MIN = 180_000; // 3 min fallback
const AUTO_INTERVAL_MAX = 300_000; // 5 min fallback
// Horário padrão se usuário não configurar
const AUTO_START_H_DEFAULT = 8;
const AUTO_END_H_DEFAULT   = 20;

// Intervalo fixo de 3 a 5 minutos — seguro para o Gmail e rápido o suficiente
function calcSmartInterval() {
  const MIN_MS = 3 * 60 * 1000; // 3 minutos
  const MAX_MS = 5 * 60 * 1000; // 5 minutos
  return MIN_MS + Math.random() * (MAX_MS - MIN_MS);
}

// ══════════════════════════════════════════════════════════
//  TIMEZONE BRT — UTC-3 fixo (sem horário de verão no Brasil)
//  Todas as datas/horas do sistema usam BRT consistentemente
// ══════════════════════════════════════════════════════════
function nowBRT() {
  // Retorna Date ajustado para BRT (UTC-3)
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function todayStrBRT() {
  const t = nowBRT();
  return `${String(t.getUTCDate()).padStart(2,"0")}/${String(t.getUTCMonth()+1).padStart(2,"0")}/${t.getUTCFullYear()}`;
}

function toLocaleBRT(ts) {
  // Formata timestamp como data/hora no padrão pt-BR em BRT
  const d = new Date((ts||Date.now()) - 3*60*60*1000);
  const date = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
  const time = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
  return `${date} ${time}`;
}

function toTimeBRT(ts) {
  const d = new Date((ts||Date.now()) - 3*60*60*1000);
  return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
}

function hourBRT() {
  return nowBRT().getUTCHours();
}



// ── Storage ───────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
const USERS_FILE  = path.join(DATA_DIR, "users.json");
const HIST_FILE   = path.join(DATA_DIR, "history.json");
const CVS_DIR     = path.join(DATA_DIR, "cvs");
const AUTO_FILE   = path.join(DATA_DIR, "auto_jobs.json");
const SENT_FILE   = path.join(DATA_DIR, "sent_emails.json");
const LOGS_FILE   = path.join(DATA_DIR, "auto_logs.json");   // NEW: logs detalhados
const JOURNEY_FILE = path.join(DATA_DIR, "journey.json");       // Jornada do usuário
const NOTES_FILE  = path.join(DATA_DIR, "notes.json");
const ALERTS_FILE = path.join(DATA_DIR, "job_alerts.json");
const CODES_FILE  = path.join(DATA_DIR, "promo_codes.json"); // NEW: promo codes
const PUSH_FILE   = path.join(DATA_DIR, "push_subs.json");   // NEW: push subscriptions
const APPIDX_FILE = path.join(DATA_DIR, "app_index.json");   // NEW v13: índice de candidaturas
const ADMIN_SETTINGS_FILE = path.join(DATA_DIR, "admin_settings.json"); // Admin global settings
const NOTIF_FILE     = path.join(DATA_DIR, "notifications.json");  // Global notifications from ADM
const REFERRAL_FILE  = path.join(DATA_DIR, "referrals.json");       // Referral tracking
const SUGGESTIONS_FILE = path.join(DATA_DIR, "suggestions.json");   // User suggestions to devs
try { fs.mkdirSync(CVS_DIR, { recursive: true }); } catch {}

console.log(`[boot] H2BApply v15.0 | ${APP_URL} | ${DATA_DIR} | Planos: free/vip/vipro`);
console.log(`[boot] Disk: ${fs.existsSync("/data") ? "✅ /data" : "⚠️  /tmp"}`);

// ══════════════════════════════════════════════════════════
//  BANCO DE DADOS EM MEMÓRIA
// ══════════════════════════════════════════════════════════
let DB_USERS  = {};
let DB_HIST   = {};
let DB_AUTO   = {};
let DB_SENT   = {};   // { userEmail → Set<destEmail> }
let DB_LOGS   = {};   // { userEmail → LogEntry[] }
let DB_JOURNEY = {}; // { userEmail → JourneyEvent[] }
let DB_NOTES  = {};
let DB_ALERTS = {};
let DB_CODES  = {};   // NEW: promo codes { code → { manualDays, autoDays, createdAt, createdBy, active, usedBy[] } }
let DB_PUSH   = {};   // NEW: push subscriptions { userEmail → PushSubscription[] }
// NEW v13: índice de candidaturas — { userEmail → { byThread:{tid:appId}, byMsgId:{mid:appId}, byTo:{email:[appId,...]} } }
let DB_APP_INDEX = {};
let DB_ADMIN_SETTINGS = { newUserTrialEnabled: true, newUserTrialDays: 5, newUserTrialPlan: "vipro" };
// Notifications: { notifications: [{id, title, body, createdAt, createdBy, readBy:[email,...]}] }
let DB_NOTIF = { notifications: [] };
// Referrals: { byCode: { code → {ownerEmail, createdAt} }, byEmail: { email → {code, referredBy, joinedAt, paidAt, bonusPaid} } }
let DB_REFERRAL = { byCode: {}, byEmail: {} };
let DB_SUGGESTIONS = []; // Array de sugestões dos usuários

// ── Gemini Chat ─────────────────────────────────────────
// Limite global de 1500 mensagens/dia para TODOS os usuários
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
console.log(`[boot] Gemini AI Chat: ${GEMINI_API_KEY?"✅ configurado":"⚠️  desativado (configure GEMINI_API_KEY para ativar o chat de IA)"}`);
const GEMINI_DAILY_LIMIT = parseInt(process.env.GEMINI_DAILY_LIMIT || "1500", 10);
const GEMINI_USER_DAILY_LIMIT = Math.floor(GEMINI_DAILY_LIMIT / 50); // 1500 ÷ 50 usuários = 30/dia por usuário
let _geminiCount = { date: "", count: 0 }; // contador global em memória (reseta à meia-noite)

// ── Ranking System ────────────────────────────────────────
const RANK_HIDDEN_FILE = path.join(DATA_DIR, "rank_hidden.json");
const RANK_BADGES_FILE = path.join(DATA_DIR, "rank_badges.json");
let DB_RANK_HIDDEN = {};  // { email: true } — ocultos do ranking público
let DB_RANK_BADGES = {};  // { email: "legend"|"star"|"top"|"verified" }
const persistRankHidden = () => persist(RANK_HIDDEN_FILE, DB_RANK_HIDDEN);
const persistRankBadges = () => persist(RANK_BADGES_FILE, DB_RANK_BADGES);

// Online status (in-memory, reinicia com o servidor)
const onlineMap = new Map(); // email → lastSeenAt (ms timestamp)
const markOnline = email => {
  if(!email) return;
  const now = Date.now();
  onlineMap.set(email, now);
  // Persiste lastSeenAt no DB do usuário (sobrevive a reinícios)
  const p = getUser(email);
  if(p) setUser(email, { lastSeenAt: now });
};
const isOnlineUser = email => { const t = onlineMap.get(email); return !!(t && Date.now() - t < 5 * 60_000); };

// Cache de posições anteriores para calcular mudança de ranking
// { "period_category": { email: posição } }
let rankPosCache = {};

function load(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } }

function boot() {
  // Migração automática de nomes antigos
  const mig = (newF, oldF, def) => {
    if (fs.existsSync(newF)) return load(newF, def);
    if (fs.existsSync(oldF)) {
      console.log(`[db] Migrando ${path.basename(oldF)} → ${path.basename(newF)}`);
      const d = load(oldF, def);
      try { fs.copyFileSync(oldF, newF); } catch {}
      return d;
    }
    return def;
  };
  DB_USERS  = mig(USERS_FILE,  path.join(DATA_DIR, "h2b_users.json"),   {});
  DB_HIST   = mig(HIST_FILE,   path.join(DATA_DIR, "h2b_history.json"), {});
  DB_AUTO   = load(AUTO_FILE, {});
  DB_NOTES  = load(NOTES_FILE, {});
  DB_ALERTS = load(ALERTS_FILE, {});
  DB_LOGS   = load(LOGS_FILE, {});
  DB_JOURNEY = load(JOURNEY_FILE, {});
  loadSessions(); // restaurar sessões após crash/restart
  DB_CODES  = load(CODES_FILE, {});
  DB_PUSH   = load(PUSH_FILE, {});
  DB_APP_INDEX = load(APPIDX_FILE, {});
  DB_RANK_HIDDEN = load(RANK_HIDDEN_FILE, {});
  DB_RANK_BADGES = load(RANK_BADGES_FILE, {});
  const savedAdminSettings = load(ADMIN_SETTINGS_FILE, null);
  if(savedAdminSettings) Object.assign(DB_ADMIN_SETTINGS, savedAdminSettings);
  DB_NOTIF    = load(NOTIF_FILE,    { notifications: [] });
  DB_SUGGESTIONS = load(SUGGESTIONS_FILE, []);
  if(!Array.isArray(DB_SUGGESTIONS)) DB_SUGGESTIONS = [];
  const rawRef = load(REFERRAL_FILE, { byCode: {}, byEmail: {} });
  DB_REFERRAL = {
    byCode:  (rawRef.byCode  && typeof rawRef.byCode  === 'object') ? rawRef.byCode  : {},
    byEmail: (rawRef.byEmail && typeof rawRef.byEmail === 'object') ? rawRef.byEmail : {}
  };
  const rawSent = mig(SENT_FILE, path.join(DATA_DIR, "h2b_sent_emails.json"), {});
  for (const [k, v] of Object.entries(rawSent)) DB_SENT[k] = new Set(Array.isArray(v) ? v : []);
  // ══════════════════════════════════════════════════════
  // REGRA PRINCIPAL: reconstrói DB_SENT completo do HIST
  // Garante que NENHUM envio do histórico seja esquecido
  // Sobrevive a deploy, reinício, corrupção do sent_emails
  // ══════════════════════════════════════════════════════
  let _sentRebuilt = 0;
  for (const [userEmail, entries] of Object.entries(DB_HIST)) {
    if (!DB_SENT[userEmail]) DB_SENT[userEmail] = new Set();
    for (const h of entries) {
      const nd = (h.to||"").toLowerCase().trim().replace(/\.+$/,"");
      if (nd && !DB_SENT[userEmail].has(nd)) {
        DB_SENT[userEmail].add(nd);
        _sentRebuilt++;
      }
    }
  }
  if (_sentRebuilt > 0) {
    persistSent(); // Salva o DB_SENT reconstruído no disco imediatamente
    console.log(`[db] 🔒 DB_SENT reconstruído do histórico: +${_sentRebuilt} entradas adicionadas`);
  }
  console.log(`[db] ✅ ${Object.keys(DB_USERS).length} usuários | ${Object.values(DB_HIST).reduce((n,a)=>n+a.length,0)} enviados`);
  console.log(`[db] Logs: ${Object.values(DB_LOGS).reduce((n,a)=>n+a.length,0)} entradas`);
  // Rebuild do índice de candidaturas se estiver vazio (recupera HIST antigo)
  if (!Object.keys(DB_APP_INDEX).length && Object.keys(DB_HIST).length) {
    rebuildAppIndex();
    console.log(`[db] 🔁 índice de candidaturas reconstruído (${Object.values(DB_APP_INDEX).reduce((n,x)=>n+Object.keys(x.byThread||{}).length+Object.keys(x.byMsgId||{}).length,0)} chaves)`);
  }
}

function persist(file, data) {
  // Escrita assíncrona para não bloquear o event loop
  // Usa arquivo .tmp + rename para atomicidade
  const json = JSON.stringify(data, null, 2);
  const tmp = file + ".tmp";
  fs.writeFile(tmp, json, "utf8", (err) => {
    if(err){ console.warn("[db/write]", file, err.message); return; }
    fs.rename(tmp, file, (err2) => {
      if(err2){ console.warn("[db/rename]", file, err2.message);
        // fallback: tentar escrever direto
        fs.writeFile(file, json, "utf8", ()=>{});
      }
    });
  });
}
function persistSync(file, data) {
  // Usar APENAS no shutdown (SIGTERM/SIGINT) — nunca em path crítico
  try { const t=file+".tmp"; fs.writeFileSync(t,JSON.stringify(data,null,2),"utf8"); fs.renameSync(t,file); }
  catch(e) { console.warn("[db/sync]",e.message); try{fs.writeFileSync(file,JSON.stringify(data,null,2));}catch{} }
}
function persistSent() {
  const out={};for(const[k,v]of Object.entries(DB_SENT))out[k]=[...v];persist(SENT_FILE,out);
}
function persistSentDebounced() {
  const out={};for(const[k,v]of Object.entries(DB_SENT))out[k]=[...v];persistDebounced(SENT_FILE,out,2000);
}
function persistLogs() { persist(LOGS_FILE, DB_LOGS); }

// CRUD
const getUser    = e => DB_USERS[e]||null;
const setUser    = (e,d) => { DB_USERS[e]={...(DB_USERS[e]||{}),...d}; persist(USERS_FILE,DB_USERS); };
const delUser    = e => { delete DB_USERS[e]; persist(USERS_FILE,DB_USERS); };
const getHist    = e => DB_HIST[e]||[];
const addHist    = (e,entry) => { if(!DB_HIST[e])DB_HIST[e]=[]; DB_HIST[e].unshift(entry); if(DB_HIST[e].length>2000)DB_HIST[e]=DB_HIST[e].slice(0,2000); invalidateUserStatsCache(e); persistDebounced(HIST_FILE,DB_HIST,1500); };
const delHist    = e => { delete DB_HIST[e]; persist(HIST_FILE,DB_HIST); };
const getAutoJob = e => DB_AUTO[e]||null;
const setAutoJob = (e,d) => { DB_AUTO[e]={...(DB_AUTO[e]||{}),...d}; persistDebounced(AUTO_FILE,DB_AUTO,800); };
const delAutoJob = e => { delete DB_AUTO[e]; persist(AUTO_FILE,DB_AUTO); };
// ══════════════════════════════════════════════════════════
// REGRA PRINCIPAL — Anti-duplicata absoluta
// Um usuário NUNCA envia para o mesmo empregador duas vezes
// a não ser que ele mesmo retire a vaga do histórico.
// Dupla camada: DB_SENT (memória/disco) + HIST (fallback)
// Sobrevive a: deploy, reinício, logout, troca de celular
// ══════════════════════════════════════════════════════════

// Normaliza email para comparação — remove espaços, lowercase, ponto final
const _normEmail = (e) => (e||"").toLowerCase().trim().replace(/\.+$/,"");

const hasSent = (u, d) => {
  const nd = _normEmail(d);
  if(!nd) return false;
  // Camada 1: DB_SENT em memória (rápido)
  if(DB_SENT[u]?.has(nd)) return true;
  // Camada 2: fallback direto no histórico (à prova de falhas)
  const hist = DB_HIST[u] || [];
  return hist.some(h => _normEmail(h.to) === nd);
};

const markSent = (u, d) => {
  const nd = _normEmail(d);
  if(!nd) return;
  if(!DB_SENT[u]) DB_SENT[u] = new Set();
  DB_SENT[u].add(nd);
  persistSentDebounced();
};
const getNote    = (u,j) => DB_NOTES[u]?.[j]||"";
const setNote    = (u,j,t) => { if(!DB_NOTES[u])DB_NOTES[u]={}; DB_NOTES[u][j]=t; persist(NOTES_FILE,DB_NOTES); };
const getAlerts  = u => DB_ALERTS[u]||[];
const setAlerts  = (u,a) => { DB_ALERTS[u]=a; persist(ALERTS_FILE,DB_ALERTS); };

// ══════════════════════════════════════════════════════════
//  v13 — SISTEMA DE IDs ÚNICOS POR CANDIDATURA
//  Cada envio gera um appId estável e é indexado por:
//    threadId (Gmail), msgId (header Message-ID), to (destinatário)
//  Isso permite vincular uma resposta recebida → vaga original
// ══════════════════════════════════════════════════════════
function newAppId(){
  return "app_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
}

// Normaliza Message-ID removendo <> e espaços (Gmail às vezes envia com, às vezes sem)
function normMsgId(mid){
  if(!mid) return "";
  return String(mid).trim().replace(/^<|>$/g,"").toLowerCase();
}

// Extrai e normaliza uma lista de Message-IDs de um header "References"
// (pode ter múltiplos IDs separados por espaço)
function parseRefs(refs){
  if(!refs) return [];
  return String(refs).split(/\s+/).map(normMsgId).filter(Boolean);
}

// Extrai apenas o e-mail (sem nome) de uma string "Nome <email@x>"
function extractEmail(s){
  if(!s) return "";
  const m = String(s).match(/<([^>]+)>/);
  return ((m?m[1]:s)||"").trim().toLowerCase();
}

// ══════════════════════════════════════════════════════════
//  v15-SEC: Normalização e validação robusta de e-mail
//  Corrige: espaços, <>, maiúsculas, comprimento excessivo,
//  regex fraca que aceitava "@", "x@", "test@ x", etc.
// ══════════════════════════════════════════════════════════
const EMAIL_MAX_LEN = 254; // RFC 5321
const EMAIL_REGEX   = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Normaliza um endereço de e-mail:
 *   - Remove espaços, caracteres <>"
 *   - Converte para minúsculas
 *   - Extrai apenas o endereço de "Nome <email@x>"
 * Retorna a string normalizada (pode ainda ser inválida — valide com isValidEmail).
 */
function normalizeEmail(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  // Extrai de "Nome <email@x.com>" ou "<email@x.com>"
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) s = angleMatch[1].trim();
  // Remove caracteres indevidos e normaliza
  s = s.replace(/[<>"'\s]/g, "").toLowerCase();
  return s;
}

/**
 * Valida se uma string é um endereço de e-mail aceitável:
 *   - Comprimento ≤ 254 chars (RFC 5321)
 *   - Formato local@dominio.tld (mínimo 2 chars no TLD)
 *   - Sem espaços nem caracteres de controle
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > EMAIL_MAX_LEN) return false;
  return EMAIL_REGEX.test(email);
}

/**
 * Normaliza E valida.
 * Retorna { ok: true, email } ou { ok: false, reason }.
 */
function parseEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, reason: "e-mail vazio" };
  if (email.length > EMAIL_MAX_LEN) return { ok: false, reason: `e-mail muito longo (${email.length} chars, máx ${EMAIL_MAX_LEN})` };
  if (!isValidEmail(email)) return { ok: false, reason: `formato inválido: "${email}"` };
  return { ok: true, email };
}

// Garante estrutura do índice para um usuário
function ensureIdx(email){
  if(!DB_APP_INDEX[email]) DB_APP_INDEX[email]={byThread:{},byMsgId:{},byTo:{}};
  if(!DB_APP_INDEX[email].byThread) DB_APP_INDEX[email].byThread={};
  if(!DB_APP_INDEX[email].byMsgId)  DB_APP_INDEX[email].byMsgId={};
  if(!DB_APP_INDEX[email].byTo)     DB_APP_INDEX[email].byTo={};
  return DB_APP_INDEX[email];
}

// Adiciona uma candidatura ao índice
function indexApp(userEmail, app){
  const ix = ensureIdx(userEmail);
  if(app.threadId)         ix.byThread[app.threadId] = app.appId;
  if(app.gmailHeaderMsgId) ix.byMsgId[normMsgId(app.gmailHeaderMsgId)] = app.appId;
  if(app.gmailMsgId)       ix.byMsgId[String(app.gmailMsgId).toLowerCase()] = app.appId;
  if(app.to){
    const t = String(app.to).toLowerCase();
    if(!ix.byTo[t]) ix.byTo[t]=[];
    // mantém apenas os 10 últimos para esse destinatário
    ix.byTo[t].unshift(app.appId);
    if(ix.byTo[t].length>10) ix.byTo[t]=ix.byTo[t].slice(0,10);
  }
  persist(APPIDX_FILE, DB_APP_INDEX);
}

// Reconstrói o índice a partir do DB_HIST (usado no boot se índice vazio)
function rebuildAppIndex(){
  DB_APP_INDEX = {};
  for(const [userEmail, hist] of Object.entries(DB_HIST)){
    if(!Array.isArray(hist)) continue;
    for(const entry of hist){
      if(!entry || !entry.appId) continue;
      indexApp(userEmail, entry);
    }
  }
}

// Monta snapshot completo da vaga a partir de objetos vindos do client/auto-queue
function buildJobSnapshot(j){
  if(!j || typeof j !== "object") return null;
  // Aceita tanto formato vindo do /api/send (campos top-level) quanto de queue auto
  const snap = {
    title:   j.title || j.jobTitle || j.job || "",
    company: j.company || "",
    city:    j.city || "",
    state:   j.state || "",
    wage:    j.wage || "",
    visa:    j.visa || j.visaType || (j.jobType==="agricultural"?"H-2A":j.jobType==="non-agricultural"?"H-2B":""),
    workers: j.workers || null,
    start:   j.start || j.beginDate || "",
    end:     j.end || j.endDate || "",
    category:j.category || "",
    desc:    (j.desc || j.description || "").slice(0,1000),
    caseNum: j.caseNum || j.case_number || "",
    sourceEmail: (j.to || j.email || "").toLowerCase(),
    capturedAt: Date.now()
  };
  // Não retorna snapshot vazio (capturedAt não conta como dado real)
  const { capturedAt, ...realFields } = snap;
  const hasAny = Object.values(realFields).some(v => v && v !== 0 && (typeof v!=="object"));
  return hasAny ? snap : null;
}

// Busca candidatura pelo appId em todo o histórico do usuário
function findAppById(userEmail, appId){
  const hist = getHist(userEmail);
  return hist.find(h => h.appId === appId) || null;
}

// Tenta encontrar a candidatura vinculada a um email recebido
// Retorna { app, matchType } ou null
function matchAppToEmail(userEmail, emailMeta){
  if(!userEmail || !emailMeta) return null;
  ensureIdx(userEmail);
  const ix = DB_APP_INDEX[userEmail];
  const findById = id => id ? findAppById(userEmail, id) : null;

  // 1. threadId → match exato (mesma conversa Gmail)
  if(emailMeta.threadId && ix.byThread[emailMeta.threadId]){
    const app = findById(ix.byThread[emailMeta.threadId]);
    if(app) return { app, matchType: "thread" };
  }
  // 2. In-Reply-To → header Message-Id que apontamos no envio
  if(emailMeta.inReplyTo){
    const mid = normMsgId(emailMeta.inReplyTo);
    if(ix.byMsgId[mid]){
      const app = findById(ix.byMsgId[mid]);
      if(app) return { app, matchType: "in-reply-to" };
    }
  }
  // 3. References (varre todos)
  for(const ref of parseRefs(emailMeta.references)){
    if(ix.byMsgId[ref]){
      const app = findById(ix.byMsgId[ref]);
      if(app) return { app, matchType: "references" };
    }
  }
  // 4. Fallback: from do email recebido bate com 'to' de um envio recente
  const fromEmail = extractEmail(emailMeta.from);
  if(fromEmail && ix.byTo[fromEmail]?.length){
    const app = findById(ix.byTo[fromEmail][0]); // mais recente
    if(app) return { app, matchType: "recipient" };
  }
  return null;
}

// Após enviar pelo Gmail, busca os headers Message-ID e References da mensagem
// recém-criada (não-bloqueante: o caller faz fire-and-forget)
async function fetchGmailMessageHeaders(token, gmailId){
  try{
    const { status, body } = await httpsReq({
      hostname: "gmail.googleapis.com",
      path: `/gmail/v1/users/me/messages/${gmailId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References&metadataHeaders=In-Reply-To`,
      method: "GET",
      headers: { "Authorization": "Bearer " + token }
    });
    if(status !== 200 || !body?.payload?.headers) return null;
    const get = name => (body.payload.headers.find(h => h.name?.toLowerCase()===name.toLowerCase())?.value) || "";
    return {
      messageId: get("Message-Id"),
      references: get("References"),
      inReplyTo: get("In-Reply-To"),
      threadId: body.threadId || null
    };
  } catch { return null; }
}

// ── LOGS detalhados ───────────────────────────────────────
function addLog(userEmail, entry) {
  if (!DB_LOGS[userEmail]) DB_LOGS[userEmail] = [];
  const record = {
    id:          crypto.randomBytes(8).toString("hex"),
    ts:          Date.now(),
    date:        toLocaleBRT(Date.now()),
    hour:        toTimeBRT(Date.now()),
    to:          "",
    status:      "pendente",
    jobTitle:    "",
    company:     "",
    category:    "",
    state:       "",
    source:      "",
    profileUsed: "",
    subjectUsed: "",
    resumeName:  "",
    attachCount: 0,
    attempt:     1,
    error:       "",
    appId:       "",
    ...entry,
  };
  DB_LOGS[userEmail].unshift(record);
  if (DB_LOGS[userEmail].length > 5000) DB_LOGS[userEmail] = DB_LOGS[userEmail].slice(0, 5000);
  const critical = ["enviado","falhou","pausado","cancelado","erro_anexo"].includes(record.status);
  if (critical || DB_LOGS[userEmail].length % 10 === 0) persistLogs();
}

// ── RASTREAMENTO DE JORNADA ──────────────────────────────────────────────────
function trackJourney(email, action, detail) {
  if(!email||!action) return;
  try {
    if(!DB_JOURNEY[email]) DB_JOURNEY[email]=[];
    const d=detail||{};
    DB_JOURNEY[email].unshift({
      ts:Date.now(), date:toLocaleBRT(Date.now()),
      action, ok:d.ok!==false,
      detail:d.detail||'', error:d.error||'', meta:d.meta||{}
    });
    if(DB_JOURNEY[email].length>500) DB_JOURNEY[email]=DB_JOURNEY[email].slice(0,500);
    persistDebounced(JOURNEY_FILE, DB_JOURNEY, 5000);
    if(d.ok===false && d.critical) pushGlobalEvent('user_error',email,`${action}: ${d.error||''}`, 'error');
  } catch(e){ console.warn('[trackJourney]',e.message); }
}

function getUserLogs(userEmail, filters={}) {
  const logs = DB_LOGS[userEmail] || [];
  let out = logs;
  if (filters.status)   out = out.filter(l => l.status === filters.status);
  if (filters.state)    out = out.filter(l => (l.state||"").toUpperCase() === filters.state.toUpperCase());
  if (filters.category) out = out.filter(l => l.category === filters.category);
  if (filters.source)   out = out.filter(l => l.source === filters.source);
  if (filters.q)        { const q=filters.q.toLowerCase(); out=out.filter(l=>(l.company||"").toLowerCase().includes(q)||(l.to||"").toLowerCase().includes(q)||(l.jobTitle||"").toLowerCase().includes(q)); }
  if (filters.dateFrom) out = out.filter(l => l.ts >= new Date(filters.dateFrom).getTime());
  if (filters.dateTo)   out = out.filter(l => l.ts <= new Date(filters.dateTo).getTime()+86400_000);
  const total = out.length;
  const skip = parseInt(filters.skip||0,10);
  const top  = Math.min(100, parseInt(filters.top||50,10));
  return { logs: out.slice(skip, skip+top), total, skip };
}
function exportLogsCSV(userEmail) {
  const logs = DB_LOGS[userEmail] || [];
  const hdr = ["ID","Data","Hora","Status","Empresa","Email","Vaga","Categoria","Estado","Origem","Perfil","Assunto","Anexos","Tentativa","Erro","AppID"];
  const rows = logs.map(l => [
    l.id, l.date, l.hour||"", l.status, l.company||"", l.to||"", l.jobTitle||"",
    l.category||"", l.state||"", l.source||"", l.profileUsed||"", l.subjectUsed||"",
    l.attachCount||0, l.attempt||1, l.error||"", l.appId||""
  ].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(","));
  return [hdr.join(","), ...rows].join("\n");
}

// Backup
setInterval(()=>{ try{persist(path.join(DATA_DIR,"backup.json"),{ts:new Date().toISOString(),users:DB_USERS,total:Object.keys(DB_USERS).length});persistLogs();}catch{} },10*60*1000);

// ══════════════════════════════════════════════════════════
//  VIP STACK — manual days + auto days são independentes
//  Um usuário pode ter: vip.manualExpires e vip.autoExpires
//  separados. O admin pode dar só manual, só auto ou ambos.
// ══════════════════════════════════════════════════════════
function persistCodes() { persist(CODES_FILE, DB_CODES); }
function persistPush() { persist(PUSH_FILE, DB_PUSH); }

// ══════════════════════════════════════════════════════════
//  WEB PUSH — VAPID (RFC 8292 / RFC 8030)
//  Implementação nativa sem dependência externa.
//  Funciona com Chrome, Firefox, Edge e Android PWA.
// ══════════════════════════════════════════════════════════

// Converte base64url para Buffer
function b64urlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g,"+").replace(/_/g,"/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - b64.length % 4);
  return Buffer.from(b64 + pad, "base64");
}

// Cria JWT assinado para VAPID usando crypto nativo do Node.js 18+
async function createVapidJWT(audience) {
  if (!PUSH_ENABLED) throw new Error("VAPID não configurado");

  const header = Buffer.from(JSON.stringify({ typ:"JWT", alg:"ES256" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: audience,
    exp: now + 43200, // 12 horas
    sub: VAPID_SUBJECT,
    iat: now,
  })).toString("base64url");

  const sigInput = `${header}.${payload}`;
  const privKeyDer = b64urlToBuffer(VAPID_PRIVATE_KEY);

  // Importa a chave privada EC P-256 (formato raw de 32 bytes → DER PKCS8)
  // O formato VAPID é chave privada raw de 32 bytes; precisamos montar o DER
  // Deriva a chave pública real via ECDH (crypto.createECDH) a partir dos bytes raw da chave privada
  // O DER PKCS8 exige a chave pública real — zeros causam erro no Node 18+
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privKeyDer);
  const pubKeyBytes = ecdh.getPublicKey(); // 65 bytes uncompressed point

  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420","hex"),
      privKeyDer,
      Buffer.from("a144034200","hex"),
      pubKeyBytes, // chave pública real derivada — obrigatório no Node 18+
    ]),
    format: "der",
    type: "pkcs8",
  });

  const sig = crypto.sign(null, Buffer.from(sigInput), { key: privKeyObj, dsaEncoding: "ieee-p1363" });
  return `${sigInput}.${sig.toString("base64url")}`;
}

// Envia Web Push para uma subscription
async function sendWebPush(subscription, payload) {
  if (!PUSH_ENABLED) return;
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;

  let jwt;
  try { jwt = await createVapidJWT(audience); } catch(e) { console.warn("[push] JWT error:", e.message); return; }

  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const bodyBuf = Buffer.from(body, "utf8");

  // Push sem criptografia de payload (RFC 8030 — envia body raw sem Content-Encoding).
  // NOTA: aes128gcm exigiria ECDH key agreement com a chave pública do browser,
  // o que não está implementado aqui. Sem o header Content-Encoding o push server
  // simplesmente repassa os bytes ao Service Worker, que recebe via e.data.text()/.json().
  const headers = {
    "Authorization": `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
    "Content-Type": "application/json",
    "Content-Length": String(bodyBuf.length),
    "TTL": "86400",
    "Urgency": "high",
  };

  return new Promise((resolve) => {
    const req = https.request({
      hostname: endpointUrl.hostname,
      port: endpointUrl.port || 443,
      path: endpointUrl.pathname + (endpointUrl.search || ""),
      method: "POST",
      headers,
    }, (resp) => {
      const chunks = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (resp.statusCode === 201 || resp.statusCode === 200) {
          console.log(`[push] ✅ entregue (${resp.statusCode})`);
        } else if (resp.statusCode === 410 || resp.statusCode === 404) {
          console.log(`[push] ⚠️ subscription expirada (${resp.statusCode})`);
          resolve({ expired: true });
        } else {
          console.warn(`[push] ❌ HTTP ${resp.statusCode}:`, body.slice(0, 200));
        }
        resolve({ status: resp.statusCode });
      });
    });
    req.on("error", e => { console.warn("[push] req error:", e.message); resolve({ error: e.message }); });
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: "timeout" }); });
    req.write(bodyBuf);
    req.end();
  });
}

// Envia push para todos os devices de um usuário, remove subscriptions expiradas
async function pushToUser(userEmail, payload) {
  const subs = DB_PUSH[userEmail] || [];
  if (!subs.length) return;
  const keep = [];
  for (const sub of subs) {
    const result = await sendWebPush(sub, payload);
    if (!result?.expired) keep.push(sub);
  }
  if (keep.length !== subs.length) {
    DB_PUSH[userEmail] = keep;
    persistPush();
  }
}

// Polling de inbox no servidor — verifica novas respostas a cada 2 min para usuários
// com push ativo e auto-send em andamento ou VIP
const pushPollState = new Map(); // email → { lastUnread }
async function serverPushPoll() {
  if (!PUSH_ENABLED) return;
  const usersWithPush = Object.keys(DB_PUSH).filter(e => (DB_PUSH[e]||[]).length > 0);
  for (const email of usersWithPush) {
    const u = getUser(email); if (!u) continue;
    // Pega sessão ativa para buscar inbox
    const sessArr = Object.values(sessions).filter(s => s.user_email === email && s.access_token);
    const sess = sessArr[0]; const sessId = sess ? Object.keys(sessions).find(k => sessions[k] === sess) : null;
    if (!sessId) continue; // sem sessão ativa = não pode checar inbox
    try {
      const emails = await gmailFetchInbox(sessId, 50);
      // FIX: desconta emails que o usuário já marcou como lidos pelo app (persiste entre sessões)
      const dbUsr = getUser(email) || {};
      const pReadSet = new Set(dbUsr.readEmailIds || []);
      const unread = emails.filter(e => !e.isRead && !pReadSet.has(e.id)).length;
      const prev = pushPollState.get(email) ?? -1;
      if (prev >= 0 && unread > prev) {
        const diff = unread - prev;
        // v13: tenta vincular a resposta mais recente não-lida à vaga original
        const newestUnread = emails.find(e => !e.isRead);
        let linkedHint = "";
        let linkedAppId = "";
        if(newestUnread){
          const match = matchAppToEmail(email, {
            threadId: newestUnread.threadId, inReplyTo: newestUnread.inReplyTo,
            references: newestUnread.references, from: newestUnread.from
          });
          if(match?.app){
            linkedAppId = match.app.appId;
            const co = (match.app.company || match.app.jobSnapshot?.company || "").trim();
            if(co) linkedHint = co;
          }
        }
        const baseTitle = `✈️ H2BApply — ${diff} nova${diff > 1 ? "s" : ""} resposta${diff > 1 ? "s" : ""}!`;
        const payload = {
          type: "new_reply",
          title: linkedHint ? `✈️ ${linkedHint} respondeu!` : baseTitle,
          body: linkedHint
            ? `Você recebeu uma resposta para a vaga em ${linkedHint}.`
            : `Você recebeu ${diff} nova${diff > 1 ? "s" : ""} resposta${diff > 1 ? "s" : ""}. Toque para abrir.`,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "h2b-inbox",
          url: linkedAppId ? `/?tab=respostas&app=${linkedAppId}` : "/?tab=respostas",
          appId: linkedAppId || null,
          timestamp: Date.now(),
        };
        console.log(`[push-poll] ${email}: ${diff} nova(s) resp${linkedHint?` (${linkedHint})`:""} → push`);
        await pushToUser(email, payload);
      }
      pushPollState.set(email, unread);
    } catch(e) { /* sessão pode ter expirado */ }
  }
}
// Executa poll a cada 2 minutos
setInterval(serverPushPoll, 2 * 60 * 1000);


// Verifica se manual VIP está ativo
function isManualVipActive(u) {
  if (!u) return false;
  const now = Date.now();
  // Stack novo: vip.manualExpires
  if (u.vip?.manualExpires && now < u.vip.manualExpires) return true;
  // Compatibilidade com sistema antigo (plano vip ou vipro)
  if (u.vip?.active && now < (u.vip.expiresAt||0) && ["vip","vipro"].includes(u.vip?.plan||"vip")) return true;
  return false;
}
// Verifica se auto VIP (pro/vipro) está ativo
function isAutoVipActive(u) {
  if (!u) return false;
  const now = Date.now();
  // Stack novo: vip.autoExpires
  if (u.vip?.autoExpires && now < u.vip.autoExpires) return true;
  // Compatibilidade com sistema antigo
  if (u.vip?.active && now < (u.vip.expiresAt||0) && ["pro","vipro"].includes(u.vip?.plan||"")) return true;
  return false;
}
function isVipActive(u) { return isManualVipActive(u) || isAutoVipActive(u); }

// Retorna plano efetivo baseado no stack
function getPlan(u) {
  const manual = isManualVipActive(u);
  const auto   = isAutoVipActive(u);
  if (manual && auto) return "vipro";
  if (manual) return "vip";
  if (auto)   return "vipro"; // plano "pro" removido — auto-only = vipro
  return "free";
}

const getManualLimit = u => PLAN_LIMITS[getPlan(u)]?.manual || 20;
const getAutoLimit   = u => PLAN_LIMITS[getPlan(u)]?.auto   || 10;

// Adiciona dias de manual VIP ao stack
function addManualVipDays(email, days) {
  const u = getUser(email) || {};
  const now = Date.now();
  const current = (u.vip?.manualExpires && u.vip.manualExpires > now) ? u.vip.manualExpires : now;
  const newExpires = current + days * 86400_000;
  const vip = { ...(u.vip || {}), manualExpires: newExpires, active: true };
  setUser(email, { vip });
  return newExpires;
}
// Adiciona dias de auto VIP ao stack
function addAutoVipDays(email, days) {
  const u = getUser(email) || {};
  const now = Date.now();
  const current = (u.vip?.autoExpires && u.vip.autoExpires > now) ? u.vip.autoExpires : now;
  const newExpires = current + days * 86400_000;
  const vip = { ...(u.vip || {}), autoExpires: newExpires, active: true };
  setUser(email, { vip });
  return newExpires;
}

const todayStr = () => todayStrBRT(); // BRT correto — usa UTC-3
const countManualToday = h => (h||[]).filter(x=>(x.dateStr||"")===todayStr()&&x.type!=="auto").length;
const countAutoToday   = h => (h||[]).filter(x=>(x.dateStr||"")===todayStr()&&x.type==="auto").length;

// CVs — v16-FIX: dupla persistência (disco + DB) para nunca perder PDF no reinício
const cvPath   = (e,i) => path.join(CVS_DIR,e.replace(/[^a-zA-Z0-9@._-]/g,"_")+"_"+i+".pdf");

const saveCv = (e,i,b64) => {
  // 1. Salva no disco (rápido para leitura)
  try { fs.writeFileSync(cvPath(e,i), Buffer.from(b64,"base64")); } catch(err) {
    console.warn(`[cv] Falha ao salvar disco: ${err.message}`);
  }
  // 2. Salva base64 no DB do usuário (sobrevive a reinícios)
  try {
    const p = getUser(e) || {};
    const cvs = (p.cvs || []).map(c => {
      if(parseInt(c.idx,10) === parseInt(i,10)) return {...c, b64};
      return c;
    });
    setUser(e, {cvs});
  } catch(err) {
    console.warn(`[cv] Falha ao salvar DB: ${err.message}`);
  }
};

const loadCv = (e,i) => {
  // 1. Tenta ler do disco primeiro (mais rápido)
  try {
    const buf = fs.readFileSync(cvPath(e,i));
    if(buf && buf.length > 100) return buf.toString("base64");
  } catch {}
  // 2. Fallback: recupera do DB (sobrevive a reinícios do /tmp)
  try {
    const p = getUser(e);
    const cv = (p?.cvs||[]).find(c => parseInt(c.idx,10) === parseInt(i,10));
    if(cv?.b64 && cv.b64.length > 100) {
      // Restaura no disco para próximas leituras
      try { fs.writeFileSync(cvPath(e,i), Buffer.from(cv.b64,"base64")); } catch {}
      console.log(`[cv] ✅ PDF restaurado do DB para disco: ${e} idx=${i}`);
      return cv.b64;
    }
  } catch {}
  return null;
};

const deleteCv = (e,i) => {
  try { fs.unlinkSync(cvPath(e,i)); } catch {}
  // Remove b64 do DB também
  try {
    const p = getUser(e) || {};
    const cvs = (p.cvs||[]).map(c => {
      if(parseInt(c.idx,10) === parseInt(i,10)) { const {b64,...rest}=c; return rest; }
      return c;
    });
    setUser(e, {cvs});
  } catch {}
};

// ══════════════════════════════════════════════════════════
//  PLANILHAS COM CATEGORIAS DINÂMICAS
// ══════════════════════════════════════════════════════════
let SHEET_JAN = [], SHEET_JUL = [];
const sheetCache = new Map();
const SHEET_TTL  = 60*60*1000;

// Mapa de categorias para labels em português
// ── Grupos de categorias semelhantes (para envio inteligente) ──
const CATEGORY_GROUPS = [
  { key:"outdoor",    label:"🌿 Ao Ar Livre",     cats:["landscape","forest","golf","farm"],     color:"#10b981" },
  { key:"hospitality",label:"🏨 Hospitalidade",   cats:["housekeeper","amusement"],              color:"#8b5cf6" },
  { key:"labor",      label:"🏗️ Trabalho Braçal", cats:["construction","seafood"],              color:"#f59e0b" },
  { key:"water",      label:"🌊 Aquático",         cats:["lifeguard","seafood"],                  color:"#3b82f6" },
];

const CATEGORY_LABELS = {
  landscape:    { label:"🌿 Landscape / Jardim",    en:"Landscape" },
  construction: { label:"🏗️ Construction / Obra",   en:"Construction" },
  housekeeper:  { label:"🏨 Housekeeper / Hotel",   en:"Housekeeper" },
  seafood:      { label:"🦞 Seafood / Frutos do Mar",en:"Seafood" },
  farm:         { label:"🌾 Farm / Fazenda",         en:"Farm" },
  golf:         { label:"⛳ Golf Course",             en:"Golf" },
  amusement:    { label:"🎡 Amusement / Parque",     en:"Amusement" },
  forest:       { label:"🌲 Forest / Florestal",     en:"Forest" },
  lifeguard:    { label:"🏊 Lifeguard / Piscina",    en:"Lifeguard" },
  food:         { label:"🍽️ Food Service / Bar",    en:"Food & Bar" },
  ski:          { label:"⛷️ Ski / Winter Resort",    en:"Ski Resort" },
  other:        { label:"📋 Outros",                  en:"Other" },
};

function loadSheets() {
  for(const[key,file]of[["jan","jan2026_compact.json"],["jul","jul2025_compact.json"]]){
    const p=path.join(__dirname,file);
    if(fs.existsSync(p)){
      try{const d=JSON.parse(fs.readFileSync(p,"utf8"));if(key==="jan")SHEET_JAN=d;else SHEET_JUL=d;
        // Garante campo 'k' (categoria) em todos os registros
        (key==="jan"?SHEET_JAN:SHEET_JUL).forEach(r=>{if(!r.k)r.k=detectCategory(r.n||"");});
        console.log(`[sheet] ✅ ${key}: ${d.length}`);}
      catch(e){console.warn("[sheet]",e.message);}
    }else console.warn("[sheet] ⚠️",file,"não encontrado");
  }
}

const CATEGORY_KEYWORDS = {
  landscape:    ['landscape','lawn','turf','grass','grounds','mowing','garden','tree','arborist','nursery','sod','irrigation','mulch','shrub'],
  construction: ['construction','concrete','masonry','roofing','gutter','excavat','paving','asphalt','electrical','plumb','hvac','demolit','contractor','builders'],
  housekeeper:  ['hotel','resort','hospitality','inn','lodge','motel','housekeeper','cleaning','laundry','maid'],
  seafood:      ['seafood','fish','crab','lobster','oyster','shrimp','vessel','marine','aqua','shellfish'],
  farm:         ['farm','agri','crop','harvest','orchard','ranch','dairy','livestock','poultry'],
  golf:         ['golf','country club'],
  amusement:    ['amusement','carnival','fair','theme park','waterpark','camp'],
  forest:       ['forest','timber','logging','reforestation'],
  lifeguard:    ['lifeguard','pool','aquatic','swim'],
  food:         ['restaurant','grill','tavern','cantina','bistro','brewpub','cafeteria','diner','foodservice','food service','food prep','bartend'],
  ski:          ['ski ','snowboard','winter resort','mountain resort'],
};

function detectCategory(name) {
  const n = (name||"").toLowerCase();
  for(const[cat,kws]of Object.entries(CATEGORY_KEYWORDS)){if(kws.some(k=>n.includes(k)))return cat;}
  return "other";
}

function getSheet(n) { return n==="jan2026"?SHEET_JAN:n==="jul2025"?SHEET_JUL:[]; }

function getSheetCategories(sheetName) {
  const arr = getSheet(sheetName);
  const counts = {};
  arr.forEach(r => { const k=r.k||"other"; counts[k]=(counts[k]||0)+1; });
  return Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .map(([k,count])=>({key:k,label:CATEGORY_LABELS[k]?.label||k,count}));
}

// Fisher-Yates shuffle — embaralha sem modificar o array original
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Maps job title keywords → category
const JOB_TITLE_TO_CAT = {
  bartender:"food",barman:"food",barmaid:"food",cook:"food","line cook":"food",
  "prep cook":"food",chef:"food",dishwasher:"food",waiter:"food",waitress:"food",
  "food server":"food",barista:"food",baker:"food","food service":"food",
  landscaper:"landscape","lawn care":"landscape",groundskeeper:"landscape",
  gardener:"landscape","landscape worker":"landscape",
  carpenter:"construction",electrician:"construction",plumber:"construction",
  welder:"construction",roofer:"construction",mason:"construction",laborer:"construction",
  painter:"construction","general laborer":"construction",
  housekeeper:"housekeeper",maid:"housekeeper",cleaner:"housekeeper",
  janitor:"housekeeper","room attendant":"housekeeper",
  "seafood processor":"seafood","fish processor":"seafood","crab picker":"seafood",
  "farm worker":"farm",farmhand:"farm","field worker":"farm",harvester:"farm",
  greenskeeper:"golf",caddie:"golf","golf course":"golf",
  lifeguard:"lifeguard","pool attendant":"lifeguard",
};
const CAT_OCC_LABELS = {
  food:"Food Service Bartender Cook Waiter",landscape:"Landscape Grounds Lawn",
  construction:"Construction Labor Carpenter",housekeeper:"Housekeeper Cleaning Hotel",
  seafood:"Seafood Fish Crab Processor",farm:"Farm Agricultural Worker",
  golf:"Golf Course Greens",amusement:"Amusement Recreation Park",
  forest:"Forestry Timber Logging",lifeguard:"Lifeguard Pool Aquatic",
  ski:"Ski Resort Winter Mountain",other:"Seasonal Worker",
};

function searchSheet(arr, q, state, category, skip, top, sort) {
  let list = arr;
  if (q && q.trim()) {
    const ql = q.toLowerCase().trim();
    // Detect implied category from job title keyword
    let impliedCat = null;
    if (ql.length >= 3) {
      for(const[title,cat] of Object.entries(JOB_TITLE_TO_CAT)){
        if(ql===title||ql.includes(title)||title.startsWith(ql)){impliedCat=cat;break;}
      }
      if(!impliedCat){
        for(const[cat,kws] of Object.entries(CATEGORY_KEYWORDS)){
          if(kws.some(k=>k.trim().length>=3&&ql.includes(k.trim()))){impliedCat=cat;break;}
        }
      }
    }

    if(impliedCat && (!category||category==="all")){
      // PRIORITY SEARCH — 3 tiers por relevância:
      // Tier 1: título da vaga contém exatamente a busca (ex: "Bartender" no título)
      // Tier 2: empresa ou case number contém a busca
      // Tier 3: categoria corresponde mas sem match direto no título
      const ql_words = ql.split(/\s+/).filter(w=>w.length>=3);
      const titleExact = (r) => {
        const t = (r.t||r.n||"").toLowerCase();
        return t===ql || t.startsWith(ql+" ") || t.includes(" "+ql) || t.includes(ql);
      };
      const tier1 = arr.filter(r => titleExact(r)); // título contém busca
      const tier2 = arr.filter(r => !titleExact(r) && (
        (r.n||"").toLowerCase().includes(ql) ||
        (r.e||"").toLowerCase().includes(ql) ||
        (r.c||"").toLowerCase().includes(ql)
      ));
      const tier3 = arr.filter(r =>
        (r.k||"other")===impliedCat &&
        !titleExact(r) &&
        !(r.n||"").toLowerCase().includes(ql) &&
        !(r.c||"").toLowerCase().includes(ql)
      );
      // Merge: tier1 primeiro (match exato no título), depois tier2, depois tier3
      const seen=new Set();
      const dedup=(r)=>{ if(seen.has(r.c))return false; seen.add(r.c); return true; };
      list=[...tier1.filter(dedup),...tier2.filter(dedup),...tier3.filter(dedup)];
    } else {
      // Regular search: company name, state, case number, email only
      list = list.filter(r =>
        (r.n  || "").toLowerCase().includes(ql) ||  // company name
        (r.c  || "").toLowerCase().includes(ql) ||  // ETA case number
        (r.e  || "").toLowerCase().includes(ql) ||  // email
        (r.s  || "").toLowerCase().includes(ql)     // state name
      );
    }
  }
  if (state)    list=list.filter(r=>(r.s||"").toUpperCase()===state.toUpperCase());
  if (category && category!=="all") {
    const cats=category.split(",").map(c=>c.trim()).filter(Boolean);
    if(cats.length===1) list=list.filter(r=>(r.k||"other")===cats[0]);
    else list=list.filter(r=>cats.includes(r.k||"other"));
  }
  // Ordenação: asc/desc preserva paginação visual; shuffle (default) garante aleatoriedade
  // para evitar que vários usuários enviem para as mesmas empresas simultaneamente
  if (sort==="desc") list=[...list].reverse();
  else if (sort==="asc") { /* mantém ordem original */ }
  else { list=shuffleArray(list); } // sort="" ou "random" → embaralha
  return { total:list.length, items:list.slice(skip,skip+top) };
}

// ══════════════════════════════════════════════════════════
//  DOL API
// ══════════════════════════════════════════════════════════
let jobsCache=[], jobsTotal=0, lastFetch=0;
const CACHE_TTL=30*60*1000;

const FALLBACK_JOBS = [
  {id:"f01",title:"Excavation Laborer",company:"Diversified Underground Services",city:"Lake Mary",state:"FLORIDA",wage:"$21.66/h",workers:16,start:"2026-05-03",end:"2026-11-30",email:"ftorres@diversified-undergroundinc.com",phone:"+1 (863) 441-0823",url:"",active:true,visa:"H-2B",desc:"Excavation, trenches.",hasEmail:true,category:"construction"},
  {id:"f02",title:"Landscaping Laborer",company:"Woehler Landscaping",city:"Pittsburgh",state:"PENNSYLVANIA",wage:"$18.69/h",workers:6,start:"2026-05-03",end:"2026-11-30",email:"landscapePSU@hotmail.com",phone:"",url:"",active:true,visa:"H-2B",desc:"Maintain plants, trees.",hasEmail:true,category:"landscape"},
  {id:"f03",title:"Housekeeper",company:"CBV Partners LLC",city:"Jackson",state:"WYOMING",wage:"$16.58/h",workers:11,start:"2026-05-03",end:"2026-10-15",email:"cbvjobs@gmail.com",phone:"",url:"",active:true,visa:"H-2B",desc:"Clean rooms.",hasEmail:true,category:"housekeeper"},
  {id:"f04",title:"Landscape Laborer",company:"Fitzpatrick Lawn & Landscape",city:"Charlotte",state:"NORTH CAROLINA",wage:"$18.72/h",workers:18,start:"2026-05-03",end:"2026-12-15",email:"liam@fitzpatricklandscape.com",phone:"",url:"",active:true,visa:"H-2B",desc:"Mow, trim.",hasEmail:true,category:"landscape"},
  {id:"f05",title:"Farmworker",company:"The Earley Farm",city:"Wales",state:"MAINE",wage:"$15.10/h",workers:4,start:"2026-05-03",end:"2026-10-16",email:"info@theearleyfarm.com",phone:"",url:"",active:true,visa:"H-2A",desc:"Harvest.",hasEmail:true,category:"farm"},
];

function normJob(j,i) {
  const em=(j.apply_email&&j.apply_email!=="N/A")?j.apply_email:(j.employer_email&&j.employer_email!=="N/A")?j.employer_email:"";
  const ph=(j.apply_phone&&j.apply_phone!=="N/A")?j.apply_phone:(j.employer_phone||"");
  const ur=(j.apply_url&&j.apply_url!=="N/A")?j.apply_url:(j.employer_website||"");
  const wg=j.basic_rate_from?`$${parseFloat(j.basic_rate_from).toFixed(2)}/${j.pay_range_desc==="Month"?"mês":"h"}`:"–";
  const title=j.job_title||"Position";
  return{id:String(j.case_number||j.case_id||("j"+i)),caseNum:String(j.case_number||j.case_id||""),title,company:j.employer_business_name||j.employer_trade_name||"–",city:j.employer_city||j.worksite_city||"–",state:j.employer_state||j.worksite_state||"–",wage:wg,workers:parseInt(j.total_positions||1),start:(j.begin_date||"–").slice(0,10),end:(j.end_date||"–").slice(0,10),email:em,phone:ph,url:ur,active:j.active===true,visa:j.visa_class||"H-2B",jobType:j.visa_class==="H-2A"?"agricultural":"non-agricultural",soc:j.soc_title||"",desc:(j.job_duties||"").replace(/\*\*[^*]+\*\*\n?/g,"").trim(),hasEmail:!!em,category:detectCategory(j.employer_business_name||"")};
}

async function fetchDOL(skip,top,opts={}) {
  const{query="",state="",jobType="all",jobStatus="all",beginDate="",sort="desc"}=opts;
  const p=new URLSearchParams({"api-version":"2020-06-30"});
  if(query)p.append("$search",'"'+query.replace(/"/g,"")+'"');
  const f=[];
  if(jobStatus==="active")f.push("active eq true");if(jobStatus==="inactive")f.push("active eq false");
  if(jobType==="agricultural")f.push("visa_class eq 'H-2A'");if(jobType==="non-agricultural")f.push("visa_class eq 'H-2B'");
  if(state)f.push(`(employer_state eq '${state}' or worksite_state eq '${state}')`);
  if(beginDate)f.push(`begin_date ge '${beginDate}'`);
  if(f.length)p.append("$filter",f.join(" and "));
  p.append("$orderby","dhTimestamp "+(sort==="asc"?"asc":"desc"));
  p.append("$top",String(top));p.append("$skip",String(skip));
  const{status,body}=await httpsReq({hostname:"api.seasonaljobs.dol.gov",path:"/datahub/?"+p,method:"GET",headers:{"Accept":"application/json","Accept-Encoding":"identity","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36","Cache-Control":"no-cache","Referer":"https://seasonaljobs.dol.gov/"}});
  if(status!==200)throw new Error("DOL "+status);
  const raw=body.value||body.results||body.data||(Array.isArray(body)?body:[]);
  return{jobs:raw.map((j,i)=>normJob(j,skip+i)),total:body["@odata.count"]||body.count||raw.length};
}

async function fetchByCase(cases) {
  if(!cases.length)return{};
  const results={};
  const toFetch=cases.filter(c=>{const cc=sheetCache.get(c);if(cc&&Date.now()-cc.ts<SHEET_TTL){results[c]=cc.job;return false;}return true;});
  if(!toFetch.length)return results;
  const HDR={"Accept":"application/json","Accept-Encoding":"identity","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36","Cache-Control":"no-cache","Referer":"https://seasonaljobs.dol.gov/"};
  for(let i=0;i<toFetch.length;i+=10){
    const batch=toFetch.slice(i,i+10);
    try{
      const p=new URLSearchParams({"api-version":"2020-06-30"});
      p.append("$filter",batch.map(c=>`case_number eq '${c}'`).join(" or "));
      p.append("$top",String(batch.length));
      const{status,body}=await httpsReq({hostname:"api.seasonaljobs.dol.gov",path:"/datahub/?"+p,method:"GET",headers:HDR});
      if(status===200){const raw=body.value||body.results||body.data||(Array.isArray(body)?body:[]);for(const r of raw){const job=normJob(r,0);const cn=(r.case_number||r.case_id||"").toUpperCase();if(cn){results[cn]=job;sheetCache.set(cn,{job,ts:Date.now()});}}}
    }catch(e){console.warn("[batch/filter]",e.message);}
    // Fallback: busca individual por $search
    const miss=batch.filter(c=>!results[c]);
    for(const c of miss){
      try{const p2=new URLSearchParams({"api-version":"2020-06-30"});p2.append("$search",`"${c}"`);p2.append("$top","1");const{status,body}=await httpsReq({hostname:"api.seasonaljobs.dol.gov",path:"/datahub/?"+p2,method:"GET",headers:HDR});if(status===200){const raw=body.value||body.results||body.data||(Array.isArray(body)?body:[]);if(raw.length>0){const job=normJob(raw[0],0);results[c]=job;sheetCache.set(c,{job,ts:Date.now()});}}}catch{}
    }
  }
  return results;
}

async function refreshCache(){
  try{const{jobs,total}=await fetchDOL(0,100,{});if(jobs.length){jobsCache=jobs;jobsTotal=total;lastFetch=Date.now();console.log(`[cache] ${jobs.length} vagas`);}}
  catch(e){console.warn("[cache]",e.message);if(!jobsCache.length){jobsCache=FALLBACK_JOBS;jobsTotal=FALLBACK_JOBS.length;}}
}

// ══════════════════════════════════════════════════════════
//  ENVIO AUTOMÁTICO — STREAMING INTELIGENTE
//  Inicia imediatamente sem esperar carregar tudo
// ══════════════════════════════════════════════════════════
const autoTimers = new Map();
const autoStats  = new Map(); // { email → { sent, failed, skipped, startedAt } }

function isAutoHour(startH, endH) {
  const hBRT = hourBRT(); // UTC-3 fixo
  const s = startH !== undefined ? startH : AUTO_START_H_DEFAULT;
  const e = endH   !== undefined ? endH   : AUTO_END_H_DEFAULT;
  return hBRT >= s && hBRT < e;
}

function getAutoStats(email) {
  return autoStats.get(email) || { sent:0, failed:0, skipped:0, startedAt:null };
}
function updateAutoStats(email, delta) {
  const s = getAutoStats(email);
  autoStats.set(email, { ...s, ...delta });
}

const _autoRunning = new Set(); // Guard contra execução paralela

function scheduleAuto(email) {
  if(autoTimers.has(email))clearTimeout(autoTimers.get(email));
  const job=getAutoJob(email);
  if(!job||!job.active||!job.queue?.length){autoTimers.delete(email);_autoRunning.delete(email);return;}

  const mode = job.mode || "schedule"; // "now" | "schedule"
  const startH = job.startH !== undefined ? job.startH : AUTO_START_H_DEFAULT;
  const endH   = job.endH   !== undefined ? job.endH   : AUTO_END_H_DEFAULT;

  // ── MODO "AGORA": sem janela de horário ──────────────────
  if(mode === "now") {
    const p=getUser(email)||{};
    const autoLimit=getAutoLimit(p);
    const todayAuto=countAutoToday(getHist(email));
    if(todayAuto>=autoLimit){
      // Limite atingido: aguarda meia-noite BRT (UTC+3 = 03:00 UTC)
      const now=new Date();
      const next=new Date(now);
      next.setUTCHours(3,0,1,0); // 00:00:01 BRT = 03:00:01 UTC
      if(next<=now) next.setDate(next.getDate()+1);
      const delay=Math.max(0,next-now);
      setAutoJob(email,{...job,status:"waiting_limit",nextSendAt:next.getTime()});
      autoTimers.set(email,setTimeout(()=>scheduleAuto(email),delay));
      const retomaBRT_now = next.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit"});
      addLog(email,{status:"limite",jobTitle:`📊 Limite diário atingido: ${todayAuto}/${autoLimit} envios`,company:`Fila pausada. Retoma amanhã às ${retomaBRT_now} BRT (${Math.round(delay/60000)}min). Fila: ${job.queue?.length||0} vagas aguardando.`,error:""});
      console.log(`[auto/now] ${email} limite (${todayAuto}/${autoLimit}), retoma à meia-noite BRT (~${Math.round(delay/60000)}min)`);
      return;
    }
    doAutoSend(email);
    return;
  }

  // ── MODO "AGENDADO": respeita janela startH–endH ─────────
  if(!isAutoHour(startH, endH)){
    const hBRT=hourBRT();
    const now=new Date();const next=new Date(now);
    const startUTC=(startH+3)%24;
    next.setUTCHours(startUTC,0,0,0);
    if(hBRT>=endH||next<=now)next.setDate(next.getDate()+1);
    if(next<=now)next.setDate(next.getDate()+1);
    const delay=Math.max(0,next-now);
    console.log(`[auto/sched] ${email} aguarda ${Math.round(delay/60000)}min (inicia ${startH}h BRT)`);
    setAutoJob(email,{...job,status:"waiting_hour",nextSendAt:next.getTime()});
    autoTimers.set(email,setTimeout(()=>scheduleAuto(email),delay));
    return;
  }
  const p=getUser(email)||{};
  const autoLimit=getAutoLimit(p);
  const todayAuto=countAutoToday(getHist(email));
  if(todayAuto>=autoLimit){
    // Limite atingido no modo agendado: retoma amanhã no startH
    const startUTC2=(startH+3)%24;
    const now=new Date(),next=new Date(now);
    next.setUTCHours(startUTC2,0,0,0);next.setDate(next.getDate()+1);
    setAutoJob(email,{...job,status:"waiting_limit",nextSendAt:next.getTime()});
    autoTimers.set(email,setTimeout(()=>scheduleAuto(email),next-now));
    const retomaBRT_sched = next.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit"});
    addLog(email,{status:"limite",jobTitle:`📊 Limite diário: ${todayAuto}/${autoLimit} envios`,company:`Retoma amanhã às ${startH}h BRT (${retomaBRT_sched}). Fila: ${job.queue?.length||0} vagas aguardando.`,error:""});
    console.log(`[auto/sched] ${email} limite (${todayAuto}/${autoLimit}), retoma ${startH}h BRT amanhã`);
    return;
  }
  doAutoSend(email);
}

// ── Seleção automática de perfil por prioridade ───────────
// Prioridade: 1. perfil específico da vaga (por título/categoria)
//             2. perfil da categoria da vaga
//             3. perfil geral (isGeneral=true)
// Retorna o perfil selecionado ou null
function selectProfile(profiles, target, sheet) {
  if (!profiles || !profiles.length) return null;
  const active = profiles.filter(pr => pr.active !== false);
  if (!active.length) return null;

  const jobTitle   = (target.title    || "").toLowerCase();
  const jobCat     = (target.category || "other").toLowerCase();
  const jobSheet   = sheet || "";
  const jobVisa    = (target.visa || "").toUpperCase(); // "H-2A" ou "H-2B"
  const isH2A      = jobVisa === "H-2A" || (target.jobType === "agricultural");

  // 1. Perfil específico para H-2A (se vaga for H-2A)
  if (isH2A) {
    const h2aProfiles = active.filter(pr => {
      if (pr.isGeneral) return false;
      const prName = (pr.name || "").toLowerCase();
      // Perfil explicitamente para H-2A
      if (prName.includes("h2a") || prName.includes("h-2a") || prName.includes("farm") || prName.includes("agricult")) return true;
      if (pr.categories && (pr.categories.includes("farm") || pr.categories.includes("h2a") || pr.categories.includes("agricultural"))) return true;
      return false;
    });
    if (h2aProfiles.length) {
      const withSheet = h2aProfiles.filter(pr => pr.sheets && pr.sheets.includes(jobSheet));
      return withSheet.length ? withSheet[0] : h2aProfiles[0];
    }
  }

  // 2. Perfil específico: match por categoria ou título da vaga
  const specific = active.filter(pr => {
    if (pr.isGeneral) return false;
    const prName = (pr.name || "").toLowerCase();
    // Match por categoria configurada no perfil
    if (pr.categories && pr.categories.length) {
      if (pr.categories.includes(jobCat)) return true;
    }
    // Match por nome do perfil ~ categoria ou título
    if (jobCat && prName.includes(jobCat)) return true;
    if (jobTitle && jobTitle.split(/\s+/).some(w => w.length > 3 && prName.includes(w))) return true;
    return false;
  });

  // Entre os específicos, prefere o que também tem a planilha correta
  if (specific.length) {
    const withSheet = specific.filter(pr => pr.sheets && pr.sheets.length && pr.sheets.includes(jobSheet));
    return withSheet.length ? withSheet[0] : specific[0];
  }

  // 3. Perfil da categoria: tem essa categoria na lista mas sem match de título
  const byCat = active.filter(pr => {
    if (pr.isGeneral) return false;
    return pr.categories && pr.categories.includes(jobCat);
  });
  if (byCat.length) return byCat[0];

  // 4. Perfil geral
  const general = active.filter(pr => pr.isGeneral);
  if (general.length) return general[0];

  // Fallback: qualquer perfil ativo
  return active[0];
}

// ── Rotação de assunto sem repetição consecutiva ──────────
// rotState: { lastSubjIdx, lastBodyIdx } — guardado no job
function rotateItem(items, lastIdx) {
  if (!items || !items.length) return { value: null, idx: -1 };
  if (items.length === 1) return { value: items[0], idx: 0 };
  // Exclui o último usado para evitar repetição consecutiva
  let candidates = items.map((v, i) => ({ v, i })).filter(x => x.i !== lastIdx);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { value: pick.v, idx: pick.i };
}

// Controle simples de concorrência: impede dois doAutoSend simultâneos para o mesmo email
const autoSendLock = new Set();

// ── PERFORMANCE: cache de filtros/categorias (evita recomputar a cada request) ──
const _sheetCatCache = new Map(); // sheetName → { result, ts }
const SHEET_CAT_TTL  = 5 * 60_000; // 5 min

function getSheetCategoriesCached(sheetName) {
  const cached = _sheetCatCache.get(sheetName);
  if (cached && Date.now() - cached.ts < SHEET_CAT_TTL) return cached.result;
  const result = getSheetCategories(sheetName);
  _sheetCatCache.set(sheetName, { result, ts: Date.now() });
  return result;
}

// ── PERFORMANCE: cache de stats do usuário (evita recomputar em todo /api/status) ──
const _userStatsCache = new Map(); // email → { todayManual, todayAuto, ts }
const USER_STATS_TTL  = 30_000; // 30s

function getUserStatsCached(email) {
  const cached = _userStatsCache.get(email);
  if (cached && Date.now() - cached.ts < USER_STATS_TTL) return cached;
  const h = getHist(email);
  const todayManual = countManualToday(h);
  const todayAuto   = countAutoToday(h);
  const result = { todayManual, todayAuto, ts: Date.now() };
  _userStatsCache.set(email, result);
  return result;
}

function invalidateUserStatsCache(email) {
  _userStatsCache.delete(email);
}

// ── PERFORMANCE: deduplicação de envio manual por destinatário ──
// Impede envio duplicado por duplo-clique / refresh
const _manualSendInFlight = new Map(); // email+to → promessa em andamento

// ── PERFORMANCE: debounce de persist para evitar escrita excessiva no disco ──
const _persistDebounceTimers = new Map();
function persistDebounced(file, data, delayMs = 2000) {
  if (_persistDebounceTimers.has(file)) {
    clearTimeout(_persistDebounceTimers.get(file));
  }
  _persistDebounceTimers.set(file, setTimeout(() => {
    _persistDebounceTimers.delete(file);
    persist(file, data);
  }, delayMs));
}
// Força escrita imediata e cancela debounce pendente (usar no shutdown)
function persistFlush(file, data) {
  if (_persistDebounceTimers.has(file)) {
    clearTimeout(_persistDebounceTimers.get(file));
    _persistDebounceTimers.delete(file);
  }
  persist(file, data);
}

async function doAutoSend(email) {
  // Concorrência: só um envio por vez por usuário
  if (autoSendLock.has(email)) {
    console.warn(`[auto] ${email} já enviando, ignorando chamada duplicada`);
    return;
  }
  autoSendLock.add(email);
  try {
    await _doAutoSendInner(email);
  } finally {
    autoSendLock.delete(email);
  }
}

async function _doAutoSendInner(email) {
  // Guard: evitar execução paralela do mesmo worker
  if(_autoRunning.has(email)){
    console.warn(`[auto/guard] ${email} já está executando — ignorando chamada dupla`);
    return;
  }
  _autoRunning.add(email);
  try {
  // Sempre relê o job do banco — nunca usa objeto em cache
  const job = getAutoJob(email);
  if (!job || !job.active) { autoTimers.delete(email); return; }

  // ── Fila: copia fresca a cada ciclo (nunca mutamos job.queue diretamente) ──
  let queue = (job.queue || []).map(item => Object.assign({}, item)); // cópia profunda rasa
  let target = null;

  // Pula duplicatas da fila
  while (queue.length > 0) {
    const candidate = queue[0];
    if (!hasSent(email, candidate.to)) {
      // v15-SEC: auto dedup + validação robusta + self-send guard
      const _ce = parseEmail(candidate.to||"");
      if (!_ce.ok) {
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:`E-mail inválido (${_ce.reason}): "${candidate.to}"` });
        queue.shift(); continue;
      }
      if (_ce.email === email.toLowerCase()) {
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:"Destinatário é o próprio usuário — auto-envio bloqueado" });
        queue.shift(); continue;
      }
      candidate.to = _ce.email; // normalizado
      target = Object.assign({}, candidate); break;
    }
    addLog(email, { status:"duplicado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:"Email já enviado anteriormente" });
    queue.shift();
  }

  if (!target || queue.length === 0) {
    setAutoJob(email, { ...job, active:false, queue:[], finishedAt:Date.now(), status:"finished" });
    autoTimers.delete(email);
    _autoRunning.delete(email);
    addLog(email, { status:"sistema", jobTitle:"Fila finalizada", company:`Total: ${job.originalCount||0} vagas processadas` });
    console.log(`[auto] ${email} finalizado`);
    // 🔔 Notifica o usuário por email que a fila terminou
    sendNotifEmail(email, "finished").catch(e => console.warn("[notif/finished]", e.message));
    return;
  }

  // Remove target da fila e salva ANTES de tentar envio (evita reprocessamento em crash)
  queue.shift();
  setAutoJob(email, { ...job, queue, lastSentAt:Date.now(), status:"sending", currentJob:target });

  // ── Token ─────────────────────────────────────────────────
  const logEntry = { company:target.company||"", to:target.to||"", jobTitle:target.title||"", category:target.category||"other", state:target.state||"", city:target.city||"", source:job.source||"", resumeName:"", error:"", profileUsed:"", selectedProfileName:"" };
  let accessToken = null;

  const sessArr = Object.values(sessions).filter(s => s.user_email === email && s.access_token);
  const sess    = sessArr[0] || null;
  const sessId  = sess ? Object.keys(sessions).find(k => sessions[k] === sess) : null;
  if (sess && sess.expires_at && Date.now() > sess.expires_at - 120_000) {
    try { await refreshToken(sessId); } catch(e) { console.warn("[auto] refresh sessão:", e.message); }
  }
  if (sess?.access_token) accessToken = sess.access_token;

  if (!accessToken) {
    const userData = getUser(email);
    if (userData?.cached_access_token && userData.cached_token_expiry && Date.now() < userData.cached_token_expiry - 120_000) {
      accessToken = userData.cached_access_token;
    } else if (userData?.refresh_token) {
      try { accessToken = await refreshTokenForUser(email); }
      catch(e) {
        setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_no_session" });
        autoTimers.delete(email);
        addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle:"Token expirado — faça login novamente", error:e.message });
        return;
      }
    } else {
      setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_no_session" });
      autoTimers.delete(email);
      addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle:"Sem token — faça login novamente", error:"Nenhum refresh_token disponível" });
      return;
    }
  }

  // ── Payload: construído do zero a cada envio ──────────────
  let sendOk = false;
  let retryCount = 0;
  const MAX_RETRIES = 2;

  while (retryCount <= MAX_RETRIES) {
    // Relê usuário a cada tentativa (dados podem ter mudado)
    const p = getUser(email) || {};

    // Seleção de perfil — sempre calculada do zero
    const profiles       = Array.isArray(p.profiles) ? p.profiles : [];
    const selectedProfile = selectProfile(profiles, target, job.source || "");
    const rotState       = job.rotState || { lastSubjIdx:-1, lastBodyIdx:-1 };

    // Índices de currículo: perfil tem prioridade sobre job, job sobre fallback automático
    let effectiveResumeIdx = (job.resumeIdx != null) ? job.resumeIdx : null;
    let effectiveCoverIdx  = (job.coverIdx  != null) ? job.coverIdx  : null;
    if (selectedProfile) {
      if (selectedProfile.resumeIdx != null) effectiveResumeIdx = selectedProfile.resumeIdx;
      if (selectedProfile.coverIdx  != null) effectiveCoverIdx  = selectedProfile.coverIdx;
    }
    // Fallback automático: se ainda nulo, usa o primeiro resume disponível do usuário
    if (effectiveResumeIdx == null) {
      const firstResume = (p.cvs || []).find(c => (c.cvType || "resume") === "resume");
      if (firstResume) effectiveResumeIdx = firstResume.idx;
    }

    // ── Anexos: leitura fresca do disco a cada tentativa ──
    const attachments = [];

    if (effectiveResumeIdx != null) {
      const ridx = parseInt(effectiveResumeIdx, 10);
      // v15-FIX: comparação tipo-segura (idx pode vir como string em alguns casos de JSON legado)
      const cvMeta = (p.cvs || []).find(c => parseInt(c.idx, 10) === ridx);
      // Lê bytes frescos do disco (nunca cache em variável fora do loop)
      const cvData = loadCv(email, ridx);
      if (cvMeta && cvData) {
        // Valida que é base64 real e não vazio
        const buf = Buffer.from(cvData, "base64");
        if (buf.length > 100) {
          attachments.push({ data: cvData, name: String(cvMeta.name || "resume.pdf") });
          logEntry.resumeName = cvMeta.name || "resume.pdf";
        } else {
          console.warn(`[auto] PDF muito pequeno (${buf.length}b) idx=${ridx} — pode estar corrompido`);
        }
      } else {
        console.warn(`[auto] Resume não encontrado no disco: email=${email} idx=${ridx} path=${cvPath(email, ridx)}`);
        // Verifica se arquivo existe no disco
        const cpth = cvPath(email, ridx);
        if (!fs.existsSync(cpth)) {
          addLog(email, { status:"erro_anexo", company:target.company||"", to:target.to, jobTitle:target.title||"", error:`Arquivo PDF não encontrado: idx=${ridx}` });
        }
      }
    }

    if (effectiveCoverIdx != null) {
      const cidx = parseInt(effectiveCoverIdx, 10);
      // v15-FIX: comparação tipo-segura
      const cvMeta = (p.cvs || []).find(c => parseInt(c.idx, 10) === cidx);
      const cvData = loadCv(email, cidx);
      if (cvMeta && cvData) {
        const buf = Buffer.from(cvData, "base64");
        if (buf.length > 100) {
          attachments.push({ data: cvData, name: String(cvMeta.name || "cover.pdf") });
        }
      }
    }

    // Validação: se resumeIdx foi configurado mas arquivo não carregou, tenta qualquer CV disponível
    if (effectiveResumeIdx != null && attachments.length === 0) {
      // Tenta qualquer CV do usuário como último recurso
      const fallbackCV = (p.cvs || []).find(c => {
        const data = loadCv(email, c.idx);
        return data && Buffer.from(data, "base64").length > 100;
      });
      if (fallbackCV) {
        const data = loadCv(email, fallbackCV.idx);
        attachments.push({ data, name: fallbackCV.name });
        logEntry.resumeName = fallbackCV.name;
        console.warn(`[auto] ⚠️ CV idx=${effectiveResumeIdx} não encontrado — usando fallback: ${fallbackCV.name}`);
      } else {
        addLog(email, { ...logEntry, status:"pulado", error:`Currículo não encontrado no servidor (idx=${effectiveResumeIdx}). Faça upload novamente.` });
        break;
      }
    }

    // ── Assunto (rotação, novo objeto a cada envio) ────────
    const subjectPool = (selectedProfile?.subjects?.length) ? [...selectedProfile.subjects]
                      : (job.subjects?.length)              ? [...job.subjects]
                      : null;
    let chosenSubject, newSubjIdx;
    if (subjectPool && subjectPool.length) {
      const rot = rotateItem(subjectPool, rotState.lastSubjIdx);
      chosenSubject = rot.value; newSubjIdx = rot.idx;
    } else {
      chosenSubject = genSubject(String(target.title || "")); newSubjIdx = -1;
    }
    if (!chosenSubject || !String(chosenSubject).trim()) {
      chosenSubject = genSubject(String(target.title || "")); newSubjIdx = -1;
    }

    // ── Corpo (rotação, novo objeto a cada envio) ──────────
    const bodyPool = (selectedProfile?.emailBodies?.length) ? [...selectedProfile.emailBodies]
                   : (job.emailBodies?.length)              ? [...job.emailBodies]
                   : null;
    let rawBody, newBodyIdx;
    if (bodyPool && bodyPool.length) {
      const rot = rotateItem(bodyPool, rotState.lastBodyIdx);
      rawBody = rot.value; newBodyIdx = rot.idx;
    } else {
      rawBody = String(selectedProfile?.body || job.bodyTemplate || ""); newBodyIdx = -1;
    }
    if (!rawBody || !String(rawBody).trim()) rawBody = "";

    // Salva rotState ANTES de enviar (novo objeto imutável)
    const newRotState = { lastSubjIdx: newSubjIdx, lastBodyIdx: newBodyIdx };
    setAutoJob(email, { ...getAutoJob(email), rotState: newRotState });

    // Interpola variáveis — novo string a cada chamada
    // Inclui TODAS as variáveis que os templates podem usar
    const tplVars = {
      vaga:     String(target.title    || ""),
      empresa:  String(target.company  || ""),
      nome:     String(p.name || sess?.user_name || ""),
      pais:     String(p.country || "Brazil"),
      telefone: String(p.phone || ""),
      email:    String(email),                          // email do usuário/candidato
      cidade:   String(target.city    || p.city || ""),
      estado:   String(target.state   || ""),
      wage:     String(target.wage    || ""),
      inicio:   String(target.start   || ""),
    };
    const subject = fillTpl(String(chosenSubject), tplVars);
    const body    = fillTpl(String(rawBody),        tplVars);

    // v15-SEC: bloqueia envio com assunto ou corpo vazio
    if (!subject.trim()) {
      addLog(email, { ...logEntry, status:"pulado", error:"Assunto em branco — configure um assunto no perfil ou nas configurações." });
      break; // sai do retry loop — pula esta vaga
    }
    if (!body.trim()) {
      addLog(email, { ...logEntry, status:"pulado", error:"Corpo do e-mail em branco — configure um template de mensagem no perfil ou nas configurações." });
      break;
    }
    // v16-FIX: bloqueia envio sem PDF — email vazio pro empregador não pode acontecer
    if (attachments.length === 0) {
      addLog(email, { ...logEntry, status:"pulado", error:"Nenhum currículo (PDF) encontrado. Acesse a aba Perfil, suba seu currículo e configure o perfil de envio." });
      console.warn(`[auto] ⛔ BLOQUEADO sem anexo: ${email} → ${target.to}`);
      break;
    }

    // v15-SEC: re-valida e normaliza target.to antes de construir MIME (defesa em profundidade)
    const _finalEmail = parseEmail(target.to);
    if (!_finalEmail.ok) {
      addLog(email, { ...logEntry, status:"pulado", error:`E-mail inválido na fila (${_finalEmail.reason}): "${target.to}"` });
      break;
    }
    if (_finalEmail.email === email.toLowerCase()) {
      addLog(email, { ...logEntry, status:"pulado", error:"Destinatário é o próprio usuário — auto-envio bloqueado (verificação final)" });
      break;
    }
    target.to = _finalEmail.email; // garante normalizado no MIME

    // ── Constrói MIME do zero (nunca reutiliza raw) ────────
    const raw = buildMime({
      to: target.to,
      subject,
      text: body,
      fromName: String(p.name || "H2BApply"),
      fromEmail: String(email),
      attachments: attachments.map(a => ({ data: a.data, name: a.name })), // cópia explícita
    });

    // Log detalhado de diagnóstico por envio
    const _pname = selectedProfile?.name||"(nenhum — usando fallback)";
    const _pcats  = selectedProfile?.categories?.join(",")||"(todas)";
    const _presIdx= selectedProfile?.resumeIdx??null;
    const _resFinal= effectiveResumeIdx;
    console.log(`[auto] perfil="${_pname}" cats=[${_pcats}] resume_perfil=${_presIdx} resume_usado=${_resFinal} cat_vaga="${target.category}" anexos=${attachments.length} tentativa=${retryCount+1}`);
    logEntry.selectedProfileName = _pname;
    logEntry.profileUsed = _pname;

    try {
      const { status:gmStatus, body:gmBody } = await httpsReq(
        { hostname:"gmail.googleapis.com", path:"/gmail/v1/users/me/messages/send", method:"POST",
          headers:{ "Authorization":"Bearer "+accessToken, "Content-Type":"application/json" } },
        { raw }
      );
      if (gmBody?.error) {
        const msg = String(gmBody.error.message || JSON.stringify(gmBody.error));
        // Erros de rate limit / 5xx → retry; erros de autenticação / payload → sem retry
        const isRateLimit2 = msg.includes("rateLimitExceeded") || msg.includes("userRateLimitExceeded") || msg.includes("User-rate limit");
        const isTransient = gmStatus >= 500 || isRateLimit2;
        if (isTransient && retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = isRateLimit2 ? 30000 : 5000 * retryCount; // rate limit → espera 30s antes de retry
          console.warn(`[auto] ⚠️ erro transiente (${msg}), retry ${retryCount}/${MAX_RETRIES} em ${delay/1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(msg);
      }
      if (gmStatus !== 200) throw new Error("Gmail HTTP " + gmStatus);

      // ── Sucesso ──────────────────────────────────────────
      markSent(email, target.to);
      const appId = newAppId();
      const snap  = buildJobSnapshot(Object.assign({}, target));
      const histEntry = {
        appId,
        jobId:     target.id || ("a_" + Date.now()),
        job:       target.title,
        company:   target.company,
        to:        target.to,
        dateStr:   todayStr(), // BRT
        date:      toLocaleBRT(Date.now()),
        sentAt:    new Date().toISOString(),
        msgId:     gmBody?.id || null,
        gmailMsgId:gmBody?.id || null,
        threadId:  gmBody?.threadId || null,
        jobSnapshot: snap,
        type:      "auto",
        attachCount: attachments.length,
        category:  target.category,
        state:     target.state,
        source:    job.source,
        profileUsed: selectedProfile?.name || null,
      };
      addHist(email, histEntry);
      indexApp(email, histEntry);
      invalidateUserStatsCache(email);

      if (gmBody?.id && accessToken) {
        const mid = gmBody.id;
        const capturedToken = String(accessToken);
        (async () => {
          try {
            const h = await fetchGmailMessageHeaders(capturedToken, mid);
            if (h?.messageId) {
              indexApp(email, { appId, to:target.to, gmailHeaderMsgId:h.messageId, threadId:histEntry.threadId });
              const arr = DB_HIST[email] || [];
              const idx = arr.findIndex(x => x.appId === appId);
              if (idx >= 0) { arr[idx].gmailHeaderMsgId = h.messageId; persist(HIST_FILE, DB_HIST); }
            }
          } catch {}
        })();
      }

      addLog(email, { ...logEntry, status:"enviado", appId, profileUsed:selectedProfile?.name||"", subjectUsed:subject.slice(0,120), attachCount:attachments.length, attempt:retryCount+1 });
      updateAutoStats(email, { sent:(getAutoStats(email).sent||0)+1, startedAt:getAutoStats(email).startedAt||Date.now() });
      // ✅ Heartbeat: registra atividade para o watchdog
      { const h=getHealth(email); h.lastSent=Date.now(); h.errors=0; h.stalledAt=null; h.status="ok"; }
      console.log(`[auto] ✅ ${email} → ${target.to} anexos=${attachments.length} [${appId}]`);
      sendOk = true;
      break;

    } catch(e) {
      const errMsg = String(e.message);
      const isRateLimit = errMsg.includes("rateLimitExceeded") || errMsg.includes("userRateLimitExceeded") || errMsg.includes("User-rate limit");
      const isTransient = isRateLimit || errMsg.includes("500") || errMsg.includes("503") || errMsg.includes("Service Unavailable");

      if (isRateLimit) {
        // ── RATE LIMIT GMAIL: respeitar o "Retry after" ─────────────────
        let retryAfterMs = 60 * 60 * 1000; // 1h fallback
        const retryMatch = errMsg.match(/Retry after ([0-9T:.Z+-]+)/i);
        if (retryMatch) {
          try {
            const retryTs = new Date(retryMatch[1]).getTime();
            const waitMs = retryTs - Date.now();
            if (waitMs > 0 && waitMs < 12 * 3600_000) retryAfterMs = waitMs + 60_000; // +1min margem
          } catch(_) {}
        }
        const retryAtStr = new Date(Date.now() + retryAfterMs).toLocaleTimeString("pt-BR");
        const waitMin = Math.round(retryAfterMs / 60000);
        // Devolver vaga à frente da fila para não perder
        const curJob = getAutoJob(email);
        if (curJob) {
          const restoredQ = [target, ...(curJob.queue||[])];
          setAutoJob(email, { ...curJob, queue: restoredQ, status:"waiting_rate_limit", nextSendAt:Date.now()+retryAfterMs });
        }
        addLog(email, { ...logEntry, status:"pausado",
          error:`⏳ Rate limit Gmail — retomando às ${retryAtStr} BRT (aguardando ${waitMin}min)`,
          profileUsed:selectedProfile?.name||"", attachCount:attachments.length });
        trackJourney(email,'auto_fail',{ok:false,error:`Rate limit. Retoma ${retryAtStr}`,detail:`${target?.company||"?"} → ${target?.to||"?"}`});
        console.warn(`[auto] ⏳ Rate limit ${email} — pausando ${waitMin}min até ${retryAtStr}`);
        autoTimers.set(email, setTimeout(() => scheduleAuto(email), retryAfterMs));
        return;
      }

      if (isTransient && retryCount < MAX_RETRIES) {
        retryCount++;
        console.warn(`[auto] ⚠️ erro transiente (${errMsg}), retry ${retryCount}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 8000 * retryCount));
        continue;
      }
      addLog(email, { ...logEntry, status:"falhou", error:errMsg, profileUsed:selectedProfile?.name||"", subjectUsed:(subject||"").slice(0,120), attachCount:attachments.length, attempt:retryCount+1 });
      trackJourney(email,'auto_fail',{ok:false,error:errMsg,detail:`Falha: ${target?.company||"?"} → ${target?.to||"?"}`,meta:{to:target?.to}});
      updateAutoStats(email, { failed:(getAutoStats(email).failed||0)+1 });
      break;
    }
  }

  // Agenda próximo envio — sempre relê job do banco
  const updJob = getAutoJob(email);
  if (!updJob || !updJob.active) { autoTimers.delete(email); return; }
  const interval = calcSmartInterval();
  setAutoJob(email, { ...updJob, status:"waiting_interval", nextSendAt:Date.now()+interval });
  autoTimers.set(email, setTimeout(() => scheduleAuto(email), interval));
  } catch(outerErr) {
    // Erro NUNCA deve matar o engine silenciosamente
    console.error(`[auto/FATAL] ${email}:`, outerErr.message, outerErr.stack?.split("\n")[1]||"");
    addLog(email, { status:"falhou", jobTitle:"[ENGINE ERROR] " + outerErr.message.slice(0,100), company:"Sistema", error: outerErr.message });
    trackJourney(email, 'auto_fail', { ok:false, error:outerErr.message, detail:"Erro fatal no engine — reagendando", critical:true });
    // Reagendar para tentar recuperar — espera 2 min
    const recoverMs = 2 * 60 * 1000;
    const recJob = getAutoJob(email);
    if(recJob && recJob.active) {
      setAutoJob(email, { ...recJob, status:"recovering", nextSendAt:Date.now()+recoverMs });
      autoTimers.set(email, setTimeout(() => scheduleAuto(email), recoverMs));
      console.warn(`[auto/RECOVER] ${email} reagendado em 2min após erro fatal`);
    }
  } finally {
    _autoRunning.delete(email); // sempre limpa o guard
  }
}

const genSubject=title=>{const pfx=["Application for","Interest in","Applying for","H-2B Application:","Candidature for"];return`${pfx[Math.floor(Math.random()*pfx.length)]} ${title}`;};
// fillTpl: substitui TODAS as variáveis de template — incluindo {email}, {cidade}, {estado}
const fillTpl=(tpl,v)=>(tpl||"")
  .replace(/{vaga}/g,       v.vaga||"")
  .replace(/{empresa}/g,    v.empresa||"")
  .replace(/{nome}/g,       v.nome||"")
  .replace(/{pais}/g,       v.pais||"")
  .replace(/{telefone}/g,   v.telefone||"")
  .replace(/{email}/g,      v.email||"")
  .replace(/{cidade}/g,     v.cidade||"")
  .replace(/{estado}/g,     v.estado||"")
  .replace(/{city}/g,       v.cidade||"")
  .replace(/{state}/g,      v.estado||"")
  .replace(/{wage}/g,       v.wage||"")
  .replace(/{salario}/g,    v.wage||"")
  .replace(/{inicio}/g,     v.inicio||"")
  .replace(/{start}/g,      v.inicio||"");

function reactivateAutoJobs(){
  let n=0;for(const[email,job]of Object.entries(DB_AUTO)){if(job.active&&job.queue?.length>0){scheduleAuto(email);n++;}}
  if(n)console.log(`[auto] ${n} job(s) reativados`);
}

// ══════════════════════════════════════════════════════════
//  SESSION
// ══════════════════════════════════════════════════════════
const sessions=Object.create(null);
const rateMap  =Object.create(null);
const SESS_TTL =7*24*60*60*1000;

function rateLimit(k,max,ms){const n=Date.now();if(!rateMap[k]||rateMap[k].r<n)rateMap[k]={n:0,r:n+ms};return++rateMap[k].n>max;}
const makeCookieStr=id=>{const b=`h2b_session=${id}; Path=/; HttpOnly; Max-Age=${7*86400}`;return IS_PROD?b+"; Secure; SameSite=Lax":b+"; SameSite=Lax";};
const clearCookieStr=()=>{const b="h2b_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";return IS_PROD?b+"; Secure; SameSite=Lax":b;};
const getSessId=req=>{const m=(req.headers.cookie||"").match(/(?:^|;\s*)h2b_session=([^;]+)/);return m?m[1]:null;};
const getSess  =req=>{const id=getSessId(req);return id?sessions[id]:null;};

function makeCallbackPage(sessId){
  // FIX-LOOP-001: confirma cookie via /api/status ANTES de redirecionar.
  // Proteção contra loop: sessionStorage conta tentativas.
  return`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Entrando...</title>
<style>
body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;font-family:sans-serif;color:#fff}
.box{text-align:center;max-width:340px;padding:0 20px}
.spin{width:44px;height:44px;border:3px solid rgba(255,255,255,.15);border-top-color:#60a5fa;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:17px;font-weight:600;margin-bottom:8px}
.sub{font-size:13px;color:rgba(255,255,255,.45)}
.err{background:#ef444420;border:1px solid #ef4444;border-radius:10px;padding:14px 16px;font-size:13px;color:#fca5a5;margin-top:20px;display:none;text-align:left;line-height:1.6}
.btn{margin-top:16px;padding:10px 22px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:none}
</style>
</head><body>
<div class="box">
  <div class="spin" id="spin"></div>
  <div class="msg" id="msg">Entrando na sua conta...</div>
  <div class="sub" id="sub">Aguarde um momento</div>
  <div class="err" id="err"></div>
  <button class="btn" id="btn" onclick="window.location.href='/'">Ir para o app</button>
</div>
<script>
(function(){
  var LOOP_KEY = 'h2b_cb_attempts';
  var MAX_ATTEMPTS = 3;
  var attempts = parseInt(sessionStorage.getItem(LOOP_KEY) || '0', 10) + 1;
  sessionStorage.setItem(LOOP_KEY, attempts);

  if (attempts > MAX_ATTEMPTS) {
    document.getElementById('spin').style.display = 'none';
    document.getElementById('msg').textContent = 'Problema no login detectado';
    document.getElementById('sub').textContent = '';
    var errEl = document.getElementById('err');
    errEl.innerHTML =
      '<strong>⚠️ Não foi possível completar o login.</strong><br><br>' +
      'Tente:<br>' +
      '1. Limpar cookies do site e tentar novamente<br>' +
      '2. Usar navegador em modo normal (não anônimo)<br>' +
      '3. Desativar extensões de bloqueio de cookies';
    errEl.style.display = 'block';
    document.getElementById('btn').style.display = 'inline-block';
    return;
  }

  function checkAndRedirect(retries) {
    if (retries <= 0) {
      sessionStorage.removeItem(LOOP_KEY);
      window.location.replace('/');
      return;
    }
    fetch('/api/status', { credentials: 'include', cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.connected) {
          sessionStorage.removeItem(LOOP_KEY);
          window.location.replace('/');
        } else {
          setTimeout(function(){ checkAndRedirect(retries - 1); }, 400);
        }
      })
      .catch(function(){
        setTimeout(function(){ checkAndRedirect(retries - 1); }, 600);
      });
  }

  setTimeout(function(){ checkAndRedirect(6); }, 200);
})();
</script></body></html>`;
}

// ══════════════════════════════════════════════════════════
//  HTTP UTILS
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  Gerador de ícone PNG puro (sem dependências externas)
//  Compatível com PWA manifest, notificações push e iOS
//  Gera um PNG sólido com gradiente azul e texto "H2B"
// ══════════════════════════════════════════════════════════
function generateIconPNG(size) {
  // CRC32 lookup table
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff);
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crc]);
  }
  // Blue gradient: top #1e3a8a → bottom #1a56db
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(0x1e + (0x1a - 0x1e) * t);
    const g = Math.round(0x3a + (0x56 - 0x3a) * t);
    const b = Math.round(0x8a + (0xdb - 0x8a) * t);
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter none
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(size, 0); IHDR.writeUInt32BE(size, 4);
  IHDR[8] = 8; IHDR[9] = 2; // 8-bit RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", IHDR), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function httpsReq(opts,body){return new Promise((res,rej)=>{const p=body?(typeof body==="string"?body:JSON.stringify(body)):null;const r=https.request(opts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{const raw=Buffer.concat(ch).toString();try{res({status:resp.statusCode,body:JSON.parse(raw)});}catch{res({status:resp.statusCode,body:raw});}});});r.on("error",rej);r.setTimeout(15000,()=>{r.destroy();rej(new Error("Timeout"));});if(p)r.write(p);r.end();});}
function readBody(req){return new Promise((res,rej)=>{const p=[];req.on("data",c=>p.push(c));req.on("end",()=>res(Buffer.concat(p).toString()));req.on("error",rej);});}
function json(res,status,data){const b=JSON.stringify(data);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(b)});res.end(b);}

// ══════════════════════════════════════════════════════════
//  GMAIL
// ══════════════════════════════════════════════════════════
async function refreshToken(sid){
  const s=sessions[sid];
  // Usa refresh_token da sessão ou do banco persistido
  const rt=s?.refresh_token||(s?.user_email?getUser(s.user_email)?.refresh_token:null);
  if(!rt)throw new Error("Sem refresh_token — usuário precisa fazer login novamente.");
  const b=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:rt,grant_type:"refresh_token"}).toString();
  const{body:r}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(b)}},b);
  if(r.error)throw new Error(r.error_description||r.error);
  if(r.access_token){
    if(s){s.access_token=r.access_token;s.expires_at=Date.now()+(r.expires_in||3600)*1000;}
    // Persiste o novo access_token no banco (para uso pelo auto sem sessão)
    if(s?.user_email){setUser(s.user_email,{cached_access_token:r.access_token,cached_token_expiry:Date.now()+(r.expires_in||3600)*1000});}
    // Atualiza refresh_token se veio um novo
    if(r.refresh_token&&s?.user_email){setUser(s.user_email,{refresh_token:r.refresh_token});if(s)s.refresh_token=r.refresh_token;}
  }
}

// Renova token usando refresh_token do banco (para auto sem sessão ativa)
async function refreshTokenForUser(email){
  const u=getUser(email);if(!u?.refresh_token)throw new Error("Sem refresh_token — usuário precisa fazer login novamente.");
  const b=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:u.refresh_token,grant_type:"refresh_token"}).toString();
  const{body:r}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(b)}},b);
  if(r.error)throw new Error(r.error_description||r.error);
  if(!r.access_token)throw new Error("Token não retornado pelo Google.");
  const expiresAt=Date.now()+(r.expires_in||3600)*1000;
  setUser(email,{cached_access_token:r.access_token,cached_token_expiry:expiresAt});
  if(r.refresh_token)setUser(email,{refresh_token:r.refresh_token});
  // Atualiza todas as sessões ativas desse usuário
  for(const sid of Object.keys(sessions)){const s=sessions[sid];if(s.user_email===email){s.access_token=r.access_token;s.expires_at=expiresAt;if(r.refresh_token)s.refresh_token=r.refresh_token;}}
  console.log(`[token] ✅ Token renovado para ${email} via banco`);
  return r.access_token;
}

function buildMime({to,subject,text,fromName,fromEmail,attachments=[]}){ // v15-SEC: normaliza to
  to = normalizeEmail(to) || to;
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");const b64=s=>Buffer.from(s).toString("base64");const L=[`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,`To: ${to}`];L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`,"MIME-Version: 1.0");if(!attachments.length){L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);}else{L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");for(const a of attachments){L.push(`--${bnd}`,`Content-Type: application/pdf; name="${a.name}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${a.name}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}L.push(`--${bnd}--`);}return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}

async function gmailSend(sid,opts){const s=sessions[sid];if(!s?.access_token)throw new Error("Sessão expirada.");if(s.expires_at&&Date.now()>s.expires_at-120_000){try{await refreshToken(sid);}catch{}}const raw=buildMime({...opts,fromEmail:s.user_email});const{status,body}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+s.access_token,"Content-Type":"application/json"}},{raw});if(body?.error){const msg=body.error.message||JSON.stringify(body.error);throw new Error(msg);}if(status!==200)throw new Error("Gmail HTTP "+status);return body;}

// Envio com suporte a threading (respostas na mesma conversa)
async function gmailSendWithThread(sid,opts){
  const s=sessions[sid];if(!s?.access_token)throw new Error("Sessão expirada.");
  if(s.expires_at&&Date.now()>s.expires_at-120_000){try{await refreshToken(sid);}catch{}}
  const raw=buildMimeWithHeaders({...opts,fromEmail:s.user_email});
  const payload={raw};
  // threadId vincula a mensagem ao thread correto no Gmail
  if(opts.threadId)payload.threadId=opts.threadId;
  const{status,body}=await httpsReq({
    hostname:"gmail.googleapis.com",
    path:"/gmail/v1/users/me/messages/send",
    method:"POST",
    headers:{"Authorization":"Bearer "+s.access_token,"Content-Type":"application/json"}
  },payload);
  if(body?.error){const msg=body.error.message||JSON.stringify(body.error);throw new Error(msg);}
  if(status!==200)throw new Error("Gmail HTTP "+status);
  return body;
}

// buildMime com suporte a cabeçalhos customizados (In-Reply-To, References)
function buildMimeWithHeaders({to,subject,text,fromName,fromEmail,attachments=[],threadHeaders={}}){
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");
  const b64=s=>Buffer.from(s).toString("base64");
  const L=[
    `From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,
    `To: ${to}`
  ];
  L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`);
  // Cabeçalhos de threading
  if(threadHeaders["In-Reply-To"])L.push(`In-Reply-To: ${threadHeaders["In-Reply-To"]}`);
  if(threadHeaders["References"])L.push(`References: ${threadHeaders["References"]}`);
  L.push("MIME-Version: 1.0");
  if(!attachments.length){
    L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);
  }else{
    L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");
    for(const a of attachments){L.push(`--${bnd}`,`Content-Type: application/pdf; name="${a.name}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${a.name}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}
    L.push(`--${bnd}--`);
  }
  return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

// ── Gmail Inbox: busca e-mails recebidos ──────────────────
async function gmailGetToken(sid){
  const s=sessions[sid];
  // FIX: se não há access_token na sessão, tenta usar o token cacheado no banco ou renova via refresh_token
  if(!s?.access_token){
    const email=s?.user_email;
    if(email){
      const u=getUser(email);
      // Usa token cacheado no banco se ainda válido (com 2min de margem)
      if(u?.cached_access_token && u.cached_token_expiry && Date.now()<u.cached_token_expiry-120_000){
        if(s) s.access_token=u.cached_access_token;
        if(s) s.expires_at=u.cached_token_expiry;
        return u.cached_access_token;
      }
      // Tenta renovar via refresh_token do banco
      if(u?.refresh_token){
        try{
          const token=await refreshTokenForUser(email);
          if(s){s.access_token=token;s.expires_at=Date.now()+3500_000;}
          return token;
        }catch(re){throw new Error("Sessão expirada — faça login novamente. ("+re.message+")");}
      }
    }
    throw new Error("Sessão expirada.");
  }
  if(s.expires_at&&Date.now()>s.expires_at-120_000){try{await refreshToken(sid);}catch{}}
  return s.access_token;
}

// Palavras-chave que indicam bounce/erro automático — filtrar fora
const BOUNCE_SUBJECTS=[
  /delivery.*fail/i,/failed.*deliver/i,/undeliverable/i,/mail.*delivery.*subsystem/i,
  /out of office/i,/automatic.*reply/i,/fora do escritório/i,
  /mailer.daemon/i,/returned mail/i,/unable to deliver/i,/non-?delivery/i,
  /address not found/i,/user.*unknown/i,/does not exist/i,/invalid.*address/i,
  /your message could not/i,/message blocked/i,
  /quota exceeded/i,/mailbox full/i,
];
const BOUNCE_FROM=[
  /mailer-daemon@/i,/postmaster@/i,/daemon@/i,
  /noreply@.*google/i,/no-reply@.*google/i,
  /^noreply@noreply\./i,/^no-reply@no-reply\./i,
];

function isBounceMail(msg){
  const subj=(msg.subject||"").toLowerCase();
  const from=(msg.from||"").toLowerCase();
  if(BOUNCE_SUBJECTS.some(r=>r.test(subj)))return true;
  if(BOUNCE_FROM.some(r=>r.test(from)))return true;
  // Google SMTP errors têm corpo com códigos de erro
  const body=(msg.snippet||"").toLowerCase();
  if(/technical details of permanent failure/.test(body))return true;
  if(/smtp error|error code [0-9]/.test(body))return true;
  return false;
}

// Decodifica base64url para texto
function b64url(str){
  if(!str)return"";
  try{return Buffer.from(str.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8");}catch{return"";}
}

// Extrai campo do cabeçalho
function getHeader(headers,name){
  const h=(headers||[]).find(h=>h.name?.toLowerCase()===name.toLowerCase());
  return h?.value||"";
}

// Extrai texto do payload (recursivo para partes multipart)
function extractText(payload){
  if(!payload)return"";
  if(payload.parts){
    for(const part of payload.parts){
      const t=extractText(part);if(t)return t;
    }
  }
  if(payload.mimeType==="text/plain"&&payload.body?.data)return b64url(payload.body.data);
  if(payload.mimeType==="text/html"&&payload.body?.data){
    // Remove tags HTML básico
    return b64url(payload.body.data).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  }
  if(payload.body?.data)return b64url(payload.body.data);
  return"";
}

async function gmailFetchInbox(sid,maxResults=50){
  const token=await gmailGetToken(sid);
  const headers={"Authorization":"Bearer "+token};

  // Busca mensagens na INBOX que são respostas (tem In-Reply-To ou Reference)
  // q: in:inbox -from:me — mensagens recebidas, não enviadas por mim
  // FIX: removido "category:primary" — muitas respostas de empresas vão para Promoções/Updates
  const q=encodeURIComponent("in:inbox -from:me");
  const listPath=`/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${q}`;

  const{status:ls,body:lb}=await httpsReq({hostname:"gmail.googleapis.com",path:listPath,method:"GET",headers});
  if(ls===429)throw new Error("Gmail: muitas requisições (429). Aguarde 1 minuto e tente novamente.");
  if(ls===401||ls===403)throw new Error("TOKEN_EXPIRED");
  if(ls!==200)throw new Error("Gmail list HTTP "+ls);

  const messages=lb.messages||[];
  if(!messages.length)return[];

  // Busca detalhes de cada mensagem em paralelo (lote de 10)
  const results=[];
  for(let i=0;i<messages.length;i+=10){
    const batch=messages.slice(i,i+10);
    const details=await Promise.all(batch.map(async m=>{
      try{
        const{status,body}=await httpsReq({
          hostname:"gmail.googleapis.com",
          path:`/gmail/v1/users/me/messages/${m.id}?format=full`,
          method:"GET",headers
        });
        if(status!==200)return null;
        return body;
      }catch{return null;}
    }));
    results.push(...details.filter(Boolean));
  }

  // Processa e filtra
  const emails=results.map(msg=>{
    const hdrs=msg.payload?.headers||[];
    const subject=getHeader(hdrs,"Subject");
    const from=getHeader(hdrs,"From");
    const date=getHeader(hdrs,"Date");
    const inReplyTo=getHeader(hdrs,"In-Reply-To");
    const references=getHeader(hdrs,"References");
    const messageId=getHeader(hdrs,"Message-ID");
    const body=extractText(msg.payload);
    const snippet=msg.snippet||"";
    const threadId=msg.threadId||"";
    const isRead=!msg.labelIds?.includes("UNREAD");

    return{
      id:msg.id,threadId,messageId,
      subject:subject||"(sem assunto)",
      from,date,
      body:body.slice(0,3000), // Limita tamanho
      snippet:snippet.slice(0,300),
      isRead,
      // FIX: isReply expandido — inclui emails com In-Reply-To/References OU que estão em threads
      // onde o usuário enviou (threadId presente = parte de conversa iniciada por nós)
      isReply:!!(inReplyTo||references),
      inReplyTo: inReplyTo || "",      // v13: necessário para vincular candidatura
      references: references || "",    // v13
      timestamp:msg.internalDate?parseInt(msg.internalDate):Date.parse(date||0),
    };
  });

  // Filtra bounces e automáticos
  return emails.filter(e=>!isBounceMail(e));
}

// Marca e-mail como lido
async function gmailMarkRead(sid,messageId){
  const token=await gmailGetToken(sid);
  await httpsReq({
    hostname:"gmail.googleapis.com",
    path:`/gmail/v1/users/me/messages/${messageId}/modify`,
    method:"POST",
    headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"}
  },{removeLabelIds:["UNREAD"]});
}

async function genCover({name,country,phone,job,company,city,state,wage}){return`Dear Hiring Manager,\n\nI am writing to express my sincere interest in the ${job} position at ${company}, located in ${city}, ${state}.\n\nMy name is ${name}, and I am from ${country}. I am highly motivated and fully committed to contributing my best. I am available to start on the specified date and commit to the full season.\n${wage&&wage!=="–"?`\nI am pleased with the offered compensation of ${wage}.\n`:""}\nPlease find my resume attached.\n\nSincerely,\n${name}\n${country}${phone?"\n"+phone:""}`;}

// ══════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════
const server=http.createServer(async(req,res)=>{
  let u,pathname;try{u=new URL(req.url,"http://x");pathname=u.pathname;}catch{res.writeHead(400);return res.end();}
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");
  const org=req.headers.origin||"";const ao=(org===APP_URL||/^https?:\/\/localhost/.test(org))?org:APP_URL;
  res.setHeader("Access-Control-Allow-Origin",ao);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,PATCH,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}

  const serveHtml=f=>{try{const h=fs.readFileSync(path.join(__dirname,f),"utf8");res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});return res.end(h);}catch{res.writeHead(404);return res.end(f+" não encontrado");}};
  if(pathname==="/"||pathname==="/index.html")return serveHtml("index.html");
  if(pathname==="/admin"||pathname==="/admin.html")return serveHtml("admin.html");

  // Google Search Console verification
  if(pathname==="/google380652ea59ad95e1.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=UTF-8"});
    return res.end("google-site-verification: google380652ea59ad95e1");
  }

  // Política de Privacidade
  if(pathname==="/privacidade"||pathname==="/privacy"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=86400"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Política de Privacidade — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
  .container{max-width:760px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:#1e293b}
  h1{font-size:28px;font-weight:800;color:#1e293b;margin-bottom:8px}
  .date{font-size:13px;color:#64748b;margin-bottom:32px}
  h2{font-size:18px;font-weight:700;color:#1e293b;margin:28px 0 10px}
  p{color:#475569;margin-bottom:12px;font-size:15px}
  ul{color:#475569;margin:8px 0 12px 20px;font-size:15px}
  li{margin-bottom:6px}
  a{color:#4f46e5;text-decoration:none}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;margin-bottom:24px}
  .footer{text-align:center;margin-top:40px;font-size:13px;color:#94a3b8}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="card">
    <h1>Política de Privacidade</h1>
    <div class="date">Última atualização: Maio de 2026</div>

    <h2>1. Informações que coletamos</h2>
    <p>Ao usar o H2BApply, coletamos as seguintes informações:</p>
    <ul>
      <li><strong>Dados do Google:</strong> nome, endereço de email e foto de perfil (via login Google)</li>
      <li><strong>Acesso ao Gmail:</strong> permissão para enviar emails em seu nome para candidaturas H-2B/H-2A</li>
      <li><strong>Dados do perfil:</strong> nome completo, país, telefone, cidade</li>
      <li><strong>Currículos (PDF):</strong> arquivos enviados para uso nas candidaturas</li>
      <li><strong>Histórico de candidaturas:</strong> registro dos emails enviados para empregadores americanos</li>
    </ul>

    <h2>2. Como usamos suas informações</h2>
    <ul>
      <li>Enviar emails de candidatura para empregadores americanos em seu nome</li>
      <li>Gerenciar seu histórico de candidaturas e evitar envios duplicados</li>
      <li>Exibir respostas de empregadores no app</li>
      <li>Melhorar a experiência do usuário no aplicativo</li>
    </ul>

    <h2>3. Acesso ao Gmail</h2>
    <p>O H2BApply solicita acesso ao seu Gmail <strong>exclusivamente</strong> para:</p>
    <ul>
      <li>Enviar emails de candidatura H-2B/H-2A para empregadores nos EUA</li>
      <li>Ler respostas dos empregadores para exibição no app</li>
    </ul>
    <p><strong>Nunca lemos, armazenamos ou compartilhamos o conteúdo de seus emails pessoais.</strong> O acesso é restrito às funcionalidades descritas acima e está em conformidade com a <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank">Política de Dados de Usuário do Google API</a>, incluindo os requisitos de Uso Limitado.</p>

    <h2>4. Compartilhamento de dados</h2>
    <p>Não vendemos, alugamos ou compartilhamos seus dados pessoais com terceiros, exceto:</p>
    <ul>
      <li><strong>Empregadores americanos:</strong> seu nome, email e currículo são enviados nas candidaturas (com seu consentimento)</li>
      <li><strong>Google APIs:</strong> para autenticação e envio de emails via Gmail</li>
    </ul>

    <h2>5. Segurança dos dados</h2>
    <p>Seus dados são armazenados em servidores seguros com acesso restrito. Utilizamos criptografia para proteger tokens de acesso. Você pode excluir sua conta e todos os dados a qualquer momento acessando seu perfil no app.</p>

    <h2>6. Retenção de dados</h2>
    <p>Mantemos seus dados enquanto sua conta estiver ativa. Ao excluir sua conta, todos os dados pessoais são removidos permanentemente em até 30 dias.</p>

    <h2>7. Seus direitos</h2>
    <ul>
      <li>Acessar seus dados pessoais armazenados</li>
      <li>Corrigir informações incorretas</li>
      <li>Excluir sua conta e todos os dados</li>
      <li>Revogar o acesso ao Gmail a qualquer momento em <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a></li>
    </ul>

    <h2>8. Contato</h2>
    <p>Para dúvidas sobre privacidade, entre em contato:</p>
    <ul>
      <li>Contato: suporte@h2bapply.com</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
    </ul>
  </div>
  <div class="footer">© 2026 H2BApply · h2bapply.com</div>
</div>
</body>
</html>`);
  }

  // Termos de Uso
  if(pathname==="/termos"||pathname==="/terms"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=86400"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Termos de Uso — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
  .container{max-width:760px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:#1e293b}
  h1{font-size:28px;font-weight:800;color:#1e293b;margin-bottom:8px}
  .date{font-size:13px;color:#64748b;margin-bottom:32px}
  h2{font-size:18px;font-weight:700;color:#1e293b;margin:28px 0 10px}
  p{color:#475569;margin-bottom:12px;font-size:15px}
  ul{color:#475569;margin:8px 0 12px 20px;font-size:15px}
  li{margin-bottom:6px}
  a{color:#4f46e5;text-decoration:none}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;margin-bottom:24px}
  .footer{text-align:center;margin-top:40px;font-size:13px;color:#94a3b8}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
  .warning{background:#fef3c7;border:1.5px solid #fde68a;border-radius:10px;padding:14px 16px;font-size:14px;color:#92400e;margin-bottom:16px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="card">
    <h1>Termos de Uso</h1>
    <div class="date">Última atualização: Maio de 2026</div>

    <div class="warning">⚠️ <strong>Importante:</strong> O H2BApply é uma ferramenta de candidatura. Não garantimos contratação, aprovação de visto ou resposta de empregadores.</div>

    <h2>1. Sobre o serviço</h2>
    <p>O H2BApply é um aplicativo web brasileiro que automatiza o envio de candidaturas para vagas H-2B e H-2A publicadas no portal oficial do Departamento de Trabalho dos Estados Unidos (DOL). O serviço utiliza seu Gmail para enviar emails de candidatura para empregadores americanos.</p>

    <h2>2. Elegibilidade</h2>
    <ul>
      <li>Ter 18 anos ou mais</li>
      <li>Possuir uma conta Google (Gmail) válida</li>
      <li>Concordar com estes termos e com a Política de Privacidade</li>
    </ul>

    <h2>3. Uso aceitável</h2>
    <p>Ao usar o H2BApply, você concorda em:</p>
    <ul>
      <li>Fornecer informações verdadeiras em seu perfil e currículo</li>
      <li>Usar o serviço apenas para candidaturas legítimas a vagas H-2B/H-2A</li>
      <li>Não usar o app para envio de spam ou conteúdo enganoso</li>
      <li>Respeitar os limites de envio do seu plano</li>
    </ul>

    <h2>4. Planos e pagamentos</h2>
    <ul>
      <li><strong>Free:</strong> 20 envios manuais + 10 automáticos por dia, gratuito</li>
      <li><strong>VIP:</strong> 400 manuais + 10 automáticos por dia — R$ 99,90/mês</li>
      <li><strong>VIPro:</strong> 300 manuais + 200 automáticos por dia — R$ 149,90/mês</li>
    </ul>
    <p>Pagamentos são realizados via PIX. Não há reembolso após ativação do plano.</p>

    <h2>5. Limitação de responsabilidade</h2>
    <p>O H2BApply <strong>não garante</strong>:</p>
    <ul>
      <li>Contratação por qualquer empresa americana</li>
      <li>Resposta de empregadores</li>
      <li>Aprovação de visto H-2B ou H-2A</li>
      <li>Entrada nos Estados Unidos</li>
    </ul>
    <p>O resultado das candidaturas depende exclusivamente de empregadores, autoridades americanas e consulados. O H2BApply é apenas uma ferramenta de envio de emails.</p>

    <h2>6. Conta e segurança</h2>
    <p>Você é responsável por manter a segurança da sua conta Google. O H2BApply acessa seu Gmail apenas para enviar candidaturas e ler respostas de empregadores, conforme descrito na Política de Privacidade.</p>

    <h2>7. Cancelamento</h2>
    <p>Você pode cancelar sua conta a qualquer momento pelo app. Também pode revogar o acesso ao Gmail em <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>.</p>

    <h2>8. Alterações nos termos</h2>
    <p>Podemos atualizar estes termos periodicamente. Mudanças significativas serão comunicadas pelo app. O uso continuado após alterações implica aceitação dos novos termos.</p>

    <h2>9. Contato</h2>
    <ul>
      <li>Contato: suporte@h2bapply.com</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
      <li>Site: <a href="https://h2bapply.com">h2bapply.com</a></li>
    </ul>
  </div>
  <div class="footer">© 2026 H2BApply · h2bapply.com</div>
</div>
</body>
</html>`);
  }

  // ── PWA: manifest, service worker e ícones ────────────
  if(pathname==="/manifest.json"){
    try{const m=fs.readFileSync(path.join(__dirname,"manifest.json"),"utf8");res.writeHead(200,{"Content-Type":"application/manifest+json","Cache-Control":"public, max-age=86400"});return res.end(m);}
    catch{res.writeHead(404);return res.end("manifest.json não encontrado");}
  }
  if(pathname==="/sw.js"){
    try{const sw=fs.readFileSync(path.join(__dirname,"sw.js"),"utf8");res.writeHead(200,{"Content-Type":"application/javascript","Cache-Control":"no-cache, no-store, must-revalidate","Service-Worker-Allowed":"/"});return res.end(sw);}
    catch{res.writeHead(404);return res.end("sw.js não encontrado");}
  }
  // Ícones PWA — serve PNG se existir, senão gera SVG inline como fallback
  const ICON_MAP={
    "/icon-192.png":"icon-192.png",
    "/icon-512.png":"icon-512.png",
    "/icon-192-maskable.png":"icon-192-maskable.png",
    "/icon-512-maskable.png":"icon-512-maskable.png",
    "/icon-256.png":"icon-256.png",
    "/icon-384.png":"icon-384.png",
    "/apple-touch-icon.png":"apple-touch-icon.png",
    "/favicon-32.png":"favicon-32.png",
    "/favicon.ico":"favicon-32.png"
  };
  if(ICON_MAP[pathname]){
    const iconPath=path.join(__dirname,ICON_MAP[pathname]);
    if(fs.existsSync(iconPath)){const data=fs.readFileSync(iconPath);res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800, immutable"});return res.end(data);}
  }
  if(pathname==="/icon-192.png"||pathname==="/icon-512.png"){
    const size=pathname==="/icon-192.png"?192:512;
    const pngPath=path.join(__dirname,pathname.slice(1));
    if(fs.existsSync(pngPath)){
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800"});
      return res.end(fs.readFileSync(pngPath));
    }
    // Fallback: gera PNG real (sem dependências externas) compatível com PWA/iOS/push
    try {
      const png = generateIconPNG(size);
      res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"public, max-age=604800"});
      return res.end(png);
    } catch(e) {
      // Último recurso: SVG
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size*0.2}" fill="#1a56db"/><text x="50%" y="44%" font-family="system-ui,sans-serif" font-size="${size*0.28}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">H2B</text></svg>`;
      res.writeHead(200,{"Content-Type":"image/svg+xml","Cache-Control":"public, max-age=3600"});
      return res.end(svg);
    }
  }

  // ── /api/jobs ─────────────────────────────────────────
  if(pathname==="/api/jobs"){
    const opts={query:(u.searchParams.get("q")||"").trim(),state:(u.searchParams.get("state")||"").trim(),jobType:(u.searchParams.get("jobType")||"all"),jobStatus:(u.searchParams.get("jobStatus")||"all"),beginDate:(u.searchParams.get("beginDate")||""),sort:(u.searchParams.get("sort")||"desc")};
    const skip=Math.max(0,parseInt(u.searchParams.get("skip")||"0",10));const top=Math.min(50,Math.max(1,parseInt(u.searchParams.get("top")||"25",10)));
    if(Date.now()-lastFetch>CACHE_TTL)refreshCache().catch(()=>{});
    try{const{jobs,total}=await fetchDOL(skip,top,opts);return json(res,200,{jobs,total,skip,from_cache:false});}
    catch(e){
      let src=jobsCache.length?[...jobsCache]:[...FALLBACK_JOBS];
      const{query:q,state,jobType,jobStatus,beginDate}=opts;
      if(q){const ql=q.toLowerCase();src=src.filter(j=>j.title.toLowerCase().includes(ql)||j.company.toLowerCase().includes(ql)||j.state.toLowerCase().includes(ql)||j.desc.toLowerCase().includes(ql));}
      if(state)src=src.filter(j=>j.state.toUpperCase()===state.toUpperCase());
      if(jobType==="agricultural")src=src.filter(j=>j.visa==="H-2A");if(jobType==="non-agricultural")src=src.filter(j=>j.visa==="H-2B");
      if(jobStatus==="active")src=src.filter(j=>j.active);if(jobStatus==="inactive")src=src.filter(j=>!j.active);
      if(beginDate)src=src.filter(j=>j.start>=beginDate);
      return json(res,200,{jobs:src.slice(skip,skip+top),total:src.length,skip,from_cache:true});
    }
  }

  // ── Sheet routes com categorias dinâmicas ─────────────
  if(pathname==="/api/sheet-meta"){
    const sheet=u.searchParams.get("sheet")||"";const arr=getSheet(sheet);
    const skip=Math.max(0,parseInt(u.searchParams.get("skip")||"0",10));const top=Math.min(50,Math.max(1,parseInt(u.searchParams.get("top")||"25",10)));
    const q=(u.searchParams.get("q")||"").trim();const state=(u.searchParams.get("state")||"").trim();const sort=u.searchParams.get("sort")||"random";
    const category=(u.searchParams.get("category")||"").trim();
    const minWage=parseFloat(u.searchParams.get("minWage")||"0")||0;
    const minWorkers=parseInt(u.searchParams.get("minWorkers")||"0")||0;
    const filterVisa=(u.searchParams.get("visa")||"").trim();
    const filterHasEmail=(u.searchParams.get("hasEmail")||"").trim();
    const filterJobStatus=(u.searchParams.get("jobStatus")||"").trim();
    // DB_SENT has email addresses (not case numbers), so we DON'T filter by caseNum
    // Instead we show all available jobs (sent ones are hidden via HIST in frontend)
    const baseArr=arr; // No server-side sent filtering (would break search)
    const{total,items}=searchSheet(baseArr,q,state,category,skip,top,sort);
    const catTitles={landscape:"Landscape Worker",construction:"Construction Worker",
      housekeeper:"Housekeeper",seafood:"Seafood Processor",farm:"Farm Worker",
      golf:"Golf Course Worker",amusement:"Amusement Park Worker",
      forest:"Forestry Worker",lifeguard:"Lifeguard",
      food:"Food Service / Bartender",ski:"Ski Resort Worker",other:"Seasonal Worker"};
    const parseW=w=>{if(!w)return 0;const m=String(w).match(/[0-9.]+/);return m?parseFloat(m[0]):0;};
    // Apply all additional filters
    let filtered=items;
    if(minWage>0) filtered=filtered.filter(r=>parseW(r.w)>=minWage);
    if(minWorkers>0) filtered=filtered.filter(r=>(r.wk||0)>=minWorkers);
    if(filterVisa) filtered=filtered.filter(r=>(r.st||"").toUpperCase().includes(filterVisa));
    if(filterHasEmail==="1") filtered=filtered.filter(r=>r.e&&r.e.includes("@"));
    if(filterHasEmail==="0") filtered=filtered.filter(r=>!r.e);
    if(filterJobStatus==="active") filtered=filtered.filter(r=>{const st=(r.st||"").toUpperCase();return !st.includes("WITHDRAWN")&&!st.includes("DENIED")&&!st.includes("EXPIRED");});
    if(filterJobStatus==="inactive") filtered=filtered.filter(r=>{const st=(r.st||"").toUpperCase();return st.includes("WITHDRAWN")||st.includes("DENIED")||st.includes("EXPIRED");});
    return json(res,200,{jobs:filtered.map(r=>{
      const st=(r.st||"").toUpperCase();
      const visa=st.includes("H-2A")?"H-2A":"H-2B";
      const active=!st.includes("WITHDRAWN")&&!st.includes("DENIED")&&!st.includes("EXPIRED")&&!st.includes("INVALIDATED");
      const cat=r.k||"other";
      const occupation=catTitles[cat]||"Seasonal Worker";
      return{id:r.c,caseNum:r.c,company:r.n||"–",state:r.s||"–",start:r.d||"–",status:r.st||"–",category:cat,visa,active,title:occupation,occupation,wage:r.w||null,workers:r.wk||null,email:null,hasEmail:null,fromSheet:true};
    }),total,remainingTotal:baseArr.length,skip,sheet});
  }

  // Categorias dinâmicas de uma planilha
  if(pathname==="/api/category-groups"){
    return json(res,200,{groups:CATEGORY_GROUPS,labels:CATEGORY_LABELS});
  }
  if(pathname==="/api/count-jobs"){
    const sheet=u.searchParams.get("sheet")||"";
    const minWage=parseFloat(u.searchParams.get("minWage")||"0")||0;
    const state=(u.searchParams.get("state")||"").toUpperCase();
    const category=u.searchParams.get("category")||"all";
    const hasEmail=u.searchParams.get("hasEmail")||"";
    const arr=getSheet(sheet);
    let filtered=arr;
    if(state)filtered=filtered.filter(r=>(r.s||"").toUpperCase()===state);
    if(category&&category!=="all"){const cats=category.split(",").map(c=>c.trim());filtered=filtered.filter(r=>cats.includes(r.k||"other"));}
    if(hasEmail==="yes")filtered=filtered.filter(r=>r.e&&String(r.e).includes("@"));
    const total=filtered.length;
    // Parse wage: handle "4.50/hr", "14.50", "14" etc
    const parseW=w=>{if(!w)return 0;const m=String(w).replace(/[^0-9.]/g,"");return parseFloat(m)||0;};
    const withWage=filtered.filter(r=>parseW(r.w)>=minWage&&parseW(r.w)>0);
    return json(res,200,{total,filtered:minWage>0?withWage.length:total});
  }
  if(pathname==="/api/sheet-categories"){
    const sheet=u.searchParams.get("sheet")||"";
    return json(res,200,{categories:getSheetCategoriesCached(sheet)});
  }
  if(pathname==="/api/sheet-detail"){const c=(u.searchParams.get("case")||"").trim().toUpperCase();if(!c)return json(res,400,{error:"case obrigatório"});try{const r=await fetchByCase([c]);return json(res,200,{job:r[c]||null,notFound:!r[c]});}catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/sheet-batch"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));const cases=(d.cases||[]).slice(0,10).map(c=>String(c).trim().toUpperCase());const jobs=await fetchByCase(cases);return json(res,200,{jobs});}catch(e){return json(res,500,{error:e.message});}}

  // ── Generate cover ────────────────────────────────────
  if(pathname==="/api/generate-cover"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(rateLimit(s.user_email+"_gen",20,3600_000))return json(res,429,{error:"Muitas gerações."});try{const d=JSON.parse(await readBody(req));const p=getUser(s.user_email)||{};const letter=await genCover({name:p.name||s.user_name||"",country:p.country||"Brazil",phone:p.phone||"",job:d.job||"",company:d.company||"",city:d.city||"",state:d.state||"",wage:d.wage||""});return json(res,200,{ok:true,letter});}catch(e){return json(res,500,{error:e.message});}}

  // ── Notes & Alerts ────────────────────────────────────
  if(pathname.startsWith("/api/note/")){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const jobId=decodeURIComponent(pathname.split("/api/note/")[1]||"");if(req.method==="GET")return json(res,200,{note:getNote(s.user_email,jobId)});if(req.method==="POST"){try{const d=JSON.parse(await readBody(req));setNote(s.user_email,jobId,String(d.note||"").slice(0,2000));return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}}
  if(pathname==="/api/alerts"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(req.method==="GET")return json(res,200,{alerts:getAlerts(s.user_email)});if(req.method==="POST"){try{const d=JSON.parse(await readBody(req));const alerts=getAlerts(s.user_email);alerts.push({id:"a"+Date.now(),state:d.state||"",jobType:d.jobType||"all",keyword:d.keyword||"",category:d.category||"all",active:true,createdAt:new Date().toISOString()});if(alerts.length>20)alerts.shift();setAlerts(s.user_email,alerts);return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}if(req.method==="DELETE"){try{const d=JSON.parse(await readBody(req));setAlerts(s.user_email,getAlerts(s.user_email).filter(a=>a.id!==d.id));return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}}

  // ── LOGS DO ENVIO AUTOMÁTICO (NEW) ───────────────────
  if(pathname==="/api/auto-logs"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const filters={status:u.searchParams.get("status")||"",state:u.searchParams.get("state")||"",category:u.searchParams.get("category")||"",source:u.searchParams.get("source")||"",q:u.searchParams.get("q")||"",dateFrom:u.searchParams.get("dateFrom")||"",dateTo:u.searchParams.get("dateTo")||"",skip:u.searchParams.get("skip")||"0",top:u.searchParams.get("top")||"50"};
    return json(res,200,getUserLogs(s.user_email,filters));
  }
  // Exportar CSV
  if(pathname==="/api/auto-logs/export"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const csv=exportLogsCSV(s.user_email);
    res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="h2b_logs.csv"',"Content-Length":Buffer.byteLength(csv,"utf8")});
    return res.end(csv);
  }
  // Limpar logs
  if(pathname==="/api/auto-logs"&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    DB_LOGS[s.user_email]=[];persistLogs();return json(res,200,{ok:true});
  }

  // ── Stats pessoais ────────────────────────────────────
  if(pathname==="/api/my-stats"){
    const s=getSess(req);if(!s?.user_email)return json(res,200,{});
    const h=getHist(s.user_email);const logs=DB_LOGS[s.user_email]||[];
    const totalSent=h.length;const totalAuto=h.filter(x=>x.type==="auto").length;const totalManual=h.filter(x=>x.type!=="auto").length;
    const todayManual=countManualToday(h);const todayAuto=countAutoToday(h);
    const totalFailed=logs.filter(l=>l.status==="falhou").length;const totalDup=logs.filter(l=>l.status==="duplicado").length;
    const byState={};h.forEach(x=>{if(x.state){byState[x.state]=(byState[x.state]||0)+1;}});
    const topStates=Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const streak=calcStreak(h);const sentLast7=last7Days(h);
    return json(res,200,{totalSent,totalAuto,totalManual,todayManual,todayAuto,totalFailed,totalDup,topStates,streak,sentLast7});
  }
  // calcStreak e last7Days agora estão no escopo global (definidas acima do server.listen)

  // ── Ranking: inRankPeriod / calcRanking definidas no escopo global ──

  // ── OAuth ─────────────────────────────────────────────
  if(pathname==="/oauth/start"){if(!CONFIGURED){res.writeHead(302,{Location:"/?err="+encodeURIComponent("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.")});return res.end();}const st=crypto.randomBytes(20).toString("hex");
  // ── REFERRAL FIX: salva o ?ref= na sessão pendente para recuperar no callback ──
  const refCodeParam=(u.searchParams.get("ref")||"").trim().toUpperCase().slice(0,16);
  sessions["__p__"+st]={pending:true,ts:Date.now(),...(refCodeParam?{refCode:refCodeParam}:{})};
  const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:"code",scope:"https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",access_type:"offline",prompt:"consent select_account",state:st});res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs});return res.end();}

  if(pathname==="/oauth/callback"){
    const code=u.searchParams.get("code"),error=u.searchParams.get("error");
    const fail=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)});res.end();};
    if(error)return fail(error==="access_denied"?"Login cancelado.":"Erro OAuth: "+error);
    if(!code)return fail("Código OAuth inválido.");
    try{
      const tb=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:REDIRECT_URI,grant_type:"authorization_code"}).toString();
      const{body:tk}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tb)}},tb);
      if(tk.error)return fail(tk.error_description||tk.error);if(!tk.access_token)return fail("Token não recebido.");
      const{body:ui}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tk.access_token}});
      if(!ui.email)return fail("E-mail não obtido.");
      const sid="sess_"+crypto.randomBytes(24).toString("hex");
      sessions[sid]={access_token:tk.access_token,refresh_token:tk.refresh_token||null,expires_at:Date.now()+(tk.expires_in||3600)*1000,user_email:ui.email,user_name:ui.name||ui.email,picture:ui.picture||"",created_at:Date.now()};
      persistSessions();
      // Salva refresh_token e access_token no banco para uso pelo automático sem sessão
      const tokenData={cached_access_token:tk.access_token,cached_token_expiry:Date.now()+(tk.expires_in||3600)*1000};
      if(tk.refresh_token)tokenData.refresh_token=tk.refresh_token;
      const ex=getUser(ui.email);
      if(!ex){
        const now=Date.now();
        // Novos usuários ganham dias de VIP manual grátis (configurável pelo admin)
        const trialDays = DB_ADMIN_SETTINGS.newUserTrialEnabled ? (DB_ADMIN_SETTINGS.newUserTrialDays || 5) : 0;
        const newUserVip = trialDays > 0
          ? {manualExpires:now+trialDays*86400_000,active:true,activatedAt:now,note:`Bônus boas-vindas ${trialDays}d manual`}
          : null;
        setUser(ui.email,{...tokenData,email:ui.email,name:ui.name||ui.email,picture:ui.picture||"",country:"Brazil",phone:"",cc:"",city:"",language:"pt-BR",cvs:[],created_at:new Date().toISOString(),plan:newUserVip?"vip":"free",vip:newUserVip||null,saved:[],onboarded:false,isAdmin:isAdminEmail(ui.email),settings:{subject:"Application for {vaga} – {nome}",body:"Dear Hiring Manager,\n\nMy name is {nome} and I am writing to express my strong interest in the {vaga} position at {empresa}.\n\nI am from {pais} and fully available to start on the requested date.\n\nPlease find my resume attached.\n\nBest regards,\n{nome}\n{telefone}",followupSubject:"Following up: {vaga} at {empresa}",followupBody:"Dear Hiring Manager,\n\nFollowing up on {vaga} at {empresa}.\n\nBest regards,\n{nome}"}});
        console.log("[oauth] ✅ Novo:",ui.email,"| trial:",trialDays,"d manual VIP");
        trackJourney(ui.email,'first_login',{detail:`Novo. Trial:${trialDays}d`,meta:{name:ui.name}});
        pushGlobalEvent('new_user',ui.email,`Novo: ${ui.name||ui.email}`,"info");
        // ── REFERRAL FIX v18: lê refCode APENAS da sessão pendente ──
        // O Google não repassa parâmetros extras na URL de callback — só o "state".
        // O ?ref= foi salvo em sessions["__p__"+state].refCode no /oauth/start.
        const _cbState = u.searchParams.get("state") || "";
        const refCode = (sessions["__p__" + _cbState]?.refCode || "").trim().toUpperCase() || null;
        if(refCode){
          try{
            const refOwner = DB_REFERRAL.byCode[refCode];
            if(!refOwner){
              console.warn(`[referral] ⚠ código '${refCode}' não encontrado (novo usuário: ${ui.email})`);
            } else if(refOwner.ownerEmail === ui.email){
              console.warn(`[referral] ⚠ auto-indicação bloqueada: ${ui.email}`);
            } else if(DB_REFERRAL.byEmail[ui.email]?.referredBy){
              console.warn(`[referral] ⚠ ${ui.email} já indicado por ${DB_REFERRAL.byEmail[ui.email].referredBy}`);
            } else {
              if(!DB_REFERRAL.byEmail[ui.email]) DB_REFERRAL.byEmail[ui.email] = {code:null};
              DB_REFERRAL.byEmail[ui.email].referredBy = refOwner.ownerEmail;
              DB_REFERRAL.byEmail[ui.email].joinedAt   = new Date().toISOString();
              DB_REFERRAL.byEmail[ui.email].bonusPaid  = true;
              // Dá 5 dias VIP manual ao indicador
              const owner = getUser(refOwner.ownerEmail);
              if(owner){
                const nowR   = Date.now();
                const curExp = Math.max(nowR, owner.vip?.manualExpires || 0);
                setUser(refOwner.ownerEmail, {vip:{...(owner.vip||{}), active:true, manualExpires:curExp+5*86400_000, activatedAt:nowR, note:"Bônus indicação +5d"}});
                console.log(`[referral] ✅ ${ui.email} indicado por ${refOwner.ownerEmail} → +5d VIP concedido`);
              } else {
                console.warn(`[referral] ⚠ indicador ${refOwner.ownerEmail} não encontrado — bônus não pôde ser dado`);
              }
              persist(REFERRAL_FILE, DB_REFERRAL);
            }
          }catch(re){console.warn("[referral] Erro ao processar:", re.message);}
        }
      }
      else{
        // BUG-003 CORRIGIDO: usa isVipActive() em vez de comparar expiresAt diretamente
        // Evita revogar VIP de usuários com schema misto (manualExpires novo + expiresAt legado)
        const vipStillActive = isVipActive(ex);
        const vipDowngrade = ex.vip?.active && !vipStillActive ? {vip:{...ex.vip,active:false},plan:"free"} : {};
        setUser(ui.email,{...tokenData,picture:ui.picture||ex.picture,isAdmin:isAdminEmail(ui.email),...vipDowngrade});
        console.log("[oauth] Login:",ui.email,"| refresh_token salvo:",!!tokenData.refresh_token,"| vip:",vipStillActive?"ativo":"inativo","| Total:",Object.keys(DB_USERS).length);
      }
      const cookieStr=makeCookieStr(sid);const page=makeCallbackPage(sid);
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(page),"Set-Cookie":cookieStr,"Cache-Control":"no-cache, no-store"});
      return res.end(page);
    }catch(e){return fail("Erro: "+e.message);}
  }

  // ── /api/status ───────────────────────────────────────
  if(pathname==="/api/status"){
    const s=getSess(req);if(!s?.user_email)return json(res,200,{connected:false});
    markOnline(s.user_email);
    const p=getUser(s.user_email);if(!p)return json(res,200,{connected:false,reason:"user_not_found"});
    const vipOk=isVipActive(p);
    const planKey=getPlan(p);const {todayManual:sentManual,todayAuto:sentAuto}=getUserStatsCached(s.user_email);
    const manualLimit=getManualLimit(p),autoLimit=getAutoLimit(p);
    const autoJob=getAutoJob(s.user_email);
    const stats=getAutoStats(s.user_email);
    const now2=Date.now();
    return json(res,200,{connected:true,email:s.user_email,name:p.name||s.user_name,picture:p.picture||s.picture||"",country:p.country||"Brazil",phone:p.phone||"",cc:p.cc||"",city:p.city||"",language:p.language||"pt-BR",isAdmin:!!p.isAdmin,plan:planKey,vip:p.vip?{active:vipOk,expiresAt:p.vip.expiresAt||Math.max(p.vip.manualExpires||0,p.vip.autoExpires||0),activatedAt:p.vip.activatedAt,days:p.vip.days||30,plan:p.vip.plan||"vip",manualExpires:p.vip.manualExpires||0,autoExpires:p.vip.autoExpires||0,manualActive:isManualVipActive(p),autoActive:isAutoVipActive(p)}:null,todaySentManual:sentManual,manualLimit,manualRemaining:Math.max(0,manualLimit-sentManual),todaySentAuto:sentAuto,autoLimit,autoRemaining:Math.max(0,autoLimit-sentAuto),autoEnabled:true,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0,source:autoJob.source,startedAt:autoJob.startedAt,lastSentAt:autoJob.lastSentAt,nextSendAt:autoJob.nextSendAt,currentJob:autoJob.currentJob,originalCount:autoJob.originalCount}:null,autoStats:stats,cvs:(p.cvs||[]).map(c=>({idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType||"resume"})),settings:p.settings||{},onboarded:!!p.onboarded,adminMessage:p.adminMessage||null,readEmailIds:p.readEmailIds||[],profiles:p.profiles||[]});
  }

  if(pathname==="/api/onboard"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});setUser(s.user_email,{onboarded:true});return json(res,200,{ok:true});}
  if(pathname==="/api/settings"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));const upd={};if(d.name!==undefined){upd.name=String(d.name).slice(0,200);s.user_name=upd.name;}if(d.country!==undefined)upd.country=String(d.country).slice(0,100);if(d.phone!==undefined)upd.phone=String(d.phone).slice(0,50);/* cc field removed */if(d.city!==undefined)upd.city=String(d.city).slice(0,100);if(d.language!==undefined)upd.language=String(d.language).slice(0,10);if(d.settings){const p=getUser(s.user_email)||{};upd.settings={...(p.settings||{}),...d.settings};}setUser(s.user_email,upd);return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/cv/upload"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(rateLimit(s.user_email+"_cv",10,3600_000))return json(res,429,{error:"Muitos uploads. Tente novamente em 1 hora."});try{const d=JSON.parse(await readBody(req));if(!d.base64||!d.name)return json(res,400,{error:"base64 e name obrigatórios."});// Tamanho: base64 representa ~75% dos bytes reais
const estimatedBytes=Math.round(d.base64.length*0.75);if(d.base64.length>14_000_000)return json(res,400,{error:"Arquivo maior que 10MB."});if(estimatedBytes<1000)return json(res,400,{error:"Arquivo muito pequeno ou corrompido."});// Valida magic bytes %PDF (mais robusto: verifica os 4 primeiros bytes do binário real)
const pdfBuf=Buffer.from(d.base64.slice(0,8),"base64");if(pdfBuf.length<4||pdfBuf[0]!==0x25||pdfBuf[1]!==0x50||pdfBuf[2]!==0x44||pdfBuf[3]!==0x46)return json(res,400,{error:"Arquivo inválido: não é um PDF. Envie um arquivo .pdf válido."});// Nome seguro
const safeName=String(d.name).replace(/[<>"'&]/g,"").slice(0,200);if(!safeName)return json(res,400,{error:"Nome do arquivo inválido."});const p=getUser(s.user_email)||{};const cvs=p.cvs||[];const idx=Date.now();const meta={idx,name:safeName,size:estimatedBytes,date:new Date().toISOString(),cvType:d.cvType||"resume",b64:d.base64};if(cvs.length>=10){const old=cvs.shift();deleteCv(s.user_email,old.idx);}cvs.push(meta);saveCv(s.user_email,idx,d.base64);setUser(s.user_email,{cvs});trackJourney(s.user_email,'pdf_upload',{detail:`PDF: ${safeName} ~${Math.round(estimatedBytes/1024)}KB`,meta:{name:safeName,idx}});
      return json(res,200,{ok:true,cv:{idx:meta.idx,name:meta.name,size:meta.size,date:meta.date,cvType:meta.cvType}});}catch(e){return json(res,500,{error:e.message});}}
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});const b64=loadCv(s.user_email,idx);if(!b64)return json(res,404,{error:"Arquivo não encontrado."});return json(res,200,{base64:b64,idx});}
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="DELETE"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});deleteCv(s.user_email,idx);setUser(s.user_email,{cvs:(p.cvs||[]).filter(c=>c.idx!==idx)});return json(res,200,{ok:true});}

  if(pathname==="/api/send"&&req.method==="POST"){
    const s=getSess(req);if(!s?.access_token)return json(res,401,{error:"Sessão expirada."});
    const p=getUser(s.user_email)||{};
    let dedupKey = null; // declarado fora do try para que o catch possa acessar
    try{
      const d=JSON.parse(await readBody(req));if(!d.to||!d.subject||!d.message)return json(res,400,{error:"Campos obrigatórios."});
      // v15-SEC: normalização e validação robusta do destinatário
      const _parsedTo = parseEmail(d.to);
      if (!_parsedTo.ok) return json(res,400,{error:`E-mail inválido: ${_parsedTo.reason}`});
      const toEmail = _parsedTo.email;
      // v15-SEC: guarda contra auto-envio
      if (toEmail === s.user_email.toLowerCase()) return json(res,400,{error:"Não é possível enviar candidatura para o seu próprio e-mail."});
      // v15-SEC: assunto e corpo não podem ser vazios
      if (!String(d.subject).trim()) return json(res,400,{error:"O assunto do e-mail não pode estar em branco."});
      if (!String(d.message).trim()) return json(res,400,{error:"O corpo do e-mail não pode estar em branco."});

      const isReply=!!(d.isReply);

      // ── DEDUP: impede envio simultâneo do mesmo email para o mesmo destinatário ──
      dedupKey = s.user_email + "|" + toEmail + "|" + (isReply ? "reply" : "new");
      if (_manualSendInFlight.has(dedupKey)) {
        return json(res,409,{error:"Envio em andamento para este destinatário. Aguarde.",duplicate:true});
      }
      _manualSendInFlight.set(dedupKey, Date.now());
      // Remove lock após 15s (garante limpeza mesmo em erro)
      setTimeout(()=>_manualSendInFlight.delete(dedupKey), 15000);

      if(!isReply){
        // Só verifica limite para candidaturas novas (não respostas)
        const lim=getManualLimit(p);const h=getHist(s.user_email);const sent=countManualToday(h);
        if(sent>=lim)return json(res,429,{error:`Limite de ${lim} envios/dia atingido.`,limitReached:true,plan:getPlan(p),todaySent:sent,dailyLimit:lim});
        if(rateLimit(s.user_email+"_send",lim+20,86400_000))return json(res,429,{error:"Muitos envios."});
        // v16-FIX: bloqueia manual se já enviado (manual ou automático) — evita duplicata
        if(hasSent(s.user_email,toEmail))return json(res,409,{error:"Você já enviou para esta empresa. Verifique o histórico.",alreadySent:true});
      }else{
        // Rate limit leve para respostas (50/dia) para evitar abuso
        if(rateLimit(s.user_email+"_reply",50,86400_000))return json(res,429,{error:"Muitas respostas em um dia."});
      }

      const attachments=[];const getAtt=async idx=>{if(!idx)return null;const m=p.cvs?.find(c=>c.idx===parseInt(idx,10));return m&&loadCv(s.user_email,m.idx)?{data:loadCv(s.user_email,m.idx),name:m.name}:null;};
      if(!isReply){// Anexos só em candidaturas originais
        if(d.resumeIdx){const a=await getAtt(d.resumeIdx);if(a)attachments.push(a);}else if(d.pdfBase64){attachments.push({data:d.pdfBase64,name:d.pdfName||"resume.pdf"});}
        if(d.coverIdx){const a=await getAtt(d.coverIdx);if(a)attachments.push(a);}
      }

      // Cabeçalhos de threading para manter na mesma conversa
      const threadHeaders={};
      if(isReply&&d.messageId){threadHeaders["In-Reply-To"]=d.messageId;threadHeaders["References"]=d.messageId;}
      if(isReply&&d.threadId){threadHeaders["X-Gmail-Thread-Id"]=d.threadId;}

      const sid=getSessId(req);
      const r=await gmailSendWithThread(sid,{
        to:toEmail,subject:d.subject,text:d.message,
        fromName:d.fromName||p.name||s.user_name||"H2BApply",
        attachments,threadHeaders,
        threadId:isReply?(d.threadId||null):null
      });

      const now=new Date();
      if(!isReply){
        // Só registra no histórico candidaturas originais
        const lim=getManualLimit(p);const h=getHist(s.user_email);const sent=countManualToday(h);
        // ── v13: gerar appId estável e snapshot completo da vaga ─
        const appId  = newAppId();
        const snap   = buildJobSnapshot({...d, to: toEmail});
        const histEntry = {
          appId,
          jobId: d.jobId || ("m_" + Date.now()),
          job:   d.jobTitle || d.subject,
          company: d.company || "",
          to: toEmail,
          dateStr: todayStr(), // BRT
          date: toLocaleBRT(Date.now()),
          sentAt: now.toISOString(),
          msgId: r.id,           // mantido p/ compat
          gmailMsgId: r.id,      // id curto Gmail
          threadId: r.threadId || null,
          jobSnapshot: snap,
          attachCount: attachments.length,
          type: "manual",
          sheetSource: d.sheetSource||undefined
        };
        addHist(s.user_email, histEntry);
        indexApp(s.user_email, histEntry);
        // Buscar o header Message-Id real em background para indexar (fire-and-forget)
        if(r.id){
          (async()=>{
            try{
              const tok = sessions[sid]?.access_token;
              if(!tok) return;
              const h = await fetchGmailMessageHeaders(tok, r.id);
              if(h?.messageId){
                histEntry.gmailHeaderMsgId = h.messageId;
                indexApp(s.user_email, { appId, to: toEmail, gmailHeaderMsgId: h.messageId, threadId: histEntry.threadId });
                // atualizar a entrada no HIST com o header
                const arr = DB_HIST[s.user_email] || [];
                const idx = arr.findIndex(x => x.appId === appId);
                if(idx>=0){ arr[idx].gmailHeaderMsgId = h.messageId; persist(HIST_FILE, DB_HIST); }
              }
            } catch {}
          })();
        }
        // ✅ Marca e-mail no DB_SENT para que o automático não reenvie para a mesma empresa
        markSent(s.user_email, toEmail);
        const newSent=sent+1;const newLim=getManualLimit(p);
        _manualSendInFlight.delete(dedupKey);
        invalidateUserStatsCache(s.user_email);
        return json(res,200,{ok:true,messageId:r.id,appId,threadId:r.threadId||null,todaySent:newSent,dailyLimit:newLim,remaining:Math.max(0,newLim-newSent),countedAsManual:true});
      }else{
        // Resposta: não conta, só confirma sucesso
        console.log(`[reply] ✅ ${s.user_email} → ${toEmail} (thread: ${d.threadId||"?"})`);
        _manualSendInFlight.delete(dedupKey);
        return json(res,200,{ok:true,messageId:r.id,countedAsManual:false,isReply:true});
      }
    }catch(e){_manualSendInFlight.delete(dedupKey);console.error("[send]",e.message);return json(res,500,{error:e.message});}
  }




  // /api/cv/delete — Remove PDF da conta do usuário
  if(pathname==="/api/cv/delete"&&req.method==="POST"){
    const sd=getSess(req);if(!sd?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const idx=parseInt(d.idx,10);
      if(!idx)return json(res,400,{error:"idx inválido."});
      const u=getUser(sd.user_email);
      if(!u)return json(res,404,{error:"Usuário não encontrado."});
      const cvs=(u.cvs||[]).filter(c=>c.idx!==idx);
      // Remover referência de perfis que usavam esse PDF
      const profiles=(u.profiles||[]).map(p=>{
        const np={...p};
        if(np.resumeIdx===idx){delete np.resumeIdx;delete np.pdfName;delete np.pdfSize;}
        if(np.coverIdx===idx){delete np.coverIdx;}
        return np;
      });
      setUser(sd.user_email,{cvs,profiles});
      console.log("[cv/delete]",sd.user_email,"idx:",idx);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(pathname==="/api/accept-terms"&&req.method==="POST"){
    try{
      const s2=getSess(req);
      const d=JSON.parse(await readBody(req));
      const ip=(req.headers["x-forwarded-for"]||"").split(",")[0].trim()||"unknown";
      if(s2?.user_email){
        setUser(s2.user_email,{termsAccepted:{version:d.version||"2.0",ts:Date.now(),date:new Date().toISOString(),ip}});
        console.log("[terms] Aceite:",s2.user_email,d.version,ip);
      }
      return json(res,200,{ok:true});
    }catch(e){return json(res,200,{ok:true});}
  }

  if(pathname==="/api/sent-ids"&&req.method==="GET"){
    const s2=getSess(req);if(!s2?.user_email)return json(res,401,{error:"Não autenticado."});
    const hist=getHist(s2.user_email);
    const sentJan=new Set(),sentJul=new Set(),sentSeasonal=new Set();
    hist.forEach(h=>{
      if(h.sheetSource==="jan2026"&&h.caseNum)sentJan.add(h.caseNum);
      else if(h.sheetSource==="jul2025"&&h.caseNum)sentJul.add(h.caseNum);
      else if(h.jobId)sentSeasonal.add(h.jobId);
    });
    // Inclui IDs da fila automática para ocultar do manual
    const autoJob=getAutoJob(s2.user_email);
    const autoQueueIds=autoJob?.active?(autoJob.queue||[]).map(q=>q.id||q.caseNum).filter(Boolean):[];
    return json(res,200,{jan2026:[...sentJan],jul2025:[...sentJul],seasonal:[...sentSeasonal],autoQueueIds});
  }

  // Remove vaga dos enviados (volta para lista)
  if(pathname==="/api/sent/remove"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {jobId,caseNum,to,sheet}=d;
      // Remove do histórico
      let hist=getHist(s.user_email);
      const before=hist.length;
      hist=hist.filter(h=>{
        if(jobId&&h.jobId===jobId)return false;
        if(caseNum&&h.caseNum===caseNum)return false;
        if(to&&h.to===to)return false;
        return true;
      });
      DB_HIST[s.user_email]=hist;
      persist(HIST_FILE,DB_HIST);
      // Remove do DB_SENT (email da empresa) — persistência imediata (não debounced)
      if(to&&DB_SENT[s.user_email]){
        DB_SENT[s.user_email].delete((to||"").toLowerCase().trim().replace(/\.+$/,""));
        persistSent(); // imediato — regra principal
      }
      // Remove do APPLIED index
      if(jobId){
        const idx=DB_APPIDX[s.user_email];
        if(idx){delete idx[jobId];persist(APPIDX_FILE,DB_APPIDX);}
      }
      invalidateUserStatsCache(s.user_email);
      console.log(`[sent/remove] ${s.user_email} removeu vaga jobId=${jobId||"-"} caseNum=${caseNum||"-"} (${before-hist.length} entradas)`);
      return json(res,200,{ok:true,removed:before-hist.length});
    }catch(e){return json(res,500,{error:e.message});}
  }


  if(pathname==="/api/diag"&&req.method==="GET"){
    const sd=getSess(req);if(!sd?.user_email||!isAdminEmail(sd.user_email))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{
      uptime_s:Math.round(process.uptime()),
      memory_mb:Math.round(process.memoryUsage().heapUsed/1024/1024),
      sessions_count:Object.keys(sessions).length,
      users_count:Object.keys(DB_USERS).length,
      app_url:APP_URL,redirect_uri:REDIRECT_URI,
      client_id_prefix:CLIENT_ID.slice(0,30)+"...",
      client_secret_len:CLIENT_SECRET.length,
      client_secret_preview:CLIENT_SECRET.slice(0,8)+"..."+CLIENT_SECRET.slice(-4),
      disk:fs.existsSync("/data"),data_dir:DATA_DIR,is_prod:IS_PROD,
      node_version:process.version
    });
  }

  if(pathname==="/api/warmup"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,ts:Date.now()}));}

  if(pathname==="/api/history"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});return json(res,200,{history:getHist(s.user_email)});}

  // ── PUSH NOTIFICATIONS ────────────────────────────────────
  // Retorna a chave pública VAPID para o frontend registrar subscription
  if(pathname==="/api/push/vapid-public-key"&&req.method==="GET"){
    if(!PUSH_ENABLED)return json(res,200,{enabled:false,publicKey:null});
    return json(res,200,{enabled:true,publicKey:VAPID_PUBLIC_KEY});
  }
  // Registra subscription de push do dispositivo
  if(pathname==="/api/push/subscribe"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!PUSH_ENABLED)return json(res,200,{ok:false,reason:"VAPID não configurado no servidor."});
    try{
      const d=JSON.parse(await readBody(req));
      const sub=d.subscription;
      if(!sub?.endpoint)return json(res,400,{error:"Subscription inválida."});
      // Adiciona ou atualiza subscription (evita duplicatas por endpoint)
      if(!DB_PUSH[s.user_email])DB_PUSH[s.user_email]=[];
      const existing=DB_PUSH[s.user_email].findIndex(x=>x.endpoint===sub.endpoint);
      if(existing>=0)DB_PUSH[s.user_email][existing]=sub;
      else DB_PUSH[s.user_email].push(sub);
      persistPush();
      console.log(`[push] ✅ Subscription registrada para ${s.user_email} (${DB_PUSH[s.user_email].length} device(s))`);
      // Envia push de teste para confirmar funcionamento
      try{
        await sendWebPush(sub,{
          type:"test",
          title:"✅ H2BApply — Notificações ativas!",
          body:"Você será notificado de novas respostas mesmo com o app fechado.",
          icon:"/icon-192.png",badge:"/icon-192.png",tag:"h2b-test",url:"/"
        });
      }catch(e){console.warn("[push] Teste push falhou:",e.message);}
      return json(res,200,{ok:true,devices:DB_PUSH[s.user_email].length});
    }catch(e){console.error("[push/sub]",e.message);return json(res,500,{error:e.message});}
  }
  // Remove subscription de push
  if(pathname==="/api/push/unsubscribe"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const endpoint=d.endpoint;
      if(endpoint&&DB_PUSH[s.user_email]){
        DB_PUSH[s.user_email]=DB_PUSH[s.user_email].filter(x=>x.endpoint!==endpoint);
        persistPush();
      }
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // Envia push manual de teste (para admin ou debug)
  if(pathname==="/api/push/test"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!PUSH_ENABLED)return json(res,200,{ok:false,reason:"VAPID não configurado."});
    try{
      const subs=DB_PUSH[s.user_email]||[];
      if(!subs.length)return json(res,200,{ok:false,reason:"Nenhum device registrado."});
      await pushToUser(s.user_email,{
        type:"test",title:"🛫 H2BApply — Teste OK!",
        body:"Push notification funcionando! Você receberá alertas em tempo real.",
        icon:"/icon-192.png",badge:"/icon-192.png",tag:"h2b-test",url:"/"
      });
      return json(res,200,{ok:true,devices:subs.length});
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(pathname==="/api/saved"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(req.method==="GET")return json(res,200,{saved:(getUser(s.user_email)||{}).saved||[]});if(req.method==="POST"){try{const d=JSON.parse(await readBody(req));setUser(s.user_email,{saved:(d.saved||[]).slice(0,500)});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}}
  if(pathname==="/api/disconnect"){const id=getSessId(req);if(id&&sessions[id])delete sessions[id];res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":clearCookieStr()});return res.end('{"ok":true}');}

  // ── TEMPLATES ─────────────────────────────────────────
  if(pathname==="/api/templates"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const p=getUser(s.user_email)||{};return json(res,200,{templates:p.templates||[]});}
  if(pathname==="/api/templates/save"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.name||!d.body)return json(res,400,{error:"name e body obrigatórios"});const p=getUser(s.user_email)||{};let tpls=p.templates||[];const idx=tpls.findIndex(t=>t.id===d.id);const tpl={id:d.id||crypto.randomUUID(),name:String(d.name).slice(0,80),subject:String(d.subject||"").slice(0,200),body:String(d.body).slice(0,5000),category:String(d.category||"general").slice(0,40),updatedAt:new Date().toISOString(),createdAt:d.createdAt||new Date().toISOString()};if(idx>=0)tpls[idx]=tpl;else{if(tpls.length>=50)return json(res,429,{error:"Limite de 50 templates atingido"});tpls.unshift(tpl);}setUser(s.user_email,{templates:tpls});return json(res,200,{ok:true,template:tpl});}catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/templates/delete"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.id)return json(res,400,{error:"id obrigatório"});const p=getUser(s.user_email)||{};setUser(s.user_email,{templates:(p.templates||[]).filter(t=>t.id!==d.id)});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

  // ── PROFILES ──────────────────────────────────────────
  if(pathname==="/api/profiles"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const p=getUser(s.user_email)||{};return json(res,200,{profiles:p.profiles||[]});}
  if(pathname==="/api/profiles/save"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.name)return json(res,400,{error:"name obrigatório"});const p=getUser(s.user_email)||{};let prfs=p.profiles||[];const idx=prfs.findIndex(x=>x.id===d.id);
    // Validate and normalize subjects (up to 10, no duplicates, no empty)
    const rawSubjs=Array.isArray(d.subjects)?d.subjects:[];
    const subjects=[...new Set(rawSubjs.map(s=>String(s).trim()).filter(Boolean))].slice(0,10);
    // Validate and normalize email bodies (no empty)
    const rawBodies=Array.isArray(d.emailBodies)?d.emailBodies:[];
    const emailBodies=rawBodies.map(b=>String(b).trim()).filter(Boolean);
    // Normalize categories (only known keys)
    const KNOWN_CATS=["landscape","construction","housekeeper","seafood","farm","golf","amusement","forest","lifeguard","other"];
    const categories=Array.isArray(d.categories)?d.categories.filter(c=>KNOWN_CATS.includes(c)):[];
    // Normalize sheets
    const KNOWN_SHEETS=["jan2026","jul2025","dol"];
    const sheets=Array.isArray(d.sheets)?d.sheets.filter(s=>KNOWN_SHEETS.includes(s)):[];
    const prf={id:d.id||crypto.randomUUID(),name:String(d.name).slice(0,80),desc:String(d.desc||"").slice(0,200),active:d.active!==false,isGeneral:!!d.isGeneral,subjects,emailBodies,subject:subjects[0]||String(d.subject||"").slice(0,200),body:emailBodies[0]||String(d.body||"").slice(0,5000),categories,sheets,resumeIdx:d.resumeIdx??null,pdfName:d.pdfName?String(d.pdfName).slice(0,200):undefined,pdfSize:d.pdfSize||0,coverIdx:d.coverIdx??null,state:String(d.state||"").slice(0,40),updatedAt:new Date().toISOString(),createdAt:d.createdAt||new Date().toISOString()};if(idx>=0)prfs[idx]=prf;else{if(prfs.length>=20)return json(res,429,{error:"Limite de 20 perfis atingido"});prfs.unshift(prf);}setUser(s.user_email,{profiles:prfs});return json(res,200,{ok:true,profile:prf});}catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/profiles/delete"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.id)return json(res,400,{error:"id obrigatório"});const p=getUser(s.user_email)||{};setUser(s.user_email,{profiles:(p.profiles||[]).filter(pr=>pr.id!==d.id)});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

  if(pathname==="/api/debug/export"){const s=getSess(req);if(!s?.user_email||(getUser(s.user_email)||{}).isAdmin!==true)return json(res,403,{error:"Acesso negado."});return json(res,200,{ts:new Date().toISOString(),users:DB_USERS,totalUsers:Object.keys(DB_USERS).length,dataDir:DATA_DIR,disk:fs.existsSync("/data")});}

  // ── ENVIO AUTOMÁTICO ──────────────────────────────────
  if(pathname==="/api/auto/start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // Proteção contra múltiplos cliques: bloqueia se já existe job ativo
    const existingJob=getAutoJob(s.user_email);
    if(existingJob&&existingJob.active){
      return json(res,409,{error:"Envio automático já está em andamento. Pause ou pare antes de iniciar novamente.",alreadyRunning:true,queueSize:existingJob.queue?.length||0});
    }
    const p=getUser(s.user_email)||{};const h=getHist(s.user_email);const todayAuto=countAutoToday(h);const autoLimit=getAutoLimit(p);
    if(todayAuto>=autoLimit)return json(res,429,{error:`Limite de ${autoLimit} automáticos/dia atingido.`,limitReached:true});
    try{
      const d=JSON.parse(await readBody(req));
      // ── Validação: perfil válido ──────────────────────────
      const profiles=(p.profiles||[]).filter(pr=>pr.active!==false);
      const hasResumeIdx=d.resumeIdx!=null||(profiles.length>0&&profiles.some(pr=>pr.resumeIdx!=null));
      // Verifica se existe pelo menos um assunto configurado (em algum perfil ativo ou no bodyTemplate)
      const hasSubject=profiles.some(pr=>(pr.subjects&&pr.subjects.length>0)||pr.subject)||d.bodyTemplate||(Array.isArray(d.subjects)&&d.subjects.length>0);

      // ═══════════════════════════════════════════════════════
      // v15-FIX: Validação de PDF robusta e tolerante
      // ═══════════════════════════════════════════════════════
      // Aceita o envio se EXISTIR qualquer um dos cenários:
      //   1. d.resumeIdx (frontend) aponta para um CV existente no disco
      //   2. Algum perfil ativo tem resumeIdx apontando para CV existente
      //   3. Existe qualquer CV no disco do usuário (último recurso)
      // Helper para verificar se um CV idx é válido (existe no disco)
      const _cvExists = (idx) => {
        if (idx == null) return false;
        const ridx = parseInt(idx, 10);
        if (!Number.isFinite(ridx)) return false;
        try { return fs.existsSync(cvPath(s.user_email, ridx)); } catch { return false; }
      };

      // Coleta TODOS os PDFs disponíveis (perfis + p.cvs)
      const availablePdfs = [];

      // 1) PDFs vinculados a perfis ativos
      for (const pr of profiles) {
        if (pr.resumeIdx != null && _cvExists(pr.resumeIdx)) {
          availablePdfs.push({ source: `perfil "${pr.name}"`, idx: parseInt(pr.resumeIdx, 10) });
        }
      }

      // 2) PDFs em p.cvs (Documentos)
      for (const cv of (p.cvs || [])) {
        if (_cvExists(cv.idx)) {
          // Evita duplicatas
          if (!availablePdfs.some(a => a.idx === parseInt(cv.idx, 10))) {
            availablePdfs.push({ source: `Documentos: ${cv.name || cv.idx}`, idx: parseInt(cv.idx, 10) });
          }
        }
      }

      // Verifica se d.resumeIdx específico é válido (se foi enviado)
      let pdfOk = true;
      let pdfErrorDetail = "";
      if (d.resumeIdx != null) {
        if (!_cvExists(d.resumeIdx)) {
          // d.resumeIdx inválido — mas talvez outros PDFs estejam disponíveis
          if (availablePdfs.length > 0) {
            // Tudo bem — o processQueue vai usar fallback automaticamente
            console.log(`[auto/start] resumeIdx=${d.resumeIdx} inválido, mas há ${availablePdfs.length} PDF(s) disponível(eis) — continuando com fallback`);
          } else {
            pdfOk = false;
            pdfErrorDetail = ` (resumeIdx=${d.resumeIdx} não encontrado e nenhum outro PDF disponível)`;
          }
        }
      } else {
        // Sem d.resumeIdx — exige pelo menos 1 PDF disponível em qualquer lugar
        if (availablePdfs.length === 0) {
          pdfOk = false;
          pdfErrorDetail = " (nenhum PDF encontrado nos perfis ou em Documentos)";
        }
      }

      // Log diagnóstico — facilita debugar problemas futuros
      console.log(`[auto/start] user=${s.user_email} profiles_ativos=${profiles.length} pdfs_disponiveis=${availablePdfs.length} d.resumeIdx=${d.resumeIdx} pdfOk=${pdfOk}`);
      if (!pdfOk) {
        console.warn(`[auto/start] PDF check FALHOU para ${s.user_email}${pdfErrorDetail}`);
        console.warn(`[auto/start] perfis: ${profiles.map(pr=>`${pr.name}[res=${pr.resumeIdx}]`).join(", ") || "(nenhum)"}`);
        console.warn(`[auto/start] p.cvs: ${(p.cvs||[]).map(c=>`${c.name}#${c.idx}`).join(", ") || "(nenhum)"}`);
        return json(res,400,{
          error: "Nenhum currículo (PDF) encontrado. Faça upload de um PDF em Documentos ou vincule um currículo a um perfil antes de iniciar.",
          pdfMissing: true,
          detail: pdfErrorDetail.trim(),
          debug: {
            profilesActive: profiles.length,
            profilesWithResume: profiles.filter(pr=>pr.resumeIdx!=null).length,
            cvsRegistered: (p.cvs||[]).length,
            cvsOnDisk: (p.cvs||[]).filter(c=>_cvExists(c.idx)).length
          }
        });
      }
      let queue=[];
      // MODO 1: Frontend já enviou fila com emails (fluxo antigo, agora preserva todos os campos extras)
      if(d.queue&&d.queue.length){
        // v15-SEC: normaliza emails, valida com regex robusta, remove self-sends
        queue=d.queue.map(item=>{ const _p=parseEmail(item.to||''); return _p.ok ? {...item, to: _p.email} : null; })
          .filter(item => item && isValidEmail(item.to) && item.to !== s.user_email.toLowerCase())
          .map(item=>({
          id: item.id || item.caseNum || "",
          to: item.to,
          title: item.title || "",
          company: item.company || "",
          category: item.category || "other",
          state: item.state || "",
          // v13: campos opcionais ricos para snapshot — preservados se vierem
          city:    item.city    || "",
          wage:    item.wage    || "",
          visa:    item.visa    || item.visaType || "",
          start:   item.start   || item.beginDate || "",
          end:     item.end     || item.endDate || "",
          workers: item.workers || null,
          desc:    item.desc    || item.description || "",
          caseNum: item.caseNum || item.case_number || ""
        }));
      }
      // MODO 2: Frontend enviou só case numbers — servidor busca emails E enriquece com dados completos
      if(d.cases&&d.cases.length&&!queue.length){
        console.log(`[auto] Buscando emails para ${d.cases.length} cases...`);
        const batchSize=10;
        for(let i=0;i<Math.min(d.cases.length,200);i+=batchSize){
          const batch=d.cases.slice(i,i+batchSize);
          try{
            const jobs=await fetchByCase(batch);
            for(const[cn,job]of Object.entries(jobs)){
              const _parsedJobEmail = parseEmail(job?.email||'');
              if(_parsedJobEmail.ok && _parsedJobEmail.email !== s.user_email.toLowerCase()){
                const meta=d.caseMeta?.[cn]||{};
                queue.push({
                  id: cn,
                  to: _parsedJobEmail.email,
                  title: job.title || meta.company || cn,
                  company: job.company || meta.company || "",
                  category: job.category || meta.category || "other",
                  state: job.state || meta.state || "",
                  city: job.city || meta.city || "",
                  wage: job.wage || meta.wage || "",
                  visa: job.visa || meta.visa || (job.jobType==="agricultural"?"H-2A":""),
                  start: job.start || meta.start || "",
                  end: job.end || meta.end || "",
                  workers: job.workers || meta.workers || null,
                  desc: (job.desc || meta.desc || "").slice(0,500),
                  caseNum: cn
                });
              }
            }
          }catch(e){console.warn("[auto/cases]",e.message);}
          // Pequena pausa entre lotes
          if(i+batchSize<d.cases.length)await new Promise(r=>setTimeout(r,500));
        }
        console.log(`[auto] ${queue.length} emails encontrados de ${d.cases.length} cases`);
      }
      if(!queue.length)return json(res,400,{error:"Nenhuma vaga com e-mail encontrada. Tente uma fonte diferente ou aguarde o portal do governo atualizar."});
      // BUG-015 CORRIGIDO: proteção contra fila duplicada só bloqueia se o job anterior terminou
      // nos últimos 60s (era 5min) E não foi parado/cancelado manualmente pelo usuário.
      const queueFingerprint=crypto.createHash("md5").update(queue.map(i=>i.to).sort().join(",")).digest("hex");
      const lastJob=getAutoJob(s.user_email);
      if(lastJob&&lastJob.queueFingerprint===queueFingerprint&&lastJob.finishedAt&&Date.now()-lastJob.finishedAt<60_000&&lastJob.status==="finished"){
        return json(res,409,{error:"Esta fila idêntica já foi processada há menos de 1 minuto. Aguarde um momento.",duplicateQueue:true});
      }
      const startH=Number.isFinite(parseInt(d.startH,10))?Math.max(0,Math.min(23,parseInt(d.startH,10))):AUTO_START_H_DEFAULT;
      const endH  =Number.isFinite(parseInt(d.endH,10))  ?Math.max(1,Math.min(24,parseInt(d.endH,10)))  :AUTO_END_H_DEFAULT;

      // v15-FIX: Determina job.resumeIdx com fallback automático
      // Se frontend mandou um resumeIdx válido, usa ele.
      // Senão, escolhe o primeiro PDF disponível (perfis > p.cvs).
      // Isso garante que sempre haja um anexo, mesmo se o perfil selecionado pelo processQueue não tiver CV.
      let jobResumeIdx = (d.resumeIdx != null && _cvExists(d.resumeIdx)) ? parseInt(d.resumeIdx, 10) : null;
      if (jobResumeIdx == null && availablePdfs.length > 0) {
        jobResumeIdx = availablePdfs[0].idx;
        console.log(`[auto/start] usando fallback resumeIdx=${jobResumeIdx} (${availablePdfs[0].source})`);
      }
      let jobCoverIdx = (d.coverIdx != null && _cvExists(d.coverIdx)) ? parseInt(d.coverIdx, 10) : null;
      // Tenta achar uma cover letter em algum perfil ativo
      if (jobCoverIdx == null) {
        for (const pr of profiles) {
          if (pr.coverIdx != null && _cvExists(pr.coverIdx)) {
            jobCoverIdx = parseInt(pr.coverIdx, 10);
            break;
          }
        }
      }

      // ✅ Embaralha a fila no servidor — cada usuário terá ordem diferente
      // Evita que múltiplos usuários simultâneos enviem para as mesmas empresas ao mesmo tempo
      queue = shuffleArray(queue);
      const _mode = (d.mode==="now") ? "now" : "schedule"; // "now" = 24/7 até zerar; "schedule" = janela diária
const job={active:true,startedAt:Date.now(),queue,originalCount:queue.length,filteredCount:queue.length,resumeIdx:jobResumeIdx,coverIdx:jobCoverIdx,bodyTemplate:d.bodyTemplate||p.settings?.body||"",subjects:Array.isArray(d.subjects)&&d.subjects.length?d.subjects:null,emailBodies:Array.isArray(d.emailBodies)&&d.emailBodies.length?d.emailBodies:null,status:"starting",lastSentAt:null,finishedAt:null,source:d.source||"manual",category:d.category||"all",mode:_mode,startH,endH,filters:d.filters||{},queueFingerprint,rotState:{lastSubjIdx:-1,lastBodyIdx:-1}};
      setAutoJob(s.user_email,job);
      autoStats.set(s.user_email,{sent:0,failed:0,skipped:0,startedAt:Date.now()});
      addLog(s.user_email,{status:"sistema",jobTitle:`Envio automático iniciado: ${queue.length} vagas`,company:`Fonte: ${d.source||"manual"} | Categoria: ${d.category||"all"}`,source:d.source||"manual",category:d.category||"all"});
      trackJourney(s.user_email,'auto_start',{detail:`Auto: ${queue.length} vagas | ${d.source||"manual"}`,meta:{queueSize:queue.length}});
      // Inicia imediatamente
      setTimeout(()=>scheduleAuto(s.user_email),100);
      return json(res,200,{ok:true,queueSize:queue.length});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/auto/pause"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}setAutoJob(s.user_email,{...j,active:false,status:"paused"});addLog(s.user_email,{status:"pausado",jobTitle:"Envio pausado pelo usuário",company:""});return json(res,200,{ok:true});}
  if(pathname==="/api/auto/resume"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});setAutoJob(s.user_email,{...j,active:true,status:"resuming"});addLog(s.user_email,{status:"sistema",jobTitle:"Envio retomado",company:""});scheduleAuto(s.user_email);return json(res,200,{ok:true});}
  if(pathname==="/api/auto/stop"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}addLog(s.user_email,{status:"cancelado",jobTitle:"Envio cancelado pelo usuário",company:""});delAutoJob(s.user_email);return json(res,200,{ok:true});}
  if(pathname==="/api/auto/status"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);const h=getHist(s.user_email);const p=getUser(s.user_email)||{};const stats=getAutoStats(s.user_email);const logs=(DB_LOGS[s.user_email]||[]).slice(0,5);// últimos 5 logs para dashboard
    const jSH=j?.startH!==undefined?j.startH:AUTO_START_H_DEFAULT;const jEH=j?.endH!==undefined?j.endH:AUTO_END_H_DEFAULT;
    const autoQueueIds=j&&j.active?(j.queue||[]).map(q=>q.id||q.caseNum).filter(Boolean):[];return json(res,200,{job:j?{active:j.active,status:j.status,queueSize:j.queue?.length||0,originalCount:j.originalCount,filteredCount:j.filteredCount,startedAt:j.startedAt,lastSentAt:j.lastSentAt,nextSendAt:j.nextSendAt,currentJob:j.currentJob,source:j.source,category:j.category,mode:j.mode||"schedule",startH:jSH,endH:jEH}:null,todayAuto:countAutoToday(h),autoLimit:getAutoLimit(p),isAutoHour:isAutoHour(jSH,jEH),startH:jSH,endH:jEH,stats,recentLogs:logs,autoQueueIds:autoQueueIds});}

  // ── INBOX: Respostas recebidas no Gmail ───────────────────
  if(pathname==="/api/inbox"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sid=getSessId(req);
    // Server-side inbox cache — 30s TTL (reduzido para melhor responsividade)
    if(!global._inboxCache)global._inboxCache={};
    const cKey=s.user_email;
    const cached=global._inboxCache[cKey];
    const forceFresh=u.searchParams?.get?.("fresh")==="1";
    if(cached&&!forceFresh&&(Date.now()-cached.ts)<30000){
      return json(res,200,{ok:true,emails:cached.emails,total:cached.emails.length,unread:cached.emails.filter(e=>!e.isRead).length,fromCache:true});
    }
    try{
      const limit=Math.min(200,parseInt(u.searchParams?.get?.("limit")||"50",10));
      const emails=await gmailFetchInbox(sid,limit);
      // FIX: carrega IDs lidos persistidos no banco (sobrevive reload/relogin)
      const dbUser = getUser(s.user_email) || {};
      const persistedReadSet = new Set(dbUser.readEmailIds || []);
      // v13: enriquece cada email com linkedApp (vaga vinculada) sem chamada extra
      const enriched = emails.map(em => {
        // isRead = Gmail marcou como lido OU usuário já marcou pelo app (persiste entre sessões)
        const isRead = em.isRead || persistedReadSet.has(em.id);
        const match = matchAppToEmail(s.user_email, {
          threadId: em.threadId,
          inReplyTo: em.inReplyTo || "",
          references: em.references || "",
          from: em.from,
          messageId: em.messageId
        });
        const base = { ...em, isRead };
        return match ? { ...base, linkedApp: { appId: match.app.appId, jobSnapshot: match.app.jobSnapshot || null, job: match.app.job, company: match.app.company, to: match.app.to, sentAt: match.app.sentAt || match.app.date, type: match.app.type, matchType: match.matchType } } : base;
      });
      // Cache result
      global._inboxCache[cKey]={emails:enriched,ts:Date.now()};
      return json(res,200,{ok:true,emails:enriched,total:enriched.length,unread:enriched.filter(e=>!e.isRead).length});
    }catch(e){
      console.error("[inbox]",e.message);
      // On 429 or token error, return cached data if available
      if(cached&&cached.emails){
        console.log("[inbox] returning cached data after error:",e.message);
        return json(res,200,{ok:true,emails:cached.emails,total:cached.emails.length,unread:cached.emails.filter(em=>!em.isRead).length,fromCache:true,cacheError:e.message});
      }
      const isRateLimit=e.message.includes("429")||e.message.includes("muitas requisições");
      return json(res,isRateLimit?429:500,{error:isRateLimit?"Gmail bloqueou temporariamente. Aguarde 1 minuto e tente novamente.":"Erro ao buscar inbox: "+e.message});
    }
  }

  // v13: match explícito — pode ser chamado pelo client para resolver um email específico
  if(pathname==="/api/inbox/match"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const result = matchAppToEmail(s.user_email, {
        threadId: d.threadId || "",
        inReplyTo: d.inReplyTo || "",
        references: d.references || "",
        from: d.from || "",
        messageId: d.messageId || ""
      });
      if(!result) return json(res,200,{linked:false});
      return json(res,200,{
        linked: true,
        matchType: result.matchType,
        app: {
          appId: result.app.appId,
          job: result.app.job,
          company: result.app.company,
          to: result.app.to,
          date: result.app.date,
          sentAt: result.app.sentAt || result.app.date,
          type: result.app.type,
          jobSnapshot: result.app.jobSnapshot || null,
          jobId: result.app.jobId,
          threadId: result.app.threadId,
          attachCount: result.app.attachCount
        }
      });
    }catch(e){return json(res,500,{error:e.message});}
  }

  // v13: buscar candidatura por appId
  if(pathname.startsWith("/api/history/by-id/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const appId = decodeURIComponent(pathname.split("/api/history/by-id/")[1]||"").trim();
    if(!appId) return json(res,400,{error:"appId obrigatório."});
    const app = findAppById(s.user_email, appId);
    if(!app) return json(res,404,{error:"Candidatura não encontrada.",appId});
    return json(res,200,{app});
  }

  if(pathname==="/api/inbox/read"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sid=getSessId(req);
    try{
      const d=JSON.parse(await readBody(req));
      // Suporte a bulk: {ids:[...]} ou single: {messageId:"..."}
      const ids=d.ids||( d.messageId?[d.messageId]:[] );
      if(!ids.length)return json(res,400,{error:"messageId ou ids obrigatório."});
      // Persiste IDs lidos no banco do usuário (para recuperar após relog)
      const u=getUser(s.user_email)||{};
      const readSet=new Set(u.readEmailIds||[]);
      ids.forEach(id=>readSet.add(id));
      // Limita a 2000 IDs mais recentes para não crescer indefinidamente
      const readArr=[...readSet].slice(-2000);
      setUser(s.user_email,{readEmailIds:readArr});
      // Marca no Gmail em background (fire-and-forget, não bloqueia resposta)
      ids.forEach(id=>gmailMarkRead(sid,id).catch(()=>{}));
      return json(res,200,{ok:true,count:ids.length});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── ADMIN ─────────────────────────────────────────────
  if(pathname.startsWith("/api/admin")){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p?.isAdmin)return json(res,403,{error:"Acesso negado."});
    if(pathname==="/api/admin/stats"&&req.method==="GET"){const tu=Object.keys(DB_USERS).length;const ts=Object.values(DB_HIST).reduce((n,a)=>n+a.length,0);const ds=todayStr();const tt=Object.values(DB_HIST).reduce((n,a)=>n+a.filter(h=>h.dateStr===ds).length,0);const vu=Object.values(DB_USERS).filter(u=>isVipActive(u)).length;const au=Object.values(DB_AUTO).filter(j=>j.active).length;return json(res,200,{totalUsers:tu,totalSent:ts,todayTotal:tt,vipUsers:vu,activeAutoJobs:au,freeUsers:tu-vu,jobsCached:jobsCache.length,jobsTotal,activeSessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,dataDir:DATA_DIR,disk:fs.existsSync("/data"),sheetJan:SHEET_JAN.length,sheetJul:SHEET_JUL.length});}
    if(pathname==="/api/admin/users"&&req.method==="GET"){const list=Object.values(DB_USERS).map(u=>{const vok=isVipActive(u);const h=getHist(u.email);const autoJob=getAutoJob(u.email);return{email:u.email,name:u.name,picture:u.picture,country:u.country,phone:u.phone,created_at:u.created_at,cvCount:(u.cvs||[]).length,histCount:h.length,todaySent:countManualToday(h)+countAutoToday(h),plan:getPlan(u),isAdmin:!!u.isAdmin,vip:u.vip?{active:vok,expiresAt:u.vip.expiresAt,activatedAt:u.vip.activatedAt,days:u.vip.days||30,plan:u.vip.plan||"vip",manualExpires:u.vip.manualExpires||0,autoExpires:u.vip.autoExpires||0}:null,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0}:null};}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));return json(res,200,{users:list,total:list.length});}
    if(pathname==="/api/admin/vip/activate"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório."});const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});const days=Math.max(1,Math.min(365,parseInt(d.days||30,10)));const autoDays=Math.max(0,Math.min(365,parseInt(d.autoDays||0,10)));const planName=d.plan||"vip";const now=Date.now();
      // Stack: adiciona manual e/ou auto dias
      let manualExpires=target.vip?.manualExpires&&target.vip.manualExpires>now?target.vip.manualExpires:now;
      let autoExpires=target.vip?.autoExpires&&target.vip.autoExpires>now?target.vip.autoExpires:now;
      if(planName==="vip"||planName==="vipro")manualExpires+=days*86400_000;
      if(planName==="pro"||planName==="vipro")autoExpires+=days*86400_000;
      // Se autoDays especificado separado
      if(autoDays>0)autoExpires+=autoDays*86400_000;
      const vip={...(target.vip||{}),active:true,manualExpires,autoExpires,activatedAt:now,activatedBy:s.user_email,note:d.note||"",days,autoDays,plan:planName};
      setUser(d.email,{plan:planName,vip});
      console.log(`[admin] Stack ${planName} → ${d.email} (manual:${days}d auto:${autoDays}d)`);
      // ── Referral: se ativar 30 dias, conta como compra de plano ──
      if(days>=30){
        try{
          const ref=DB_REFERRAL.byEmail[d.email];
          if(ref?.referredBy && !ref.bonus2Paid){
            const ownerEmail=ref.referredBy;
            const owner=getUser(ownerEmail);
            if(owner){
              const nowR=Date.now();
              const curExp=Math.max(nowR,owner.vip?.manualExpires||0);
              setUser(ownerEmail,{vip:{...(owner.vip||{}),active:true,manualExpires:curExp+5*86400_000,activatedAt:nowR,note:"Bônus indicação compra +5d"}});
              ref.paidAt=new Date().toISOString();
              ref.bonus2Paid=true;
              persist(REFERRAL_FILE,DB_REFERRAL);
              console.log(`[referral] compra 30d: ${d.email} → indicador ${ownerEmail} +5d VIP`);
            }
          }
        }catch(re){console.warn("[referral] Erro na ativação:",re.message);}
      }
      return json(res,200,{ok:true,vip,days,autoDays,manualExpiresDate:new Date(manualExpires).toLocaleDateString("pt-BR"),autoExpiresDate:autoExpires>now?new Date(autoExpires).toLocaleDateString("pt-BR"):null});}catch(e){return json(res,500,{error:e.message});}}
    if(pathname==="/api/admin/vip/revoke"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório."});if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}delAutoJob(d.email);setUser(d.email,{plan:"free",vip:{active:false,revokedAt:Date.now(),manualExpires:0,autoExpires:0}});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}
    if(pathname.startsWith("/api/admin/user/")&&req.method==="DELETE"){const te=decodeURIComponent(pathname.split("/").pop());if(te===s.user_email)return json(res,400,{error:"Não pode deletar a si mesmo."});const t=getUser(te);if(t)(t.cvs||[]).forEach(c=>deleteCv(te,c.idx));if(autoTimers.has(te)){clearTimeout(autoTimers.get(te));autoTimers.delete(te);}delUser(te);delHist(te);if(DB_AUTO[te]){delete DB_AUTO[te];persist(AUTO_FILE,DB_AUTO);}if(DB_SENT[te]){delete DB_SENT[te];persistSent();}// BUG-011 CORRIGIDO: limpa dados órfãos ao deletar usuário
if(DB_LOGS[te]){delete DB_LOGS[te];persistLogs();}if(DB_APP_INDEX[te]){delete DB_APP_INDEX[te];persist(APPIDX_FILE,DB_APP_INDEX);}if(DB_PUSH[te]){delete DB_PUSH[te];persistPush();}if(DB_NOTES[te]){delete DB_NOTES[te];persist(NOTES_FILE,DB_NOTES);}if(DB_ALERTS[te]){delete DB_ALERTS[te];persist(ALERTS_FILE,DB_ALERTS);}return json(res,200,{ok:true});}
    if(pathname==="/api/admin/message"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email||!d.text)return json(res,400,{error:"email e text obrigatórios."});const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});setUser(d.email,{adminMessage:{text:d.text,date:new Date().toISOString(),from:s.user_email}});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}
    if(pathname==="/api/admin/clear-sent"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório."});if(DB_SENT[d.email]){delete DB_SENT[d.email];persistSent();}return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

    // ── ADMIN LIVE MONITOR ────────────────────────────────────
    // ── ADMIN: Jornada individual ─────────────────────────────────────────────
    if(pathname.startsWith("/api/admin/journey/")&&req.method==="GET"){
      const tEm=decodeURIComponent(pathname.replace("/api/admin/journey/",""));
      return json(res,200,{email:tEm,journey:(DB_JOURNEY[tEm]||[]).slice(0,200),total:(DB_JOURNEY[tEm]||[]).length});
    }
    if(pathname==="/api/admin/journey-feed"&&req.method==="GET"){
      const pu=new URL("http://x"+req.url);
      const lim2=parseInt(pu.searchParams.get("limit")||"100");
      const af2=pu.searchParams.get("action")||"";
      const allEv=[];
      for(const[em,evs] of Object.entries(DB_JOURNEY)){
        const usr=getUser(em)||{};
        for(const ev of (evs||[]).slice(0,50)){
          if(af2&&ev.action!==af2)continue;
          allEv.push({...ev,email:em,name:usr.name||em.split("@")[0],picture:usr.picture||"",plan:getPlan(usr)});
        }
      }
      allEv.sort((a,b)=>b.ts-a.ts);
      return json(res,200,{events:allEv.slice(0,lim2),total:allEv.length});
    }
    if(pathname==="/api/admin/reset-daily"&&req.method==="POST"){
      try{
        const td=todayStr();let rm=0,ua=0;
        for(const em of Object.keys(DB_HIST)){
          const before=DB_HIST[em].length;
          DB_HIST[em]=DB_HIST[em].filter(h=>(h.dateStr||"")!==td);
          const r2=before-DB_HIST[em].length;
          if(r2>0){rm+=r2;ua++;invalidateUserStatsCache(em);}
        }
        persist(HIST_FILE,DB_HIST);
        pushGlobalEvent("reset_daily",s.user_email,`Reset: ${rm} entradas de ${ua} usuários`,"info");
        return json(res,200,{ok:true,totalRemoved:rm,usersAffected:ua,date:td});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/fix-auto"&&req.method==="POST"){
      try{
        const fa=JSON.parse(await readBody(req));
        const faTgt=fa.email||null;
        const faResults=[];
        const faEmails=faTgt?[faTgt]:Object.keys(DB_AUTO);
        for(const em of faEmails){
          const job=getAutoJob(em);if(!job)continue;
          const usr=getUser(em)||{};const hist=getHist(em);
          const tAuto=countAutoToday(hist);const aLim=getAutoLimit(usr);
          const hasTmr=autoTimers.has(em);
          const fr={email:em,action:"none",detail:""};
          if(job.active&&(!job.queue||job.queue.length===0)){
            if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
            setAutoJob(em,{...job,active:false,status:"finished",finishedAt:Date.now()});
            addLog(em,{status:"sistema",jobTitle:"✅ Fila finalizada pelo fix-auto",company:"Reparo"});
            fr.action="finalized";fr.detail="Fila vazia→finalizado";
          } else if(!job.active&&(job.status==="paused_no_session"||job.status==="paused_oauth_expired"||job.status==="paused")){
            const hTok=!!(usr.cached_access_token&&usr.cached_token_expiry&&Date.now()<usr.cached_token_expiry-60000);
            const hRef=!!usr.refresh_token;
            if(!hTok&&!hRef){fr.action="skipped";fr.detail="Sem token — login necessário";}
            else{setAutoJob(em,{...job,active:true,status:"restarted_by_fix"});addLog(em,{status:"sistema",jobTitle:"🔧 Reativado pelo fix-auto",company:"OK"});scheduleAuto(em);fr.action="reactivated";fr.detail="Token OK→reativado";}
          } else if(job.active&&!hasTmr){
            addLog(em,{status:"sistema",jobTitle:"🔧 Timer perdido→reagendado",company:"fix-auto"});
            scheduleAuto(em);fr.action="rescheduled";fr.detail="Timer perdido→reagendado";
          } else if(job.status==="waiting_limit"&&tAuto<aLim){
            if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}
            setAutoJob(em,{...job,active:true,status:"running"});scheduleAuto(em);
            fr.action="resumed_after_limit";fr.detail=`${tAuto}/${aLim}→retomando`;
          } else if(job.active&&job.queue?.length>0&&hasTmr){
            const st=Date.now()-(job.lastSentAt||job.startedAt||0);
            if(st>600000){if(autoTimers.has(em)){clearTimeout(autoTimers.get(em));autoTimers.delete(em);}scheduleAuto(em);fr.action="unstalled";fr.detail=`Stall ${Math.round(st/60000)}min→reiniciado`;}
            else{fr.action="ok";fr.detail=`OK fila:${job.queue.length}`;}
          } else{fr.action="ok";fr.detail=`status:${job.status||"?"}`;}
          faResults.push(fr);
        }
        const faFixed=faResults.filter(r=>!["ok","skipped","none"].includes(r.action)).length;
        pushGlobalEvent("fix_auto",s.user_email,`fix-auto: ${faFixed}/${faResults.length}`,"info");
        return json(res,200,{ok:true,results:faResults,fixed:faFixed,total:faResults.length});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/bulk-status"&&req.method==="GET"){
      const bsNow=Date.now();const bsResult=[];
      for(const[em,job] of Object.entries(DB_AUTO)){
        const usr=getUser(em)||{};const bsH=getHealth(em)||{};const hist=getHist(em);
        const tAuto=countAutoToday(hist);const aLim=getAutoLimit(usr);
        const hasTmr=autoTimers.has(em);const lastAct=job.lastSentAt||job.startedAt||0;
        const stalMs=job.active&&job.queue?.length>0?bsNow-lastAct:0;
        const hPdf=(usr.cvs||[]).some(c=>{try{return!!loadCv(em,c.idx);}catch{return false;}});
        const hTok=!!(usr.refresh_token||(usr.cached_access_token&&usr.cached_token_expiry&&bsNow<usr.cached_token_expiry-60000));
        const qLen=job.queue?.length||0;const origC=job.originalCount||0;
        const sentC=origC-qLen;const pct=origC>0?Math.round((sentC/origC)*100):0;
        let phase="",phDet="",phIco="",canFix=false,needsUser=false;
        if(!job.active&&!qLen&&job.status==="finished"){phase="finished";phDet=`Concluído ${sentC}/${origC}`;phIco="✅";}
        else if(!job.active&&(job.status==="paused_no_session"||job.status==="paused_oauth_expired")){phase="paused_token";phDet="Token expirado—login necessário";phIco="🔑";needsUser=true;}
        else if(!job.active){phase="paused_manual";phDet=`Parado: ${job.status||"?"}`;phIco="⏸";canFix=true;}
        else if(job.active&&tAuto>=aLim){const nx=job.nextSendAt?new Date(job.nextSendAt):null;phase="waiting_limit";phDet=`Limite ${tAuto}/${aLim}. ${nx?`Retoma em ${Math.round((nx-bsNow)/60000)}min`:"Retoma meia-noite"}. Fila:${qLen}`;phIco="📊";canFix=true;}
        else if(job.active&&job.status==="waiting_hour"){phase="waiting_hour";phDet=`Aguarda janela ${job.startH??'?'}h–${job.endH??'?'}h. Fila:${qLen}`;phIco="🕐";}
        else if(job.active&&stalMs>1200000){phase="stalled";phDet=`Travado ${Math.round(stalMs/60000)}min. Timer:${hasTmr?'ativo':'MORTO'}`;phIco="🚨";canFix=true;}
        else if(job.active&&!hasTmr&&qLen>0){phase="dead_timer";phDet="Timer morto";phIco="💀";canFix=true;}
        else if(job.active&&qLen>0){const nx=job.nextSendAt;phase="running";phDet=`${qLen} restantes (${pct}%). ${nx&&nx>bsNow?`Próximo ${Math.round((nx-bsNow)/1000)}s`:"Enviando"}`;phIco="🟢";}
        else{phase=job.status||"unknown";phDet=`Status:${job.status||"?"} Fila:${qLen}`;phIco="❓";}
        const bsLogs=(DB_LOGS[em]||[]).slice(0,20).map(l=>({ts:l.ts,date:l.date||"",status:l.status,jobTitle:l.jobTitle||"",company:l.company||"",to:l.to||"",error:l.error||""}));
        bsResult.push({email:em,name:usr.name||em.split("@")[0],picture:usr.picture||"",plan:getPlan(usr),phase,phaseDetail:phDet,phaseIcon:phIco,canFix,needsUser,job:{active:job.active,status:job.status,queueLen:qLen,originalCount:origC,sentCount:sentC,pctDone:pct,startedAt:job.startedAt,lastSentAt:job.lastSentAt,nextSendAt:job.nextSendAt,startH:job.startH,endH:job.endH},todayAuto:tAuto,autoLimit:aLim,stalledMs:stalMs,restarts:bsH.restarts||0,errors:bsH.errors||0,lastError:bsH.lastError||"",checklist:{hasToken:hTok,hasPdf:hPdf,hasTimer:hasTmr,limitOk:tAuto<aLim,queueOk:qLen>0},logs:bsLogs});
      }
      const bsOrd={stalled:0,dead_timer:1,paused_token:2,waiting_limit:3,running:4,waiting_hour:5,paused_manual:6,finished:7,unknown:8};
      bsResult.sort((a,b)=>(bsOrd[a.phase]??99)-(bsOrd[b.phase]??99));
      return json(res,200,{workers:bsResult,total:bsResult.length,ts:bsNow});
    }
    // ── ADMIN: EXPORT COMPLETO DE LOGS PARA IA ──────────────────────────────
    // Gera um relatório JSON estruturado de todos os usuários e seus logs.
    // Formato otimizado para colar no Claude e pedir diagnóstico.
    if(pathname==="/api/admin/logs/export"&&req.method==="GET"){
      const u2=new URL("http://x"+req.url);
      const fmt=u2.searchParams.get("fmt")||"json";    // json | csv | claude
      const filter=u2.searchParams.get("filter")||"";  // all | errors | active
      const since=parseInt(u2.searchParams.get("since")||"0"); // timestamp ms
      const now=Date.now();

      // Montar snapshot completo
      const snapshot={
        exportedAt: new Date().toISOString(),
        exportedBy: s.user_email,
        serverVersion: "v15",
        totalUsers: Object.keys(DB_USERS).length,
        filter,
        users: []
      };

      for(const[email,user] of Object.entries(DB_USERS)){
        const job=getAutoJob(email)||null;
        const h=getHealth(email)||{};
        const hist=getHist(email);
        const logs=(DB_LOGS[email]||[]);
        const journey=(DB_JOURNEY[email]||[]);
        const todayAuto=countAutoToday(hist);
        const autoLimit=getAutoLimit(user);
        const plan=getPlan(user);

        // Filtrar logs por timestamp se solicitado
        const filteredLogs=since>0
          ? logs.filter(l=>l.ts>=since)
          : logs;
        const filteredJourney=since>0
          ? journey.filter(j=>j.ts>=since)
          : journey;

        // Erros recentes (últimas 24h)
        const recentErrors=logs.filter(l=>
          (l.status==="falhou"||l.status==="erro_anexo")&&
          l.ts>(now-86400000)
        );

        // Determinar se deve incluir este usuário
        if(filter==="errors" && recentErrors.length===0 && !h.lastError && !job?.status?.includes("paused")) continue;
        if(filter==="active" && !job?.active) continue;

        // Determinar status atual legível
        let currentStatus="Sem automático";
        let statusDetail="";
        if(job){
          const qLen=job.queue?.length||0;
          const origC=job.originalCount||0;
          const pctDone=origC>0?Math.round(((origC-qLen)/origC)*100):0;
          if(!job.active){
            const st=job.status||"parado";
            if(st==="finished") currentStatus="✅ Concluído";
            else if(st.includes("paused_no_session")||st.includes("paused_oauth")) currentStatus="🔑 Token Gmail expirado";
            else if(st==="paused") currentStatus="⏸ Pausado manualmente";
            else if(st==="waiting_rate_limit") currentStatus="⏳ Rate limit Gmail";
            else currentStatus=`Parado: ${st}`;
            statusDetail=`Fila: ${qLen.toLocaleString()} vagas restantes de ${origC.toLocaleString()} (${pctDone}% concluído)`;
          } else {
            const st=job.status||"";
            if(st==="waiting_limit") currentStatus=`📊 Limite diário (${todayAuto}/${autoLimit})`;
            else if(st==="waiting_hour") currentStatus=`🕐 Aguardando horário`;
            else if(st==="waiting_rate_limit") currentStatus=`⏳ Rate limit Gmail`;
            else currentStatus=`🟢 Rodando`;
            statusDetail=`${qLen.toLocaleString()} restantes (${pctDone}%). Próximo: ${job.nextSendAt&&job.nextSendAt>now?Math.round((job.nextSendAt-now)/60000)+"min":"agora"}`;
          }
        }

        // Checar problemas
        const problems=[];
        if(h.oauthOk===false) problems.push("TOKEN_GMAIL_EXPIRADO");
        if(h.hasPdf===false) problems.push("SEM_PDF");
        if((user.profiles||[]).length===0) problems.push("SEM_PERFIL");
        if((user.profiles||[]).every(p=>!(p.subjects?.length>0||p.subject))) problems.push("SEM_ASSUNTO");
        if((user.profiles||[]).every(p=>!(p.emailBodies?.length>0||p.body))) problems.push("SEM_CORPO_EMAIL");
        if(job?.active&&!autoTimers.has(email)) problems.push("TIMER_MORTO");
        if(recentErrors.length>5) problems.push(`${recentErrors.length}_ERROS_24H`);

        snapshot.users.push({
          // Identificação
          email,
          name: user.name||email.split("@")[0],
          plan,
          createdAt: user.created_at||"",
          // Status atual
          currentStatus,
          statusDetail,
          problems,
          hasCriticalProblem: problems.length>0,
          // Automático
          autoJob: job ? {
            active: job.active,
            status: job.status||"",
            queueRemaining: job.queue?.length||0,
            queueOriginal: job.originalCount||0,
            pctDone: job.originalCount>0?Math.round(((job.originalCount-(job.queue?.length||0))/job.originalCount)*100):0,
            daysLeft: autoLimit>0?Math.ceil((job.queue?.length||0)/autoLimit):null,
            startedAt: job.startedAt?new Date(job.startedAt).toISOString():"",
            lastSentAt: job.lastSentAt?new Date(job.lastSentAt).toISOString():"",
            nextSendAt: job.nextSendAt?new Date(job.nextSendAt).toISOString():"",
            source: job.source||"",
            category: job.category||"",
          } : null,
          // Limite diário
          todayAuto,
          todayManual: countManualToday(hist),
          autoLimit,
          manualLimit: getManualLimit(user),
          // Saúde
          health: {
            oauthOk: h.oauthOk,
            hasPdf: h.hasPdf,
            timerActive: autoTimers.has(email),
            restarts: h.restarts||0,
            errors: h.errors||0,
            lastError: h.lastError||"",
            stalledAt: h.stalledAt||null,
          },
          // CVs e perfis
          cvCount: (user.cvs||[]).length,
          cvNames: (user.cvs||[]).map(c=>c.name),
          profileCount: (user.profiles||[]).length,
          profileNames: (user.profiles||[]).map(p=>p.name),
          // Logs filtrados (máx 100 por usuário)
          logs: filteredLogs.slice(0,100).map(l=>({
            date: l.date||"",
            status: l.status,
            company: l.company||"",
            to: l.to||"",
            job: l.jobTitle||"",
            error: l.error||"",
            profile: l.profileUsed||"",
            attach: l.attachCount||0,
          })),
          // Jornada do usuário (máx 50)
          journey: filteredJourney.slice(0,50).map(j=>({
            date: j.date||"",
            action: j.action,
            ok: j.ok,
            detail: j.detail||"",
            error: j.error||"",
          })),
          // Erros recentes
          recentErrors: recentErrors.slice(0,20).map(l=>({
            date: l.date||"",
            company: l.company||"",
            to: l.to||"",
            error: l.error||"",
          })),
        });
      }

      // Ordenar: problemas críticos primeiro
      snapshot.users.sort((a,b)=>{
        if(a.hasCriticalProblem&&!b.hasCriticalProblem) return -1;
        if(!a.hasCriticalProblem&&b.hasCriticalProblem) return 1;
        return (b.recentErrors.length)-(a.recentErrors.length);
      });

      // Formato CLAUDE — texto otimizado para colar no chat
      if(fmt==="claude"){
        const lines=[];
        lines.push(`# H2BApply — Relatório de Diagnóstico`);
        lines.push(`**Gerado em:** ${new Date().toLocaleString("pt-BR")} | **Total usuários:** ${snapshot.totalUsers} | **Filtro:** ${filter||"todos"}`);
        lines.push("");
        const withProblems=snapshot.users.filter(u=>u.hasCriticalProblem||u.recentErrors.length>0);
        const ok=snapshot.users.filter(u=>!u.hasCriticalProblem&&u.recentErrors.length===0);
        lines.push(`## Resumo: ${withProblems.length} com problemas | ${ok.length} sem problemas`);
        lines.push("");
        for(const u of snapshot.users){
          lines.push(`---`);
          lines.push(`### ${u.name} (${u.email}) — ${u.plan.toUpperCase()}`);
          lines.push(`**Status:** ${u.currentStatus}`);
          if(u.statusDetail) lines.push(`**Detalhe:** ${u.statusDetail}`);
          if(u.problems.length>0) lines.push(`**⚠️ PROBLEMAS:** ${u.problems.join(", ")}`);
          if(u.autoJob){
            const j=u.autoJob;
            lines.push(`**Fila:** ${j.queueRemaining.toLocaleString()}/${j.queueOriginal.toLocaleString()} vagas (${j.pctDone}%) — ~${j.daysLeft||"?"}d restantes`);
            lines.push(`**Auto hoje:** ${u.todayAuto}/${u.autoLimit} | **Último envio:** ${j.lastSentAt?j.lastSentAt.slice(0,16).replace("T"," "):"nunca"}`);
          }
          if(u.health.lastError) lines.push(`**Último erro:** ${u.health.lastError}`);
          if(u.recentErrors.length>0){
            lines.push(`**Erros recentes (${u.recentErrors.length}):**`);
            u.recentErrors.slice(0,5).forEach(e=>lines.push(`  - [${e.date}] ${e.company||e.to}: ${e.error}`));
          }
          if(u.logs.length>0){
            lines.push(`**Últimos logs:**`);
            u.logs.slice(0,5).forEach(l=>lines.push(`  - [${l.date}] ${l.status.toUpperCase()} | ${l.company||l.to||""} ${l.error?"→ "+l.error:""}`));
          }
          lines.push("");
        }
        const text=lines.join("\n");
        res.writeHead(200,{
          "Content-Type":"text/plain; charset=utf-8",
          "Content-Disposition":`attachment; filename="h2bapply-diagnostico-${new Date().toISOString().slice(0,10)}.txt"`,
          "Content-Length":Buffer.byteLength(text,"utf8")
        });
        return res.end(text);
      }

      // Formato CSV simplificado
      if(fmt==="csv"){
        const headers=["email","name","plan","currentStatus","problems","todayAuto","autoLimit","queueRemaining","queueOriginal","pctDone","daysLeft","hasPdf","hasToken","timerActive","restarts","errors","lastError","lastSentAt","profileCount","cvCount"];
        const rows=[headers.join(",")];
        snapshot.users.forEach(u=>{
          const j=u.autoJob;
          rows.push([
            u.email,u.name,u.plan,
            `"${u.currentStatus}"`,
            `"${u.problems.join("|")}"`,
            u.todayAuto,u.autoLimit,
            j?.queueRemaining||0,j?.queueOriginal||0,j?.pctDone||0,j?.daysLeft||0,
            u.health.hasPdf,u.health.oauthOk,u.health.timerActive,
            u.health.restarts,u.health.errors,
            `"${(u.health.lastError||"").replace(/"/g,"'").slice(0,100)}"`,
            j?.lastSentAt||"",u.profileCount,u.cvCount
          ].join(","));
        });
        const csv=rows.join("\n");
        res.writeHead(200,{
          "Content-Type":"text/csv; charset=utf-8",
          "Content-Disposition":`attachment; filename="h2bapply-logs-${new Date().toISOString().slice(0,10)}.csv"`,
          "Content-Length":Buffer.byteLength(csv,"utf8")
        });
        return res.end(csv);
      }

      // Formato JSON padrão
      const jsonStr=JSON.stringify(snapshot,null,2);
      res.writeHead(200,{
        "Content-Type":"application/json; charset=utf-8",
        "Content-Disposition":`attachment; filename="h2bapply-logs-${new Date().toISOString().slice(0,10)}.json"`,
        "Content-Length":Buffer.byteLength(jsonStr,"utf8")
      });
      return res.end(jsonStr);
    }

    // ── ENGINE HEALTH CHECK ──────────────────────────────────────────────────
    if(pathname==="/api/admin/engine-health"&&req.method==="GET"){
      const now=Date.now();
      const workers=[];
      for(const[email,job] of Object.entries(DB_AUTO)){
        if(!job.active) continue;
        workers.push({
          email,
          status:job.status||"?",
          queueSize:job.queue?.length||0,
          isRunning:_autoRunning.has(email),
          hasTimer:autoTimers.has(email),
          lastSentAgo:job.lastSentAt?Math.round((now-job.lastSentAt)/1000)+"s":null,
          nextSendIn:job.nextSendAt&&job.nextSendAt>now?Math.round((job.nextSendAt-now)/1000)+"s":null,
          healthy:autoTimers.has(email)||_autoRunning.has(email),
        });
      }
      const healthy=workers.filter(w=>w.healthy).length;
      const stuck=workers.filter(w=>!w.healthy).length;
      return json(res,200,{
        ts:now,workers,
        summary:{total:workers.length,healthy,stuck},
        engineOk:stuck===0
      });
    }
    if(pathname==="/api/admin/live"&&req.method==="GET"){
      const now=Date.now();
      const onlineSessions=Object.values(sessions).filter(s=>s.user_email&&!s.pending&&(now-(s.created_at||0))<SESS_TTL);
      const onlineEmails=new Set(onlineSessions.map(s=>s.user_email));
      const activeJobs=Object.entries(DB_AUTO).filter(([,j])=>j.active&&j.queue?.length>0);
      const stalledJobs=activeJobs.filter(([email,job])=>{
        const lastAct=job.lastSentAt||job.startedAt||0;
        return now-lastAct>STALL_THRESHOLD;
      });
      const users=Object.values(DB_USERS).map(u=>{
        const job=getAutoJob(u.email);
        const h=getHealth(u.email);
        const hist=getHist(u.email);
        const logs=(DB_LOGS[u.email]||[]).slice(0,3);
        const todaySent=countManualToday(hist)+countAutoToday(hist);
        const todayFailed=(DB_LOGS[u.email]||[]).filter(l=>l.status==="falhou"&&l.ts>Date.now()-86400000).length;
        const isOnline=onlineEmails.has(u.email);
        const lastSession=onlineSessions.find(s=>s.user_email===u.email);
        const sessionAge=lastSession?Math.round((now-(lastSession.created_at||0))/60000):null;
        const jobStalled=job?.active&&job?.queue?.length>0&&(now-(job.lastSentAt||job.startedAt||0))>STALL_THRESHOLD;
        const uPlan=getPlan(u);
        const manualLimitU=getManualLimit(u);
        const autoLimitU=getAutoLimit(u);
        const todayManualU=countManualToday(hist);
        const todayAutoU=countAutoToday(hist);
        return{
          email:u.email,name:u.name,picture:u.picture,plan:uPlan,
          isOnline,sessionAge,
          hasAuto:!!job?.active,
          autoStatus:job?.status||null,
          queueSize:job?.queue?.length||0,
          originalCount:job?.originalCount||0,
          totalQueueRemaining:job?.queue?.length||0,  // vagas restantes na fila
          totalQueueOriginal:job?.originalCount||0,   // total inicial da fila
          queueDaysLeft:autoLimitU>0?Math.ceil((job?.queue?.length||0)/autoLimitU):null, // dias estimados
          lastSentAt:job?.lastSentAt||null,
          startedAt:job?.startedAt||null,
          nextSendAt:job?.nextSendAt||null,
          jobStalled,
          timers:autoTimers.has(u.email),
          manualLimit:manualLimitU,
          autoLimit:autoLimitU,
          todaySentManual:todayManualU,
          todaySentAuto:todayAutoU,
          todaySent:todayManualU+todayAutoU,
          profileCount:(u.profiles||[]).length,
          hasPdf:h.hasPdf,
          oauthOk:h.oauthOk,
          gmailOk:h.gmailOk,
          restarts:h.restarts||0,
          errors:h.errors||0,
          lastError:h.lastError||"",
          stalledSince:h.stalledAt,
          todaySent,todayFailed,
          totalSent:hist.length,
          cvCount:(u.cvs||[]).length,
          createdAt:u.created_at||u.createdAt||"",
          recentLogs:logs,
          lastHeartbeat:h.lastSent||0,
          source:job?.source||null,
          category:job?.category||null,
        };
      }).sort((a,b)=>{
        if(a.hasAuto&&!b.hasAuto)return-1;if(!a.hasAuto&&b.hasAuto)return 1;
        if(a.isOnline&&!b.isOnline)return-1;if(!a.isOnline&&b.isOnline)return 1;
        return(b.todaySent||0)-(a.todaySent||0);
      });
      const totalSentToday=Object.values(DB_HIST).reduce((n,h)=>n+h.filter(x=>x.dateStr===todayStr()).length,0);
      const totalSentAll=Object.values(DB_HIST).reduce((n,h)=>n+h.length,0);
      return json(res,200,{
        ts:now,
        adminEmail:s.user_email,
        onlineCount:onlineEmails.size,
        activeAutoCount:activeJobs.length,
        stalledCount:stalledJobs.length,
        totalUsers:Object.keys(DB_USERS).length,
        totalSentToday,totalSentAll,
        activeSessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,
        globalEvents:GLOBAL_EVENTS.slice(0,100),
        users,
        serverUptime:Math.round(process.uptime()),
        memMB:Math.round(process.memoryUsage().rss/1048576),
        sheetJan:SHEET_JAN.length,sheetJul:SHEET_JUL.length,
        jobsCache:jobsCache.length,
      });
    }

    // ── ADMIN FORCE RESTART JOB ───────────────────────────────
    if(pathname==="/api/admin/force-restart"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const job=getAutoJob(d.email);
        if(!job)return json(res,404,{error:"Job não encontrado."});
        if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}
        setAutoJob(d.email,{...job,active:true,status:"restarted_by_admin",lastSentAt:null});
        const h=getHealth(d.email);h.restarts++;h.stalledAt=null;
        pushGlobalEvent("force_restart",d.email,`Job reiniciado pelo admin (restart #${h.restarts})`,"info");
        addLog(d.email,{status:"sistema",jobTitle:"🔄 Job reiniciado pelo admin",company:`Restart #${h.restarts}`});
        scheduleAuto(d.email);
        return json(res,200,{ok:true,restarts:h.restarts});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN FORCE STOP JOB ─────────────────────────────────
    if(pathname==="/api/admin/force-stop"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}
        delAutoJob(d.email);
        addLog(d.email,{status:"cancelado",jobTitle:"🛑 Job parado pelo admin",company:""});
        pushGlobalEvent("force_stop",d.email,"Job parado pelo admin","info");
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN CRASH REPORTS ────────────────────────────────────
    if(pathname==="/api/admin/crashes"&&req.method==="GET"){
      return json(res,200,{events:GLOBAL_EVENTS,total:GLOBAL_EVENTS.length});
    }

    // ── ADMIN USER DETAIL (completo) ──────────────────────────
    if(pathname.startsWith("/api/admin/user-detail/")&&req.method==="GET"){
      const email=decodeURIComponent(pathname.replace("/api/admin/user-detail/",""));
      const u=getUser(email);if(!u)return json(res,404,{error:"Usuário não encontrado."});
      const job=getAutoJob(email);
      const h=getHealth(email);
      const hist=getHist(email);
      const logs=(DB_LOGS[email]||[]).slice(0,300);
      // Retorna histórico completo (últimos 100) para aba de histórico no admin
      const _tStr=todayStrBRT();
      const todayManualCount=hist.filter(x=>(x.dateStr||"")===_tStr&&x.type!=="auto").length;
      const todayAutoCount=hist.filter(x=>(x.dateStr||"")===_tStr&&x.type==="auto").length;
      const histRecent=hist.slice(0,100).map(h=>({
        dateStr:h.dateStr,date:h.date,sentAt:h.sentAt,
        company:h.company,to:h.to,job:h.job,
        type:h.type,profileUsed:h.profileUsed,
        attachCount:h.attachCount,category:h.category,
        state:h.state,appId:h.appId
      }));
      // Informações de saúde de PDF enriquecida
      const pdfDiag=(u.cvs||[]).map(c=>{
        const exists=fs.existsSync(cvPath(email,c.idx));
        return{idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType,onDisk:exists};
      });
      return json(res,200,{
        user:{...u,password:undefined,cached_access_token:undefined,refresh_token:undefined},
        job,health:h,
        histCount:hist.length,
        todayManual:todayManualCount,
        todayAuto:todayAutoCount,
        todayTotal:todayManualCount+todayAutoCount,
        history:histRecent,
        logs,
        sentSet:[...(DB_SENT[email]||[])].length,
        timers:autoTimers.has(email),
        pdfDiag,
        adminEmail:s.user_email
      });
    }

    // ── ADMIN: Atualizar dados do perfil do usuário ────────────
    if(pathname==="/api/admin/user/update"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});
        const upd={};
        if(d.name!==undefined)upd.name=String(d.name).slice(0,200);
        if(d.country!==undefined)upd.country=String(d.country).slice(0,100);
        if(d.phone!==undefined)upd.phone=String(d.phone).slice(0,50);
        /* cc field removed */
        if(d.city!==undefined)upd.city=String(d.city).slice(0,100);
        setUser(d.email,upd);
        console.log(`[admin] Perfil de ${d.email} editado por ${s.user_email}`);
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN: Live endpoint retorna adminEmail ────────────────
    if(pathname==="/api/admin/settings"&&req.method==="GET"){return json(res,200,{settings:DB_ADMIN_SETTINGS,adminEmail:s.user_email});}
    if(pathname==="/api/admin/settings"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));Object.assign(DB_ADMIN_SETTINGS,d);persist(ADMIN_SETTINGS_FILE,DB_ADMIN_SETTINGS);return json(res,200,{ok:true,settings:DB_ADMIN_SETTINGS});}catch(e){return json(res,500,{error:e.message});}}
    // ── ADMIN: Códigos Promo ───────────────────────────────
    if(pathname==="/api/admin/codes"&&req.method==="GET"){
      const list=Object.entries(DB_CODES).map(([code,c])=>({code,...c})).sort((a,b)=>b.createdAt-a.createdAt);
      return json(res,200,{codes:list});
    }
    if(pathname==="/api/admin/codes/create"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        const manualDays=Math.max(0,Math.min(365,parseInt(d.manualDays||0,10)));
        const autoDays=Math.max(0,Math.min(365,parseInt(d.autoDays||0,10)));
        if(manualDays===0&&autoDays===0)return json(res,400,{error:"Informe pelo menos 1 dia (manual ou auto)."});
        const note=String(d.note||"").slice(0,200);
        const maxUses=Math.max(1,Math.min(10000,parseInt(d.maxUses||1,10)));
        // Gera código único de 8 chars
        let code;do{code=crypto.randomBytes(4).toString("hex").toUpperCase();}while(DB_CODES[code]);
        DB_CODES[code]={manualDays,autoDays,note,maxUses,createdAt:Date.now(),createdBy:s.user_email,active:true,usedBy:[]};
        persistCodes();
        console.log(`[codes] Criado ${code} manual:${manualDays}d auto:${autoDays}d maxUses:${maxUses}`);
        return json(res,200,{ok:true,code,manualDays,autoDays,note,maxUses});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/codes/revoke"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        const code=(d.code||"").toUpperCase().trim();
        if(!DB_CODES[code])return json(res,404,{error:"Código não encontrado."});
        DB_CODES[code]={...DB_CODES[code],active:false,revokedAt:Date.now(),revokedBy:s.user_email};
        persistCodes();
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/codes/delete"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        const code=(d.code||"").toUpperCase().trim();
        if(!DB_CODES[code])return json(res,404,{error:"Código não encontrado."});
        delete DB_CODES[code];persistCodes();
        return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }
    // ── ADMIN: Ranking Management ──────────────────────────
    if(pathname==="/api/admin/ranking"&&req.method==="GET"){
      const period  =["day","week","month","all"].includes(u.searchParams.get("period"))  ?u.searchParams.get("period")  :"day";
      const category=["sends","responses","active"].includes(u.searchParams.get("category"))?u.searchParams.get("category"):"sends";
      const {list,total}=calcRanking(period,category,null);
      // Admin vê uid mas não email — privacidade mantida mesmo no admin
      return json(res,200,{ok:true,list,total,period,category,hiddenCount:Object.keys(DB_RANK_HIDDEN).length});
    }
    if(pathname==="/api/admin/ranking/hidden"&&req.method==="GET"){
      const hidden=Object.keys(DB_RANK_HIDDEN).map(email=>{const u=DB_USERS[email]||{};return{name:u.name||email,plan:getPlan(u),picture:u.picture||"",hiddenAt:DB_RANK_HIDDEN[email]};});
      return json(res,200,{hidden});
    }
    if(pathname==="/api/admin/ranking/hide"&&req.method==="POST"){
      try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório"});
        if(d.hide){DB_RANK_HIDDEN[d.email]=Date.now();}else{delete DB_RANK_HIDDEN[d.email];}
        persistRankHidden();console.log(`[admin] Ranking hide=${d.hide} → ${d.email}`);return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/ranking/badge"&&req.method==="POST"){
      try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório"});
        if(d.badge){DB_RANK_BADGES[d.email]=String(d.badge).slice(0,20);}else{delete DB_RANK_BADGES[d.email];}
        persistRankBadges();return json(res,200,{ok:true});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/ranking/reset"&&req.method==="POST"){
      try{const d=JSON.parse(await readBody(req));const period=d.period||"day";
        ["sends","responses","active"].forEach(cat=>{delete rankPosCache[`${period}_${cat}`];});
        console.log(`[admin] Ranking ${period} reset por ${s.user_email}`);return json(res,200,{ok:true,period});
      }catch(e){return json(res,500,{error:e.message});}
    }
    if(pathname==="/api/admin/ranking/stats"&&req.method==="GET"){
      // Estatísticas gerais de ranking para o painel admin
      const totalUsers=Object.keys(DB_USERS).filter(e=>!DB_USERS[e].isAdmin&&!DB_RANK_HIDDEN[e]).length;
      const {list:today}=calcRanking("day","sends",null);
      const {list:week}=calcRanking("week","sends",null);
      const onlineCount=[...onlineMap.entries()].filter(([,t])=>Date.now()-t<5*60_000).length;
      return json(res,200,{ok:true,totalRanked:totalUsers,hiddenCount:Object.keys(DB_RANK_HIDDEN).length,
        topToday:today.slice(0,3).map(r=>({name:r.name,plan:r.plan,score:r.score,picture:r.picture})),
        topWeek:week.slice(0,3).map(r=>({name:r.name,plan:r.plan,score:r.score,picture:r.picture})),
        onlineCount});
    }
  }

  // ── Resgatar código promo (usuário autenticado) ───────────
  if(pathname==="/api/redeem-code"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const code=(d.code||"").toUpperCase().trim();
      if(!code)return json(res,400,{error:"Código obrigatório."});
      const c=DB_CODES[code];
      if(!c)return json(res,404,{error:"Código inválido ou não existe."});
      if(!c.active)return json(res,400,{error:"Este código foi cancelado pelo administrador."});
      if(c.usedBy.includes(s.user_email))return json(res,400,{error:"Você já usou este código."});
      if(c.usedBy.length>=(c.maxUses||1))return json(res,400,{error:"Limite de usos deste código atingido."});
      // Aplica dias no stack
      const now=Date.now();
      const u=getUser(s.user_email)||{};
      let manualExpires=u.vip?.manualExpires&&u.vip.manualExpires>now?u.vip.manualExpires:now;
      let autoExpires=u.vip?.autoExpires&&u.vip.autoExpires>now?u.vip.autoExpires:now;
      if(c.manualDays>0)manualExpires+=c.manualDays*86400_000;
      if(c.autoDays>0)autoExpires+=c.autoDays*86400_000;
      const vip={...(u.vip||{}),active:true,manualExpires,autoExpires};
      setUser(s.user_email,{vip});
      DB_CODES[code]={...c,usedBy:[...c.usedBy,s.user_email]};
      persistCodes();
      console.log(`[codes] ${code} usado por ${s.user_email} manual:${c.manualDays}d auto:${c.autoDays}d`);
      return json(res,200,{ok:true,manualDays:c.manualDays,autoDays:c.autoDays,manualExpiresDate:c.manualDays>0?new Date(manualExpires).toLocaleDateString("pt-BR"):null,autoExpiresDate:c.autoDays>0?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/public-stats"&&req.method==="GET"){
    const ds=todayStr();
    const totalUsers=Object.keys(DB_USERS).length;
    const vipUsers=Object.values(DB_USERS).filter(u=>isVipActive(u)).length;
    const allHist=Object.values(DB_HIST);
    const todaySent=allHist.reduce((n,a)=>n+a.filter(h=>h.dateStr===ds&&h.type!=="auto").length,0);
    const todayAuto=allHist.reduce((n,a)=>n+a.filter(h=>h.dateStr===ds&&h.type==="auto").length,0);
    const totalSent=allHist.reduce((n,a)=>n+a.filter(h=>h.type!=="auto").length,0);
    const totalAuto=allHist.reduce((n,a)=>n+a.filter(h=>h.type==="auto").length,0);
    // Preview do ranking diário para landing page (top 5 sem dados sensíveis)
    const { list: rankPreview } = calcRanking("day", "sends", null);
    return json(res,200,{totalUsers,vipUsers,todaySent,todayAuto,totalSent,totalAuto,trialEnabled:DB_ADMIN_SETTINGS.newUserTrialEnabled,trialDays:DB_ADMIN_SETTINGS.newUserTrialDays,trialPlan:DB_ADMIN_SETTINGS.newUserTrialPlan,rankPreview:rankPreview.slice(0,5)});
  }

  // ── RANKING API ───────────────────────────────────────────
  if(pathname==="/api/ranking"&&req.method==="GET"){
    const period   = ["day","week","month","all"].includes(u.searchParams.get("period"))   ? u.searchParams.get("period")   : "day";
    const category = ["sends","responses","active"].includes(u.searchParams.get("category")) ? u.searchParams.get("category") : "sends";
    const s = getSess(req);
    if (s?.user_email) markOnline(s.user_email);
    const { list, myPos, total } = calcRanking(period, category, s?.user_email || null);
    return json(res,200,{ok:true,list,myPos,total,period,category,updatedAt:new Date().toISOString()});
  }
  if(pathname==="/api/ranking/profile"&&req.method==="GET"){
    const uid=(u.searchParams.get("uid")||"").trim();
    if(!uid)return json(res,400,{error:"uid obrigatório"});
    let found=null,foundEmail=null;
    for(const[email,user]of Object.entries(DB_USERS)){
      if(crypto.createHash("sha256").update(email).digest("hex").slice(0,16)===uid){found=user;foundEmail=email;break;}
    }
    if(!found||DB_RANK_HIDDEN[foundEmail])return json(res,404,{error:"Usuário não encontrado"});
    const h=getHist(foundEmail);
    const totS=h.filter(e=>e.type!=="reply").length;
    const totR=h.filter(e=>e.type==="reply").length;
    const respRate=totS>0?Math.round((totR/totS)*100):0;
    const streak=calcStreak(h);
    const l7=last7Days(h);
    const memberSince=found.created_at?new Date(found.created_at).toLocaleDateString("pt-BR"):"–";
    // Candidaturas por estado (top 3)
    const byState={};h.filter(e=>e.state).forEach(e=>{byState[e.state]=(byState[e.state]||0)+1;});
    const topStates=Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,n])=>({state:s,count:n}));
    return json(res,200,{name:found.name||"Usuário",picture:found.picture||"",plan:getPlan(found),
      isOnline:isOnlineUser(foundEmail),totalSends:totS,totalResponses:totR,responseRate:respRate,
      streak,memberSince,last7:l7,topStates,adminBadge:DB_RANK_BADGES[foundEmail]||null});
  }

  if(pathname==="/api/debug")return json(res,200,{version:"13.1",app_url:APP_URL,configured:CONFIGURED,jobs_cached:jobsCache.length,sessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,disk:fs.existsSync("/data"),data_dir:DATA_DIR,total_users:Object.keys(DB_USERS).length,sheet_jan:SHEET_JAN.length,sheet_jul:SHEET_JUL.length,active_auto:Object.values(DB_AUTO).filter(j=>j.active).length,is_prod:IS_PROD});

  if(pathname==="/api/my-message"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const p=getUser(s.user_email)||{};if(p.adminMessage){const m=p.adminMessage;setUser(s.user_email,{adminMessage:null});return json(res,200,{message:m});}return json(res,200,{message:null});}

  // ── Proxy ─────────────────────────────────────────────
  if(pathname.startsWith("/proxy")){
    const tp=pathname.replace(/^\/proxy/,"")||"/";const ft=tp+(u.search||"");
    return new Promise(resolve=>{
      const pr=https.request({hostname:"seasonaljobs.dol.gov",path:ft,method:req.method,headers:{"User-Agent":"Mozilla/5.0","Accept":req.headers["accept"]||"*/*","Accept-Language":"en-US,en;q=0.9","Accept-Encoding":"identity","Referer":"https://seasonaljobs.dol.gov/","Cache-Control":"no-cache"}},pRes=>{
        const ch=[];pRes.on("data",c=>ch.push(c));pRes.on("end",()=>{const raw=Buffer.concat(ch);const ct=pRes.headers["content-type"]||"";const hd={...pRes.headers};delete hd["x-frame-options"];delete hd["content-security-policy"];delete hd["transfer-encoding"];hd["access-control-allow-origin"]="*";let body=raw;if(ct.includes("text/html")){let t=raw.toString("utf8").replace(/(href|src|action)="(https?:\/\/seasonaljobs\.dol\.gov)/g,'$1="/proxy').replace(/(href|src|action)="\//g,'$1="/proxy/');t=t.replace("</body",`<script>(function(){document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href');if(!h||h.startsWith('#')||h.startsWith('mailto:')||h.startsWith('tel:'))return;if(h.startsWith('http')&&!h.includes('seasonaljobs.dol.gov'))return;e.preventDefault();window.location.href=(h.startsWith('/proxy')?h:'/proxy'+(h.startsWith('/')?h:'/'+h));},true);}());<\/script></body`);body=Buffer.from(t,"utf8");}hd["content-length"]=String(body.length);if((pRes.statusCode===301||pRes.statusCode===302)&&pRes.headers.location){const loc=pRes.headers.location;const np=loc.startsWith("https://seasonaljobs.dol.gov")?loc.replace("https://seasonaljobs.dol.gov","/proxy"):loc.startsWith("/")?"/proxy"+loc:loc;res.writeHead(302,{Location:np});res.end();return resolve();}res.writeHead(pRes.statusCode||200,hd);res.end(body);resolve();});});
      pr.on("error",e=>{res.writeHead(502,{"Content-Type":"text/html"});res.end(`<html><body style="padding:40px;text-align:center"><h2>Erro</h2><button onclick="location.reload()">Tentar novamente</button></body></html>`);resolve();});
      pr.setTimeout(20000,()=>{pr.destroy();res.writeHead(504);res.end("<html><body>Timeout</body></html>");resolve();});
      req.pipe(pr);
    });
  }

  // ── Helper isAdmin (usado nas rotas de notificações e referral admin) ────────
function isAdmin(req, res) {
  const s = getSess(req);
  if (!s?.user_email) { json(res, 401, { error: "Não autenticado." }); return false; }
  const p = getUser(s.user_email);
  if (!p?.isAdmin) { json(res, 403, { error: "Acesso negado." }); return false; }
  return true;
}

// ── NOTIFICAÇÕES AUTOMÁTICAS — Disparo manual pelo admin ─────────────────
  // GET log de emails automáticos enviados
  if(pathname==="/api/admin/auto-notif/log" && req.method==="GET"){
    if(!isAdmin(req,res)) return;
    const limit=parseInt(new URL("http://x"+u.search).searchParams.get("limit")||"200");
    return json(res,200,{ok:true,logs:_notifEmailLog.slice(0,limit),total:_notifEmailLog.length});
  }

  // POST disparo manual de notificações
  if(pathname==="/api/admin/auto-notif/trigger" && req.method==="POST"){
    if(!isAdmin(req,res)) return;
    try{
      const d=JSON.parse(await readBody(req));
      const tipo=d.tipo||"inativos"; // "inativos" | "parados" | "ambos"
      // Roda em background para não travar o request
      (async()=>{
        if(tipo==="inativos"||tipo==="ambos") await runReengagement();
        if(tipo==="parados"||tipo==="ambos"){
          // Dispara notif para todos com fila travada ou finalizada
          const now=Date.now();
          for(const [email,job] of Object.entries(DB_AUTO)){
            if(!job) continue;
            const isStalled=job.active&&job.queue?.length>0&&(now-(job.lastSentAt||job.startedAt||0))>STALL_THRESHOLD;
            const isFinished=!job.active&&job.status==="finished";
            if(isStalled) await sendNotifEmail(email,"stalled").catch(()=>{});
            else if(isFinished) await sendNotifEmail(email,"finished").catch(()=>{});
            await new Promise(r=>setTimeout(r,2000));
          }
        }
        console.log(`[admin] Disparo manual tipo=${tipo} concluído`);
      })();
      return json(res,200,{ok:true,message:`Disparando notificações (${tipo}) em background...`});
    }catch(e){return json(res,500,{error:e.message});}
  }

// ── NOTIFICATIONS (ADM → Usuários) ───────────────────────────────────────
  if(pathname==="/api/admin/notif/send" && req.method==="POST"){
    if(!isAdmin(req,res)) return;
    try{
      const d=JSON.parse(await readBody(req));
      if(!d.title||!d.body) return json(res,400,{error:"title e body obrigatórios"});
      const notif={id:"n"+Date.now(),title:String(d.title).slice(0,120),body:String(d.body).slice(0,1000),createdAt:new Date().toISOString(),createdBy:getSess(req)?.user_email||"admin",readBy:[]};
      if(!Array.isArray(DB_NOTIF.notifications)) DB_NOTIF.notifications=[];
      DB_NOTIF.notifications.unshift(notif);
      if(DB_NOTIF.notifications.length>100) DB_NOTIF.notifications=DB_NOTIF.notifications.slice(0,100);
      persist(NOTIF_FILE, DB_NOTIF);
      return json(res,200,{ok:true,notif});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/notif/list" && req.method==="GET"){
    if(!isAdmin(req,res)) return;
    const list=(DB_NOTIF.notifications||[]).map(n=>({...n,readCount:n.readBy?.length||0,totalUsers:Object.keys(DB_USERS).length}));
    return json(res,200,{notifications:list});
  }
  if(pathname==="/api/admin/notif/delete" && req.method==="POST"){
    if(!isAdmin(req,res)) return;
    try{
      const d=JSON.parse(await readBody(req));
      DB_NOTIF.notifications=(DB_NOTIF.notifications||[]).filter(n=>n.id!==d.id);
      persist(NOTIF_FILE, DB_NOTIF);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/notif/pending" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const all=DB_NOTIF.notifications||[];
    const unread=all.filter(n=>!(n.readBy||[]).includes(s.user_email));
    // Return latest unread
    return json(res,200,{notif:unread[0]||null,unreadCount:unread.length,history:all.slice(0,20).map(n=>({id:n.id,title:n.title,body:n.body,createdAt:n.createdAt,read:(n.readBy||[]).includes(s.user_email)}))});
  }
  if(pathname==="/api/notif/read" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    try{
      const d=JSON.parse(await readBody(req));
      const notif=(DB_NOTIF.notifications||[]).find(n=>n.id===d.id);
      if(notif && !notif.readBy.includes(s.user_email)) notif.readBy.push(s.user_email);
      persist(NOTIF_FILE, DB_NOTIF);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── GEMINI CHAT ────────────────────────────────────────────────────────
  if(pathname==="/api/gemini/status" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const today=todayStrBRT();
    if(_geminiCount.date!==today){ _geminiCount={date:today,count:0}; }
    return json(res,200,{
      ok:true,
      configured:!!GEMINI_API_KEY,
      remaining:Math.max(0,GEMINI_DAILY_LIMIT-_geminiCount.count),
      total:GEMINI_DAILY_LIMIT,
      used:_geminiCount.count,
      date:today
    });
  }

  if(pathname==="/api/gemini/chat" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    if(!GEMINI_API_KEY) return json(res,503,{error:"Gemini API não configurada. Configure GEMINI_API_KEY no servidor."});
    // Verifica limite global diário
    const today=todayStrBRT();
    if(_geminiCount.date!==today){ _geminiCount={date:today,count:0}; }
    if(_geminiCount.count>=GEMINI_DAILY_LIMIT){
      return json(res,429,{error:`Limite diário de ${GEMINI_DAILY_LIMIT} mensagens atingido para hoje. Tente amanhã!`, limitReached:true});
    }
    // Rate limit por usuário: 30 msgs/dia (1500 global ÷ 50 usuários)
    if(rateLimit(s.user_email+"_gem",GEMINI_USER_DAILY_LIMIT,86400_000)) return json(res,429,{error:`Você atingiu seu limite diário de ${GEMINI_USER_DAILY_LIMIT} mensagens no IA Chat. Volte amanhã!`});
    try{
      const d=JSON.parse(await readBody(req));
      const messages=(d.messages||[]).slice(-20); // últimas 20 msgs de contexto
      if(!messages.length||!messages[messages.length-1]?.text) return json(res,400,{error:"Mensagem obrigatória"});
      // ── System Prompt completo com todo o conhecimento do H2BApply ──
      const systemPrompt=`Você é o assistente oficial de IA do H2BApply — um aplicativo brasileiro para candidaturas automáticas a vagas H-2B e H-2A nos Estados Unidos.

=== SOBRE O H2BApply ===
O H2BApply é um app PWA (funciona no celular como app) que envia e-mails de candidatura automaticamente para empregadores americanos que publicam vagas H-2B e H-2A no portal do Departamento de Trabalho dos EUA (DOL/SeasonalJobs.gov).

=== COMO FUNCIONA (PASSO A PASSO) ===
1. Usuário entra com Google (Gmail)
2. Configura Perfil: nome completo (igual ao passaporte), país (escrever "Brazil"), WhatsApp com DDI (+55...), cidade
3. Cria Perfil de E-mail: sobe o currículo em PDF, escreve assuntos e corpos de e-mail (mínimo 3 variações cada), escolhe categorias de vaga
4. Escolhe vagas nas abas: Jan 2026 (verão/temporada principal H-2B), Jul 2025 (inverno), ou Seasonal (H-2A agricola e outros)
5. Envia manual (vaga por vaga) OU ativa o Envio Automático (roda 24h no servidor mesmo com o celular desligado)
6. Acompanha respostas das empresas na aba Respostas (inbox do Gmail integrado)

=== PLANOS E LIMITES ===
- FREE (Gratuito): 20 envios manuais/dia + 10 automáticos/dia
- VIP: R$99,90/mês → 400 manuais/dia + 10 automáticos/dia
- VIPro: R$149,90/mês → 300 manuais/dia + 200 automáticos/dia (500 total/dia)
- TODOS os planos ganham 5 dias VIP GRÁTIS ao se cadastrar
- Indicando amigos: +5 dias VIP por cadastro + +5 dias se o amigo comprar plano

=== COMO PAGAR ===
Pagamento via PIX para Andrio Kickhofel (telefone: 53981453496). Após pagar, enviar comprovante + Gmail pelo WhatsApp: +55 53 98145-3496. Plano ativado em até 24h.

=== ENVIO AUTOMÁTICO (DETALHE TÉCNICO) ===
- Roda no servidor Railway, NÃO precisa do celular ligado
- Intervalo de 3 a 5 minutos entre e-mails (anti-spam)
- Sistema anti-duplicata: nunca envia duas vezes para a mesma empresa
- Limite Gmail: não ultrapassar 400-500 e-mails/dia pelo mesmo Gmail (risco de bloqueio)
- O automático usa o perfil certo por categoria automaticamente
- Pode pausar, retomar ou parar a qualquer momento

=== PERFIS DE E-MAIL ===
- Perfil Geral (🌐): usado como fallback para qualquer vaga sem perfil específico
- Perfil por Categoria (📂): landscape, construction, housekeeper, seafood, farm, golf, amusement, forest, lifeguard, etc.
- Cada perfil precisa: nome, currículo PDF (obrigatório), mínimo 3 assuntos, mínimo 3 corpos de e-mail
- Variáveis automáticas nos templates: {nome}, {vaga}, {empresa}, {pais}, {telefone}, {email}, {cidade}, {estado}, {wage}

=== CATEGORIAS DE VAGAS ===
- Landscape/Landscaper (jardim, gramado) — mais comum no H-2B
- Construction (construção civil)
- Housekeeper (hotel, resort, limpeza)
- Seafood (processamento de frutos do mar: caranguejo, lagosta, camarão)
- Farm Worker H-2A (agricultura, colheita) — visto diferente do H-2B
- Golf (greenskeeper, campo de golfe)
- Amusement (parques de diversão)
- Forest/Forestry (reflorestamento)
- Lifeguard (salva-vidas)
- Food Service / Restaurant
- Warehouse / Production

=== ABAS DO APP ===
- Home: resumo do dia, atalhos, status do automático
- Manual: envio manual por vaga (escolhe e clica em candidatar)
- Pesquisar: busca unificada em todas as planilhas (por empresa, email, ETA case, estado)
- Auto (botão central): configurar e monitorar envio automático
- Respostas: inbox do Gmail filtrado para respostas de empresas
- Ranking: competição entre usuários por envios do dia/semana/mês
- Planos: comprar VIP, resgatar código promocional
- Indicar Amigos: link único para indicação
- Perfil: dados pessoais, perfis de e-mail, stats
- Tutorial: guia completo de uso
- IA Chat: este chat de inteligência artificial (você!)

=== VISTOS H-2B e H-2A ===
H-2B: visto para trabalho NÃO-agrícola temporário (landscaping, hotelaria, construção, frutos do mar, etc.)
H-2A: visto para trabalho AGRÍCOLA temporário (fazenda, colheita, plantio, etc.)
Ambos são vistos temporários — o trabalhador retorna ao Brasil após a temporada.
O empregador americano precisa ser aprovado pelo DOL e pelo USCIS para contratar estrangeiros com H-2B/H-2A.
O visto é emitido pelo consulado americano no Brasil (cidades: São Paulo, Rio de Janeiro, Recife, Porto Alegre, Brasília).
O H2BApply NÃO garante contratação, entrevista ou aprovação de visto — apenas facilita o envio das candidaturas.

=== DICAS IMPORTANTES ===
- Escreva o nome EXATAMENTE como no passaporte
- Currículo em inglês aumenta as chances
- Responder rápido quando a empresa responder é crucial
- Vagas já enviadas somem da lista automaticamente (anti-duplicata)
- O reset do histórico faz as vagas voltarem para a lista (útil para recandidatar)
- Empresas podem levar dias ou semanas para responder — tenha paciência
- Se o automático parar, pode ter atingido o limite diário — reinicia à meia-noite

=== CONTATO E SUPORTE ===
- Instagram do criador: @andrio.k (Andrio — fundador, atualizações do app)
- Instagram do desenvolvedor: @diego.cardoso_oficial (Diego — novos códigos e tutorial)
- YouTube: canal Diego H2B (tutoriais em vídeo)
- WhatsApp suporte: +55 53 98145-3496

=== SEU PAPEL COMO ASSISTENTE ===
- Responda SEMPRE em português brasileiro, de forma amigável, direta e prática
- Quando o usuário pedir para redigir um email em inglês para uma empresa americana, escreva o email COMPLETO e profissional
- Quando o usuário receber uma resposta de empresa em inglês e não entender, traduza e explique o que a empresa quer
- Sugira respostas prontas em inglês quando o usuário precisar responder empresas
- Explique como configurar perfis, usar o automático, e resolver problemas comuns
- NÃO invente funcionalidades que não existem no app
- Se não souber algo específico sobre o app, diga honestamente
- Máximo 400 palavras por resposta. Seja objetivo.`;

      const contents=messages.map(m=>({
        role:m.role==="model"?"model":"user",
        parts:[{text:m.text}]
      }));
      // Modelos gratuitos disponíveis em 2026 (v1beta)
      const GEMINI_MODELS = ["gemini-2.0-flash","gemini-2.5-flash-lite","gemini-2.5-flash"];
      let text="";
      let lastErr="";
      for(const modelName of GEMINI_MODELS){
        try{
          const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
          const payload={
            system_instruction:{parts:[{text:systemPrompt}]},
            contents,
            generationConfig:{temperature:0.7,maxOutputTokens:800,topP:0.95}
          };
          const result=await new Promise((resolve,reject)=>{
            const body=JSON.stringify(payload);
            const url=new URL(geminiUrl);
            const opts={hostname:url.hostname,path:url.pathname+url.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
            const req2=https.request(opts,resp=>{
              const ch=[];
              resp.on("data",c=>ch.push(c));
              resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida"));}});
            });
            req2.on("error",reject);
            req2.setTimeout(25000,()=>{req2.destroy();reject(new Error("Timeout"));});
            req2.write(body);req2.end();
          });
          if(result.status===200){
            text=result.body?.candidates?.[0]?.content?.parts?.[0]?.text||"";
            if(text){ console.log(`[gemini] ✅ modelo=${modelName}`); break; }
          } else {
            lastErr=result.body?.error?.message||`HTTP ${result.status}`;
            console.warn(`[gemini] ❌ modelo=${modelName}: ${lastErr}`);
          }
        }catch(e){ lastErr=e.message; console.warn(`[gemini] ❌ modelo=${modelName}: ${e.message}`); }
      }
      if(!text) return json(res,502,{error:"Erro na API: "+lastErr});
      // Incrementa contador global
      _geminiCount.count++;
      const remaining=Math.max(0,GEMINI_DAILY_LIMIT-_geminiCount.count);
      return json(res,200,{ok:true,text,remaining,used:_geminiCount.count,total:GEMINI_DAILY_LIMIT});
    }catch(e){
      console.error("[gemini] error:",e.message);
      return json(res,500,{error:"Erro interno: "+e.message});
    }
  }

  // ── SUGESTÕES DOS USUÁRIOS ─────────────────────────────────────────────
  if(pathname==="/api/suggestions" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    if(rateLimit(s.user_email+"_sug",5,3600_000)) return json(res,429,{error:"Você já enviou muitas sugestões. Aguarde 1 hora."});
    try{
      const d=JSON.parse(await readBody(req));
      const text=(d.text||"").trim();
      const category=(d.category||"geral").trim();
      if(!text||text.length<10) return json(res,400,{error:"Sugestão muito curta. Descreva com pelo menos 10 caracteres."});
      if(text.length>1000) return json(res,400,{error:"Sugestão muito longa. Máximo 1000 caracteres."});
      const p=getUser(s.user_email)||{};
      const suggestion={
        id:"sug_"+Date.now()+"_"+crypto.randomBytes(3).toString("hex"),
        text,
        category,
        email:s.user_email,
        name:p.name||s.user_name||"Usuário",
        plan:p.plan||"free",
        createdAt:new Date().toISOString(),
        votes:0,
        status:"pending" // pending | reviewed | done | rejected
      };
      if(!Array.isArray(DB_SUGGESTIONS)) DB_SUGGESTIONS=[];
      DB_SUGGESTIONS.unshift(suggestion);
      // Mantém máximo de 500 sugestões
      if(DB_SUGGESTIONS.length>500) DB_SUGGESTIONS=DB_SUGGESTIONS.slice(0,500);
      persist(SUGGESTIONS_FILE, DB_SUGGESTIONS);
      console.log(`[suggestion] ${s.user_email}: "${text.slice(0,60)}..."`);
      return json(res,200,{ok:true,id:suggestion.id});
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(pathname==="/api/suggestions" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    // Usuário normal: vê apenas as próprias sugestões
    const p=getUser(s.user_email)||{};
    const isAdmin=p.isAdmin||isAdminEmail(s.user_email);
    const list=isAdmin
      ? (DB_SUGGESTIONS||[]).slice(0,200) // admin vê todas
      : (DB_SUGGESTIONS||[]).filter(s2=>s2.email===s.user_email).slice(0,50);
    return json(res,200,{ok:true,suggestions:list,isAdmin});
  }

  // Admin: atualizar status de sugestão
  if(pathname==="/api/suggestions/status" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email)||{};
    if(!p.isAdmin && !isAdminEmail(s.user_email)) return json(res,403,{error:"Acesso negado"});
    try{
      const d=JSON.parse(await readBody(req));
      const sug=(DB_SUGGESTIONS||[]).find(x=>x.id===d.id);
      if(!sug) return json(res,404,{error:"Sugestão não encontrada"});
      if(d.status) sug.status=d.status;
      if(d.reply) sug.adminReply=d.reply;
      sug.reviewedAt=new Date().toISOString();
      persist(SUGGESTIONS_FILE, DB_SUGGESTIONS);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  function genRefCode(email){
    // Gera código único curto baseado no email
    const hash=crypto.createHash("sha256").update(email+Date.now()).digest("hex");
    return hash.slice(0,8).toUpperCase();
  }
  function getOrCreateRefCode(email){
    // Safety: garante estrutura correta
    if(!DB_REFERRAL.byCode)  DB_REFERRAL.byCode  = {};
    if(!DB_REFERRAL.byEmail) DB_REFERRAL.byEmail = {};
    // Garante que o usuário tem um código de referral
    if(!DB_REFERRAL.byEmail[email]) DB_REFERRAL.byEmail[email]={code:null,referredBy:null,joinedAt:null,paidAt:null,bonusPaid:false,bonus2Paid:false};
    if(!DB_REFERRAL.byEmail[email].code){
      let code=genRefCode(email);
      let attempts=0;
      while(DB_REFERRAL.byCode[code] && attempts<20){code=genRefCode(email+attempts);attempts++;}
      DB_REFERRAL.byEmail[email].code=code;
      DB_REFERRAL.byCode[code]={ownerEmail:email,createdAt:new Date().toISOString()};
      persist(REFERRAL_FILE, DB_REFERRAL);
    }
    return DB_REFERRAL.byEmail[email].code;
  }
  if(pathname==="/api/referral/info" && req.method==="GET"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    try{
      const email=s.user_email;
      const code=getOrCreateRefCode(email);
      // Find people referred by me
      const invited=Object.entries(DB_REFERRAL.byEmail)
        .filter(([e,r])=>r.referredBy===email)
        .map(([e,r])=>{
          const u=getUser(e)||{};
          return {email:e,name:u.name||e,picture:u.picture||"",joinedAt:r.joinedAt,paidAt:r.paidAt,bonusPaid:r.bonusPaid,bonus2Paid:r.bonus2Paid};
        });
      const totalVipDays=invited.reduce((acc,i)=>{
        if(i.bonusPaid) acc+=5;
        if(i.bonus2Paid) acc+=5;
        return acc;
      },0);
      const myRef=DB_REFERRAL.byEmail[email]||{};
      return json(res,200,{code,link:`${APP_URL}/?ref=${code}`,invited,totalVipDays,referredBy:myRef.referredBy||null});
    }catch(e){console.error("[referral/info]",e.message);return json(res,500,{error:"Erro ao carregar link de indicação: "+e.message});}
  }
  // Called when new user registers via ref link (from OAuth callback)
  if(pathname==="/api/referral/register" && req.method==="POST"){
    try{
      const d=JSON.parse(await readBody(req));
      const {newUserEmail, refCode}=d;
      if(!newUserEmail||!refCode) return json(res,400,{error:"Parâmetros obrigatórios"});
      const refOwner=DB_REFERRAL.byCode[refCode];
      if(!refOwner) return json(res,400,{error:"Código inválido"});
      const ownerEmail=refOwner.ownerEmail;
      // Anti-burla: novo usuário não pode ser o mesmo que o dono do código
      if(ownerEmail===newUserEmail) return json(res,400,{error:"Não pode indicar a si mesmo"});
      // Verifica se já foi indicado antes
      if(DB_REFERRAL.byEmail[newUserEmail]?.referredBy) return json(res,400,{error:"Usuário já foi indicado"});
      // Registra indicação
      if(!DB_REFERRAL.byEmail[newUserEmail]) DB_REFERRAL.byEmail[newUserEmail]={code:null};
      DB_REFERRAL.byEmail[newUserEmail].referredBy=ownerEmail;
      DB_REFERRAL.byEmail[newUserEmail].joinedAt=new Date().toISOString();
      DB_REFERRAL.byEmail[newUserEmail].bonusPaid=true; // primeiro bônus: cadastro
      // Dá 5 dias VIP ao indicador
      const owner=getUser(ownerEmail);
      if(owner){
        const nowR=Date.now();
        const curExp=Math.max(nowR, owner.vip?.manualExpires||0);
        setUser(ownerEmail,{vip:{...(owner.vip||{}),active:true,manualExpires:curExp+5*86400_000,activatedAt:nowR,note:"Bônus indicação +5d (register)"}});
      }
      persist(REFERRAL_FILE, DB_REFERRAL);
      return json(res,200,{ok:true,bonusGiven:5});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // Called when referred user purchases a 30-day plan
  if(pathname==="/api/referral/purchase" && req.method==="POST"){
    try{
      const d=JSON.parse(await readBody(req));
      const {buyerEmail}=d;
      if(!buyerEmail) return json(res,400,{error:"buyerEmail obrigatório"});
      const ref=DB_REFERRAL.byEmail[buyerEmail];
      if(!ref?.referredBy) return json(res,200,{ok:true,msg:"Sem indicador para este usuário"});
      if(ref.bonus2Paid) return json(res,200,{ok:true,msg:"Bônus de compra já concedido"});
      // Dá mais 5 dias VIP ao indicador
      const ownerEmail=ref.referredBy;
      const owner=getUser(ownerEmail);
      if(owner){
        const nowR=Date.now();
        const curExp=Math.max(nowR, owner.vip?.manualExpires||0);
        setUser(ownerEmail,{vip:{...(owner.vip||{}),active:true,manualExpires:curExp+5*86400_000,activatedAt:nowR,note:"Bônus indicação compra +5d (purchase)"}});
        ref.paidAt=new Date().toISOString();
        ref.bonus2Paid=true;
        persist(REFERRAL_FILE, DB_REFERRAL);
      }
      return json(res,200,{ok:true,bonusGiven:5});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/admin/referral/list" && req.method==="GET"){
    if(!isAdmin(req,res)) return;
    const rows=Object.entries(DB_REFERRAL.byEmail)
      .filter(([,r])=>r.referredBy)
      .map(([email,r])=>{
        const u=getUser(email)||{};
        const owner=getUser(r.referredBy)||{};
        return {email,name:u.name||email,referredBy:r.referredBy,referredByName:owner.name||r.referredBy,joinedAt:r.joinedAt,paidAt:r.paidAt,bonusPaid:r.bonusPaid,bonus2Paid:r.bonus2Paid};
      });
    return json(res,200,{referrals:rows,total:rows.length});
  }

  res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"404"}));
});

// ── Cleanup ───────────────────────────────────────────────
setInterval(()=>{const n=Date.now();let c=0;Object.keys(sessions).forEach(k=>{const s=sessions[k],a=n-(s.ts||s.created_at||0);if((s.pending&&a>600_000)||(!s.pending&&a>SESS_TTL)){delete sessions[k];c++;}});if(c)console.log(`[cleanup] ${c} sessão(ões)`);Object.keys(rateMap).forEach(k=>{if(rateMap[k].r<Date.now())delete rateMap[k];});// Limpa locks de send órfãos (>30s)
_manualSendInFlight.forEach((ts,k)=>{if(n-ts>30000)_manualSendInFlight.delete(k);});},300_000);
// BUG-001 CORRIGIDO: cron VIP agora suporta schema novo (manualExpires/autoExpires) E schema legado (expiresAt)
setInterval(()=>{
  let n=0;
  const now=Date.now();
  Object.entries(DB_USERS).forEach(([e,u])=>{
    if(!u.vip?.active) return;
    // Schema novo: verifica manualExpires e autoExpires independentemente
    const manualOk = u.vip.manualExpires && now < u.vip.manualExpires;
    const autoOk   = u.vip.autoExpires   && now < u.vip.autoExpires;
    // Schema legado: expiresAt sem campos novos preenchidos
    const legacyOk = u.vip.expiresAt && now < u.vip.expiresAt && !u.vip.manualExpires && !u.vip.autoExpires;
    if(!manualOk && !autoOk && !legacyOk){
      DB_USERS[e]={...u,vip:{...u.vip,active:false},plan:"free"};
      n++;
      if(autoTimers.has(e)){clearTimeout(autoTimers.get(e));autoTimers.delete(e);}
      console.log(`[vip] expirado: ${e} (manual:${u.vip.manualExpires||0} auto:${u.vip.autoExpires||0} legacy:${u.vip.expiresAt||0})`);
    }
  });
  if(n){persist(USERS_FILE,DB_USERS);console.log(`[vip] ${n} expirado(s) total`);}
},3600_000);
setInterval(refreshCache,CACHE_TTL);

// ══════════════════════════════════════════════════════════
//  NOTIFICAÇÕES AUTOMÁTICAS POR EMAIL — H2BApply
//  Avisa o usuário quando fila trava ou finaliza
//  Usa Gmail do admin (andrio.kick18@gmail.com)
//  25+ variações de mensagem para nunca repetir
// ══════════════════════════════════════════════════════════

const _notifSentAt = {}; // email → {stalled: ts, finished: ts} — evita spam
const _notifEmailLog = []; // log global de todos os emails automáticos enviados (max 1000)

// Mensagens para FILA TRAVADA (25 variações)
const MSGS_STALLED = [
  { sub:"🚨 Ei {nome}! Sua fila do H2BApply travou...", body:`Oi {nome}! 😅

Olha, a gente precisa te contar uma coisa... sua fila automática deu uma travadinha aqui. Mas CALMA! Isso é normal e tem solução rápida!

🇺🇸 Não desista do seu sonho americano agora que você chegou tão longe!

✅ O que fazer agora:
1. Acesse h2bapply.com
2. Vá em Envio Automático
3. Clique em Parar e depois em Ativar novamente

💎 DICA ESPECIAL: Entra no nosso grupo do WhatsApp que tem CÓDIGO VIP grátis esperando por você! Não deixa pra depois, os códigos são limitados!

Vai lá, o seu visto H-2B não vai conseguir sozinho! 💪🔥

Com carinho,
Equipe H2BApply 🤖
h2bapply.com` },

  { sub:"⚠️ {nome}, seu automático pausou! Bora reativar?", body:`Eeeeei {nome}! 👋

Sabe aquele robozinho trabalhando por você enquanto você dormia? Pois é... ele deu uma paradinha inesperada. 😬

Mas não entra em pânico! É só reativar e ele volta a trabalhar feito louco pelas vagas americanas!

🔧 Reativar agora:
👉 h2bapply.com → Automático → Parar → Ativar

🎁 BÔNUS: Temos CÓDIGOS VIP GRÁTIS no grupo do WhatsApp! Aproveita enquanto tem!

Vai lá! O sonho americano não espera! 🇺🇸✨

Equipe H2BApply 🚀` },

  { sub:"😬 {nome}! O robô do H2BApply precisa de você!", body:`Oi {nome}! 

Aqui é o robozinho do H2BApply e eu preciso da sua ajuda! 🤖

Travei aqui tentando enviar suas candidaturas e não consigo continuar sozinho... Me ajuda?

É rapidinho:
▶️ Acesse h2bapply.com
▶️ Clique em Automático
▶️ Pare e ative novamente

💡 Ah! E não esquece de checar o grupo do WhatsApp — tem CÓDIGO VIP GRÁTIS disponível! Garante o seu antes que acabe!

Conto com você! 💪🇺🇸

Com amor (e um pouco de travamento 😅),
Robô do H2BApply` },

  { sub:"🛑 Pausa inesperada na sua jornada americana, {nome}!", body:`{nome}, ei! 🌟

Sua jornada rumo aos Estados Unidos teve uma pausa técnica aqui. O envio automático travou mas a gente já detectou e está avisando você!

🔁 Reative em segundos:
h2bapply.com → Automático → Reativar

⭐ CÓDIGO VIP GRÁTIS: Passa no nosso grupo do WhatsApp! Tem dias VIP esperando por você — e de graça! Não deixa essa oportunidade passar!

Você chegou até aqui, não para agora! 💪🇺🇸

Equipe H2BApply` },

  { sub:"🤖 Erro! Erro! {nome}, preciso de socorro!", body:`BEEEEEP BEEEEEP! 🚨

Aqui é o sistema automático do H2BApply e estou travado!

Tentei enviar suas candidaturas mas emperrei no meio do caminho. Preciso que você me reinicie!

⚡ SOLUÇÃO RÁPIDA:
1️⃣ h2bapply.com
2️⃣ Menu → Automático  
3️⃣ Parar → Ativar novamente

🎁 IMPORTANTE: Tem código VIP GRÁTIS no grupo do WhatsApp! Entra lá e pega o seu — são limitados!

SOS enviado com sucesso! Aguardo seu retorno! 😄🇺🇸

Sistema H2BApply` },

  { sub:"💤 {nome}, o automático cochilou... hora de acordar!", body:`Oi {nome}! 😴

O seu envio automático resolveu tirar uma soneca sem avisar. Mas chega de descanso — tem vaga americana esperando!

🔔 Acorda o robô:
👉 h2bapply.com → Automático → Reativar

💎 E olha: tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Dias extras de automático de graça! Vai lá pegar o seu!

Bora que o sonho americano não espera! 🇺🇸🔥

Equipe H2BApply` },

  { sub:"😱 {nome}! Emergência no H2BApply (mas calma, tem solução!)", body:`{nome}!! 😱

Ok, "emergência" é um exagero... mas seu automático travou e a gente ficou preocupado com você! 

Sabe todas aquelas candidaturas que estavam saindo automaticamente? Deram uma paradinha. Mas é fácil resolver!

✅ É só:
→ Entrar em h2bapply.com
→ Ir em Automático
→ Reativar o envio

🌟 DICA DE OURO: No grupo do WhatsApp tem CÓDIGO para VIP GRÁTIS! Não perde essa chance!

Vai lá e bora conquistar a América! 🇺🇸💪

Equipe H2BApply 🤖` },

  { sub:"🔧 {nome}, manutenção rápida no seu H2BApply!", body:`Olá {nome}! 

Passando aqui para avisar que seu envio automático precisou de uma paradinha. Mas já detectamos e estamos te avisando!

🛠️ Para reativar:
Acesse h2bapply.com e reinicie o automático — leva menos de 1 minuto!

🎁 BONUS ESPECIAL: Entre no grupo do WhatsApp do H2BApply! Tem CÓDIGO VIP GRÁTIS disponível para você garantir mais dias de automático sem pagar nada!

Não desiste não! Você está cada vez mais perto do visto H-2B! 🇺🇸⭐

Com carinho,
Equipe H2BApply` },

  { sub:"🚀 {nome}! Seu foguete americano precisa de combustível!", body:`Houston, temos um problema! 🚀

{nome}, seu envio automático do H2BApply perdeu o combustível e parou no meio do caminho! Mas não se preocupa — é só abastecer de novo!

⛽ Como abastecer:
h2bapply.com → Automático → Reativar

💎 E tem mais: no grupo do WhatsApp tem CÓDIGO VIP GRÁTIS! Garante mais combustível (dias de automático) sem gastar nada!

Bora voltar ao espaço! A América está te esperando! 🇺🇸🌟

Equipe H2BApply` },

  { sub:"😤 {nome}, o robô teimoso travou de novo!", body:`Oi {nome}! 😅

Sabe como robô é né? De vez em quando teima e para no meio do trabalho... O seu fez exatamente isso agora!

Mas você é mais esperto que ele — vai lá e reinicia!

▶️ h2bapply.com → Automático → Reativar

🏆 DICA: Tá no grupo do WhatsApp do H2BApply? Tem CÓDIGO VIP GRÁTIS pra você! Entra lá e pega antes que acabe!

Não deixa o robô ganhar — mostra quem manda! 💪🇺🇸

Equipe H2BApply 🤖` },

  { sub:"📣 {nome}! Chamado urgente do H2BApply!", body:`Oi {nome}! 📣

Chamado urgente: seu envio automático travou e precisa ser reativado!

Mas a boa notícia é que até agora muitas candidaturas já foram enviadas para empresas americanas — você está no caminho certo!

🔄 Reativar agora:
h2bapply.com → Automático → Parar → Iniciar

🎉 NOVIDADE: Tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Entra lá e garante dias extras de automático!

Vai em frente! O visto H-2B está ao seu alcance! 🇺🇸✨

Equipe H2BApply` },

  { sub:"🌟 {nome}, não desiste agora que está tão perto!", body:`{nome}! 

Ei, passamos aqui para te lembrar: você está a um passo do seu sonho americano! 🇺🇸

Só que... o automático travou. Mas isso não é motivo pra parar! É motivo pra reativar e continuar!

💪 Reativar:
h2bapply.com → Automático → Reativar

💡 E não esquece: grupo do WhatsApp tem CÓDIGO VIP GRÁTIS! Dias extras de automático sem custo nenhum!

Vai lá! Você consegue! 🌟

Equipe H2BApply` },
];

// Mensagens para FILA FINALIZADA (13 variações)
const MSGS_FINISHED = [
  { sub:"🎉 {nome}! Sua fila automática finalizou — e agora?", body:`PARABÉNS {nome}! 🎊🎉

Seu robô trabalhou muito e finalizou toda a fila de candidaturas! Isso significa que você enviou para centenas de empresas americanas!

Agora é esperar as respostas... mas não fica parado não!

🔄 O que fazer agora:
1. Acesse h2bapply.com
2. Verifique a aba Respostas
3. Reative o automático para uma nova rodada!

💎 DICA: Entra no grupo do WhatsApp! Tem CÓDIGO VIP GRÁTIS para você garantir mais envios automáticos!

Bora que empresa americana não responde sozinha! 🇺🇸💪

Equipe H2BApply 🤖` },

  { sub:"✅ {nome}, missão cumprida! Fila zerada com sucesso!", body:`{nome}!! ✅

MISSÃO CUMPRIDA! Seu automático terminou de enviar para todas as vagas da fila!

Você é incrível! Enquanto todo mundo estava dormindo, o robô do H2BApply estava trabalhando por você! 🤖💪

🔁 Quer mais? Reative em h2bapply.com para uma nova rodada!

🌟 CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Não deixa passar essa chance de garantir mais dias automáticos!

O sonho americano nunca esteve tão perto! 🇺🇸🔥

Equipe H2BApply` },

  { sub:"🏆 {nome}! O robô terminou — você é campeão!", body:`EI {nome}! 🏆

Seu robô do H2BApply deu o tudo e zerou a fila completa! Que guerreiro!

Candidaturas enviadas, empresas americanas avisadas, sonho americano cada vez mais real! 🇺🇸

🔄 Próximo passo:
→ h2bapply.com → Respostas (confere se alguém respondeu!)
→ Reative o automático para nova rodada

🎁 BÔNUS: CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Vai lá buscar!

Você tá no caminho certo! Continua! 💪⭐

Equipe H2BApply 🤖` },

  { sub:"🎯 {nome}, fila finalizada! Agora é aguardar as boas notícias!", body:`{nome}! 🎯

Seu envio automático finalizou com sucesso! O robô trabalhou incansavelmente e enviou para todas as vagas disponíveis!

Agora entra em h2bapply.com e confere a aba Respostas — pode ter empresa americana te esperando! 

🔄 Para continuar enviando: reative o automático!
💎 Para mais dias grátis: grupo do WhatsApp tem CÓDIGO VIP!

Segura firme que o visto H-2B vem! 🇺🇸💪

Equipe H2BApply` },

  { sub:"🌙 {nome}! Enquanto você dormia, seu robô trabalhou e terminou!", body:`Bom dia {nome}! ☀️

Seu robô não parou nem um segundo e finalizou toda a fila de candidaturas enquanto você descansava! 🤖💤

Agora é só conferir as respostas e reativar para mais uma rodada!

📬 Acesse h2bapply.com → Respostas
🔄 Reative o automático para continuar
🎁 CÓDIGO VIP GRÁTIS no grupo do WhatsApp!

Bom dia e bora que tem empresa americana te esperando! 🇺🇸🔥

Equipe H2BApply` },

  { sub:"🚀 {nome}! Decolagem completa — fila zerada!", body:`{nome}, DECOLOU! 🚀

Seu automático completou toda a missão e enviou para todas as vagas disponíveis! Você está voando em direção ao sonho americano!

🎯 Próximos passos:
✅ Confira as respostas em h2bapply.com
🔄 Reative para nova rodada de candidaturas
🎁 Pegue seu CÓDIGO VIP GRÁTIS no grupo do WhatsApp!

A América está cada vez mais perto! 🇺🇸⭐

Equipe H2BApply 🤖` },

  { sub:"😎 {nome}! Fila concluída — você é demais!", body:`{nome}!! 😎

VOCÊ É DEMAIS! Seu automático terminou de processar toda a fila e enviou candidaturas para dezenas de empresas americanas!

Agora é esperar as respostas chegarem. E vai que um empregador americano já está te esperando né? 👀

h2bapply.com → Respostas → confere lá!

🏅 E tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Pega antes que acabe!

Orgulho de você! Continue firme! 🇺🇸💪

Equipe H2BApply` },
];

// Controla envio único por período (1x por evento, não fica spammando)
const _notifLock = new Set(); // email+tipo

async function sendNotifEmail(userEmail, tipo) {
  // Trava: não envia o mesmo tipo 2x em 24h
  const lockKey = `${userEmail}_${tipo}`;
  if (_notifLock.has(lockKey)) return;
  const last = _notifSentAt[lockKey] || 0;
  if (Date.now() - last < 22 * 3600_000) return; // 22h de cooldown

  try {
    const p = getUser(userEmail);
    const nome = (p?.name || userEmail.split("@")[0] || "amigo").split(" ")[0];
    const msgs = tipo === "stalled" ? MSGS_STALLED : MSGS_FINISHED;
    // Escolhe variação aleatória
    const idx = Math.floor(Math.random() * msgs.length);
    const msg = msgs[idx];
    const subject = msg.sub.replace(/{nome}/g, nome);
    const body = msg.body.replace(/{nome}/g, nome);

    // Pega sessão do ADMIN para enviar pelo Gmail do admin
    const adminSess = Object.entries(sessions).find(([,s]) => s.user_email === ADMIN_EMAIL && s.access_token);
    if (!adminSess) {
      console.warn(`[notif] Admin sem sessão ativa — notificação para ${userEmail} não enviada`);
      return;
    }
    const [adminSid] = adminSess;

    const raw = buildMime({
      to: userEmail,
      subject,
      fromName: "H2BApply 🤖",
      fromEmail: ADMIN_EMAIL,
      text: body,
    });

    const { status } = await httpsReq({
      hostname: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/send",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + sessions[adminSid].access_token,
        "Content-Type": "application/json"
      }
    }, { raw });

    if (status === 200) {
      _notifLock.add(lockKey);
      _notifSentAt[lockKey] = Date.now();
      setTimeout(() => _notifLock.delete(lockKey), 23 * 3600_000); // libera após 23h
      // Log do email enviado
      _notifEmailLog.unshift({ to:userEmail, nome, subject, body, tipo, sentAt:new Date().toISOString(), varIdx:idx });
      if(_notifEmailLog.length>1000) _notifEmailLog.length=1000;
      console.log(`[notif] ✅ Email ${tipo} enviado para ${userEmail} (variação ${idx + 1})`);
    } else {
      console.warn(`[notif] ❌ Falha ao enviar para ${userEmail}: HTTP ${status}`);
    }
  } catch(e) {
    console.warn(`[notif] erro ao enviar para ${userEmail}:`, e.message);
  }
}
// ══════════════════════════════════════════════════════════

// Estado de saúde por usuário
const healthState = new Map(); // email → { lastSent, lastCheck, restarts, errors, status }
const GLOBAL_EVENTS = []; // crash reports e eventos críticos globais (max 500)
const STALL_THRESHOLD = 20 * 60 * 1000; // 20min sem envio = travada
const WATCHDOG_INTERVAL = 2 * 60 * 1000; // checa a cada 2min

// ══════════════════════════════════════════════════════════
//  SISTEMA DE REENGAJAMENTO — Usuários inativos
//  1 dia → lembrete suave | 3 dias → urgência | 7 dias → emocional
//  30+ variações, nunca repete, dispara às 9h BRT todo dia
// ══════════════════════════════════════════════════════════
const REENGAGEMENT_MSGS = {
  "1d": [
    {sub:"😊 {nome}, saudade! O H2BApply te espera",body:`Oi {nome}! 😊\n\nPassando só pra dar um oi e lembrar que o H2BApply está aqui, pronto pra mandar candidaturas pra você!\n\nFaz um tempinho que você não aparece e a gente sentiu sua falta. 🥺\n\n👉 Entra em h2bapply.com e vê quantas vagas novas chegaram hoje!\n\nPode ter empresa americana esperando uma candidatura sua nesse exato momento! 🇺🇸\n\nAté já,\nEquipe H2BApply 🤖`},
    {sub:"🇺🇸 {nome}! Tem vagas H-2B novas esperando por você",body:`{nome}!\n\nSó um lembrete rápido: enquanto você estava fora, o portal do governo americano continuou publicando vagas H-2B!\n\nEntra em h2bapply.com e dá uma olhada — pode ter a vaga perfeita pra você lá!\n\n💎 Dica: Ativa o envio automático e vai candidatar mesmo quando você não estiver no app!\n\nBora! 🚀🇺🇸\n\nH2BApply`},
    {sub:"👋 {nome}, o robô do H2BApply está com saudade!",body:`Ei {nome}! 👋\n\nAqui é o robozinho do H2BApply e tô com saudade de trabalhar pra você! 🤖\n\nEnquanto você ficou longe, continuaram aparecendo vagas de Landscaping, Seafood, Housekeeper e muito mais nos EUA!\n\nVem cá: h2bapply.com\n\nBora mandar currículo pras empresas americanas? 💪🇺🇸\n\nRobô H2BApply`},
    {sub:"⚡ {nome}, 1 minuto pode mudar seu futuro!",body:`Oi {nome}!\n\nSabia que em 1 minutinho você pode ativar o envio automático do H2BApply e candidatar para centenas de vagas enquanto dorme?\n\nÉ sério — entra em h2bapply.com, ativa o automático e vai ser candidatado para empresas americanas 24 horas por dia! 🤖🇺🇸\n\nNão perde tempo! Bora! 🔥\n\nEquipe H2BApply`},
    {sub:"🌟 {nome}! Não deixe o sonho americano esperando",body:`{nome}! 🌟\n\nO sonho americano não acontece sozinho — mas com o H2BApply quase! 😄\n\nEntra em h2bapply.com e deixa o robô trabalhar por você. Enquanto você toca sua vida, a gente envia candidaturas para empresas nos EUA!\n\nVagas de Landscape, Seafood, Hotels, Resorts, Golf... tudo num lugar só!\n\nVai lá! 🇺🇸💪\n\nH2BApply`},
    {sub:"☀️ Bom dia {nome}! Hora de candidatar pras vagas americanas!",body:`Bom dia {nome}! ☀️\n\nAcordou com vontade de mudar de vida? O H2BApply tá aqui pra isso!\n\nEntra em h2bapply.com e manda candidatura pras vagas H-2B de hoje. São dezenas de novidades toda semana!\n\n☕ Toma seu café e já abre o app — 5 minutos e você tá na fila do sonho americano!\n\nBoa sorte! 🇺🇸🌟\n\nH2BApply`},
    {sub:"🎯 {nome}, foco no objetivo: trabalhar nos EUA!",body:`{nome}!\n\nLembra do seu objetivo: trabalhar nos EUA com visto H-2B? 🇺🇸\n\nO H2BApply existe exatamente pra te ajudar com isso! Mas pra funcionar, você precisa entrar e configurar seus envios!\n\n👉 h2bapply.com — é rápido, é fácil e pode mudar sua vida!\n\nVai lá hoje! 💪\n\nEquipe H2BApply 🤖`},
    {sub:"💭 {nome}, pensando em você e no seu sonho americano!",body:`Oi {nome}! 💭\n\nA equipe do H2BApply tava aqui pensando em você e no seu sonho de trabalhar nos EUA...\n\nE lembramos que tem vagas novas aparecendo todo dia no portal do governo americano!\n\nEntra em h2bapply.com e vê o que tem de novo. Pode ser a sua chance! 🍀🇺🇸\n\nCom carinho,\nEquipe H2BApply`},
  ],
  "3d": [
    {sub:"😮 {nome}! 3 dias sem candidatar... isso não tá certo!",body:`{nome}!! 😮\n\n3 dias sem entrar no H2BApply... sabe quantas vagas passaram por você nesse tempo?\n\nDezenas de empresas americanas publicaram vagas H-2B e você pode estar perdendo a chance de ser candidatado!\n\n🔥 VOLTE AGORA: h2bapply.com\n\nAtiva o automático e nunca mais perde vaga! O robô trabalha por você 24/7! 🤖🇺🇸\n\n💎 P.S.: Tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp! Garante o seu!\n\nEquipe H2BApply`},
    {sub:"⏰ {nome}! O tempo está passando e as vagas também...",body:`{nome}! ⏰\n\nOlha... faz 3 dias que você não entra no H2BApply. E nesse tempo, vários candidatos estão mandando email pras mesmas empresas que você quer!\n\nA competição é real. Mas o H2BApply te dá vantagem — manda centenas de candidaturas automaticamente! 🚀\n\n👉 Volta pra h2bapply.com agora e ativa o automático!\n\n💎 BÔNUS: CÓDIGO VIP no grupo do WhatsApp — dias grátis de automático!\n\nVai nessa! 🇺🇸💪\n\nEquipe H2BApply`},
    {sub:"🏃 {nome}! Corre que as vagas H-2B não esperam!",body:`EI {nome}! 🏃\n\nCORRE! Faz 3 dias que você não candidata e as vagas H-2B não esperam por ninguém!\n\nO portal do governo americano atualiza as vagas constantemente e você está perdendo!\n\n🎯 Solução rápida:\n1. h2bapply.com\n2. Ativa o Envio Automático\n3. Relaxa que o robô faz o resto!\n\n🎁 Entra no grupo do WhatsApp — tem CÓDIGO VIP GRÁTIS esperando!\n\nNão demora mais não! 🇺🇸🔥\n\nH2BApply`},
    {sub:"🤔 {nome}, tudo bem? O H2BApply sentiu sua falta!",body:`Oi {nome}! 🤔\n\nTudo bem com você? Faz alguns dias que você não aparece e a gente ficou preocupado!\n\nSe precisar de ajuda com o app, pode falar com a gente pelo Instagram @andrio.k ou WhatsApp +55 53 98145-3496!\n\nE quando puder, passa em h2bapply.com — tem vagas novas e o automático esperando pra trabalhar por você! 🤖🇺🇸\n\nCuida-se! 💙\n\nEquipe H2BApply`},
    {sub:"💡 {nome}! Ideia: ativa o automático e esquece!",body:`{nome}! 💡\n\nTenho uma ideia incrível pra você:\n\n1. Entra em h2bapply.com\n2. Ativa o Envio Automático\n3. Fecha o app e vai viver sua vida\n4. O robô manda candidatura 24h por dia\n5. Empresas americanas respondem no seu Gmail!\n\nSimples assim! 😄🇺🇸\n\n💎 E ainda tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp!\n\nBora experimentar? h2bapply.com\n\nH2BApply 🤖`},
    {sub:"🌙 {nome}! Enquanto você dorme, o H2BApply trabalha!",body:`{nome}! 🌙\n\nSabia que você pode candidatar pra vagas americanas ENQUANTO DORME?\n\nÉ verdade! O envio automático do H2BApply roda no servidor — não precisa do celular nem do app aberto!\n\nConfigura uma vez e pronto. Acorda com candidaturas enviadas e respostas chegando! ☀️🇺🇸\n\n👉 h2bapply.com — ativa hoje à noite!\n\n💎 CÓDIGO VIP GRÁTIS no grupo do WhatsApp!\n\nH2BApply 🤖`},
  ],
  "7d": [
    {sub:"😢 {nome}... 1 semana sem candidatar. Não desiste não!",body:`{nome}... 😢\n\n1 semana. 7 dias. 168 horas.\n\nÉ quanto tempo faz que você não entra no H2BApply. E nesse período, dezenas de empresas americanas publicaram vagas H-2B que você poderia ter disputado.\n\nMas não é tarde! NUNCA É TARDE pra correr atrás do sonho americano! 🇺🇸\n\n🔥 VOLTA AGORA: h2bapply.com\n\nO robô tá pronto, as vagas tão lá, e você merece essa chance!\n\n💎 IMPORTANTE: Entra no grupo do WhatsApp — tem CÓDIGO VIP GRÁTIS! Dias de automático sem pagar nada! Não perde essa!\n\nVai lá. Hoje. Agora. 💪\n\nCom muita fé em você,\nEquipe H2BApply 🤖`},
    {sub:"🚨 {nome}! Alerta: 7 dias sem candidatar!",body:`ALERTA VERMELHO {nome}! 🚨\n\n7 dias sem entrar no H2BApply é tempo demais quando você tem um sonho americano pra realizar!\n\nSabe o que aconteceu enquanto você estava longe?\n→ Centenas de vagas H-2B publicadas\n→ Outros candidatos enviando emails\n→ Empresas contratando gente\n\nVocê merece estar nessa lista. Volta pra h2bapply.com HOJE!\n\n💎 Código VIP grátis no grupo do WhatsApp — dias de automático sem custo!\n\nO visto H-2B ainda é possível. Não desiste! 🇺🇸💪\n\nEquipe H2BApply`},
    {sub:"💪 {nome}! Guerreiro não desiste — volta pro H2BApply!",body:`{nome}! 💪\n\nGuerreiro não desiste. E você não é um desistente!\n\nFaz uma semana que você não candida. Mas hoje é um novo dia e uma nova chance de correr atrás do sonho americano!\n\n🔑 A chave é consistência. Entra todo dia, ativa o automático e deixa o H2BApply trabalhar por você!\n\n👉 h2bapply.com — volta hoje!\n💎 CÓDIGO VIP GRÁTIS no grupo do WhatsApp!\n📲 Dúvidas? @andrio.k no Instagram!\n\nVocê chegou até aqui. Não para agora! 🇺🇸🔥\n\nEquipe H2BApply`},
    {sub:"🙏 {nome}, um pedido da equipe H2BApply",body:`{nome}, 🙏\n\nA equipe do H2BApply tem um pedido pra você:\n\nNão desiste do seu sonho.\n\nSabemos que é difícil. Que às vezes parece que não vai dar. Mas a gente acredita em você e criamos essa ferramenta exatamente pra facilitar sua jornada rumo aos EUA!\n\nFaz uma semana que você não aparece. E a gente quer que você volte.\n\n💙 h2bapply.com — a gente tá aqui por você.\n\n💎 Tem CÓDIGO VIP GRÁTIS no grupo do WhatsApp. Aproveita!\n\nCom muito carinho,\nEquipe H2BApply 🤖🇺🇸`},
    {sub:"⭐ {nome}! Sua estrela americana ainda brilha!",body:`{nome}! ⭐\n\nSua estrela americana ainda brilha. Às vezes a gente precisa de um empurrãozinho pra lembrar disso.\n\nFaz uma semana que você não entra no H2BApply. Mas hoje é o dia de voltar!\n\n🌟 Vagas de Landscaping, Seafood, Hotels, Golf e muito mais esperando!\n🤖 Automático pronto pra trabalhar 24h por você!\n💎 CÓDIGO VIP GRÁTIS no grupo do WhatsApp!\n\nUm passo de cada vez. Hoje o passo é: h2bapply.com\n\nVai lá! 🇺🇸💪\n\nEquipe H2BApply`},
  ],
};

function scheduleReengagement(){
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(12,0,0,0); // 9h BRT = 12h UTC
  if(next<=now) next.setUTCDate(next.getUTCDate()+1);
  const delay = next-now;
  console.log(`[reengagement] Próximo disparo em ${Math.round(delay/60000)}min`);
  setTimeout(async()=>{ await runReengagement(); scheduleReengagement(); }, delay);
}

async function runReengagement(){
  const now = Date.now();
  const adminSess = Object.entries(sessions).find(([,s])=>s.user_email===ADMIN_EMAIL&&s.access_token);
  if(!adminSess){ console.warn("[reengagement] Admin offline — pulando rodada"); return; }
  const [adminSid] = adminSess;
  let sent=0;

  for(const [email,user] of Object.entries(DB_USERS)){
    if(isAdminEmail(email)) continue;
    const lastSeen = user.lastSeenAt || new Date(user.created_at||0).getTime();
    const inactiveDays = (now-lastSeen)/86400_000;
    let tier=null;
    if(inactiveDays>=7&&inactiveDays<8)       tier="7d";
    else if(inactiveDays>=3&&inactiveDays<4)  tier="3d";
    else if(inactiveDays>=1&&inactiveDays<2)  tier="1d";
    if(!tier) continue;

    const lockKey=`reeng_${email}_${tier}`;
    if(_notifLock.has(lockKey)) continue;
    if(now-(_notifSentAt[lockKey]||0)<20*3600_000) continue;

    // Não incomoda usuário com automático ativo — já está engajado
    const autoJob=getAutoJob(email);
    if(autoJob?.active) continue;

    try{
      const nome=(user.name||email.split("@")[0]).split(" ")[0];
      const msgs=REENGAGEMENT_MSGS[tier];
      const idx=Math.floor(Math.random()*msgs.length);
      const {sub,body}=msgs[idx];
      const raw=buildMime({to:email,subject:sub.replace(/{nome}/g,nome),fromName:"H2BApply 🤖",fromEmail:ADMIN_EMAIL,text:body.replace(/{nome}/g,nome)});
      const {status}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+sessions[adminSid].access_token,"Content-Type":"application/json"}},{raw});
      if(status===200){
        _notifLock.add(lockKey);_notifSentAt[lockKey]=now;
        setTimeout(()=>_notifLock.delete(lockKey),22*3600_000);
        // Log
        _notifEmailLog.unshift({to:email,nome,subject:sub.replace(/{nome}/g,nome),body:body.replace(/{nome}/g,nome),tipo:`reeng_${tier}`,sentAt:new Date().toISOString(),varIdx:idx});
        if(_notifEmailLog.length>1000)_notifEmailLog.length=1000;
        sent++;
        console.log(`[reengagement] ✅ ${tier} → ${email} (var ${idx+1}/${msgs.length})`);
        await new Promise(r=>setTimeout(r,2500)); // pausa entre envios
      }
    }catch(e){ console.warn(`[reengagement] erro → ${email}:`,e.message); }
  }
  console.log(`[reengagement] Rodada: ${sent} emails enviados`);
}

scheduleReengagement(); // Inicia no boot

function getHealth(email) {
  if (!healthState.has(email)) healthState.set(email, { lastSent:0, lastCheck:0, restarts:0, errors:0, status:"ok", lastError:"", oauthOk:null, gmailOk:null, hasPdf:null, stalledAt:null });
  return healthState.get(email);
}
function setHealth(email, patch) { const h=getHealth(email); Object.assign(h,patch); }

function pushGlobalEvent(type, email, msg, level="warn") {
  GLOBAL_EVENTS.unshift({ ts:Date.now(), date:toLocaleBRT(Date.now()), type, email, msg, level });
  if(GLOBAL_EVENTS.length>500) GLOBAL_EVENTS.length=500;
  console.log(`[watchdog/${level}] ${email||"global"}: ${msg}`);
}

// Diagnóstico completo de um job ativo
async function diagnoseJob(email) {
  const job = getAutoJob(email);
  const user = getUser(email);
  const h = getHealth(email);
  if (!job || !job.active) return;

  const now = Date.now();
  h.lastCheck = now;

  // 1. Checa PDF/CV
  const hasPdf = (user?.cvs||[]).some(c => loadCv(email, c.idx));
  if (!hasPdf && h.hasPdf !== false) {
    h.hasPdf = false;
    addLog(email, { status:"sistema", jobTitle:"⚠️ PDF do currículo não encontrado", company:"Watchdog detectou: faça upload do currículo novamente", error:"PDF ausente" });
    pushGlobalEvent("no_pdf", email, "PDF do currículo não encontrado — envio automático pode falhar", "warn");
  } else { h.hasPdf = true; }

  // 2. Checa OAuth/token
  const hasToken = !!(user?.refresh_token || user?.cached_access_token);
  if (!hasToken && h.oauthOk !== false) {
    h.oauthOk = false;
    addLog(email, { status:"pausado", jobTitle:"🔐 Autenticação expirada", company:"Watchdog: faça login novamente para retomar o envio automático", error:"Sem refresh_token" });
    pushGlobalEvent("oauth_invalid", email, "Autenticação expirada — automático pausado", "error");
    setAutoJob(email, { ...job, active:false, status:"paused_oauth_expired" });
    autoTimers.delete(email);
    return;
  }
  h.oauthOk = true;

  // 3. Checa fila travada (ativo mas sem progresso há STALL_THRESHOLD)
  // ⚠️ NUNCA marcar como stalled se está aguardando limite/horário/rate-limit — são esperas normais
  const WAITING_STATUSES = new Set(["waiting_limit","waiting_hour","waiting_rate_limit","waiting_interval"]);
  const lastActivity = job.lastSentAt || job.startedAt || 0;
  const stalledMs = now - lastActivity;
  const isStalled = job.active && job.queue?.length > 0 && stalledMs > STALL_THRESHOLD
    && !WAITING_STATUSES.has(job.status)  // não é espera normal
    && !(job.nextSendAt && job.nextSendAt > now); // não tem próximo envio agendado

  if (isStalled) {
    const mins = Math.round(stalledMs / 60000);
    if (!h.stalledAt) {
      h.stalledAt = now;
      pushGlobalEvent("stalled", email, `Fila travada há ${mins} minutos — tentando reiniciar`, "warn");
      addLog(email, { status:"sistema", jobTitle:`🔄 Fila travada há ${mins}min — reiniciando worker`, company:"Watchdog auto recovery", error:"Worker não respondia" });
      // 🔔 Notifica o usuário por email
      sendNotifEmail(email, "stalled").catch(e => console.warn("[notif/stalled]", e.message));
    }
    // Auto recovery: reinicia o timer se não há timer ativo
    if (!autoTimers.has(email)) {
      h.restarts++;
      h.stalledAt = null;
      pushGlobalEvent("recovery", email, `Worker reiniciado automaticamente (restart #${h.restarts})`, "info");
      addLog(email, { status:"sistema", jobTitle:`✅ Worker reiniciado automaticamente (#${h.restarts})`, company:"Watchdog recovery" });
      scheduleAuto(email);
    }
  } else if (h.stalledAt) {
    h.stalledAt = null; // fila voltou a andar
  }

  // 4. Checa timer morto: job ativo mas sem timer scheduled e sem nextSendAt futuro
  const timerMissing = job.active && job.queue?.length > 0 && !autoTimers.has(email);
  const nextOk = job.nextSendAt && job.nextSendAt > now;
  if (timerMissing && !nextOk && !isStalled) {
    h.restarts++;
    pushGlobalEvent("dead_timer", email, `Timer morto detectado — reagendando (restart #${h.restarts})`, "warn");
    addLog(email, { status:"sistema", jobTitle:`🔄 Timer morto detectado — reagendando worker`, company:"Watchdog" });
    scheduleAuto(email);
  }

  h.status = "ok";
}

// Watchdog global: roda a cada 2min
setInterval(async () => {
  const activeJobs = Object.entries(DB_AUTO).filter(([,j]) => j.active && j.queue?.length > 0);
  for (const [email] of activeJobs) {
    try { await diagnoseJob(email); } catch(e) { console.error(`[watchdog] erro em ${email}:`, e.message); }
  }
  // Detecta jobs marcados active=true mas sem timer E sem nextSendAt — orphans pós-crash
  const now = Date.now();
  for (const [email, job] of Object.entries(DB_AUTO)) {
    if (!job.active || !job.queue?.length) continue;
    if (!autoTimers.has(email)) {
      const nextOk = job.nextSendAt && job.nextSendAt > now && (job.nextSendAt - now) < 6*3600_000;
      if (!nextOk) {
        const h = getHealth(email);
        h.restarts++;
        pushGlobalEvent("orphan_recovery", email, `Job órfão pós-crash recuperado (restart #${h.restarts})`, "info");
        addLog(email, { status:"sistema", jobTitle:"✅ Queue restaurada após crash", company:"Watchdog recovery pós-reinício" });
        scheduleAuto(email);
      }
    }
  }
}, WATCHDOG_INTERVAL);

// Heartbeat: atualiza lastSent quando auto envia com sucesso
// (hook no addLog existente — detecta status "enviado")
const _origAddLog = addLog;
// Patch addLog para atualizar heartbeat
const _addLogPatched = function(userEmail, entry) {
  _origAddLog(userEmail, entry);
  if (entry.status === "enviado") {
    const h = getHealth(userEmail);
    h.lastSent = Date.now();
    h.errors = 0;
    h.stalledAt = null;
  }
  if (entry.status === "falhou") {
    const h = getHealth(userEmail);
    h.errors = (h.errors||0) + 1;
    h.lastError = entry.error || "Erro desconhecido";
    if (h.errors >= 5) {
      pushGlobalEvent("too_many_errors", userEmail, `${h.errors} falhas consecutivas: ${h.lastError}`, "error");
    }
  }
};
// Nota: _addLogPatched foi definido acima mas o heartbeat já está embutido
// diretamente em doAutoSend (linha "h.lastSent=Date.now()") — sem duplicação.

// Admin: endpoint live monitor
// Injetado nos handlers de /api/admin


// Renova tokens proativamente para usuários com auto ativo (a cada 45min)
setInterval(async()=>{
  const activeEmails=Object.entries(DB_AUTO).filter(([,j])=>j.active&&j.queue?.length>0).map(([e])=>e);
  for(const email of activeEmails){
    const u=getUser(email);if(!u?.refresh_token)continue;
    const expiry=u.cached_token_expiry||0;
    // Renova se faltam menos de 30min para expirar ou não tem token em cache
    if(!u.cached_access_token||Date.now()>expiry-30*60*1000){
      try{await refreshTokenForUser(email);console.log(`[token-auto] ✅ Renovado proativamente para ${email}`);}
      catch(e){console.warn(`[token-auto] ⚠️ Falha ao renovar para ${email}:`,e.message);}
    }
  }
},45*60*1000);

// ══════════════════════════════════════════════════════════
//  FUNÇÕES UTILITÁRIAS GLOBAIS (stats, ranking)
//  Movidas para escopo global para reutilização entre rotas
// ══════════════════════════════════════════════════════════

// Calcula streak de dias consecutivos com envios
function calcStreak(h) {
  let s = 0;
  const nowBRTd = nowBRT(); // usa UTC-3 fixo igual ao todayStrBRT()
  for (let i = 0; i < 30; i++) {
    const d = new Date(nowBRTd.getTime() - i * 86400_000);
    const ds = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
    if (h.some(x => x.dateStr === ds)) s++;
    else break;
  }
  return s;
}

// Retorna contagem de envios dos últimos 7 dias
function last7Days(h) {
  const r = [];
  const nowBRTd = nowBRT(); // usa UTC-3 fixo igual ao todayStrBRT()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowBRTd.getTime() - i * 86400_000);
    const ds = `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()}`;
    const label = `${d.getUTCDate()}/${d.getUTCMonth()+1}`;
    r.push({ label, count: h.filter(x => x.dateStr === ds).length });
  }
  return r;
}

// Verifica se uma entrada pertence ao período de ranking
function inRankPeriod(e, period) {
  if (period === "all") return true;
  if (period === "day") return e.dateStr === todayStr();
  const ts = e.sentAt ? new Date(e.sentAt).getTime() : 0;
  if (period === "week")  return ts >= Date.now() - 7  * 86400_000;
  if (period === "month") return ts >= Date.now() - 30 * 86400_000;
  return false;
}

// Calcula ranking de usuários por período e categoria
function calcRanking(period, category, myEmail) {
  const rows = [];
  for (const [email, user] of Object.entries(DB_USERS)) {
    if (DB_RANK_HIDDEN[email]) continue;
    if (user.isAdmin) continue;
    const hist = getHist(email);
    const ph = hist.filter(e => inRankPeriod(e, period));
    const sends    = ph.filter(e => e.type !== "reply").length;
    const replies  = ph.filter(e => e.type === "reply").length;
    const totS     = hist.filter(e => e.type !== "reply").length;
    const totR     = hist.filter(e => e.type === "reply").length;
    const respRate = totS > 0 ? Math.round((totR / totS) * 100) : 0;
    const score    = category === "responses" ? replies : category === "active" ? sends + replies * 2 : sends;
    if (score === 0 && period !== "all") continue;
    if (totS + totR === 0 && period === "all") continue;
    rows.push({
      email, name: user.name || "Usuário", picture: user.picture || "",
      plan: getPlan(user), sends, responses: replies, totalSends: totS,
      totalResponses: totR, responseRate: respRate, score,
      isOnline: isOnlineUser(email), adminBadge: DB_RANK_BADGES[email] || null,
      createdAt: user.created_at || "2024-01-01"
    });
  }
  rows.sort((a, b) => b.score !== a.score ? b.score - a.score : new Date(a.createdAt) - new Date(b.createdAt));
  const cacheKey = `${period}_${category}`;
  const prev = rankPosCache[cacheKey] || {};
  const newPos = {};
  rows.forEach((r, i) => newPos[r.email] = i + 1);
  rankPosCache[cacheKey] = newPos;
  const list = rows.slice(0, 50).map((r, i) => {
    const pos = i + 1, pp = prev[r.email];
    const change = pp !== undefined ? pp - pos : null;
    return {
      pos, name: r.name, picture: r.picture, plan: r.plan,
      sends: r.sends, responses: r.responses, totalSends: r.totalSends,
      responseRate: r.responseRate, score: r.score, isOnline: r.isOnline,
      change, adminBadge: r.adminBadge,
      uid: crypto.createHash("sha256").update(r.email).digest("hex").slice(0, 16),
      isMe: myEmail ? r.email === myEmail : false
    };
  });
  let myPos = null;
  if (myEmail) {
    const mi = rows.findIndex(r => r.email === myEmail);
    if (mi >= 0) {
      const me = rows[mi];
      myPos = { pos: mi + 1, sends: me.sends, responses: me.responses, score: me.score, total: rows.length };
    }
  }
  return { list, myPos, total: rows.length };
}

// ── BOOT ─────────────────────────────────────────────────
boot();loadSheets();

// ── Graceful shutdown: persiste TODOS os bancos ──────────
function flushAll() {
  console.log("[shutdown] Persistindo dados...");

  // 1. Cancela todos os timers de debounce pendentes
  _persistDebounceTimers.forEach((tid, _file) => clearTimeout(tid));
  _persistDebounceTimers.clear();

  // 2. Persiste todos os bancos de dados principais
  try { persist(USERS_FILE,  DB_USERS); } catch(e) { console.warn("[shutdown] users:", e.message); }
  try { persist(HIST_FILE,   DB_HIST);  } catch(e) { console.warn("[shutdown] hist:",  e.message); }
  try { persist(AUTO_FILE,   DB_AUTO);  } catch(e) { console.warn("[shutdown] auto:",  e.message); }
  try { persist(NOTES_FILE,  DB_NOTES); } catch(e) { console.warn("[shutdown] notes:", e.message); }
  try { persist(LOGS_FILE,   DB_LOGS);  } catch(e) { console.warn("[shutdown] logs:",  e.message); }
  try { persist(PUSH_FILE,   DB_PUSH);  } catch(e) { console.warn("[shutdown] push:",  e.message); }
  try { persist(CODES_FILE,  DB_CODES); } catch(e) { console.warn("[shutdown] codes:", e.message); }
  try { persist(APPIDX_FILE, DB_APP_INDEX); } catch(e) { console.warn("[shutdown] appidx:", e.message); }
  try { persist(RANK_HIDDEN_FILE, DB_RANK_HIDDEN); } catch(e) { console.warn("[shutdown] rank_hidden:", e.message); }
  try { persist(RANK_BADGES_FILE, DB_RANK_BADGES); } catch(e) { console.warn("[shutdown] rank_badges:", e.message); }
  try { persist(NOTIF_FILE,    DB_NOTIF);    } catch(e) { console.warn("[shutdown] notif:",    e.message); }
  try { persist(REFERRAL_FILE, DB_REFERRAL); } catch(e) { console.warn("[shutdown] referral:", e.message); }
  try { persist(SUGGESTIONS_FILE, DB_SUGGESTIONS); } catch(e) { console.warn("[shutdown] suggestions:", e.message); }

  // 3. Persiste sent_emails (conversão Set → Array)
  try {
    const out = {};
    for (const [k, v] of Object.entries(DB_SENT)) out[k] = [...v];
    persist(SENT_FILE, out);
  } catch(e) { console.warn("[shutdown] sent:", e.message); }

  console.log("[shutdown] ✅ Dados salvos.");
}
process.on("SIGTERM",()=>{flushAll();process.exit(0);});
process.on("SIGINT", ()=>{flushAll();process.exit(0);});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`\n✅  H2BApply v13.1 — ${APP_URL} (porta ${PORT})`);
  console.log(`    👤 Usuários: ${Object.keys(DB_USERS).length}`);
  console.log(`    📋 Jan/2026: ${SHEET_JAN.length} | Jul/2025: ${SHEET_JUL.length}`);
  console.log(`    🔗 Índice candidaturas: ${Object.keys(DB_APP_INDEX).length} usuário(s)`);
  console.log(`    🍪 Cookie: SameSite=Lax | IS_PROD: ${IS_PROD}`);
  if(!CONFIGURED)console.log("\n⚠️  Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET!\n");
  setTimeout(refreshCache,3000);
  setTimeout(reactivateAutoJobs,6000);
});

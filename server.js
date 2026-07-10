// ═══════════════════════════════════════════════════════════
//  H2BApply v13.1 — Motor de envio automático profissional
//  [REESTRUTURADO: calcStreak/last7Days/inRankPeriod/calcRanking
//   movidas para escopo global; flushAll completo no shutdown]
//
//  PLANOS:
//    free   → 20 manual + 10 auto /dia
//    vip    → 400 manual + 10 auto /dia  (R$49,90)
//    pro    → 300 manual + 200 auto /dia  (R$119,90)
//    vipro  → 400 manual + 200 auto /dia (R$149,90)
//
//  NOVIDADES v13:
//    • Envio automático STREAMING (começa imediatamente)
//    • Logs completos com status detalhado
//    • Filtros dinâmicos por categoria de serviço
//    • Painel de logs profissional + exportação CSV
//    • Dashboard em tempo real
//    • Recuperação automática após queda
//    • Migração automática de dados antigos
//    • IDs únicos por candidatura (appId) + índice de vinculação
// ═══════════════════════════════════════════════════════════
"use strict";
const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const zlib = require("zlib");

// ═══ V951 (Parte 1 do plano 10/10): COMPRESSÃO HTTP + ETag ═══════════════
// index.html tem ~1,18MB e era servido CRU com no-cache → ~1,2MB por visita
// no 4G. Agora: brotli/gzip (cai para ~180-250KB) + ETag (revalidação vira
// 304 sem corpo). Compressão roda UMA vez por arquivo/mtime e fica em cache
// de memória — custo por request é zero.
const _assetCache = {}; // { file: { mtime, raw, gz, br, etag } }
function getStaticAsset(file){
  const fp = path.join(__dirname, file);
  const st = fs.statSync(fp);
  const c = _assetCache[file];
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(fp);
  const entry = {
    mtime: st.mtimeMs,
    raw,
    gz: zlib.gzipSync(raw, { level: 6 }),
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    etag: '"' + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20) + '"'
  };
  _assetCache[file] = entry;
  return entry;
}
function sendAsset(req, res, file, ctype, cacheControl){
  let a;
  try { a = getStaticAsset(file); }
  catch { res.writeHead(404); return res.end(file + " não encontrado"); }
  if (req.headers["if-none-match"] === a.etag) {
    res.writeHead(304, { ETag: a.etag, "Cache-Control": cacheControl || "no-cache", Vary: "Accept-Encoding" });
    return res.end();
  }
  const ae = String(req.headers["accept-encoding"] || "");
  const h = { "Content-Type": ctype, "Cache-Control": cacheControl || "no-cache", ETag: a.etag, Vary: "Accept-Encoding" };
  let body = a.raw;
  if (/\bbr\b/.test(ae))        { h["Content-Encoding"] = "br";   body = a.br; }
  else if (/\bgzip\b/.test(ae)) { h["Content-Encoding"] = "gzip"; body = a.gz; }
  h["Content-Length"] = body.length;
  res.writeHead(200, h);
  return res.end(body);
}
// ══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const APP_URL       = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
// ── MULTI-SERVIDOR: identidade deste servidor ─────────────────────────────
// Cada deploy (produção = 1, h2b-teste = 2) define SERVER_ID no ambiente.
// Mesmo código nos dois; só a env var muda. Default 1 (produção).
const SERVER_ID     = parseInt(process.env.SERVER_ID || "1", 10) || 1;
if(!process.env.SERVER_ID){
  console.warn("⚠️⚠️⚠️ [servers] Env SERVER_ID NÃO DEFINIDA — assumindo 1 (produção). Se este deploy é o h2b-teste, DEFINA SERVER_ID=2 no Render, senão a trava de 'lotado' bloqueia os cadastros deste servidor! ⚠️⚠️⚠️");
}
const REDIRECT_URI        = APP_URL + "/oauth/callback";
const REDIRECT_URI_SENDER = APP_URL + "/oauth/add-sender/callback";
// ── Fase 1 · Módulo 1: configuração extraída para src/config.js ──────────
const { MAX_SENDER_EMAILS_FREE, MAX_SENDER_EMAILS_VIP, MAX_SENDER_EMAILS_ADMIN,
        MAX_RESUMES, MAX_COVERS,
        ADMIN_EMAIL, ADMIN_EMAIL_2, ADMIN_EMAILS_EXTRA, ADMIN_EMAILS, isAdminEmail,
        VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_ENABLED,
        PLAN_LIMITS } = require("./mod-config.js");
// getMaxSenders retorna o TOTAL de emails (principal + extras)
const getMaxSenders = (u) => {
  if(u?.isAdmin || isAdminEmail(u?.email||"")) return MAX_SENDER_EMAILS_ADMIN;
  // Gmail extra: SOMENTE plano PAGO e ATIVO. Trial e dias promocionais
  // (vip.source 'trial' ou 'code') NÃO liberam Gmail extra, mesmo com VIP ativo.
  // Plano expirado também não (isVipActive é checado em tempo real).
  const src = (u?.vip?.source||"").toLowerCase();
  const isPaidActive = isVipActive(u) && src !== 'trial' && src !== 'code';
  if(isPaidActive) return MAX_SENDER_EMAILS_VIP;
  return MAX_SENDER_EMAILS_FREE; // free, trial, bônus puro, expirado: só o principal
};
const PORT          = parseInt(process.env.PORT || "3000", 10);
const IS_PROD       = APP_URL.startsWith("https://");
const CONFIGURED    = !!(CLIENT_ID && CLIENT_SECRET);

// ── VAPID — Web Push Notifications ───────────────────────
// Gere suas chaves com: npx web-push generate-vapid-keys
// Configure as variáveis de ambiente VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY
console.log(`[boot] Push VAPID: ${PUSH_ENABLED?"✅ configurado":"⚠️  desativado (configure VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY)"}`);

// ── Planos ────────────────────────────────────────────────
//   free      → 20 manual  + 10 auto   /dia (Grátis)
//   vip       → 200 manual + 10 auto   /dia (só manual pago)
//   vipro     → 200 manual + 200 auto  /dia (manual + automático)
//   doublepro → 400 manual + 400 auto  /dia (2 contas Gmail)
//   pro       → 0 manual   + 200 auto  /dia (só auto — legado)
//
//   Os limites de manual e auto são INDEPENDENTES — não se misturam.
// PLAN_LIMITS: extraído para src/config.js (Fase 1 · Módulo 1)
// Intervalos base (substituídos pelo cálculo inteligente)
// (constantes AUTO_INTERVAL_MIN/MAX removidas — o motor usa calcSmartInterval)
// Horário padrão se usuário não configurar
// Horário de envio REMOVIDO: automático roda 24/7 sem janela de horário

// Intervalo de envio: padrão 5-6 min (comportamento humano, menos bloqueios).
// Admins podem configurar intervalo menor.
// adminIntervalSecs: número de segundos entre envios (mín 30s para admins)
// calcSmartInterval: corpo em src/engine/core.js (Fase 1 · Módulo 6)
const { createCalcSmartInterval, nowBRT: _nowBRTMod, todayStrBRT: _todayStrBRTMod, toLocaleBRT: _toLocaleBRTMod, calcStreak: _calcStreakMod, last7Days: _last7DaysMod } = require("./mod-engine-core.js");
// 🔒 Integridade de vagas — 1 vaga = 1 ETA Case Number único (KB-076).
// Mesmo módulo usado pelo build-sheets.js standalone, pra nunca divergir a
// regra de dedupe/merge entre o cron oficial e o bot de coleta do admin.
const { dedupeVagas: _vagasDedupe, verifyIntegrity: _vagasVerify, buildManifest: _vagasManifest } = require("./mod-vagas-integrity.js");
let _calcSmartIntervalImpl = null;
function calcSmartInterval(email){
  if(!_calcSmartIntervalImpl) _calcSmartIntervalImpl = createCalcSmartInterval({ getUser, isAdminVip }); // lazy: getUser/isAdminVip declarados adiante
  return _calcSmartIntervalImpl(email);
}

// ══════════════════════════════════════════════════════════
//  TIMEZONE BRT — UTC-3 fixo (sem horário de verão no Brasil)
//  Todas as datas/horas do sistema usam BRT consistentemente
// ══════════════════════════════════════════════════════════
function nowBRT(){ return _nowBRTMod(); } // corpo em src/engine/core.js

function todayStrBRT(){ return _todayStrBRTMod(); } // corpo em src/engine/core.js

function toLocaleBRT(ts){ return _toLocaleBRTMod(ts); } // corpo em src/engine/core.js

function toTimeBRT(ts) {
  const d = new Date((ts||Date.now()) - 3*60*60*1000);
  return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
}

function hourBRT() {
  return nowBRT().getUTCHours();
}



// ── Storage ───────────────────────────────────────────────
// REGRA: /data é persistente (volume Docker/Railway). /tmp é volátil e apagado no reinício.
// Tenta garantir que /data exista e seja gravável antes de usá-lo.
(function ensureDataDir() {
  const preferred = process.env.DATA_DIR || "/data";
  try {
    if (!fs.existsSync(preferred)) fs.mkdirSync(preferred, { recursive: true });
    const testFile = require("path").join(preferred, ".write_test");
    fs.writeFileSync(testFile, "ok"); fs.unlinkSync(testFile);
  } catch (e) {
    console.error(`[CRÍTICO] ⚠️  Não foi possível usar ${process.env.DATA_DIR||"/data"} para dados: ${e.message}`);
    console.error("[CRÍTICO] ⚠️  USANDO /tmp — tokens e PDFs serão PERDIDOS no próximo reinício!");
    console.error("[CRÍTICO] ⚠️  Monte um volume persistente em /data ou defina DATA_DIR corretamente.");
  }
})();
const DATA_DIR    = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
// ── 💾 STORAGE ENGINE (Fase 4): SQLite com fallback JSON e dual-write ──────
const { initStorage, storageLoad, storagePersist, storageInfo } = require("./storage.js");
initStorage(DATA_DIR);
const USERS_FILE  = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json"); // KB-078: só guarda OAuth __sender__ em andamento — login NUNCA sobrevive a deploy (de propósito)

// ══ V955: CIFRAGEM EM REPOUSO (AES-256-GCM) ═══════════════════════════════
// Protege refresh_tokens/access_tokens do Gmail gravados em disco (users.json,
// sessions.json e SQLite). Chave: env DATA_ENC_KEY (qualquer string forte).
// Sem a chave definida → comportamento antigo (texto puro) + aviso no boot.
// Formato: "enc1:" + base64(iv[12] | authTag[16] | ciphertext). Retrocompatível:
// valores sem o prefixo passam direto (dados legados continuam funcionando).
const _encKeyRaw = process.env.DATA_ENC_KEY || "";
const _encKey = _encKeyRaw ? crypto.createHash("sha256").update(_encKeyRaw).digest() : null;
if(_encKey)console.log("[crypto] 🔐 Cifragem em repouso ATIVA (AES-256-GCM) — tokens Gmail protegidos no disco");
else console.warn("[crypto] ⚠️  DATA_ENC_KEY não definida — tokens Gmail ficam em TEXTO PURO no disco. Defina no Render para ativar a cifragem (retrocompatível, sem migração).");
function encStr(s){
  if(!_encKey||typeof s!=="string"||!s||s.startsWith("enc1:"))return s;
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv("aes-256-gcm",_encKey,iv);
  const ct=Buffer.concat([c.update(s,"utf8"),c.final()]);
  return "enc1:"+Buffer.concat([iv,c.getAuthTag(),ct]).toString("base64");
}
function decStr(s){
  if(typeof s!=="string"||!s.startsWith("enc1:"))return s; // legado texto puro
  if(!_encKey)return null; // cifrado mas sem chave → trata como ausente (re-login)
  try{
    const raw=Buffer.from(s.slice(5),"base64");
    const iv=raw.subarray(0,12),tag=raw.subarray(12,28),ct=raw.subarray(28);
    const d=crypto.createDecipheriv("aes-256-gcm",_encKey,iv);d.setAuthTag(tag);
    return Buffer.concat([d.update(ct),d.final()]).toString("utf8");
  }catch{return null;} // chave errada/corrompido → ausente, nunca crash
}
// Campos sensíveis do usuário cifrados no disco (cópia rasa — runtime intocado)
const USER_SECRET_FIELDS=["refresh_token","cached_access_token"];
function _encUsersForDisk(db){
  if(!_encKey)return db;
  const out={};
  for(const[e,u]of Object.entries(db||{})){
    const c={...u};
    for(const f of USER_SECRET_FIELDS)if(typeof c[f]==="string"&&c[f])c[f]=encStr(c[f]);
    if(Array.isArray(c.senderEmails))c.senderEmails=c.senderEmails.map(se=>
      se&&typeof se.refresh_token==="string"?{...se,refresh_token:encStr(se.refresh_token)}:se);
    out[e]=c;
  }
  return out;
}
function _decUsersFromDisk(db){
  for(const u of Object.values(db||{})){
    if(!u)continue;
    for(const f of USER_SECRET_FIELDS)if(typeof u[f]==="string"&&u[f].startsWith("enc1:"))u[f]=decStr(u[f]);
    if(Array.isArray(u.senderEmails))for(const se of u.senderEmails)
      if(se&&typeof se.refresh_token==="string"&&se.refresh_token.startsWith("enc1:"))se.refresh_token=decStr(se.refresh_token);
  }
  return db;
}
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
const SUGGESTIONS_FILE = path.join(DATA_DIR, "suggestions.json");   // User suggestions to devs
const PEDIDOS_FILE     = path.join(DATA_DIR, "pedidos.json");         // Pedidos de plano dos usuários
const FINANCEIRO_FILE  = path.join(DATA_DIR, "financeiro.json");      // Dados financeiros (entradas + gastos)
const BLOCKED_FILE     = path.join(DATA_DIR, "blocked_emails.json");  // Emails banidos permanentemente
const TRIAL_USED_FILE  = path.join(DATA_DIR, "trial_used.json");       // Histórico anti-abuse: phones/IPs que já receberam trial
// V951: cooldowns de notificação (admin+usuário) precisam sobreviver a
// restart/deploy — antes eram objetos só-em-memória (_notifSentAt,
// _pedAlertSent, _authErrNotifiedAt, _refillNotifiedAt) que voltavam a
// {} a cada deploy no Render. Como as varreduras (health-sentinel,
// pendingOrderAlert) disparam poucos minutos após o boot, TODO deploy
// reenviava de novo qualquer notificação "pendente", ignorando o
// cooldown de 12-24h combinado — daí "toda vez que eu faço deploy essas
// notificações aparecem". Persistindo em disco, o cooldown é respeitado
// de verdade entre reinícios do processo.
const NOTIF_COOLDOWN_FILE = path.join(DATA_DIR, "notif_cooldowns.json");
const KB_FILE          = path.join(DATA_DIR, "knowledge_base.json");  // Base de Conhecimento Permanente (IA↔IA)
try { fs.mkdirSync(CVS_DIR, { recursive: true }); } catch {}

console.log(`[boot] H2BApply v13.0 | ${APP_URL} | ${DATA_DIR}`);
const _diskOk = DATA_DIR !== "/tmp";
console.log(`[boot] Disk: ${_diskOk ? `✅ ${DATA_DIR} (persistente)` : "❌ /tmp (VOLÁTIL — tokens/PDFs serão perdidos no próximo deploy!)"}`);
if (!_diskOk) {
  console.error("══════════════════════════════════════════════════════");
  console.error("  ❌  ATENÇÃO: dados sendo salvos em /tmp (VOLÁTIL)!");
  console.error("  Configure DATA_DIR=/data ou monte um volume em /data");
  console.error("══════════════════════════════════════════════════════");
}

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
let DB_ADMIN_SETTINGS = { emailNotificationsEnabled: false, newUserTrialEnabled: true, newUserTrialDays: 1, newUserTrialAutoDays: 0, newUserTrialPlan: "vip", editorPasswords: { andrew: "84800-54", diego: "Diego2026" },
  // MULTI-SERVIDOR: lista de servidores exibida no seletor da landing.
  // status "lotado" = fechado p/ contas novas (só login); "aberto" = cadastro liberado.
  // maxExibido é o teto MOSTRADO na barra (pode ser menor que o real p/ marcar lotação).
  // Editável em Admin → Configurações → 🌐 Servidores (sem deploy).
  servers: [
    { id: 1, nome: "Servidor 1", url: "https://h2bapply.com",            maxExibido: 50,  status: "lotado" },
    { id: 2, nome: "Servidor 2", url: "https://h2b-teste.onrender.com",  maxExibido: 100, status: "aberto" }
  ]
}; // v9: trial = 1d VIP Manual apenas (sem auto)
// Senhas de editor (Andrew/Diego) agora vivem no banco e podem ser trocadas pelo
// próprio dono via painel. Fallback para os padrões caso ainda não tenham sido salvas.
function getEditorPasswords(){
  // SEGURANÇA (V954-fix): prioridade = senha trocada no painel > env > fallback legado.
  // Recomendado: definir EDITOR_PWD_ANDREW / EDITOR_PWD_DIEGO no Render e trocar as
  // senhas pelo painel — os fallbacks legados ficam expostos a quem tiver o código.
  const dp=(DB_ADMIN_SETTINGS&&DB_ADMIN_SETTINGS.editorPasswords)||{};
  return {
    andrew: dp.andrew||process.env.EDITOR_PWD_ANDREW||"84800-54",
    diego:  dp.diego ||process.env.EDITOR_PWD_DIEGO ||"Diego2026"
  };
}
// Compara senha candidata com as dos editores em tempo constante (anti timing attack).
// Retorna "andrew" | "diego" | null.
function matchEditorPassword(candidate){
  const c=String(candidate||"");if(!c)return null;
  const pwds=getEditorPasswords();
  let found=null;
  for(const [who,pwd] of Object.entries(pwds)){
    if(!pwd)continue;
    const a=crypto.createHash("sha256").update(c).digest();
    const b=crypto.createHash("sha256").update(String(pwd)).digest();
    if(crypto.timingSafeEqual(a,b))found=who; // sem break: tempo constante entre editores
  }
  return found;
}
// Notifications: { notifications: [{id, title, body, createdAt, createdBy, readBy:[email,...]}] }
let DB_NOTIF = { notifications: [] };
let DB_SUGGESTIONS = []; // Array de sugestões dos usuários
let DB_PEDIDOS     = []; // Array de pedidos de plano
let DB_FINANCEIRO  = {pagamentos:[],gastos:[]};  // Dados financeiros persistentes
// ── MONITOR ETA ──────────────────────────────────────────────────────────
// Registro permanente de TODAS as vagas por ETA Case Number: status, grupo,
// histórico completo, agenda de consultas. Alimentado pelas planilhas +
// worker independente que consulta o DOL 24/7 (não depende de interface).
let DB_BLOCKED     = {emails:[]};               // Emails banidos permanentemente
let DB_TRIAL_USED  = {phones:{},ips:{},googleIds:{}};  // Anti-abuse: {phones:{"+5511...":"email"}, ips:{"1.2.3.4":["email1","email2"]}, googleIds:{"108...":"email"}}
// Base de Conhecimento Permanente — transferência de conhecimento entre IAs e versões
// Estrutura: { entries: [{ id, problema, solucao, motivo, impacto, modulos, versao, data, autor }] }
let DB_KB = { entries: [] };

// ── Gemini Chat ─────────────────────────────────────────
// Limite global de 1500 mensagens/dia para TODOS os usuários
// Relê do process.env a cada chamada — garante que o Render não perca a key após boot
const _GEMINI_API_KEY_BOOT = (process.env.GEMINI_API_KEY || "").trim();
function getGeminiKey(){ return (process.env.GEMINI_API_KEY || _GEMINI_API_KEY_BOOT || "").trim(); }
const GEMINI_API_KEY = _GEMINI_API_KEY_BOOT; // mantido para compatibilidade das verificações de status
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

function load(f, def) { return storageLoad(f, def); } // Fase 4: SQLite + migração automática + fallback JSON

// ══════════════════════════════════════════════════════════
//  SISTEMA DE INTELIGÊNCIA DE EMAILS — Base Global
//  Aprende com bounces de TODOS os usuários
// ══════════════════════════════════════════════════════════
const INVALID_EMAILS_FILE   = path.join(DATA_DIR, "invalid_emails.json");
const EMAIL_CORRECTIONS_FILE = path.join(DATA_DIR, "email_corrections.json");
const TEMP_FAILURES_FILE    = path.join(DATA_DIR, "temp_failures.json");

let DB_INVALID_EMAILS   = {};  // { email: {email,domain,motivo,tipo,first,last,count,users,msg,status} }
let DB_EMAIL_CORRECTIONS = {}; // { orig: {original,corrected,confidence,count,first,last} }
let DB_TEMP_FAILURES    = {};  // { email: {email,errors:[],count} }

// Padrões de erro permanente (o endereço não existe)
const PERM_PATTERNS = [
  /550[\s-]5\.1\.1/i, /user unknown/i, /no such user/i,
  /address not found/i, /account does not exist/i, /recipient not found/i,
  /does not exist/i, /invalid address/i, /user not found/i,
  /mailbox not found/i, /bad destination/i, /550 unknown/i,
  /5\.1\.1/i, /5\.1\.2/i, /5\.4\.1/i, /5\.7\.1.*unknown/i,
  /email account.*does not exist/i, /no mailbox/i
];

// Padrões de erro temporário (não é lista negra)
const TEMP_PATTERNS = [
  /temporary/i, /retry/i, /will retry/i, /delivery incomplete/i,
  /mailbox full/i, /server unavailable/i, /timeout/i, /4\.\d+\.\d+/i,
  /try again/i, /busy/i, /too many/i, /rate limit/i, /temporarily/i
];

// Domínios comuns para correção de typo
const COMMON_DOMAINS = [
  'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
  'aol.com','protonmail.com','live.com','msn.com','me.com',
  'yahoo.com.br','hotmail.com.br','bol.com.br','uol.com.br','terra.com.br'
];

function levenshtein(a,b){
  const m=a.length,n=b.length;
  const d=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>j===0?i:i===0?j:0));
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) d[i][j]=a[i-1]===b[j-1]?d[i-1][j-1]:1+Math.min(d[i-1][j],d[i][j-1],d[i-1][j-1]);
  return d[m][n];
}

function suggestEmailCorrection(email){
  if(!email||!email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if(!domain) return null;
  // Typo muito óbvio no domínio
  let best=null, bestDist=99;
  for(const cd of COMMON_DOMAINS){
    const dist = levenshtein(domain.toLowerCase(), cd);
    if(dist>0 && dist<=2 && dist<bestDist){ bestDist=dist; best=cd; }
  }
  if(best) return { original:email, corrected:`${local}@${best}`, confidence: bestDist===1?0.95:0.80 };
  return null;
}

function classifyBounce(bodyText){
  if(!bodyText) return null;
  const text = bodyText.toLowerCase();
  for(const p of PERM_PATTERNS){ if(p.test(text)) return 'permanent'; }
  for(const p of TEMP_PATTERNS){ if(p.test(text)) return 'temporary'; }
  return null;
}

function processBounce(toEmail, bodyText, fromUser){
  const now = Date.now();
  const tipo = classifyBounce(bodyText);
  if(!tipo) return; // Não é bounce reconhecido
  
  if(tipo === 'permanent'){
    if(!DB_INVALID_EMAILS[toEmail]){
      DB_INVALID_EMAILS[toEmail] = {
        email:toEmail, domain:toEmail.split('@')[1]||'',
        motivo:'Endereço inexistente', tipo:'permanent',
        first:now, last:now, count:1,
        users:new Set([fromUser]), msg:bodyText.slice(0,300), status:'invalid'
      };
    } else {
      const e = DB_INVALID_EMAILS[toEmail];
      e.last=now; e.count++;
      if(fromUser) e.users.add(fromUser);
      e.msg = bodyText.slice(0,300);
    }
    // Salvar
    const toSave = {};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){
      toSave[k] = {...v, users: [...(v.users instanceof Set ? v.users : new Set(v.users||[]))]};
    }
    try{ fs.writeFileSync(INVALID_EMAILS_FILE, JSON.stringify(toSave, null, 2)); }catch{}
    
    // Verificar correção possível
    const correction = suggestEmailCorrection(toEmail);
    if(correction && correction.confidence >= 0.80){
      if(!DB_EMAIL_CORRECTIONS[toEmail]){
        DB_EMAIL_CORRECTIONS[toEmail] = {...correction, count:1, first:now, last:now};
      } else {
        DB_EMAIL_CORRECTIONS[toEmail].count++;
        DB_EMAIL_CORRECTIONS[toEmail].last=now;
      }
      try{ fs.writeFileSync(EMAIL_CORRECTIONS_FILE, JSON.stringify(DB_EMAIL_CORRECTIONS,null,2)); }catch{}
    }
    console.log(`[bounce] 🔴 PERMANENTE: ${toEmail} (de ${fromUser})`);
    
  } else if(tipo === 'temporary'){
    if(!DB_TEMP_FAILURES[toEmail]) DB_TEMP_FAILURES[toEmail]={email:toEmail,errors:[],count:0};
    DB_TEMP_FAILURES[toEmail].count++;
    DB_TEMP_FAILURES[toEmail].errors.push({msg:bodyText.slice(0,200),ts:now,user:fromUser});
    try{ fs.writeFileSync(TEMP_FAILURES_FILE, JSON.stringify(DB_TEMP_FAILURES,null,2)); }catch{}
    console.log(`[bounce] 🟡 TEMPORÁRIO: ${toEmail}`);
  }
}

function _savePlaniha(key, arr){ _saveEnrichedSheet(key, arr); } // alias unificado

function removeFromSheets(email){
  if(!email) return;
  const emailLow = email.toLowerCase().trim();
  let totalRemoved = 0;

  // Remover do SKIP_SENT_IDS (lista de emails já enviados) para não reprocessar
  // Os emails inválidos entram no DB_INVALID_EMAILS e são filtrados ANTES do envio

  // Registrar remoção no DB de inválidos
  if(DB_INVALID_EMAILS[emailLow]){
    DB_INVALID_EMAILS[emailLow].removedFromSheets = true;
    DB_INVALID_EMAILS[emailLow].removedAt = Date.now();
  }

  // Remover dos jobs em memória (se estiver na fila de algum usuário)
  for(const [sid, sess] of Object.entries(sessions)){
    if(!sess.autoJob) continue;
    const queueBefore = (sess.autoJob.queue||[]).length;
    sess.autoJob.queue = (sess.autoJob.queue||[]).filter(j =>
      (j.to||'').toLowerCase() !== emailLow
    );
    const removed = queueBefore - (sess.autoJob.queue||[]).length;
    if(removed > 0){
      totalRemoved += removed;
      console.log(`[bounce] Removidos ${removed} jobs de ${emailLow} da fila de ${sess.user_email}`);
    }
  }

  // Salvar estado atualizado dos inválidos
  try{
    const toSave = {};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){
      toSave[k] = {...v, users: [...(v.users instanceof Set ? v.users : new Set(v.users||[]))]};
    }
    fs.writeFileSync(INVALID_EMAILS_FILE, JSON.stringify(toSave, null, 2));
  }catch(e){ console.warn('[bounce] erro salvando:', e.message); }

  if(totalRemoved > 0) console.log(`[bounce] Total removido das filas: ${totalRemoved} jobs de ${emailLow}`);
  return totalRemoved;
}

function isEmailInvalid(email){
  const e = DB_INVALID_EMAILS[email?.toLowerCase()];
  return e && e.status === 'invalid' && e.count >= 1;
}

function boot() {
  // ── CANÁRIO DE PERSISTÊNCIA (diagnóstico turnkey nos logs) ────────────
  // Prova se DATA_DIR sobrevive a restarts. Se este aviso aparecer a CADA
  // deploy ("criado agora"), o disco é EFÊMERO → TODOS os dados se perdem a
  // cada reinício (causa de "app fantasma": usuários somem, contadores zeram,
  // VIP volta pra trial de 1 dia). Solução: montar o disco persistente do
  // Render em /data (Dashboard → Disks → Mount Path /data).
  try {
    const _cf = path.join(DATA_DIR, ".persist_canary");
    if (fs.existsSync(_cf)) {
      const _c = JSON.parse(fs.readFileSync(_cf, "utf8") || "{}");
      _c.boots = (_c.boots || 1) + 1; _c.lastBootAt = Date.now();
      const _ageH = ((Date.now() - (_c.createdAt || Date.now())) / 3600000).toFixed(1);
      fs.writeFileSync(_cf, JSON.stringify(_c));
      console.log(`[persist] ✅ Canário OK — disco PERSISTENTE. Idade: ${_ageH}h | boots: ${_c.boots}`);
    } else {
      fs.writeFileSync(_cf, JSON.stringify({ id: "cny_" + Date.now().toString(36), createdAt: Date.now(), boots: 1, lastBootAt: Date.now() }));
      console.warn(`[persist] ⚠️ Canário CRIADO AGORA em ${DATA_DIR}. Se aparecer a CADA deploy, o disco é EFÊMERO — monte o disco persistente do Render em /data!`);
    }
  } catch (e) { console.error("[persist] erro no canário:", e.message); }

  // ── RESET ÚNICO CONTROLADO POR ENV (turnkey, sem abrir shell) ─────────
  // Para resetar TUDO: no Render, crie a env RESET_NOW com um valor qualquer
  // (ex.: RESET_NOW=temporada1) e faça deploy. Roda UMA vez, carimba o token
  // em /data/.reset_token e NUNCA repete — mesmo deixando a env ligada.
  // Para um novo reset no futuro, troque o valor (ex.: temporada2).
  // PRESERVA: admin_settings.json (senhas de editor + trial), knowledge_base.json
  // e os arquivos de vagas DOL. Roda antes dos loads → memória sobe limpa.
  try {
    const _resetTok = (process.env.RESET_NOW || "").trim();
    if (_resetTok) {
      const _tokFile = path.join(DATA_DIR, ".reset_token");
      let _prev = ""; try { _prev = fs.readFileSync(_tokFile, "utf8").trim(); } catch {}
      if (_resetTok !== _prev) {
        // ── PROTEÇÃO ANTI-WIPE ────────────────────────────────────────
        // Se o token mudou mas JÁ EXISTEM usuários, normalmente significa
        // que o .reset_token sumiu (disco efêmero) e o reset tentaria rodar
        // DE NOVO, apagando pagantes. Aborta — a não ser que o token termine
        // em ":force" (reset intencional de nova temporada).
        const _force = _resetTok.endsWith(":force");
        let _existingUsers = 0;
        try { _existingUsers = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "users.json"), "utf8") || "{}")).length; } catch {}
        if (_existingUsers > 0 && !_force) {
          console.error(`[reset] 🛑 ABORTADO: ${_existingUsers} usuário(s) existem e RESET_NOW="${_resetTok}" mudou sem ":force".`);
          console.error(`[reset] 🛑 Provável disco efêmero (token sumiu). Para evitar perda, NÃO apaguei nada.`);
          console.error(`[reset] 🛑 Reset intencional? Use RESET_NOW="${_resetTok}:force". Senão, REMOVA a env RESET_NOW.`);
          try { fs.writeFileSync(_tokFile, _resetTok); } catch {}
        } else {
        console.log(`[reset] 🔄 RESET_NOW="${_resetTok}" novo — executando reset único da temporada...`);
        const _empty = {
          "users.json": {}, "h2b_users.json": {}, "history.json": {}, "h2b_history.json": {},
          "app_index.json": {}, "auto_jobs.json": {}, "sent_emails.json": {}, "auto_logs.json": {},
          "journey.json": {}, "notes.json": {}, "job_alerts.json": {}, "promo_codes.json": {},
          "push_subs.json": {}, "financeiro.json": { pagamentos: [], gastos: [] }, "pedidos.json": [],
          "suggestions.json": [], "referrals.json": { byCode: {}, byEmail: {} },
          "notifications.json": { notifications: [] }, "rank_hidden.json": {}, "rank_badges.json": {},
          "invalid_emails.json": {}, "email_corrections.json": {}, "temp_failures.json": {},
          "trial_used.json": { phones: {}, ips: {}, googleIds: {} }
        };
        for (const [f, v] of Object.entries(_empty)) {
          try { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2)); }
          catch (e) { console.warn("[reset] " + f + ":", e.message); }
        }
        try { fs.unlinkSync(path.join(DATA_DIR, "backup.json")); } catch {}
        try { fs.rmSync(path.join(DATA_DIR, "cvs"), { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(path.join(DATA_DIR, "cvs"), { recursive: true }); } catch {}
        try { fs.writeFileSync(_tokFile, _resetTok); } catch {}
        console.log("[reset] ✅ Reset concluído. PRESERVADOS: admin_settings, knowledge_base, vagas DOL.");
        } // fim do bloco de wipe (proteção anti-wipe)
      } else {
        console.log(`[reset] RESET_NOW="${_resetTok}" já aplicado antes — ignorando.`);
      }
    }
  } catch (e) { console.error("[reset] erro geral:", e.message); }

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
  _decUsersFromDisk(DB_USERS); // V955: decifra tokens gravados com DATA_ENC_KEY
  DB_HIST   = mig(HIST_FILE,   path.join(DATA_DIR, "h2b_history.json"), {});
  DB_AUTO   = load(AUTO_FILE, {});
  DB_NOTES  = load(NOTES_FILE, {});
  DB_ALERTS = load(ALERTS_FILE, {});
  DB_LOGS   = load(LOGS_FILE, {});
  DB_JOURNEY = load(JOURNEY_FILE, {});
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
  DB_PEDIDOS = load(PEDIDOS_FILE, []);
  if(!Array.isArray(DB_PEDIDOS)) DB_PEDIDOS = [];
  DB_FINANCEIRO = load(FINANCEIRO_FILE, {pagamentos:[],gastos:[],repasses:[]});
  if(!DB_FINANCEIRO.pagamentos) DB_FINANCEIRO = {pagamentos:[],gastos:[],repasses:[]};
  if(!Array.isArray(DB_FINANCEIRO.repasses)) DB_FINANCEIRO.repasses = []; // repasses entre sócios (dinheiro que um já pagou ao outro)
  DB_BLOCKED = load(BLOCKED_FILE, {emails:[]});
  if(!Array.isArray(DB_BLOCKED.emails)) DB_BLOCKED = {emails:[]};
  DB_TRIAL_USED = load(TRIAL_USED_FILE, {phones:{},ips:{},googleIds:{}});
  if(!DB_TRIAL_USED.phones) DB_TRIAL_USED.phones={};
  if(!DB_TRIAL_USED.ips) DB_TRIAL_USED.ips={};
  if(!DB_TRIAL_USED.googleIds) DB_TRIAL_USED.googleIds={};

  // ── Emails Inválidos (bounces) — carregado do disco, persiste entre deploys ──
  const _rawInvalid = load(INVALID_EMAILS_FILE, {});
  DB_INVALID_EMAILS = {};
  for(const [k,v] of Object.entries(_rawInvalid)){
    DB_INVALID_EMAILS[k] = {...v, users: new Set(Array.isArray(v.users)?v.users:(v.users?[v.users]:[]))};
  }
  DB_EMAIL_CORRECTIONS = load(EMAIL_CORRECTIONS_FILE, {});
  DB_TEMP_FAILURES = load(TEMP_FAILURES_FILE, {});
  const _invalidCount = Object.keys(DB_INVALID_EMAILS).length;
  const _tempCount = Object.keys(DB_TEMP_FAILURES).length;
  if(_invalidCount||_tempCount) console.log(`[bounce] ✅ ${_invalidCount} emails inválidos | ${_tempCount} falhas temporárias carregados do disco`);

  // ── Base de Conhecimento Permanente (KB) ──────────────────────────────────
  // Carregada do disco; se vazia, popula com entradas fundadoras do projeto
  DB_KB = load(KB_FILE, { entries: [] });
  if(!DB_KB || !Array.isArray(DB_KB.entries)) DB_KB = { entries: [] };
  // Garante entradas fundadoras sempre presentes (idempotente)
  const _kbFoundingIds = new Set(DB_KB.entries.map(e => e.id));
  const _kbFounding = [
    {
      id:"KB-001",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Robôs classificados como 'travados' quando aguardando limite/rate limit/intervalo/token-retry.",
      solucao:"Excluir statuses waiting_limit, waiting_rate_limit, waiting_interval, waiting_token_retry do critério de travamento em todos os pontos: auditoria, Central de Incidentes e restart-all-stalled.",
      impacto:"Zero falsos positivos. Saúde 35→65/100.",modulos:["server.js: auditoria","server.js: incidentes"],tags:["automação","watchdog","travamento"]
    },
    {
      id:"KB-002",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Tokens expirados de inativos (>10 dias) geravam alertas críticos desnecessários.",
      solucao:"Filtro de inatividade em 6 pontos: incidente só para inativos ≤10d; notificação só para ativos ≤10d; dossiê distingue token-problema-real vs token-inativo-ignorado.",
      impacto:"Painel limpo. Foco nos problemas reais.",modulos:["server.js: incidentes","server.js: watchdogs"],tags:["token","inatividade"]
    },
    {
      id:"KB-003",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Scope OAuth limitado a gmail.send impedia inbox e bounces.",
      solucao:"Adicionar gmail.readonly e gmail.modify. Campo scopeVersion:2. Prompt=consent para usuários sem novos escopos.",
      impacto:"Inbox de respostas funcionando. Bounces detectados.",modulos:["server.js: /oauth/start"],tags:["oauth","gmail"]
    },
    {
      id:"KB-004",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"DB_INVALID_EMAILS nunca carregado no boot — reiniciava vazio.",
      solucao:"load() de bounces, corrections e temp_failures no boot(). Sets serializados como Array.",
      impacto:"Bounces persistem entre deploys.",modulos:["server.js: boot()"],tags:["bounce","persistência"]
    },
    {
      id:"KB-005",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Bounces durante downtime nunca processados ao reiniciar.",
      solucao:"20s após boot: varrer inbox de todos com refresh_token. Sessão temporária por usuário. Pausa 2s entre usuários.",
      impacto:"Bounces do período offline capturados imediatamente.",modulos:["server.js: server.listen"],tags:["bounce","boot"]
    },
    {
      id:"KB-006",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"lockedAutoLimit ignorava expiração do plano — enviava 200/dia mesmo após VIP expirar.",
      solucao:"scheduleAuto verifica isAutoVipActive() a cada ciclo. getAutoLimit(p) em tempo real. vipExpiryWatchdog a cada 1h.",
      impacto:"Trial abuse eliminado. Free users param ao expirar VIP.",modulos:["server.js: scheduleAuto","server.js: vipExpiryWatchdog"],tags:["vip","abuso"]
    },
    {
      id:"KB-007",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Trial multi-conta: recriando email ganhava novo trial.",
      solucao:"DB_TRIAL_USED com IPs, telefones E Google ID (novo jun/2026). Bloqueio por ≥2 contas no mesmo IP. Google ID salvo permanentemente.",
      impacto:"Trial abuse por multi-conta bloqueado por 3 camadas.",modulos:["server.js: OAuth callback","server.js: trial_used.json"],tags:["trial","abuse","google-id"]
    },
    {
      id:"KB-008",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Central de Incidentes ficava em Carregando... — chamada dupla de loadIncidentes() causava race condition.",
      solucao:"Remover chamada duplicada do sidebar. setTimeout(50ms) no showView antes de loadIncidentes().",
      impacto:"Central de Incidentes funciona corretamente.",modulos:["admin.html: showView","admin.html: loadIncidentes"],tags:["incidentes","bug"]
    },
    {
      id:"KB-009",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Modal de detalhe do histórico (hist-detail-overlay) nunca criado no HTML — JS falhava silenciosamente.",
      solucao:"Criar HTML estático do modal. Expandir infoItems com todos os campos DOL.",
      impacto:"Cards de enviadas abrem com dados completos.",modulos:["index.html: hist-detail-overlay"],tags:["modal","histórico"]
    },
    {
      id:"KB-010",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"SHEET_EXTRAS perdidas a cada restart. _autoEnrichCycle hardcoded para jan/jul.",
      solucao:"loadSheets() carrega DB_SHEETS_META + SHEET_EXTRAS do disco. _autoEnrichCycle varre dinâmico. Watchdog 30min.",
      impacto:"Planilhas extras sobrevivem a restarts. Enriquecimento automático.",modulos:["server.js: loadSheets"],tags:["planilhas","boot"]
    },
    {
      id:"KB-011",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Usuários com paused_auth_error sem notificação automática.",
      solucao:"authErrorWatchdog a cada 3h: detecta paused_auth_error >12h em ativos ≤30d e envia email. Botão 1-click no admin.",
      impacto:"Usuários notificados automaticamente. Admin notifica com 1 clique.",modulos:["server.js: authErrorWatchdog"],tags:["auth-error","notificação"]
    },
    {
      id:"KB-012",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Robô de Auditoria com dados mínimos, relatório cortado (4000 tokens), sem memória cumulativa.",
      solucao:"maxOutputTokens:8000. Dossiê expandido. Seção 🧠 APRENDIZADOS extraída e salva na KB automaticamente após cada auditoria.",
      impacto:"Relatório completo. Gemini aprende com cada auditoria.",modulos:["server.js: /api/admin/auditoria-gemini"],tags:["gemini","auditoria","treinamento"]
    },
    {
      id:"KB-013",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Painel admin sem alertas proativos para pedidos críticos e auth_errors.",
      solucao:"Banner vermelho dinâmico no dashboard. Aba ⚡ Críticos em pedidos. Destaque visual nos cards.",
      impacto:"Admin vê problemas urgentes imediatamente.",modulos:["admin.html: dashboard"],tags:["admin","alertas"]
    },
    {
      id:"KB-014",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"UX sem feedback visual de status críticos, VIP expirando, offline, stats no perfil.",
      solucao:"20 melhorias UX: banner offline, banner VIP ≤3d, X limpar busca, mini-stats perfil, toast auto pausado, barra de progresso.",
      impacto:"UX melhorada. Usuário recebe feedback claro.",modulos:["index.html: múltiplos"],tags:["ux","visual"]
    },
    {
      id:"KB-015",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Trial concedia 2 dias VIPro (com automático) — permitia abuso do automático no trial.",
      solucao:"Trial mudado para 1 dia VIP Manual apenas (sem automático). plan:'vip', autoExpires:0. Anti-abuse por Google ID além de IP.",
      impacto:"Automático não disponível no trial. Google ID como 3ª camada anti-abuse.",modulos:["server.js: OAuth callback"],tags:["trial","vip","abuse"]
    },
    {
      id:"KB-016",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Perfil do usuário poluído: avatar solto, Perfil H2B desorganizado, sem hierarquia visual.",
      solucao:"Tela de Perfil aba Eu redesenhada com 5 cards organizados: Hero (avatar+nome+stats), Dados Pessoais, Gmail Extra, Ranking&Avatar (grid 5col), Perfil H2B (mini-cards), Notificações.",
      impacto:"UX moderna. Cada seção em card separado. Avatar grid 5 colunas com border-radius:12px.",modulos:["index.html: ptab-content-me"],tags:["ux","perfil","redesign"]
    },
    {
      id:"KB-017",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Modal de usuário no admin espalhava informações — sem CCC (Client Control Center). Edições sem rastreamento.",
      solucao:"Client Control Center: 11 abas (Visão Geral, Editar, Plano, Pagamento, Docs, Perfis, Auto, Enviados, Saúde, Jornada, Histórico). Toda edição exige senha Andrew(84800-54)/Diego(Diego2026). Log adminEditHistory[] salvo no perfil.",
      impacto:"Admin gerencia clientes completamente em 1 modal. Todas edições rastreadas.",modulos:["admin.html: user-modal CCC","server.js: /api/admin/user/full-update"],tags:["admin","ccc","auditoria"]
    },
    {
      id:"KB-018",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Aprovação de pedido com confirm() simples — sem ver comprovante, sem dias bônus, sem autenticação.",
      solucao:"Modal de Aprovação v2 (bottom sheet): mostra comprovante em tela cheia, botões +0/+5/+10/+15 dias bônus, senha obrigatória Andrew/Diego, Gemini audita automaticamente após ativar, dados financeiros preenchidos no CCC do cliente.",
      impacto:"Zero trabalho manual. Admin vê comprovante, define bônus, confirma com senha. Gemini valida tudo.",modulos:["admin.html: modal-aprovacao","server.js: PATCH /api/pedido/:id"],tags:["pedidos","aprovação","gemini"]
    },
    {
      id:"KB-019",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"drodrigues266@gmail.com enviou 129 emails automáticos sendo Free sem plano VIP ativo.",
      solucao:"Causa provável: job iniciado durante trial ativo, trial expirou mas job continuou com lockedAutoLimit em memória. KB-006 corrigiu via vipExpiryWatchdog. Monitorar recorrência.",
      impacto:"Watchdog de expiração evita reocorrência. Usuário específico deve ser investigado.",modulos:["server.js: vipExpiryWatchdog"],tags:["abuse","free","automático","limite"]
    },
    {
      id:"KB-020",versao:"V900",data:"2026-06-27",autor:"Claude/Andrio",
      problema:"Discrepância contagem planos ativos: resumo mostra 18 mas detalhe mostra 24.",
      solucao:"Causa: resumo usa DB_PEDIDOS.filter(status==='ativo') mas detalhe usa isVipActive(). Usuários com VIP ativo sem pedido formal (ex: ativados diretamente via /api/admin/vip/activate) não aparecem no resumo. Fonte única = isVipActive().",
      impacto:"Usar isVipActive() como fonte única de verdade para métricas de plano ativo.",modulos:["server.js: /api/admin/live","server.js: /api/admin/auditoria-gemini"],tags:["métricas","planos","discrepância"]
    },
    {
      id:"KB-021",versao:"V901",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Central de Incidentes nunca carregava (tela vazia) e download de relatórios (TXT/CSV/JSON) não funcionava. Causa-raiz: aspas simples não escapadas em admin.html linha 7860 — innerHTML='...onclick=\"selectResolution('ignore',this)\"...' fechava a string JS no 'ignore', gerando SyntaxError que QUEBRAVA O BLOCO <script> INTEIRO (linhas 6604–8357). Isso matou ~15 funções únicas desse bloco: loadIncidentes, downloadIncidents, loadFinanceiro, registrarPagamento/Gasto, loadVencimentos, exportVencimentosCSV, loadVipList, vipEmailSearch, loadPedidosLixeira, restaurarPedido, excluirPedido, excluirPermanente, renewVipFromModal, adminSendMessage. O resto do painel parecia funcionar só porque aprovarPedido/adminSetPlan/verComprovante/renderModalCompras estão DUPLICADAS num bloco posterior saudável que as sobrescreve.",
      solucao:"Trocar a string de aspas simples por template literal (crase) na linha 7860 para que as aspas simples internas de 'ignore' sejam literais. Lição permanente: em onclick inline dentro de string JS, SEMPRE usar crase (`) no literal externo — nunca aspas simples — quando o handler contém aspas simples. Um único caractere quebra o bloco <script> inteiro e some com dezenas de funções silenciosamente.",
      impacto:"Central de Incidentes volta a carregar e baixar relatórios. Financeiro, Vencimentos VIP, lista de VIPs, Lixeira de Pedidos e envio de mensagem ao usuário — todos restaurados. Regra de prevenção: validar admin.html com `node --check` por bloco <script> antes de gerar ZIP.",modulos:["admin.html: openResolveModal (linha 7860)","admin.html: bloco script 6604-8357"],tags:["incidentes","syntax-error","aspas","bloco-script","download","financeiro","regressão-oculta"]
    },
    {
      id:"KB-022",versao:"V902",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Textos do trial mentiam para o usuário: front prometia '5 dias VIP grátis' e '400 candidaturas/dia', mas o backend concede 1 dia VIP Manual (200 manuais/dia, sem automático — server.js L204/L4444, PLAN_LIMITS vip:{manual:200}). Também havia limites do plano FREE errados na UI (30 manuais+20 auto) vs config real (20+10), e o amigo indicado aparecia ganhando '5 dias' quando recebe o trial padrão de 1 dia.",
      solucao:"Alinhados todos os textos de boas-vindas ao backend: 1 dia VIP Manual / 200 manuais. Free corrigido para 20+10. Amigo indicado = 1 dia (o INDICADOR continua ganhando +5 dias VIP Manual, +5 se o amigo assinar = correto). Badge de trial usa d.trialDays vindo do backend (fallback 1). Lição permanente: NÚMEROS DE PLANO/TRIAL/LIMITE nunca hardcodados no HTML — sempre vindos de /api/me ou de uma fonte única; senão divergem do backend e quebram a confiança no dia 2.",
      impacto:"Promessa = entrega. Menos churn e menos ticket no dia seguinte. PENDENTE DE DECISÃO DO DONO: card do plano PAGO 'VIP Manual' anuncia 400/dia (L3245) e comentários do server.js L7-10 citam 400/R$49,90, mas PLAN_LIMITS entrega 200 — alinhar para 200 OU subir o backend para 400 (decisão de preço, não alterado nesta entrega).",modulos:["index.html: banner/planos/onboarding/indicação/i18n","server.js: PLAN_LIMITS (referência)"],tags:["trial","conversão","consistência","fonte-única","preço-pendente"]
    },
    {
      id:"KB-023",versao:"V902",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"4 funções globais duplicadas no admin.html (aprovarPedido, verComprovante, adminSetPlan, renderModalCompras) — a 2ª definição vencia e a 1ª virava código morto; editar a errada 'não fazia nada'.",
      solucao:"Removidas as 4 cópias mortas do bloco antigo (verificadas byte-idênticas às vivas antes de apagar). admin.html 12275→12179 linhas. Cada nome agora tem 1 definição. Lição permanente: um nome global = uma definição. Antes de apagar duplicata, confirmar igualdade com a cópia que vence (a última no fluxo de execução).",
      impacto:"Manutenção previsível — editar a função tem efeito. Menos superfície para o bug do KB-021 se repetir.",modulos:["admin.html: blocos script 4 e 5"],tags:["dívida-técnica","duplicatas","manutenção","regressão"]
    },
    {
      id:"KB-024",versao:"V902",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Cadastro/onboarding sem orientação suficiente para iniciantes e estrangeiros — campos sem o 'porquê', sem nota de privacidade, sem explicar as variáveis do e-mail.",
      solucao:"Onboarding enriquecido (mantendo todos os IDs/handlers): intro com tempo estimado, caixa de privacidade ('dados protegidos, nunca compartilhados'), ajuda no WhatsApp ('avisamos quando empresa responder'), caixa de benefício no perfil H2B, dica de currículo H2B, e explicação das variáveis {nome}/{vaga}/{empresa}/{pais}/{telefone}. Contador de passos estático corrigido (1 de 5 → 1 de 7, batendo com OB_ALL).",
      impacto:"Cadastro mais claro, completo e confiável para o público H2B mobile. Lição: enriquecer informação ≠ adicionar campos obrigatórios — manter Mobile First e menos burocracia.",modulos:["index.html: onboarding wizard ob-step-1..5"],tags:["onboarding","ux","cadastro","mobile","conversão","acessibilidade"]
    },
    {
      id:"KB-025",versao:"V903",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Dono não conseguia organizar 'quem pagou e quantos dias de VIP cada um ainda tem' — a informação estava espalhada em 4 telas (VIP & Planos, Vencimentos VIP, Pedidos, Financeiro), exigindo reconciliação manual. Agravado pela divergência de contadores (KB-020) por cálculos no cliente.",
      solucao:"Criada tela única '💳 Pagantes' alimentada por NOVO endpoint GET /api/admin/pagantes que CALCULA TUDO NO SERVIDOR (fonte única): junta usuários (vip.manualExpires/autoExpires via isManualVipActive/isAutoVipActive) com DB_PEDIDOS pagos/ativos (valorTotal + ativadoEm). Retorna por pagante: plano, dias restantes, status (ativo/vencendo≤3d/vencido/sem_data), último pagamento (valor+data), total pago, qtd pedidos. Ordenado por urgência (menos dias primeiro). Frontend: busca, filtro, export CSV e RENOVAR +30 em 1 clique (reusa /api/admin/vip/activate, que acumula dias corretamente). 'Pagante' = tem pedido pago/ativo OU VIP de origem paga/admin (inclui vencidos; exclui trial/código/indicação). Nenhuma tela antiga removida.",
      impacto:"Dono vê numa tela só quem pagou, quanto, quando e quantos dias faltam — e renova sem editar datas. Cálculo no servidor elimina divergência de contador. Lição permanente: métricas de cobrança/dias devem ser computadas no servidor (fonte única), nunca remontadas no cliente a partir de telas separadas.",modulos:["server.js: GET /api/admin/pagantes","admin.html: view-pagantes + loadPagantes/renderPagantes/pagRenovar/exportPagantesCSV"],tags:["pagantes","vip","cobrança","fonte-única","admin","vencimentos","conversão","retenção"]
    },
    {
      id:"KB-026",versao:"V904",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Aba Pagantes mostrava 'sem pagamento registrado' para clientes ativados pelo admin sem pedido em DB_PEDIDOS, deixando o valor pago incompleto. Além disso, o app do usuário bloqueava zoom de pinça (maximum-scale=1), prejudicando acessibilidade para trabalhadores mais velhos/baixa visão.",
      solucao:"Endpoint /api/admin/pagantes passou a usar o LIVRO-CAIXA DB_FINANCEIRO.pagamentos como fonte primária de valor/data (cobre ativações de pedido + lançamentos manuais), com fallback para DB_PEDIDOS e, por último, u.paymentAmount — sem dupla contagem. Receita (mês/total) calculada do livro-caixa quando existe. Removido maximum-scale=1 de index.html e guia.html (mantido viewport-fit=cover para notch).",
      impacto:"Pagantes agora reflete quanto cada um pagou de forma completa e a receita bate com o Financeiro. App acessível com zoom. LIÇÃO DE PROCESSO (incidente real): uma escrita Python com escapes de surrogate (\\uD83E…) lançou UnicodeEncodeError APÓS abrir o arquivo em modo 'w', truncando server.js para 0 bytes. Recuperado do último ZIP entregue. Regra permanente: ao gerar texto com emojis para splice, usar SEMPRE UTF-8 real (nunca \\u-surrogate) e validar tamanho/sintaxe logo após escrever; manter o último ZIP como backup de recuperação.",modulos:["server.js: /api/admin/pagantes","index.html: viewport","guia.html: viewport"],tags:["pagantes","financeiro","fonte-única","acessibilidade","viewport","processo","backup","encoding"]
    },
    {
      id:"KB-027",versao:"V905",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Home não respondia 'o que faço primeiro?' — iniciante sem perfil/currículo ficava perdido (atrito de ativação). Prompts maximalistas pediam 'refatorar tudo nível Big Tech' de uma vez, o que arrisca quebrar um produto que já gera receita.",
      solucao:"Adicionado card inteligente 'Próximo passo' na home (renderNextStep, aditivo e guardado por try/catch): lê o estado real (perfil ativo, currículo via resumeIdx/DOCS, envios do dia, plano, auto) e mostra UMA ação dominante — Criar perfil → Anexar currículo → Buscar vagas → Ver planos (limite) → Ativar automático. Esconde quando não há passo pendente. Entregue também o MAPA + AUDITORIA NÍVEL MUNDIAL (documento) com roadmap priorizado por impacto×risco. Abordagem: nível mundial em incrementos seguros, nunca big-bang.",
      impacto:"Ativação e conversão maiores: o usuário sempre sabe o próximo passo. Risco baixo (aditivo, falha em silêncio). Lição permanente: diante de pedido 'refatore tudo', traduzir em mapa + roadmap priorizado e entregar em incrementos validados — preservar funcionalidades > velocidade de mudança.",modulos:["index.html: renderNextStep + #home-next-step + renderHome","MAPA_E_AUDITORIA_MUNDIAL_2026-06-28.md"],tags:["home","onboarding","ativação","conversão","ux","próximo-passo","roadmap","processo"]
    },
    {
      id:"KB-028",versao:"V906",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Cadastro (onboarding) parecia amador e poluído. Causa principal: a regra .ob-av usava aspect-ratio:1 + font-size:24px numa grade de 5 colunas, fazendo cada avatar do ranking virar um quadradão de ~65px — 20 deles dominavam a tela ('ícones gigantes'). Além disso, cada passo tinha um emoji flutuante gigante (28-32px) como cabeçalho, reforçando o ar improvisado.",
      solucao:"Avatares do ranking redesenhados estilo Facebook: regra ESCOPADA (#ob-avatar-grid .ob-av) com círculos de 44px (border-radius:50%, aspect-ratio:auto), grade responsiva repeat(auto-fit,44px) centralizada — sem afetar a grade de avatares do perfil (prf-av). Emojis-cabeçalho de TODOS os passos (1,1b,1c,2,3,4) padronizados em badge circular limpo (54px, fundo gradiente suave). Label do avatar com dica 'toque para selecionar'. O 🎉 do passo final (celebração) mantido grande de propósito.",
      impacto:"Cadastro limpo, compacto e profissional, mobile-first. Lição permanente: avatares/ícones de seleção devem ser círculos de tamanho fixo (~44px), nunca quadrados full-cell com aspect-ratio:1 em grade de poucas colunas. Ao reestilizar, ESCOPAR por id do container (#ob-avatar-grid) para não afetar outras grades que compartilham a classe (.ob-av também é usada por .prf-av no perfil).",modulos:["index.html: .ob-av CSS escopado + #ob-avatar-grid + cabeçalhos dos passos do onboarding"],tags:["cadastro","onboarding","avatar","ranking","ui","mobile","css-escopado","poluição-visual"]
    },
    {
      id:"KB-029",versao:"V907",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Gemini do site precisava de mais contexto permanente para 'já saber o que fazer sempre' que o site sobe — faltava no dossiê a arquitetura técnica e as regras de desenvolvimento (só tinha negócio/planos).",
      solucao:"Adicionada ao dossiê do Gemini a seção 12 'ARQUITETURA TÉCNICA & REGRAS DE DESENVOLVIMENTO' (conhecimento permanente): stack, modelo de dados (DB_USERS/PEDIDOS/FINANCEIRO/REFERRAL/INCIDENTS/LOGS/KB), funções-chave (getUser/setUser, httpsReq, isVipActive...), 10 regras críticas que NUNCA podem ser quebradas, mapa de telas e como o Gemini deve agir. Referências antigas 'KB-001 a KB-020' atualizadas para 'todas as KB resolvidas'. Incluído README_DEPLOY.txt no ZIP. Splice feito em UTF-8 real (lição KB-026).",
      impacto:"Toda auditoria do Gemini agora carrega o cérebro técnico completo do projeto — diagnósticos mais precisos, menos falsos positivos, sugestões alinhadas à arquitetura. Lição: o 'treinamento' do Gemini = base de conhecimento (DB_KB) + dossiê injetados no prompt a cada auditoria; persiste em /data/knowledge_base.json e só soma. Enriquecer = adicionar seções ao dossiê e entradas KB, nunca apagar.",modulos:["server.js: dossiê Gemini seção 12 + regras","README_DEPLOY.txt"],tags:["gemini","conhecimento","dossiê","arquitetura","memória-evolutiva","deploy"]
    },
    {
      id:"KB-030",versao:"V908",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"O proprietário definiu a CONSTITUIÇÃO MESTRE DE EVOLUÇÃO CONTÍNUA DA IA — carta irrevogável: memória permanente (nunca apagar/substituir/reduzir conhecimento; só somar), mentalidade de dono, aprendizado acumulativo, comparação entre versões, detecção de bugs/segurança/performance, escalabilidade e relatório obrigatório. Faltava embuti-la no cérebro do Gemini.",
      solucao:"Constituição incorporada como DIRETRIZ SUPREMA no topo do prompt do Gemini (lida em TODA auditoria, com prioridade máxima), com 9 mandatos condensados. Relatório do Gemini ganhou seções 'Comparação com a versão anterior' e 'Gargalos futuros (escalabilidade)'. Texto integral preservado em CONSTITUICAO_IA_H2BAPPLY.txt (no projeto). Princípio reforçado em todo o sistema KB: NUNCA apagar entrada; só somar (já garantido pela política de dedup que mantém ids/versões distintos).",
      impacto:"Gemini passa a operar permanentemente sob a Constituição do dono: acumula conhecimento indefinidamente, compara versões, pensa como dono e nunca reinicia memória. Lição permanente e irrevogável: conhecimento do projeto só CRESCE; toda nova versão deve deixar a IA mais inteligente que a anterior.",modulos:["server.js: prompt Gemini (diretriz suprema) + relatório","CONSTITUICAO_IA_H2BAPPLY.txt"],tags:["constituição","memória-permanente","gemini","governança","evolução-contínua","dono"]
    },
    {
      id:"KB-031",versao:"V909",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Aba 'Eu' do perfil estava poluída: a grade de avatares do ranking (classe .prf-av, container repeat(5,1fr)) usava aspect-ratio:1 + border-radius:12px INLINE, gerando 20 quadradões gigantes que ocupavam ~60% da tela. O mesmo problema do cadastro (KB-028), mas nesta grade os estilos eram inline (a correção de classe simples não pegava).",
      solucao:"Container ganhou id #prf-avatar-grid (grade responsiva repeat(auto-fit,44px) centralizada). CSS escopado #prf-avatar-grid .prf-av com !important para VENCER os estilos inline: width/height 44px, aspect-ratio:auto, border-radius:50%. Resultado: círculos compactos estilo Facebook, igual ao cadastro. Label centralizado com dica 'toque para escolher'. Restante da aba é formulário padrão (toggles cfgToggle/cfgEng, área, CNH) — preservado.",
      impacto:"Aba 'Eu' limpa e profissional; avatares deixaram de dominar a tela. Lição permanente: quando o estilo problemático é INLINE (não em classe), a correção via CSS precisa de seletor mais específico + !important (ex.: #container .classe{...!important}); ou editar o inline. Avatares de seleção = sempre círculos fixos ~44px.",modulos:["index.html: #prf-avatar-grid + CSS .prf-av escopado (aba Eu do perfil)"],tags:["perfil","avatar","ui","mobile","css-inline","!important","poluição-visual"]
    },
    {
      id:"KB-032",versao:"V910",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Auditoria Gemini deu 55/100 por DOIS falsos-críticos causados por bugs de métrica no PRÓPRIO dossiê: (1) 'Discrepância de receita' — Resumo Geral somava DB_PEDIDOS.status==='ativo' (R$2450, conta pedidos cujo VIP já expirou) enquanto Financeiro usava isVipActive (R$1319,90); (2) 'Envios 7 dias por plano: 0 emails' em TODOS os planos, enquanto o total era 17.673 — o por-plano lia DB_HIST (vazio) e o total lia DB_LOGS (status==='enviado'). O e-mail automático ESTAVA funcionando; a métrica é que estava quebrada.",
      solucao:"(1) totalReceita do Resumo agora usa a MESMA fonte canônica do Financeiro (isVipActive + paymentAmount) — discrepância eliminada. (2) _enviosPorPlano reescrito para usar DB_LOGS com filtro l.ts>since7 && l.status==='enviado' (mesma fonte do total), agrupado por getPlan — agora bate com o total. Resultado: dossiê internamente consistente; Gemini para de reportar falsos-críticos e a nota sobe de forma legítima.",
      impacto:"Nota da auditoria reflete a realidade (o sistema enviou 17.673 e-mails em 7 dias — automático OK). Lição permanente: TODA métrica do dossiê deve usar a MESMA fonte canônica das outras seções (receita=isVipActive; envios=DB_LOGS status enviado). Nunca misturar DB_HIST e DB_LOGS. Itens reais que restam são OPERACIONAIS (aprovar pedidos pagos pendentes, renovar VIP a vencer via aba Pagantes, pedir relogin de auth_error), não bugs de código.",modulos:["server.js: dossiê Gemini — totalReceita (linha ~8110) e _enviosPorPlano (~8146)"],tags:["gemini","métricas","receita","envios","fonte-única","falso-positivo","DB_LOGS","auditoria"]
    },
    {
      id:"KB-033",versao:"V911",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"E-mail de novo pedido para os admins dizia 'Comprovante: ANEXADO a este email' mas o anexo NUNCA ia. Causa-raiz: o front salva o comprovante como base64 PURO (index.html: e.target.result.split(',')[1]) com o tipo guardado à parte (comprovanteType), mas o código do e-mail só montava o anexo quando a string começava com 'data:' (pedido.comprovante.startsWith('data:')) — condição que nunca é verdadeira. O texto usava pedido.comprovante? (truthy) e o anexo exigia 'data:' → texto e realidade divergiam.",
      solucao:"Bloco de anexo reescrito para aceitar AMBOS: se casar /^data:([^;]+);base64,(.+)$/ usa o data URL; senão usa pedido.comprovanteType + o base64 puro. O buildMime já espera data=base64 puro. Lição permanente: quando o texto do e-mail afirma que há anexo, a CONDIÇÃO que monta o anexo tem que usar o MESMO sinal do texto — e o formato salvo do comprovante neste sistema é base64 puro + comprovanteType, nunca data URL.",
      impacto:"Andrew e Diego passam a receber o comprovante anexado no e-mail de pedido. Obs.: o comprovante nunca se perdeu — sempre esteve salvo no pedido e visível no painel (/api/pedido/:id); só o anexo do e-mail falhava.",modulos:["server.js: POST /api/pedido — preparação de attachments (~L5736)","index.html: handler do comprovante (split(',')[1])"],tags:["comprovante","email","anexo","base64","gmail","buildMime","pedido"]
    },
    {
      id:"KB-034",versao:"V911",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Aba Eventos mostrava 'INBOX_EMAILS is not defined'. Em /api/followup/check, a linha usava new Set((INBOX_EMAILS||[]).map(...)) mas INBOX_EMAILS NUNCA foi declarado em lugar nenhum. O operador || NÃO protege contra identificador inexistente (lança ReferenceError antes de avaliar) — só typeof protege. Isso quebrava o endpoint de follow-up.",
      solucao:"Trocado para: const _inboxArr = (typeof INBOX_EMAILS!=='undefined' && Array.isArray(INBOX_EMAILS)) ? INBOX_EMAILS : []; e new Set(_inboxArr.map(...)). Degradação segura (assume sem respostas) sem crash. Lição permanente: para variável que PODE não existir, sempre guardar com typeof X!=='undefined', nunca com (X||default) — || só evita falsy de valor existente, não ReferenceError de identificador não declarado.",
      impacto:"Endpoint de follow-up volta a responder; erro some de Eventos. Investigar à parte se a aba 'Respostas' vazia tem relação (ela usa /api/inbox, fluxo distinto que depende de token gmail.readonly válido).",modulos:["server.js: /api/followup/check (~L5288)"],tags:["bug","reference-error","typeof","eventos","followup","inbox","escopo"]
    },
    {
      id:"KB-035",versao:"V911",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"PRINCÍPIO DE NEGÓCIO recorrente: trial NÃO é VIP e NÃO é pagamento. Um usuário com 1 dia de trial (vip.source==='trial') aparecia/contava como 'VIP' e como 'cliente com plano ativo não validado' em telas do admin (ex.: contagem 'VIP 19' inflada; rótulo enganoso no perfil de quem só tem trial). Isso confunde a operação e a cobrança.",
      solucao:"Regra permanente em TODO o sistema: (1) CONTAGEM — separar sempre 'pagantes (com comprovante/source=payment)' de 'trial (source=trial)' de 'free'; nunca somar trial em 'VIP pago'. (2) RÓTULO — para quem só tem trial, mostrar 'Free — usando trial de 1 dia', nunca 'plano ativo'. (3) CÁLCULO — trial não ancora nem empilha dias pagos (já tratado em _ehTrial no PATCH /api/pedido: trial não conta como VIP ativo para empilhar, recuperação ancora na data de pagamento). Fonte da verdade do tipo é vip.source.",
      impacto:"Métricas e rótulos passam a refletir o caixa real. Pendente de aplicação nas telas do admin (Todos os Usuários: contador; perfil do usuário trial: rótulo) — registrado para a próxima entrega de UI.",modulos:["server.js: vip.source / isVipActive / cálculo de dias","admin.html: Todos os Usuários (contador) e card de perfil (rótulo) — A FAZER"],tags:["trial","vip","pagamento","contagem","rótulo","fonte-única","princípio","cobrança"]
    },
    {
      id:"KB-036",versao:"V911",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Lote de UI: (1) Modo escuro ilegível na aba Manual — campos da vaga (Salário, Período, Classificação SOC, ETA Case, Funções da vaga) ficavam texto branco sobre fundo branco porque .info-box tinha fundo CLARO fixo (#fafbff,#f5f3ff) e NENHUM override [data-theme=dark]. (2) Nome do app no topo (.app-logo-text) com color:#1e1b4b fixo — sumia no dark e não destacava. (3) Planos vinham com VIPro pré-selecionado (radio checked + classe selected + círculo roxo no HTML) e updatePlanCalc tinha default ||'vipro', então re-selecionava sozinho. (4) Card do Automático DESLIGADO mostrava texto branco (#fff inline) sobre card branco (.home-auto-card.inactive) = 'tela branca'.",
      solucao:"(1) Adicionado [data-theme=dark] .info-box (fundo escuro) + .info-val/.info-lbl legíveis. (2) .app-logo-text virou gradiente roxo da marca com background-clip:text (destaca nos 2 modos). (3) Removido checked/selected/círculo do VIPro no HTML; updatePlanCalc agora usa plan=null quando nada marcado (círculos vazios + prompt 'Selecione um plano' em vez de preço); goToPlanStep2 exige seleção. Selo MAIS POPULAR mantido. (4) Estado desligado virou card roxo CTA com texto branco legível + mensagem de valor ('Inicie o seu Automático. Envie currículos enquanto trabalha. Não garantimos a vaga, garantimos que seu currículo chegue ao empregador'). Lição permanente do dark mode: o padrão é claro e o dark sobrescreve via [data-theme=dark] .classe — TODO fundo claro fixo precisa de um override dark, senão vira texto-claro-sobre-fundo-claro; nunca deixar color:#fff inline em elemento cujo fundo muda de tema.",
      impacto:"Aba Manual legível no escuro; nome do app destacado; escolha de plano consciente (nada empurrado); Automático desligado comunica valor em vez de tela branca. PENDENTE (próximas entregas): regras novas de indicação (manual→automático, +1/+1 cadastro, +5 compra) em 6 sites espelhados; contador 'Todos os Usuários' separar pagantes/trial/free; cálculo de Planos só pagantes; Incidentes de token expirado deixarem de ser acionáveis; features grandes (Notificações Gemini, deletar conta, redesenho Automáticos).",modulos:["index.html: .info-box dark, .app-logo-text, cards de plano + updatePlanCalc + goToPlanStep2, render do home-auto-card","admin.html: rótulo trial no perfil (ccc-validation-result)"],tags:["dark-mode","contraste","planos","seleção","automático","ux","legibilidade","trial","roadmap"]
    },
    {
      id:"KB-037",versao:"V912",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"NOVA REGRA DE NEGÓCIO (dono): indicação deixou de dar dias MANUAIS e passou a dar AUTOMÁTICO — cadastro = +1d automático para os DOIS lados (indicador e indicado); compra de QUALQUER plano pelo indicado = +5d automático extra pro indicador (era +5d manual só pro indicador no cadastro, sem nada pro indicado, e o bônus de compra estava MORTO — ver KB-038). Mapeados 5 pontos de concessão no código: (1) OAuth callback signup (vivo), (2) PATCH /api/pedido ativação (lia chave morta), (3) admin set-plan direto (lia a mesma chave morta), (4)/(5) dois endpoints standalone /api/referral/register e /api/referral/purchase (nunca chamados por nada).",
      solucao:"(1) Reescrito: indicador +1d autoExpires (era manualExpires+5); NOVO — indicado também recebe +1d autoExpires por cima do trial. (2) e (3) Reescritos para ler DB_REFERRAL.byEmail[email]?.referredBy (a fonte REAL, mesma do cadastro) em vez da chave morta `ref:${email}` em DB_USERS que nunca era escrita; guard bonus2Paid evita repetir em renovações; removido o gate diasBase>=30/days>=30 — agora QUALQUER plano conta; +5d em autoExpires (não manualExpires). Math.max(now, autoExpires atual) preserva o que a pessoa já tinha (nunca subtrai). Front-end (index.html: card de Indicar Amigos + i18n ref_step2_html/ref_step3_html) e a soma de 'totalVipDays' em /api/referral/info atualizados para os novos valores (1+5, não mais 5+5).",
      impacto:"Indicação agora soma automático de verdade (cadastro 1+1, compra +5 — empilha sobre o que a pessoa já tem). Bônus de compra, que NUNCA disparava na prática (chave morta), agora funciona. Math testado: cadastro sem nada prévio → +1d cada lado; indicador com 10d prévios → 11; compra com indicador já com 1d (do cadastro) → 6; compra sem nada prévio → 5.",modulos:["server.js: OAuth callback (~L4700-4725), PATCH /api/pedido (~L6000), admin set-plan (~L7130), /api/referral/info totalVipDays","index.html: card Indicar Amigos + i18n ref_step2_html/ref_step3_html"],tags:["indicação","referral","automático","manual","bônus","fonte-única","código-morto","regra-de-negócio"]
    },
    {
      id:"KB-038",versao:"V912",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"FALHA DE SEGURANÇA encontrada ao auditar a indicação: /api/referral/register e /api/referral/purchase eram rotas POST com ZERO autenticação (sem getSess/sessão), recebendo newUserEmail/buyerEmail livremente do corpo da requisição. refCode é PÚBLICO (é o próprio link de indicação mostrado a cada usuário). Um atacante podia: ler o refCode de qualquer usuário, chamar /api/referral/register repetidamente com um newUserEmail FALSO e diferente a cada vez (dedup checava apenas DB_REFERRAL.byEmail[newUserEmail], chave 100% controlada pelo atacante — sempre 'nova'), e conceder dias VIP grátis ao dono do código indefinidamente, sem limite. Confirmado por grep que NADA no projeto (index.html, admin.html, nem o próprio server.js) chamava essas rotas — eram órfãs.",
      solucao:"Rotas DELETADAS por completo (não só desativadas — removidas do código). A lógica de bônus real e seguro já vive nos dois lugares certos, ambos autenticados por construção: cadastro dentro do OAuth callback (chave é o e-mail da sessão Google, não pode ser forjado pelo corpo da requisição) e compra dentro de PATCH /api/pedido + admin set-plan (exigem sessão de usuário/admin válida). Lição permanente: TODA rota POST que concede algo de valor (dias VIP, créditos, dinheiro) precisa de getSess()+checagem de usuário OU estar dentro de um fluxo cuja identidade vem de uma fonte não-forjável (sessão OAuth, sessão admin) — nunca aceitar o e-mail/identidade-alvo como campo livre do corpo sem dono autenticado. Antes de remover/alterar uma rota, sempre grep o projeto inteiro por quem a chama; rota sem nenhum chamador é candidata a código morto OU brecha esquecida — neste caso era as duas coisas.",
      impacto:"Brecha de autoconcessão ilimitada de dias VIP fechada. Nenhuma funcionalidade real perdida (rotas eram inertes — nada as usava).",modulos:["server.js: /api/referral/register e /api/referral/purchase — REMOVIDOS"],tags:["segurança","auth","exploit","referral","vip-grátis","sem-autenticação","código-morto","auditoria"]
    },
    {
      id:"KB-039",versao:"V913",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Bug 'VIP 19' reportado pelo dono: contador na página Todos os Usuários ('⭐ VIP+') e no Dashboard ('s-vip', rótulo 'com plano pago') faziam allUsers.filter(u=>u.plan!=='free').length — e o TRIAL também seta plan:'vip' no signup. Resultado: todo usuário usando o trial gratuito de 1 dia entrava na conta de 'VIP'/'plano pago', inflando o número e confundindo cobrança real com uso gratuito. O filtro 'Clientes pagos' (sf==='paid') tinha o mesmo problema de raiz, só ao contrário: contava qualquer coisa QUE NÃO FOSSE trial como pago — incluindo bônus de admin/indicação, que também não é pagamento real.",
      solucao:"Fonte única e correta: vip.source==='payment' (setado SÓ na ativação real de pedido com comprovante, PATCH /api/pedido) + VIP ainda ativo (manualExpires ou autoExpires > agora). Card 'VIP+' renomeado para '💳 Pagantes' com esse cálculo; trial ativo agora aparece SEPARADO como sub-texto '🆓 N trial' no mesmo card (sem quebrar o grid de 6 colunas). Dashboard 's-vip' segue a mesma fonte, rótulo agora 'N pagantes ativos'. Filtro 'paid' corrigido para exigir vip.source==='payment' explicitamente. Lição permanente: 'plan !== free' NUNCA é sinônimo de 'pagou' — plan é setado por trial/admin/indicação/pagamento igualmente; SÓ vip.source==='payment' confirma dinheiro real recebido com comprovante validado.",
      impacto:"Métricas de Usuários e Dashboard agora refletem pagantes reais, com trial visível separadamente — sem inflar a percepção de quantos clientes pagantes existem.",modulos:["admin.html: users-stats-bar (usb-vip/usb-trial-sub), updateDashboard (s-vip), filtro sf==='paid'"],tags:["contagem","vip","pagamento","trial","fonte-única","métricas","dashboard"]
    },
    {
      id:"KB-040",versao:"V913",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Comprovante de GASTO e de ENTRADA (pagamento manual) ficava SÓ no localStorage do navegador de quem lançou — o código explicitamente descartava a imagem antes de mandar pro servidor ({...record, img:null}), com comentário 'comprovante vive no localStorage do admin'. Consequência real: se Andrio lança um gasto com foto da nota fiscal no celular dele, Diego abrindo o Financeiro em OUTRO navegador/aparelho NUNCA via essa foto — o registro aparecia sem comprovante para ele, quebrando o próprio propósito de 'mostrar com comprovante pros dois sócios'. Bônus: a categoria do gasto (campo 'cat' no front) nunca era enviada como 'categoria' (chave que o backend lê) — sempre caía no default 'geral' no servidor.",
      solucao:"registrarGasto() e registrarPagamento() agora separam o prefixo data:<mime>;base64, da imagem comprimida e enviam comprovante (base64 puro) + comprovanteType pro servidor — mesmo formato/padrão já usado no comprovante de pedido (KB-033). Backend (add_pagamento) ganhou a MESMA validação/sanitização de comprovante que add_gasto já tinha (tamanho, mime allowlist, flag temComprovante, lancadoPor automático pela sessão). Novo endpoint GET /api/admin/pagamento/:id espelha o GET /api/admin/gasto/:id já existente (comprovante sob demanda, fora da listagem). Campo 'categoria' agora vai junto no payload do gasto. Lição permanente: 'fica no localStorage' é uma frase de alerta — sempre que dois admins/sócios precisam ver o MESMO dado, ele tem que estar no servidor; localStorage é por navegador, não é dado compartilhado.",
      impacto:"Comprovantes de gasto e de entrada agora são visíveis por QUALQUER admin, em qualquer aparelho — não mais presos ao navegador de quem lançou. Categoria do gasto passa a ser gravada de verdade no servidor.",modulos:["admin.html: registrarGasto(), registrarPagamento()","server.js: add_pagamento (enriquecido), GET /api/admin/pagamento/:id (novo)"],tags:["comprovante","localStorage","financeiro","gasto","pagamento","sócios","fonte-única","categoria"]
    },
    {
      id:"KB-041",versao:"V913",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Central de Incidentes gerava 2 tipos de incidente ACIONÁVEL (com botões 'Resolver'/'Notificar usuário') para token Gmail expirado / automático pausado por erro de autenticação (token_expired, oauth_expired). Decisão do dono: 'token não é um problema' — quem resolve é o USUÁRIO relogando em h2bapply.com, o admin não tem nenhuma ação real possível, e ele nem quer ter que clicar 'Notificar' manualmente (o aviso automático já existe e roda sozinho via authErrorWatchdog a cada 3h). O mesmo conceito (u.oauthOk===false) também inflava o contador '🚨 Problemas' e o destaque vermelho na página Todos os Usuários, ao lado de problemas reais como jobStalled/hasPdf===false/errors>3.",
      solucao:"Removida a geração dos 2 incidentes (token_expired/tok_*, oauth_expired/auth_err_*) e da mission órfã associada — não entram mais na fila que o dono precisa revisar/decidir. Removido oauthOk===false de _hasProblem() no admin — token expirado não pinta mais o card vermelho nem soma no contador de Problemas. Saúde do token CONTINUA 100% rastreada (healthState/oauthOk, diagnóstico do Robô de Auditoria) — só parou de ser tratado como incidente acionável. Lição permanente: um 'incidente' só deve aparecer numa fila de ação do dono se existir uma ação REAL que ele possa tomar; problemas que só o usuário final pode resolver (e que já têm aviso automático) não pertencem à fila — virar telemetria passiva, não item de decisão.",
      impacto:"Central de Incidentes e contador de Problemas refletem só o que realmente precisa de decisão do dono. Token expirado deixa de aparecer como pendência sua.",modulos:["server.js: geração de incidents/missions (~L4900-4930) — blocos token_expired/oauth_expired removidos","admin.html: _hasProblem() — oauthOk removido"],tags:["incidentes","token","oauth","acionável","escopo-de-decisão","ux-admin"]
    },
    {
      id:"KB-042",versao:"V914",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Feature nova (Lote 5, dono): usuário precisa poder deletar a própria conta a partir de 'Ver tudo' (drawer) → Configurações. Regra exata do dono: a conta 'some pra todos' (ranking e qualquer lugar público), mas os DADOS continuam guardados (nada é apagado de verdade), e relogando com o MESMO e-mail a conta 'volta ao normal' automaticamente — sem precisar recriar nada nem perder histórico/VIP.",
      solucao:"Soft-delete: novo campo user.accountDeleted (+deletedAt). Endpoint POST /api/account/delete (autenticado, exige {confirm:true}): seta a flag, pausa o automático se estiver rodando (setAutoJob status paused_account_deleted + limpa o timer), destrói a sessão (mesmo padrão do /api/disconnect) e loga em addLog+trackJourney. calcRanking() agora pula accountDeleted (mesmo padrão do DB_RANK_HIDDEN já existente). scheduleAuto() ganhou guarda defensiva extra contra corrida (um setTimeout em voo no instante exato do delete). RESTAURAÇÃO: no ramo de usuário EXISTENTE do OAuth callback (não no ramo de usuário novo — crucial para não reconceder trial), se ex.accountDeleted, limpa a flag automaticamente no mesmo setUser do login normal e loga journey 'account_restored'. UI: nova view 'settings' (drawer ganhou item 'Configurações'), com card de conta + 'Zona de perigo' + modal de confirmação explicando exatamente o que acontece antes de confirmar. Admin: accountDeleted exposto no resumo de cada usuário + badge '🗑️ Deletada pelo usuário' na lista (transparência entre Andrio/Diego — não é um bug se o usuário simplesmente parou de aparecer).",
      impacto:"Usuário tem controle real sobre sua visibilidade pública sem perder dado nenhum; admin entende imediatamente por que alguém 'desapareceu' (badge, não suspense). Restauração é automática e silenciosa — exatamente como o dono pediu. Lição permanente: ações de exclusão de usuário-final em produto com histórico/financeiro real quase sempre devem ser SOFT-delete (flag + filtro nas listas), nunca DELETE físico — a reversibilidade é o que torna a feature seguramente oferecível ao usuário sem medo de erro.",modulos:["server.js: POST /api/account/delete (novo), calcRanking, scheduleAuto (guarda), OAuth callback ramo existente (restauração), resumo admin (+accountDeleted/deletedAt)","index.html: drawer (+Configurações), view v-settings (nova), modal #del-acc-m, _populateSettingsView/openDeleteAccountModal/confirmDeleteAccount","admin.html: badge 🗑️ no card do usuário"],tags:["conta","deletar","soft-delete","privacidade","ranking","restauração","drawer","configurações"]
    },
    {
      id:"KB-043",versao:"V915",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Reclamação do dono: aba Automáticos tinha 'muita coisa que não tá nem cabendo na tela'. Causa-raiz: buildWorkersTable() gerava uma <table> de 6 colunas (Usuário/Status/Por que·O que fazer/Progresso/Timings/Ações), cada célula empilhando 3-5 sub-informações (checklist de saúde, badges de restart/erro, caixa de diagnóstico, barra de progresso + %+dias restantes+hoje, último envio+próximo envio+falhas+duplicados+pulados). Em tela de celular isso só funciona com scroll horizontal forçado ou texto ilegível — exatamente o sintoma relatado. Pedido específico: 'miniatura' por usuário com info chave (quantos enviou hoje, qual foi o último, qual), e clicar na pessoa abre tudo.",
      solucao:"buildWorkersTable() reescrita por completo (MESMO nome/assinatura — função compartilhada por 3 chamadores: view principal de Automáticos, filterWorkers, e o widget 'top 10' do Dashboard — todos ganharam o redesign de uma vez sem precisar tocar nos chamadores). Tabela → grid responsivo de cards (CSS grid auto-fill minmax(290px,1fr) — 1 coluna no celular, várias em tela larga, sem precisar de breakpoint manual). Cada card mostra o MÍNIMO quando saudável (nome+status pill+hoje enviado+último enviado de verdade, filtrando recentLogs por status==='enviado' em vez de mostrar qualquer log) — e SÓ exibe a caixa de diagnóstico (motivo+ação) quando há problema real (isProb||isWarn), em vez de sempre. Card inteiro é clicável → abre o modal de detalhe completo já existente (openUser, com abas overview/auto/pdfs/journey/etc.) — preservando 100% da informação detalhada, só tirando da lista o que não precisa estar sempre visível. Removido um bloco de ~45 linhas de código MORTO (a implementação antiga da <tr>/<table> ficou órfã fora da função depois da reescrita — identificado e limpo antes de validar).",
      impacto:"Lista de Automáticos passa de tabela ilegível no celular para cards de '1 olhada' — saudável é compacto, problemático já mostra o motivo na lista (sem precisar abrir), e tudo continua acessível com 1 toque. O mesmo ganho se propaga de graça pro widget do Dashboard, que usa a mesma função. Lição permanente: ao redesenhar uma função compartilhada por múltiplos chamadores, MANTER nome+assinatura (input/output) é o que permite trocar a implementação inteira sem tocar em quem chama — e sempre re-visualizar o trecho IMEDIATAMENTE após o novo `}` de fechamento, porque é onde sobra código órfão da versão antiga quando o `return` é movido pra mais cedo.",modulos:["admin.html: buildWorkersTable() — reescrita completa, mesmo nome (3 chamadores: renderWorkersTable, filterWorkers, renderDashWorkers)"],tags:["automáticos","mobile-first","cards","tabela","ux-admin","refatoração","código-morto","1-olhada"]
    },
    {
      id:"KB-044",versao:"V916",data:"2026-06-28",autor:"Claude/Andrio",
      problema:"Reclamação do dono: ao clicar 'Iniciar Coleta' na 'Nova Planilha do DOL' (bot que monta planilha H-2A/H-2B coletando vagas pela URL do Advanced Search do seasonaljobs.dol.gov, e NÃO por ETA case number como o bot de enriquecimento), 'nada acontece'. Diagnóstico: a rota POST /api/admin/sheet/build-from-dol e o frontend dolBuildStart() estavam estruturalmente corretos (sem <form> envolvendo o botão, sem erro de sintaxe, _runDolBuildBot recalcula parsed internamente). Os dois defeitos REAIS encontrados: (1) o bot, ao receber do datahub do DOL um status != 200/429/403, logava apenas '❌ DOL HTTP {status}' SEM o corpo — escondendo a mensagem OData do erro de filtro/campo (ex.: 'Could not find a property named begin_date'), que é exatamente o que diz por que não coletou; e como setava ok=true sem avançar o skip, podia ficar em LOOP repetindo a mesma página com erro. (2) frontend não dava feedback garantido (r.json() podia lançar em resposta não-JSON e o botão não tinha type=button nem trava anti-duplo-clique). NÃO foi possível testar a API ao vivo (api.seasonaljobs.dol.gov fora do sandbox) — por isso a correção foca em tornar a falha VISÍVEL no log em vez de adivinhar campos.",
      solucao:"server.js: no _runDolBuildBot, ramo de status inesperado agora loga o corpo da resposta (snippet 300 chars com a mensagem do DOL) e ABORTA após 5 erros seguidos (_dolBuildBot.errors>=5 → running=false) em vez de loopar. admin.html: botão 'Iniciar Coleta' ganhou type=\"button\"; dolBuildStart() reescrito — clamp de targetCount (50..5000, ajusta no campo se passar), parse de JSON tolerante a resposta não-JSON, feedback SEMPRE com status HTTP + mensagem do servidor ('Erro ao iniciar (400): ...'), e trava o botão (disabled/opacity) durante a chamada com finally. Lição permanente: quando um bot que fala com API externa 'não faz nada', o conserto de maior valor (e o único honesto sem poder testar a API) é EXPOR o erro bruto da resposta no log em tempo real — status + corpo — e blindar contra loop; adivinhar nome de campo às cegas é pior que mostrar a mensagem que a própria API já devolve.",
      impacto:"O 'Iniciar Coleta' agora sempre dá retorno claro (sucesso ou o motivo exato), nunca trava em loop, e o log em tempo real do bot passa a mostrar a mensagem do DOL quando a coleta falha — transformando 'nada acontece' em diagnóstico acionável. Bot H-2A é o MESMO motor do H-2B (só muda visa_class no filtro e a detecção H-300=H-2A / H-400=H-2B pelo case number); a diferença para o bot de enriquecimento é a fonte: coleta = busca OData pela URL; enriquecimento = abre cada vaga por ETA case number.",modulos:["server.js: _runDolBuildBot (ramo de erro: corpo no log + aborta após 5 erros)","admin.html: botão Iniciar Coleta (type=button) + dolBuildStart() reescrito (clamp, feedback garantido, trava anti-duplo-clique)"],tags:["dol","planilha","h2a","h2b","coleta","seasonaljobs","odata","diagnóstico","log","bot","loop","feedback"]
    },
    {
      id:"KB-045",versao:"V917",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Dono clicou 'Iniciar Coleta' (Nova Planilha do DOL, H-2A) e 'nada aconteceu' — nem o log apareceu. Causa-raiz dupla: (A) FRONTEND — a caixa de log da COLETA (#dol-build-log, dentro de #dol-build-progress-area) só era exibida via dolBuildShowProgress() DEPOIS de a chamada retornar ok; se a chamada falhava antes disso, o usuário não via NADA (o log visível atrás do modal era o do bot de ENRIQUECIMENTO, outro bot). (B) BACKEND — a coleta usa o datahub do DOL com $filter (visa_class/begin_date) + $orderby (dhTimestamp); se o DOL recusa um desses campos (400), o bot só errava. Não foi possível testar a API ao vivo (api.seasonaljobs.dol.gov bloqueada no sandbox; curl deu 403 no proxy). Confirmado que o MESMO endpoint/filtro é usado por fetchDOL() do enriquecimento — então o que comprovadamente funciona em produção é o caminho $search (fetchByCase), não necessariamente o $filter/$orderby.",
      solucao:"FRONTEND (admin.html): dolBuildStart() reescrito para FECHAR o modal e CHAMAR dolBuildShowProgress() IMEDIATAMENTE no clique (antes do fetch), limpar e escrever no #dol-build-log na hora ('🚀 Iniciando', '🔗 url', '📡 Enviando...'). Nova função dolBuildLogLine(msg,type) injeta linhas client-side direto na caixa; o poll (dolBuildPoll) só sobrescreve o log quando o servidor já tem linhas (d.log?.length), então as linhas-cliente servem de ponte e, em erro, PERMANECEM visíveis. Qualquer falha (HTTP recusado, rede) agora é escrita no log E em toast. BACKEND (server.js _runDolBuildBot): degradação progressiva — flags _useOrderby/_useBeginDate; ao receber 4xx, REMOVE $orderby (1º) e depois o filtro begin_date (2º, passando a filtrar a data no lado do servidor por j.begin_date), refazendo a MESMA página (attempt-- para não perder tentativa) em vez de falhar; só conta erro/aborta (após 5) quando já totalmente degradado. Corpo da resposta do DOL é logado para diagnóstico. Resultado: a coleta funciona mesmo se o DOL mudou/recusou um nome de campo, e o usuário SEMPRE vê o log.",
      impacto:"Clicar 'Iniciar Coleta' agora SEMPRE mostra a caixa de log com o que está acontecendo (ou o motivo do erro), nunca mais 'nada acontece'. O bot de coleta passa a se auto-adaptar a recusas de campo do DOL (degradação) em vez de morrer calado. Lição permanente: (1) UI de processo longo deve revelar o painel de progresso/log NO CLIQUE, nunca só no sucesso — o estado de falha é o que mais precisa ser visível; (2) bot que depende de campos OData de API externa que não controlamos deve degradar campo a campo (orderby→filtros), não exigir o esquema completo; (3) quando há dois caminhos para a mesma API e um (search/fetchByCase) já roda em produção e o outro (filter) é suspeito, o filtro é o primeiro réu.",modulos:["admin.html: dolBuildStart() reescrito + dolBuildLogLine() novo (log no clique)","server.js: _runDolBuildBot (flags _useOrderby/_useBeginDate, degradação em 4xx, filtro begin_date client-side)"],tags:["dol","coleta","h2a","log-no-clique","degradação","odata","orderby","begin_date","ux","diagnóstico","resiliência"]
    },
    {
      id:"KB-046",versao:"V918",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"BUG-RAIZ do 'Iniciar Coleta' que travava em 0% no log 'Enviando pedido ao servidor...' e nunca saía disso: a rota POST /api/admin/sheet/build-from-dol fazia `const b=body;` referenciando uma variável `body` que NÃO existe no escopo do handler do http.createServer (todas as outras rotas leem o corpo com `JSON.parse(await readBody(req))`; não há body parser global). Resultado: `body is not defined` → o handler async lançava → NENHUM json(res,...) era enviado → a requisição HTTP ficava pendurada pra sempre → o fetch do front nunca resolvia → travava em 'Enviando...'. Como _dolBuildBot.running nunca virava true, o painel de progresso também 'sumia' ao sair/voltar da aba (a restauração em switchView depende de d.running||d.finishedAt, que ficavam falsos).",
      solucao:"server.js: a rota agora lê o corpo de verdade — `let b={}; try{ b=JSON.parse((await readBody(req))||'{}'); }catch{ return json(res,400,...) }` — antes de desestruturar searchUrl/sheetKey/sheetName/targetCount. Com isso a rota responde, o _runDolBuildBot inicia (running=true síncrono no topo, antes do 1º await), o poll assume e o painel é restaurado automaticamente ao voltar pra aba (lógica já existente, que só não disparava porque o bot nunca rodava). Isso, somado ao KB-045 (log no clique + degradação de campos), fecha o caminho inteiro: clique→servidor→bot→log→persistência.",
      impacto:"'Iniciar Coleta' deixa de travar e realmente inicia a coleta; o painel de progresso/log persiste ao sair e voltar da aba enquanto roda (e mostra o estado final quando termina). Lição permanente e crítica: em handler http.createServer SEM body-parser global, TODA rota POST precisa ler o corpo explicitamente com readBody(req) — referenciar um `body` 'mágico' não só falha como PENDURA a conexão (pior que um erro, porque não há resposta nem stack visível pro usuário). Sempre que um POST 'trava sem responder', o primeiro suspeito é resposta nunca enviada por exceção não-capturada no handler (ex.: destructuring de undefined).",modulos:["server.js: POST /api/admin/sheet/build-from-dol — leitura correta do corpo via readBody(req) (era `const b=body` com body inexistente → request pendurada)"],tags:["dol","coleta","bug-raiz","readBody","request-pendurada","handler","exceção-não-capturada","persistência-aba","crítico"]
    },
    {
      id:"KB-047",versao:"V919",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Dono publicou a planilha H-2A (5000 vagas, coleta funcionou e enriqueceu 100% — case H-300, email, datas, salário, SOC, visa corretos) mas ela NÃO apareceu para o usuário no Manual nem no Automático. Causa-raiz: (1) a rota build-publish só setava _dolBuildBot.published=true (flag transitória em memória) — não marcava nada persistente em DB_SHEETS_META; (2) MAIS GRAVE: o frontend (index.html) tem os SELETORES DE FONTE hardcoded só com jan2026 e jul2025 (chips do Manual ~L2853, botões do Automático #source-btns ~L3714, contadores ~L6226) — não existia lista dinâmica de planilhas, então NENHUMA planilha nova jamais apareceria, por mais que fosse publicada. getAllSheets() já incluía as extras, e /api/sheet-meta já serve qualquer chave genérica — só faltava o usuário PODER SELECIONAR a planilha. Categoria das H-2A vinha como 'other' porque detectCategory usava só o nome da empresa (não o título/SOC 'Farm Worker').",
      solucao:"server.js: build-publish agora grava DB_SHEETS_META[key].published=true + name + visaType + count e persiste. NOVO endpoint GET /api/sheets-list (auth) retorna as fixas (jan2026/jul2025, sempre) + todas as extras com published===true (key,name,visa,count,emoji). Bot de coleta: k passou a usar detectCategory(empresa+título+SOC) → vagas H-2A 'Farm Worker' caem em 'farm', não 'other' (vale pras próximas, ex. Julho). index.html: nova função loadDynamicSheets() busca /api/sheets-list e INJETA as planilhas extras nos dois seletores (chip no Manual após Jul 2025; botão no #source-btns do Automático) com BADGE do visto (H-2A verde / H-2B azul) — ADITIVO, mantém as fixas, sem regressão. selectSource()/setPesqSrc() já eram genéricos. Chamada em openAutoModal e no DOMContentLoaded.",
      impacto:"Planilhas novas passam a aparecer SOZINHAS para o usuário assim que publicadas — o fluxo do dono para Julho ('só fazer upload e funcionar') agora vale: publicar/upar → /api/sheets-list inclui → loadDynamicSheets injeta nos seletores com o badge do visto → usuário filtra e usa igual às outras → Automático mostra que é H-2A. Lição permanente: quando o backend já trata dados de forma genérica (getAllSheets, /api/sheet-meta por chave) mas 'nada aparece' pro usuário, o gargalo costuma ser uma LISTA HARDCODED no frontend; a correção certa é uma fonte única dinâmica (endpoint que lista) + render injetado, nunca adicionar mais um item fixo no HTML a cada planilha. PENDENTE/refinamento: re-categorizar a planilha H-2A já coletada (k='other') exige re-coletar ou re-upload; novas coletas já saem categorizadas certo.",modulos:["server.js: build-publish (published persistente), GET /api/sheets-list (novo), _runDolBuildBot (k por empresa+título+SOC)","index.html: loadDynamicSheets() nova + chamada em openAutoModal/DOMContentLoaded (injeta extras nos seletores Manual e Automático com badge de visto)"],tags:["planilhas","publicar","h2a","h2b","sheets-list","dinâmico","hardcoded","frontend","filtros","categoria","julho","fonte-única","upload"]
    },
    {
      id:"KB-048",versao:"V920",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"A planilha H-2A coletada SUMIU após o deploy — não pode acontecer (o dono só deve pesquisar no DOL 1x). Causa: planilhas EXTRAS (coletadas em runtime) só carregam de /data/sheets/*.json; se o disco /data não persistir entre deploys, a planilha some. As built-in (Jan/Jul) sobrevivem porque carregam de __dirname (arquivo no repositório). Decisão do dono: embutir a H-2A como BUILT-IN nos próprios arquivos + já com os 20 maiores tipos de vaga H-2A como filtros, marcada como agricultura.",
      solucao:"Planilha H-2A virou BUILT-IN: arquivo h2a_jun2026_compact.json (5000 vagas, 97% com email) commitado no repo e carregado de __dirname no mesmo loop de loadSheets (chave 'h2a' → SHEET_H2A). getSheet('h2a-jun2026') e getAllSheets() incluem SHEET_H2A. /api/sheets-list expõe como built-in (name 'H-2A Agricultura', visa H-2A, emoji 🌾). loadDynamicSheets (index.html) agora injeta tudo que não seja jan2026/jul2025 (inclui a H-2A built-in) nos seletores Manual e Automático com badge verde H-2A. 20 CATEGORIAS H-2A criadas a partir da análise REAL dos SOC/títulos da planilha (crop 2110, equipment_op 1786, livestock 569, sheepherder 125, nursery 107, irrigation 98, construction 41, mechanic 33, supervisor 30, driver 28, grader_sorter/packer 17, cook 12, carpenter 7, ironworker 5, logging 3, inspector 2, fence/truck_driver/meat 1, e other p/ o resto) — detecção por título+SOC+empresa, ordem específico→geral (crop por último antes de other para não roubar de nursery/equipment). CATEGORY_LABELS ganhou rótulos pt-BR legíveis para cada uma (🌱 Lavoura, 🚜 Operador de Máquinas, 🐄 Pecuária, 🐑 Pastor de Ovelhas, etc.). O bot de coleta também passou a categorizar por empresa+título+SOC (KB-047), então futuras coletas H-2A já nascem categorizadas igual.",
      impacto:"A planilha H-2A NUNCA mais some no deploy (está no código, não no disco), aparece sozinha pra todos os usuários no Manual e Automático com badge de agricultura, e tem 20 filtros reais de tipo de vaga + busca + estado + salário, igual às outras. Lição permanente: dado que PRECISA sobreviver a deploy e não pode depender de coleta repetida deve ser BUILT-IN (commitado no repo, carregado de __dirname), não runtime em /data — /data é para enriquecimento/override, não para a fonte que não pode faltar. Filtros de categoria devem ser derivados da distribuição REAL dos dados (SOC/título), não inventados.",modulos:["server.js: SHEET_H2A (3ª built-in no loadSheets), getSheet/getAllSheets, /api/sheets-list (+H-2A), CATEGORY_LABELS (+20 rótulos H-2A)","index.html: loadDynamicSheets injeta H-2A built-in nos 2 seletores","h2a_jun2026_compact.json (NOVO arquivo built-in, 5000 vagas H-2A categorizadas)"],tags:["h2a","agricultura","built-in","persistência","deploy","planilha","20-filtros","categorias","SOC","fonte-única","automático","manual"]
    },
    {
      id:"KB-049",versao:"V921",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"A planilha H-2A built-in carregava e as vagas H-2A já apareciam no feed 'Seasonal', MAS não havia uma ABA/BOTÃO separado de H-2A para o usuário selecionar — nem no Manual nem no Automático. Causa: o seletor visível do Manual são botões .stab (setTab) hardcoded só com seasonal/jan2026/jul2025 (NÃO os .pesq-src-chip que o loadDynamicSheets tinha mirado por engano); o seletor do Automático são .source-btn (#source-btns) hardcoded com jan/jul. O dono exige CERTEZA de que dá pra abrir a planilha H-2A e enviar pelo Manual E pelo Automático.",
      solucao:"Como a H-2A é built-in PERMANENTE, fixei a aba/botão dela (garantido), deixando o loadDynamicSheets só para planilhas FUTURAS (ex.: Julho). MANUAL: adicionado .stab 'H-2A Agricultura' (#stab-h2a-jun2026, setTab('h2a-jun2026')) com badge verde 🌾 H-2A (.stab-sheet-h2a::after); setTab passou a alternar 'h2a-jun2026' no active; loadTabCounts preenche #sc-h2a. AUTOMÁTICO: adicionado .source-btn 'H-2A Agricultura' (data-src='h2a-jun2026', selectSource) com tag H-2A; loadDynamicSheets preenche #src-h2a-cnt e passou a pular jan/jul/h2a (evita duplicar). Fluxo de envio confirmado ponta a ponta: Manual setTab→/api/sheet-meta?sheet=h2a-jun2026 (getSheet genérico)→abre vaga→envia; Auto selectSource→/api/sheet-categories→wizard coleta cases→/api/auto/start monta fila via getAllSheets() (que inclui SHEET_H2A) por case number→envia.",
      impacto:"Usuário vê 3 abas no Manual (Seasonal, Jan 2026, Jul 2025, H-2A Agricultura) e 3 fontes no Automático, com a H-2A claramente marcada como agricultura, e CONSEGUE abrir e enviar pela planilha H-2A nos dois modos. Lição permanente: o seletor que o usuário realmente vê pode não ser o que o nome do CSS sugere — confirmar QUAL elemento está na tela (aqui .stab/setTab, não .pesq-src-chip) antes de injetar; e para fonte built-in permanente, fixar no HTML é mais confiável que injeção dinâmica (esta fica para itens que variam, como uploads futuros).",modulos:["index.html: .stab H-2A (#stab-h2a-jun2026)+CSS badge, setTab inclui h2a, loadTabCounts #sc-h2a, .source-btn H-2A (#src-h2a-cnt), loadDynamicSheets preenche counts e pula fixas"],tags:["h2a","aba","stab","setTab","source-btn","manual","automático","seletor","built-in","enviar","fixo"]
    },
    {
      id:"KB-050",versao:"V922",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Esdras Silva (e qualquer usuário com VIP MANUAL + automático ativos ao mesmo tempo — badges 'VIP 21 dias' + 'Pro 21 dias') via o limite automático como 0/10 em vez de 0/200. BUG no getPlan: havia um atalho `if(u.plan && u.plan!=='free' && isVipActive(u)) return u.plan;` ANTES de calcular manual/auto. Como o campo u.plan dele estava salvo como 'vip' (setado quando o manual foi concedido), o atalho devolvia 'vip' → PLAN_LIMITS.vip.auto = 10, ignorando que o automático também estava ativo (deveria ser tratado como vipro = 200). NÃO era problema do cadastro do cliente — a conta dele estava correta (manual e auto ativos); o cálculo do plano é que errava. (Separadamente, o popup 'precisa criar um perfil de currículo' NÃO é bug: dispara só quando profiles.length===0; é fluxo normal — o usuário precisa criar um perfil de currículo com CV. O 'Seu perfil está completo' da Home refere-se ao perfil BÁSICO, diferente do perfil de currículo que o automático exige.)",
      solucao:"getPlan reescrito para calcular pelo que está REALMENTE ativo: doublepro continua usando o atalho (único que precisa, p/ limites 400); fora isso → (manual&&auto)→'vipro', (auto)→'vipro' (inclui legado 'pro'), (manual)→'vip', senão 'free'. Removido o atalho genérico `return u.plan` que travava o auto em 10 para quem tinha u.plan='vip' mas automático ativo. Testado: Esdras (vip+auto)→vipro/200; VIP manual puro→10; DoublePro→400.",
      impacto:"Quem tem manual + automático ativos passa a ver e usar o limite correto (200 auto), não mais 10. Lição permanente: NUNCA derivar limite/capacidade do campo u.plan salvo como atalho — u.plan é um rótulo que pode estar defasado em relação às expirações reais (manualExpires/autoExpires). A fonte da verdade do plano EFETIVO é o que está ativo agora (isManualVipActive/isAutoVipActive); só doublepro precisa do rótulo salvo por causa dos limites 400. E lembrar: 'perfil básico completo' ≠ 'perfil de currículo' — o automático exige o segundo.",modulos:["server.js: getPlan (remove atalho genérico u.plan; calcula por manual/auto ativos; doublepro explícito)"],tags:["getPlan","limite-automático","vip","vipro","pro","doublepro","0/10","esdras","fonte-única","u.plan","perfil-currículo"]
    },
    {
      id:"KB-051",versao:"V923",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Contradição na tela do Envio Automático: usuário sem plano automático aparecia com limite 0/10 e ~28 dias restantes (ou seja, JÁ tratado como free 10/dia pelo getAutoLimit) MAS levava faixa vermelha 'Automático pausado — plano expirou. Renove em Planos.' e não enviava nada. Regra do negócio (já anunciada no próprio banner): '10 envios automáticos GRÁTIS/dia para TODOS'. Causa: dois hard-stops paravam o automático sempre que !isAutoVipActive(p), bloqueando até os 10/dia grátis: (1) scheduleAuto setava status 'paused_no_vip'; (2) vipExpiryWatchdog (a cada 15min) re-pausava qualquer job sem VIP — desfazendo qualquer retomada. O limite diário (getAutoLimit=10 p/ free) e o estado 'waiting_limit' (espera até meia-noite) já bastavam para regular; os hard-stops eram redundantes E erravam a regra.",
      solucao:"Removido o hard-stop por VIP no scheduleAuto (agora o fluxo cai direto no controle de limite diário: free=10, vipro=200; ao bater o teto vira waiting_limit e retoma à meia-noite). vipExpiryWatchdog virou no-op quanto a parar por falta de plano (não re-pausa mais ninguém por não ter VIP). MANTIDO intacto o /api/admin/revoke-trial, que para o automático de propósito (punição de abuso de trial — é intencional, não é o bloqueio automático). /api/auto/resume e reactivateAutoJobs já funcionam: como o job não vira mais paused_no_vip, fica ativo e retoma no boot/scheduling. Resultado: todos (free/sem plano/plano expirado) enviam 10 automáticos/dia; pagantes seguem com seu limite maior.",
      impacto:"Acaba a contradição '0/10 + 28 dias + plano expirou'. Free e plano expirado passam a realmente enviar 10 auto/dia, e a faixa vermelha 'plano expirou' deixa de aparecer para eles (paused_no_vip agora só ocorre por revogação manual do admin). Lição permanente: limite e bloqueio são responsabilidades SEPARADAS — quem regula capacidade é o limite diário (getAutoLimit) + waiting_limit; NÃO criar hard-stops paralelos por VIP que contradigam a regra '10 grátis para todos'. Um watchdog 'rede de segurança' que re-aplica um bloqueio errado a cada 15min transforma um bug pontual em bug permanente — cuidado com watchdogs que desfazem correções.",modulos:["server.js: scheduleAuto (removido paused_no_vip por VIP; limite diário regula), vipExpiryWatchdog (no-op para parada por plano), revoke-trial (mantido intencional)"],tags:["automático","10-grátis","free","plano-expirou","paused_no_vip","watchdog","limite-diário","waiting_limit","regra-negócio"]
    },
    {
      id:"KB-052",versao:"V924",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Três pedidos do dono: (1) Gemini deve LER a documentação mestre e devolver as conclusões dele num relatório; (2) quem ativa por link de gift/código NÃO conta como dinheiro nem como VIP pago — conta como categoria 'código' (quantos + quantos dias); (3) a soma total de receita que Andrio e Diego veem no dashboard deve ser a MESMA (todos os pedidos aprovados no sistema, histórico todo), com o sistema de 'adicionar gasto com print' funcionando para DESPESAS.",
      solucao:"(1) Novo endpoint POST /api/admin/gemini-doc-report: lê DOCUMENTACAO_MESTRA_H2BAPPLY.md (embutida no repo) e manda ao Gemini (2.5-flash→2.0-flash→lite) com prompt de auditor pedindo resumo executivo, pontos fortes, riscos, top-5 prioridades, problemas ocultos, recomendação de arquitetura e nota 0-10; admin.html ganhou botão 'Relatório do Gemini' no painel financeiro que abre modal e exibe a análise. (2) GET /api/admin/financeiro agora retorna codGift{usuarios,ativos,diasTotal,lista} calculado de DB_USERS por vip.source==='code' — card '🎁 Código/Gift' no dashboard mostra quantos/ativos/dias e diz 'sem R$'. Código NÃO cria pagamento (redeem-code seta source:'code' e nunca toca DB_FINANCEIRO) → já fora da receita e da contagem de pagantes. (3) Confirmado que a receita = DB_FINANCEIRO.pagamentos, alimentado automaticamente na aprovação de cada pedido (PATCH /api/pedido, com valor real e source 'pedido_automatico'), acumulado e GUARDADO NO SERVIDOR — logo Andrio e Diego leem o MESMO total (50/50 no acerto). Despesas via add_gasto (com comprovante/print, campo pagoPor p/ acerto) já funcionam.",
      impacto:"Dashboard de sócios fica idêntico para os dois (fonte única no servidor), gift/código aparece numa categoria própria sem inflar caixa nem pagantes, e o dono tem um botão que faz o Gemini auditar a própria documentação. Princípio reforçado (KB-029/anteriores): só vip.source==='payment'/pedido aprovado = dinheiro; 'code'/'trial' nunca contam como receita. Lição: contabilidade compartilhada tem que viver no servidor (DB_FINANCEIRO), nunca em localStorage por sócio — senão cada um vê um número.",modulos:["server.js: /api/admin/financeiro (codGift), /api/admin/gemini-doc-report (novo), DOCUMENTACAO_MESTRA_H2BAPPLY.md (embutida)","admin.html: card 🎁 Código/Gift, botão+modal Relatório do Gemini, finLoadFromServer captura codGift"],tags:["financeiro","código","gift","receita","sócios","dashboard","gemini","documentação","relatório","fonte-única","despesas"]
    },
    {
      id:"KB-053",versao:"V925",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"Painel Financeiro mostrava TUDO R$ 0,00 mesmo com vários VIPs 'Pago' na lista (Daniela, Adriel, Eros, Mauricio, Maico, Marjorie...). Andrio e Diego 'não sabiam nada sobre valores'. Causa: loadFinanceiro (admin) calculava a receita SÓ do livro-caixa DB_FINANCEIRO.pagamentos — que só tem ativações recentes (auto-registradas) + lançamentos manuais. Os pagantes aceitos ANTES do livro-caixa automático não estão lá → receita 0. O endpoint /api/admin/pagantes já calculava certo (fin→pedido→paymentAmount), mas o painel não usava essa fonte.",
      solucao:"GET /api/admin/financeiro passou a calcular no servidor receitaReal/receitaMes/qtdPagantes somando TODOS os pagantes, UMA fonte por pagante (sem dupla contagem): livro-caixa (DB_FINANCEIRO) → pedido pago/ativo (DB_PEDIDOS.valorTotal) → u.paymentAmount. Exclui source 'code' e 'trial' (gift/código e trial nunca são receita). admin.html: o painel usa receitaReal para Total Recebido, Lucro, 50% Andrio e 50% Diego; rótulo vira 'N pagantes'. O card 'Acerto entre sócios' (quem recebeu o quê) segue do livro-caixa detalhado — é sub-detalhe; os números do topo refletem o caixa real total que os dois sócios veem igual.",
      impacto:"Andrio e Diego passam a ver a receita real (histórico todo de pagantes), não R$ 0. Ressalva honesta: se um cliente foi ativado SEM valor registrado (nem em pedido, nem paymentAmount), ele soma R$ 0 — é dado faltando, não bug; corrige-se setando o valor (pedido-set-valor ou Registrar entrada). Lição: relatório financeiro deve usar a MESMA fonte canônica server-side em todas as telas (pagantes E painel), nunca um subconjunto client-side; telas divergentes = números divergentes e perda de confiança.",modulos:["server.js: /api/admin/financeiro (receitaReal/receitaMes/qtdPagantes, exclui code/trial)","admin.html: loadFinanceiro usa receitaReal; finLoadFromServer captura os campos"],tags:["financeiro","receita","pagantes","livro-caixa","fonte-única","sócios","histórico","zerado"]
    },
    {
      id:"KB-054",versao:"V926",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"(A) BUG: ao registrar um gasto, ele 'sumia' ao trocar de página e o print não abria. Causa: o gasto era salvo no cache local (finSaveData→localStorage) e o POST add_gasto era 'dispara-e-esquece' com erro engolido (catch vazio); loadFinanceiro só relia do servidor se !_finLoaded, então mostrava o gasto do cache — mas a verdade do servidor (que podia não ter salvo) prevalecia depois. E finVerDetalhes mostrava item.img local, que some quando a lista é relida do servidor (vem sem imagem por peso). (B) Pedido: 20 ferramentas/análises financeiras que Andrio e Diego possam usar.",
      solucao:"(A) add_gasto e add_pagamento agora AGUARDAM o POST, checam r.ok+d.ok, e SEMPRE releem do servidor (_finLoaded=false; finLoadFromServer) — se falhar, toast de erro e nada de falso-sucesso. loadFinanceiro passou a reler SEMPRE do servidor (fonte única). finVerDetalhes busca o comprovante sob demanda em /api/admin/gasto/:id ou /pagamento/:id (a lista vem sem imagem). (B) Novo endpoint GET /api/admin/fin-insights calcula no SERVIDOR ~20 análises (receita total/mês, lucro, ticket médio, despesas total/mês, novos no mês, vencendo em 7d + projeção de renovação, vencidos, gift/código, trials, receita por plano vip/vipro/doublepro, gastos por sócio andrio/diego/empresa, série de 6 meses, top 5 pagantes, despesas por categoria). Botão '📊 Inteligência' abre modal com os 20 cards. Gift/código e trial nunca entram na receita.",
      impacto:"Gasto agora persiste de verdade (servidor é fonte única) e o print abre buscando do servidor; Andrio e Diego têm um painel de inteligência financeira com 20 visões idênticas para os dois. Lição: toda gravação financeira deve AGUARDAR confirmação do servidor e RELER a verdade do servidor — cache otimista sem confirmação gera 'fantasmas' que somem no refresh e quebram a confiança. Imagens pesadas nunca vêm na lista; carregam sob demanda por id.",modulos:["admin.html: add_gasto/add_pagamento (await+reload+erro), loadFinanceiro (relê sempre), finVerDetalhes (comprovante sob demanda), botão+modal finInsights","server.js: /api/admin/fin-insights (20 análises, fonte única)"],tags:["financeiro","gasto","persistência","cache","comprovante","print","inteligência","20-ferramentas","sócios","fonte-única"]
    },
    {
      id:"KB-055",versao:"V927",data:"2026-06-29",autor:"Claude/Andrio",
      problema:"O gasto AINDA sumia mesmo após o KB-054 (que corrigiu o salvamento/reload). BUG-RAIZ verdadeiro: finGetData() — a função que MONTA a tela financeira — lia do localStorage com um TTL de 2 MINUTOS: `if(Date.now()-ts>120000) return {pagamentos:[],gastos:[]}`. Ou seja, ao 'fazer outras coisas' e voltar depois de 2 min, finGetData via o TTL vencido e RETORNAVA VAZIO, apagando o gasto da tela — independente do servidor ter salvo. O reload do servidor (_finCache) estava correto, mas a renderização não usava _finCache, usava localStorage com TTL. Além disso, o dono queria os 20 indicadores VISÍVEIS na aba VIP & Planos, não só num modal.",
      solucao:"finGetData() reescrita para usar _finCache (carregado do servidor por finLoadFromServer) como FONTE ÚNICA; localStorage virou só fallback offline SEM TTL que apaga. O corpo antigo virou _finGetDataLegacy (stub morto). Resultado: o gasto persiste de verdade — a tela sempre reflete o servidor. INLINE: novo container #fin-insights-inline + loadFinInsightsInline() renderiza os 20 indicadores (receita total/mês, lucro, ticket, despesas, novos, vencendo 7d+projeção, vencidos, gift, trials, receita por plano, gastos por sócio, série 6 meses, top 5 pagantes, despesas por categoria) DIRETO na aba VIP & Planos, chamado em loadFinanceiro. O botão '📊 Inteligência' (modal) continua para a versão ampla.",
      impacto:"Fim do gasto que sumia: a fonte da tela é o servidor, sem TTL que zera. Os 20 indicadores agora aparecem na própria aba VIP & Planos, iguais para Andrio e Diego. Lição CRÍTICA: quando há fix no salvamento mas o bug persiste, suspeitar da função que RENDERIZA — ela pode ler de uma fonte diferente (aqui localStorage com TTL) da que foi corrigida (servidor). Cache de leitura com TTL que retorna VAZIO é uma armadilha: parece otimização, mas apaga dados na cara do usuário. Fonte única ponta a ponta: salvar→servidor, ler→servidor, renderizar→servidor.",modulos:["admin.html: finGetData (usa _finCache, sem TTL), _finGetDataLegacy (stub), #fin-insights-inline + loadFinInsightsInline(), loadFinanceiro chama inline"],tags:["financeiro","gasto","TTL","localStorage","finGetData","renderização","fonte-única","20-indicadores","inline","vip-planos","bug-raiz"]
    },
    {
      id:"KB-056",versao:"V928",data:"2026-06-30",autor:"Claude/Andrio",
      problema:"Pedido central do dono: usuário pagante com múltiplos Gmails precisa ESCOLHER quais e-mails enviam (Auto e Manual), com rodízio ESTRITO 1 a 1 entre os escolhidos (1 do principal, 1 do 2º, 1 do 3º, recomeça — nunca 200 de um e depois 200 do outro). Caso real: cliente com o principal BLOQUEADO pelo Gmail precisa enviar SÓ pelo secundário. Problemas no código: (a) o pool do round-robin sempre incluía principal+todos os extras, sem seleção; (b) o fallback final SEMPRE retornava o principal — usaria o e-mail bloqueado contra a vontade da cliente. Pendentes da sessão: (c) incidente 'VIP vencido sem atualização' era FALSO ALARME (vip.active é rótulo; getPlan/limites já voltam ao free sozinhos; com 10/dia grátis não há ação humana); (d) aba Pagamento do CCC mostrava 'COMPROVANTES (0)' pois só lia o localStorage do admin — os comprovantes dos PEDIDOS (servidor) não apareciam.",
      solucao:"(1) getSenderToken(owner, requested, allowedSenders): pool filtrado pela seleção; se o principal NÃO está na lista, NUNCA é usado — fallback lança erro claro em vez de voltar ao principal. Alternância 1 a 1 já emerge da ordenação por menor contagem do dia (validado em simulação: principal→2º→3º→principal...). (2) /api/auto/start aceita d.senders (validado contra principal+extras ativos; se todos marcados, null = padrão). Job guarda senders. (3) Motor: getSenderToken(email,null,job.senders); se TODOS os selecionados indisponíveis e principal excluído → devolve a vaga à fila e pausa paused_auth_error com instrução de reconectar (nada enviado pelo e-mail errado). (4) UI Auto: bloco 'Enviar usando quais e-mails?' no wizard (checkboxes, todos marcados por padrão, badge RECONECTAR p/ token expirado; só aparece com 2+ e-mails). (5) UI Manual: seletor 'Enviar por' no modal de envio (persistido em localStorage; /api/send já aceitava senderEmail). (6) Incidente VIP vencido: robô agora AUTO-CORRIGE o rótulo (vip.active=false) silenciosamente — sem incidente, sem missão. (7) CCC: seção de comprovantes agora TAMBÉM busca os pedidos do usuário no servidor e renderiza cards separados '🧾 plano · R$ · status' clicáveis (verComprovante) — locais podem excluir; de pedido são registro contábil (só ver). (8) Tentativa de anti-duplicidade de pedido revertida: JÁ EXISTIA (DEDUP #3 devolve o pendente) — verificar antes de adicionar o que o código já faz.",
      impacto:"Cliente com Gmail principal bloqueado envia só pelos secundários (auto e manual); rodízio distribui 1 a 1 protegendo contra bloqueio; falsos alarmes de VIP vencido somem da Central de Incidentes (auto-corrigidos); comprovantes de pedidos aparecem no CCC em cards separados. Lições: (i) fallback 'sempre principal' quebra a intenção do usuário — se houve seleção explícita, respeitar mesmo em degradação, falhando com mensagem clara; (ii) incidente que pede ação que o sistema pode fazer sozinho deve virar auto-correção; (iii) antes de adicionar validação, procurar se já existe (DEDUP #3 já cobria pedidos duplicados).",modulos:["server.js: getSenderToken (allowedSenders), /api/auto/start (senders), _doAutoSendInner (pausa clara), robô contábil (auto-fix vip.active)","index.html: #auto-senders-box + renderAutoSenders/getSelectedAutoSenders, #m-sender no modal manual","admin.html: CCC #ccc-pedidos-comps (cards de comprovantes de pedidos do servidor)"],tags:["senders","multi-gmail","rodízio","seleção","bloqueado","manual","automático","incidente-falso","vip-vencido","comprovantes","ccc","pedidos"]
    },
    {
      id:"KB-057",versao:"V929",data:"2026-06-30",autor:"Claude/Andrio",
      problema:"COMANDO MASTER de auditoria (usuários/planos/compras/segurança/Vanessa). Achados: (1) DADOS (export real, 40 usuários): 8 usuários com onboarding incompleto (SEM_PERFIL/ASSUNTO/CORPO — não é bug, é o padrão Esdras: falta criar perfil de currículo); ZERO dias negativos, ZERO contadores acima do limite, ZERO limites divergentes (os '9999' são os 2 admins — correto); planos: 8 free, 16 vip, 13 vipro, 3 doublepro. (2) VANESSA: existem DUAS contas (vanessagabriele1930=vipro ativo enviando ok; vanessagabriele2015=free) — provável origem do lançamento duplicado de R$150; o pagamento duplicado está no LIVRO FINANCEIRO do servidor (não veio no export de monitoramento), então a correção é operacional via ferramenta. (3) SEGURANÇA: falso alarme inicial — TODAS as rotas /api/admin/* passam por guard de grupo (sessão + p.isAdmin) ANTES do roteamento; limites são validados server-side; trial→free é automático por comparação de timestamp (funciona sem o usuário logar). (4) FERRAMENTA FALTANTE: delete_pagamento/delete_gasto APAGAVAM SEM HISTÓRICO e não existia edição.",
      solucao:"(1) delete_pagamento/delete_gasto agora EXIGEM motivo (mín. 3 chars) e gravam trilha append-only em DB_FINANCEIRO.alteracoes[] (quem [da sessão, não forjável], quando, motivo, registro anterior sem imagem). (2) NOVAS actions edit_pagamento/edit_gasto (campos permitidos: valor, desconto, datas, nota/descrição, categoria, plano, email, pagoPor/recebidoPor) com o MESMO log antes/depois+motivo. (3) action get_alteracoes lista a trilha (últimas 200). (4) UI: modal de detalhes do registro ganhou botões ✏️ Editar e 🗑️ Excluir (prompt de motivo obrigatório; relê do servidor após); botão 🕓 Histórico no cabeçalho do painel abre a trilha completa. CORREÇÃO DA VANESSA (operacional, 30s): VIP & Planos → Entradas → abrir o R$150 duplicado → 🗑️ Excluir → motivo 'Pagamento duplicado por erro do admin — mantendo 1 de R$150' → o total recalcula na hora (receita, lucro, 50/50) e a exclusão fica auditada. Dias VIP dela NÃO precisam recálculo: a conta 1930 tem vipro correto de UMA compra; o erro era só o lançamento financeiro em dobro.",
      impacto:"Financeiro ganha CRUD completo auditado (adicionar/editar/excluir/histórico) — nada some sem rastro, qualquer sócio vê quem mexeu, quando e por quê; casos como o da Vanessa se corrigem em 30 segundos sem tocar código. Auditoria confirma sistema saudável nos dados reais. Lições: (a) export de monitoramento ≠ livro financeiro — cada correção usa a fonte certa; (b) 'apagar sem histórico' é dívida de auditoria: toda mutação financeira exige motivo + trilha; (c) guard de grupo no roteamento (startsWith /api/admin) é o padrão que evita esquecer auth em rota nova.",modulos:["server.js: delete_* (motivo+trilha), edit_pagamento/edit_gasto (novos), get_alteracoes, DB_FINANCEIRO.alteracoes[]","admin.html: botões ✏️/🗑️ no modal de detalhes, finEditarRegistro/finExcluirRegistro/finVerHistorico, botão 🕓 Histórico"],tags:["auditoria","vanessa","duplicado","editar","excluir","histórico","trilha","motivo","segurança","trial","limites","financeiro"]
    },
    {
      id:"KB-058",versao:"V930",data:"2026-06-30",autor:"Claude/Andrio",
      problema:"Varredura sistemática de erros visuais+funcionais em todo o site (pedido: 'arrumar 30 erros'). Método: scanners automatizados (onclick→função inexistente, IDs duplicados, fetch→rota inexistente, funções redefinidas, XSS via innerHTML sem esc, target=_blank sem rel, img sem alt, inputs number sem inputmode, console.log em produção, placeholders com valores errados, travas de duplo-clique em ações financeiras) + confirmação manual caso a caso antes de corrigir.",
      solucao:"CORRIGIDOS (122 pontos em 12 categorias): (1) showPedido() NÃO EXISTIA — 3 botões mortos no Robô Contábil ('Ver Pedido'/'Ajustar Valor'/'Ver'); criada: showView(pedidos)+loadPedidos+scroll até #pvc-{id}+highlight 4s. (2-3) 31 links target=_blank sem rel=noopener (22 index + 9 admin) — tabnabbing corrigido. (4-5) 43 <img> sem alt (15+28) — acessibilidade. (6) 17 console.log→console.debug no index (não polui/vaza no console do usuário). (7-8) 21 inputs type=number sem inputmode=decimal (3+18) — teclado numérico correto no celular. (9) theme-color faltava no admin. (10) 4 placeholders com PREÇOS INEXISTENTES (R$149,90/R$29,90 → R$150,00; planos reais são 100/150/250 — placeholder errado induz o admin a registrar valor errado). (11-12) registrarPagamento e registrarGasto SEM trava anti-duplo-clique — 2 cliques = lançamento financeiro DUPLICADO (a própria classe de erro do caso Vanessa); trava _finSubmitting com finally. AUDITADOS E DELIBERADAMENTE NÃO MEXIDOS: IDs 'duplicados' (padrão inject-replace, não duplicam em runtime; ex.: auto-progress-wrap já usa querySelectorAll) — mexer sem bug confirmado é risco puro; 274 color:#fff no index (maioria correta sobre gradientes; troca em massa quebraria o tema). VERIFICADOS LIMPOS: XSS (esc() consistente), rotas front↔back 100% cobertas, zero funções redefinidas no server, setInterval/clearInterval balanceados.",
      impacto:"3 botões admin voltam a funcionar; segurança (tabnabbing) e acessibilidade elevadas; UX mobile melhor (teclado certo); console do usuário limpo; placeholders não induzem mais erro de valor; e a contabilidade ganha proteção contra duplo-lançamento por clique duplo. Lições: (a) scanner automatizado ACHA candidatos, mas cada um exige confirmação manual — falsos positivos (IDs inject-replace, rotas por prefixo) são comuns; (b) corrigir só o que é bug CONFIRMADO: 'consertar' padrão que funciona é como se introduz regressão; (c) toda ação financeira precisa de trava anti-duplo-clique por padrão.",modulos:["admin.html: showPedido() nova, travas em registrarPagamento/registrarGasto, placeholders, theme-color, rel/alt/inputmode","index.html: rel/alt/inputmode, console.debug"],tags:["varredura","30-erros","botão-morto","tabnabbing","acessibilidade","inputmode","duplo-clique","placeholder","falso-positivo","auditoria"]
    },
    {
      id:"KB-059",versao:"V931",data:"2026-07-03",autor:"Claude/Andrio",
      problema:"DECISÃO DE NEGÓCIO (dono): o programa de indicação estava sendo usado de MÁ FÉ (abuso do bônus de dias grátis) e foi ENCERRADO DEFINITIVAMENTE. Ordem: remover a aba de indicação e tudo relacionado, para sempre.",
      solucao:"Remoção completa em 3 camadas. SERVER: DB_REFERRAL/REFERRAL_FILE removidos (declaração, load, shutdown persist); bônus de cadastro no OAuth callback removido; bônus de compra removido dos DOIS pontos (PATCH /api/pedido e admin set-plan); genRefCode/getOrCreateRefCode removidos; GET /api/referral/info e /api/admin/referral/list removidos — qualquer /api/referral* ou /api/admin/referral* agora responde 410 Gone (clientes/PWA com cache antigo recebem mensagem clara em vez de erro); prompt do IA Chat e dossiê Gemini atualizados (também corrigida a mentira '5 dias grátis' → trial real de 1 dia VIP Manual). INDEX: aba v-indicar inteira, botão da sidebar (si-indicar), atalho do drawer, chip do IA Chat, bullet '5 dias por amigo' das boas-vindas, captura de ?ref= (IIFE + _getOAuthURL simplificada para /oauth/start puro), loadReferralView/copyRefLink/shareRefLink, 'indicar' fora do array VIEWS e do roteador sv(), chaves i18n ref_*/refer* nas 3 línguas e os 2 blocos de tradução da aba. ADMIN: botão sidebar Indicações, view-indicacoes, loadAdminReferrals, entrada no titles/showView, teste do QA robot (/api/referral/info fora da lista de endpoints e da suite Social). PRESERVADO de propósito: rótulos de legado (vip.source==='referral', origem 'indicacao' no histórico de créditos) para que usuários que JÁ ganharam dias por indicação continuem com histórico legível; referrals.json permanece no seed do RESET_NOW para ser zerado num próximo reset; KB antigas sobre indicação permanecem (KB é append-only).",
      impacto:"Programa de indicação morto de ponta a ponta: sem UI, sem rotas, sem concessão de dias — o vetor de abuso deixa de existir. Dias já concedidos NÃO são revogados (decisão conservadora: revogar em massa puniria indicações legítimas; se o dono quiser revogar casos específicos, usar o CCC). Links antigos ?ref=CODIGO continuam abrindo o site normalmente — o parâmetro é simplesmente ignorado. Lição: recurso de crescimento com concessão automática de valor (dias grátis) precisa de teto/força de auditoria desde o dia 1; quando o abuso supera o ganho, remover por completo é mais seguro que remendar.",modulos:["server.js: OAuth callback, /api/pedido, set-plan, rotas referral (410), DB_REFERRAL, prompts IA/Gemini","index.html: v-indicar, sidebar, drawer, VIEWS/sv, ?ref=, i18n, funções ref*","admin.html: view-indicacoes, sidebar, loadAdminReferrals, QA robot"],tags:["indicação","referral","remoção","abuso","má-fé","410-gone","decisão-de-negócio","kill-switch"]
    },
    {
      id:"KB-060",versao:"V933",data:"2026-07-04",autor:"Claude/Andrio",
      problema:"PACOTE MULTI-SERVIDOR + RANKING v15 + PERFIL PÚBLICO + REPASSES (ordem do dono). (1) Servidor 1 (produção) 'lotado' — precisa de um seletor de servidores na landing (padrão realm-select de MMO/Habbo/region-picker) apontando novas contas para o Servidor 2 (h2b-teste.onrender.com), MESMO código nos dois deploys. (2) Ranking de Respostas não agradou — trocar por ranking de compras VIP + ranking Global entre servidores. (3) Usuário precisa de perfil público opcional (sobre/experiências/foi contratado/opinião) visível ao clicar no ranking. (4) Financeiro não tinha onde registrar o que Diego JÁ repassou ao Andrio — o card 'Acerto entre sócios' sempre mostrava a dívida cheia.",
      solucao:"SERVER: env SERVER_ID (1=produção, 2=teste; default 1) identifica o deploy. DB_ADMIN_SETTINGS.servers (editável em Configurações, sem deploy) define nome/url/maxExibido/status(lotado|aberto) de cada servidor. Rotas públicas novas: GET /api/servers/self (id+usuários locais, p/ peers), GET /api/servers (lista p/ o seletor; conta local + busca peers via httpsReq com cache 10min e falha silenciosa), GET /api/servers/ranking-export (top50 local só com dados já públicos, nunca e-mail), GET /api/ranking/global (funde local+peers, ordena, top50 com serverId). RANKING: categoria 'responses' REMOVIDA das rotas; novas categorias: 'vip' (score = nº de compras VIP via calcVipCompras() — MESMA fonte canônica única por pagante da receitaReal: livro-caixa→pedidos pagos→paymentAmount; trial/código nunca contam; ignora período) e 'active' redefinida (dias distintos com envio no período, desempate por envios). Sort geral ganhou desempate por envios. Privacidade: user.publicProfile.mostrarFotoGoogle===false omite a foto Google no ranking E no perfil (avatar do app sempre pode). /api/ranking/profile devolve sobre/experiencias/foiContratado/opiniao/vipCompras/serverId. /api/settings aceita publicProfile sanitizado (strip de tags + limites de tamanho). /api/status devolve serverId+publicProfile. FINANCEIRO: DB_FINANCEIRO.repasses[] (novo) com actions add_repasse (de/para/valor/dataRepasse/nota; lancadoPor da SESSÃO, não forjável) e delete_repasse (motivo obrigatório) — ambas na trilha alteracoes[]. GET /api/admin/financeiro retorna repasses. FRONT (index): overlay seletor de servidores na landing (1x por sessão + pill 🌐 na navbar), cards com barra de lotação (ex.: 76/50 LOTADO só-login vs 0/100 ABERTO), clique no servidor remoto redireciona pra URL dele; aviso fixo 'sua conta pertence ao servidor onde foi criada'. Abas do ranking: Envios | 💎 VIP | 🔥 Mais Ativos | 🌐 Global (períodos ocultos em VIP/Global; entradas globais de outro servidor mostram chip SN e não abrem perfil — perfil vive no outro servidor). Corrigido bug pré-existente: renderRanking lia e.posChange mas o server manda e.change (todo mundo aparecia como 'Novo'). Modal de perfil do ranking ganhou seção de bio pública + stat Compras VIP. Editar Perfil ganhou card '🌟 Perfil Público (opcional)' (sobre/experiências/foi contratado/opinião/toggle foto Google) salvo pelo saveProfile existente. Badge 'Servidor N' no drawer e no hero do perfil. ADMIN: card Acerto ganhou lista de repasses + botão 💸 Registrar repasse (modal) + exclusão com motivo; cálculo do acerto agora desconta repasses (heldAndrio − repassesAndrio→Diego + repassesDiego→Andrio); Configurações ganhou seção 🌐 Servidores (editar nome/url/max/status dos 2 servidores).",
      impacto:"Cadastros novos são direcionados ao Servidor 2 sem tocar no Servidor 1 (produção protegida), com o MESMO ZIP nos dois repositórios — só a env SERVER_ID muda. Ranking fica mais comercial (VIP incentiva compra; Global une a comunidade dos servidores). Perfis públicos são 100% opt-in e só expõem o que o usuário escreveu + stats já públicas. O acerto entre sócios finalmente reflete a realidade (o que Diego já pagou ao Andrio abate a dívida), com trilha auditável. Lições: (a) multi-servidor com flat-file = servidores IRMÃOS independentes conversando por APIs públicas mínimas com cache e falha silenciosa — nunca acoplar bancos; (b) contas NÃO migram entre servidores (DBs separados) — comunicar isso na UI é obrigatório; (c) métrica pública de dinheiro nunca expõe R$ de terceiros — usar contagem de compras; (d) todo ajuste de acerto financeiro precisa ser lançamento auditável (repasse), nunca edição do resultado.",modulos:["server.js: SERVER_ID, DB_ADMIN_SETTINGS.servers, /api/servers*, /api/ranking/global, calcVipCompras, calcRanking (vip/active/privacidade), /api/ranking/profile, /api/settings (publicProfile), /api/status, financeiro repasses","index.html: overlay seletor de servidores, pill navbar, abas do ranking, renderRanking (change fix, chips), modal perfil (bio), card Perfil Público, badges Servidor N","admin.html: repasses no acerto (+modal+cálculo), Configurações 🌐 Servidores"],tags:["multi-servidor","seletor","lotado","server-id","ranking","vip","global","perfil-público","privacidade","repasses","acerto","sócios","auditoria"]
    },
    {
      id:"KB-061",versao:"V934",data:"2026-07-04",autor:"Claude/Andrio",
      problema:"MASTER PROMPT ETA (ordem do dono): transformar o H2BApply na plataforma H-2B mais completa monitorando TODAS as vagas por ETA Case Number — grupo, status oficial, histórico completo, agenda de consultas, worker independente da interface, exclusividade Double Pro com tela premium para Free/VIPro, painel admin e logs. Entrega faseada decidida pelo co-owner técnico: Fase 1 = infraestrutura completa + monitoramento real via API oficial do DOL (testável hoje); Fase 2 = FLAG/status pré-certificação, IA de probabilidade, filtros avançados, notificações e importador de planilhas por upload.",
      solucao:"SERVER: DB_ETA (eta_registry.json em DATA_DIR) — 1 registro por case: empresa/estado/cidade/begin/end/grupo(+grupoManual)/visa/status/hist[](máx 40, append-only)/lastCheckAt/nextCheckAt/checks/changes/err/updBadgeUntil. etaSeedFromSheets() roda 30s pós-boot e 1x/dia: importa getAllSheets() SEM duplicar (chave=case), atualiza só campos alterados, status de planilha vale só até a 1ª consulta do robô (16.410 cases importados no teste). etaGrupoFromBegin(): 🟢A Abr–Jun, 🟡B Jul–Set, 🔵C Out–Dez, 🔴D Jan–Mar — coluna de grupo da planilha (r.g) e ajuste manual do admin têm prioridade. etaSetStatus(): aceita QUALQUER string (status novos entram sozinhos), grava histórico + selo ✨ por 48h. WORKER etaTick(): 45s, lock anti-reentrância, fila inteligente (só nextCheckAt vencido, mais antigo primeiro), 5 cases por tick em 1 request DOL ($filter case_number eq ... or ...), extrai active/begin_date/end_date, deriva status (Certified·Ativa / Certified·Inativa / Encerrada / Não listada no DOL), agenda adaptativa (12h se contrato começa em <30d, 24h padrão, 48h não listada, 7d encerrada), retry 30min com backoff em erro, contadores diários, NUNCA trava (try/finally). Persistência: debounce 3min só se sujo + flush no SIGTERM (~6,5MB p/ 16k cases, hist capado). Kill-switch: DB_ADMIN_SETTINGS.etaWorkerEnabled. ROTAS user (sessão): POST /api/eta/map (≤60 cases; grupo p/ todos, status/upd SÓ Double Pro — demais locked:true) e GET /api/eta/case?c= (detalhe completo DP; teaser p/ demais). ROTAS admin (grupo-guard /api/admin): eta/stats (totais, byStatus, byGrupo, fila, checagens/erros hoje, lastSync, próxima consulta, workerEnabled), eta/logs (ring 400 em memória), eta/toggle, eta/check-now (fura fila + dispara tick), eta/set-grupo (A–H ou automático). INDEX: mkSheetCard ganhou linha .jcard-eta preenchida em batch por etaEnrichCards() (cache local, POST /api/eta/map) — selo de grupo colorido + chip de status (DP) ou 🔒 Status ETA (demais) + botão ⭐ Monitor ETA verde. Modal criado sob demanda (design Stripe/Linear dark): versão DP com case, selos, grid de 6 métricas (início/fim/última/próxima consulta/nº consultas/mudanças) e linha do tempo vertical do histórico; versão bloqueada com timeline borrada, 6 benefícios e CTA '💎 Quero ser Double Pro — R$250' → sv('plans'). ADMIN: item sidebar 📡 Monitor ETA + view com 8 stat-cards, distribuição por status/grupo, botão ligar/pausar robô, consultar case agora, definir grupo manual e logs ao vivo.",
      impacto:"O H2BApply passa a ter um ativo que nenhum concorrente tem: monitoramento contínuo e auditável de TODAS as vagas por case number, com histórico permanente — e vira o motivo de venda nº1 do Double Pro (grupo visível de graça é a isca; status/timeline atrás do 🔒). Capacidade: ~9.600 checagens/dia em 1 request/45s — 16k cases cabem no ciclo de 24-48h sem estressar o DOL. Lições: (a) worker de monitoramento em massa DEVE consultar em lote via $filter (5 cases/request), nunca 1 request por case; (b) status de planilha é semente, nunca sobrepõe consulta ao vivo; (c) dado derivado (grupo por Begin Date) precisa de override manual persistente (grupoManual) senão o robô desfaz a correção do admin; (d) gate de plano se resolve no SERVIDOR (locked:true) — o front nunca recebe o dado que não pode mostrar.",modulos:["server.js: DB_ETA/ETA_FILE, etaSeedFromSheets, etaTick, etaSetStatus, etaGrupoFromBegin, /api/eta/map, /api/eta/case, /api/admin/eta/* (stats/logs/toggle/check-now/set-grupo), etaWorkerEnabled","index.html: .jcard-eta em mkSheetCard, etaEnrichCards, etaGrupoBadge/etaStatusChip, modal Monitor ETA (DP + upsell)","admin.html: view-eta, loadEtaAdmin/loadEtaLogs/etaAdminToggle/etaAdminCheckNow/etaAdminSetGrupo, sidebar"],tags:["eta","monitor","case-number","worker","fila-inteligente","grupo","status","histórico","doublepro","upsell","dol","robô","24-7","fase-1"]
    },
    {
      id:"KB-062",versao:"V935",data:"2026-07-04",autor:"Claude/Andrio",
      problema:"Fluxo entre servidores repetia o seletor: quem clicava no Servidor 2 era redirecionado para h2b-teste e via o card de escolha DE NOVO na chegada (sessionStorage é por origem — sessão nova no destino), quando deveria cair direto no login. No Servidor 1 (próprio site) o comportamento já era o correto: card fecha e o modal do Google abre.",
      solucao:"O redirect do seletor passou a anexar ?entrar=1 à URL do servidor destino. maybeShowServerSelect() no destino detecta o parâmetro: marca h2bSrvSeen, limpa a URL (history.replaceState) e abre showGoogleWarnModal() automaticamente após 450ms — a pessoa escolhe o servidor UMA vez e desemboca direto na autenticação do Google, sem repetir a escolha. Sem parâmetro, o comportamento continua o mesmo (card 1x por sessão + pill 🌐 para reabrir).",
      impacto:"Jornada de cadastro entre servidores vira um fluxo contínuo de 2 toques (escolher servidor → autorizar Google). Lição: qualquer handoff entre origens diferentes precisa carregar o estado da decisão NA URL — sessionStorage/localStorage não atravessam domínios.",modulos:["index.html: srvGo (?entrar=1 no redirect), maybeShowServerSelect (detecção do parâmetro + auto-login)"],tags:["multi-servidor","seletor","redirect","handoff","entrar","login","fluxo-contínuo","ux"]
    },
    {
      id:"KB-063",versao:"V936",data:"2026-07-04",autor:"Claude/Andrio",
      problema:"Nada impedia DE VERDADE a mesma pessoa de criar conta nos dois servidores (o 'lotado' era só visual do seletor) — abrindo brecha para trial duplo, ranking duplicado e confusão de 'onde está minha conta'. Ordem do dono: quem já tem conta no Servidor 1 NÃO pode criar no Servidor 2 (e vice-versa); ao tentar, deve ver um erro bonito dizendo em qual servidor a conta dela existe, com caminho direto para o login de lá.",
      solucao:"Trava 100% server-side no callback OAuth (impossível burlar pelo front), aplicada SÓ a conta NOVA — login de quem já existe no servidor segue intocado. (1) LOTADO REAL: se o próprio servidor está status 'lotado' na config, cadastro novo é recusado antes de criar qualquer registro (sessão pré-criada descartada) e redireciona /?err=srv_lotado&srv_*=<servidor aberto>. (2) CONTA ÚNICA: checkAccountOnPeers() consulta os irmãos via GET /api/servers/has-account?h=<SHA-256 do e-mail> — o e-mail NUNCA viaja em texto entre servidores; peer responde exists com set de hashes local em cache (5 min, inclui soft-deletadas pois relogin restaura). Achou em outro → recusa e redireciona /?err=conta_outro_srv&srv_id/nome/url. Rota has-account tem rate limit 120/min por IP e valida formato do hash. FAIL-OPEN deliberado: peer fora do ar (timeout 6s) não trava cadastro legítimo — disponibilidade > rigidez, com log para auditoria. FRONT: handler de ?err intercepta os dois códigos ANTES do display genérico (e do history.replaceState que apagava os params), guarda em window._srvBlock; maybeShowServerSelect dá prioridade máxima ao card de bloqueio: 'conta_outro_srv' → 👋 'Você já tem conta no Servidor X!' + botão azul 'Ir para o Servidor X e entrar' (com ?entrar=1 → login abre sozinho lá) + 'Ver todos os servidores'; 'srv_lotado' → 🔴 'Este servidor está lotado' + botão verde 'Criar conta grátis no Servidor 2' + 'Já tenho conta AQUI — Entrar'. Subtítulo do seletor agora avisa a regra de conta única.",
      impacto:"Fluxo fecha redondo: escolhe servidor → Google → se a conta é de outro servidor, 1 clique leva ao lugar certo com o login já abrindo. Trial duplo entre servidores morre no nascedouro. Lições: (a) regra de negócio de cadastro SEMPRE no servidor, no ponto único de criação (callback OAuth) — UI é só cortesia; (b) checagem de existência entre sistemas troca HASH, nunca PII; (c) trava dependente de peer externo precisa decidir fail-open vs fail-closed EXPLICITAMENTE (aqui: fail-open logado); (d) params de erro na URL devem ser capturados ANTES de qualquer replaceState genérico.",modulos:["server.js: checkAccountOnPeers, _emailHashExists, GET /api/servers/has-account, callback OAuth (travas lotado + conta única)","index.html: handler ?err (intercepta srv_lotado/conta_outro_srv), showSrvBlockModal, maybeShowServerSelect (prioridade), subtítulo do seletor"],tags:["multi-servidor","conta-única","trava","oauth","hash","sha-256","privacidade","lotado","fail-open","rate-limit","upsell-servidor"]
    },
    {
      id:"KB-064",versao:"V947",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"URGENTE/PRODUÇÃO: NINGUÉM conseguia logar. O modal 'O Google vai mostrar esta tela de aviso' abria, mas o botão ficava eternamente travado em 'Leia acima… 7s' — o contador nunca andava e marcar a caixinha não liberava nada. Causa raiz: existiam DUAS definições de showGoogleWarnModal no index.html. A original (junto ao HTML do #gwm) armava o timer de 7s e resetava o estado. Mais abaixo, o interceptador de Termos de Uso sobrescrevia window.showGoogleWarnModal reimplementando METADE da lógica: só fazia display=flex, sem iniciar o setInterval e sem definir window._gwmTimeOk. Resultado: _gwmTimeOk ficava undefined para sempre, gwmUpdateBtn() nunca liberava o botão, e o fallback da versão sobrescrita ainda usava '/oauth/start' hardcoded em vez de _getOAuthURL().",
      solucao:"(1) CAUSA RAIZ: interceptador reescrito para o padrão correto — captura a referência original (var _gwmOriginalShow = window.showGoogleWarnModal) ANTES de sobrescrever e delega: showTerms(function(){ _gwmOriginalShow(); }). Zero duplicação de lógica. (2) REFATORAÇÃO: a preparação do modal (reset do checkbox, texto/estilo do botão, clearInterval, _gwmTimeOk=false, setInterval de 7s) extraída para _gwmArm(); showGoogleWarnModal vira display=flex + _gwmArm(). (3) DEFESA EM PROFUNDIDADE: gwmUpdateBtn() detecta modal exibido sem timer armado (_gwmTimeOk===undefined e _gwmTimer nulo) e chama _gwmArm() na hora — qualquer caminho futuro que exiba #gwm 'na mão' se auto-corrige em vez de travar o login. (4) Fallback do interceptador usa _getOAuthURL() com guarda typeof.",
      impacto:"Login destravado para 100% dos usuários. LIÇÕES PERMANENTES: (a) interceptador/wrapper NUNCA reimplementa a função interceptada — captura a referência original e delega (duplicar lógica cria duas fontes de verdade que divergem no primeiro refactor); (b) todo gate de UI baseado em timer precisa de caminho de auto-recuperação: se o estado indica 'timer nunca iniciou', iniciar, nunca travar; (c) modal que bloqueia o funil de entrada (login/cadastro) é código CRÍTICO — qualquer mudança nele exige teste manual do fluxo completo antes do deploy; (d) grep por definições duplicadas da mesma função (window.fn= vs function fn) deve fazer parte da revisão de qualquer arquivo >10k linhas.",
      modulos:["index.html: _gwmArm (novo), showGoogleWarnModal (refatorada), gwmUpdateBtn (auto-recuperação), interceptador de Termos (delegação via referência capturada)"],
      tags:["bug-crítico","produção","login","oauth","modal-gwm","timer","função-duplicada","interceptador","showGoogleWarnModal","auto-recuperação"]
    },
    {
      id:"KB-065",versao:"V948",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"PAINEL FINANCEIRO confuso e com buraco contábil. (1) Andrio recebeu R$1.468 via Pix/PicPay no INÍCIO do projeto (antes do fluxo de Pedidos existir) e esse dinheiro era INVISÍVEL para o sistema: o 'Registrar entrada' EXIGIA email de cliente — para uma entrada avulsa/saldo inicial não existe um email único, então a validação bloqueava com um toast de 3s que no celular passa batido → 'salvei e não salvou, sem nenhuma mensagem'. (2) Mesmo se salvasse: receitaReal (servidor) itera DB_USERS e busca pagamentos POR EMAIL — entrada sem email de usuário cadastrado sumia da receita total, do mês, dos indicadores e da série de 6 meses. (3) add_pagamento/add_gasto NÃO gravavam na trilha de auditoria (só edição/exclusão) — lançamentos novos não apareciam no Histórico. (4) O card 'Acerto entre sócios' mostrava 4 números soltos sem a conta — 'Andrio recebeu R$0' sem explicar o caminho até 'Diego repassa X'. (5) O robô de auditoria contábil (runAnalysis) calculava o acerto com fórmula DIFERENTE do painel (ignorava gastos) — duas verdades. (6) GET /api/admin/financeiro devolvia repasses só dentro de financeiro.*, mas o front lia d.repasses (sempre vazio). (7) 20 indicadores inline = poluição; sócios 'quebravam a cabeça'.",
      solucao:"SERVIDOR: (a) Novo conceito ENTRADA AVULSA: add_pagamento aceita entrada SEM email (tipo:'avulsa') exigindo descrição ≥3 chars — é dinheiro que entrou por fora do site e precisa estar na contabilidade; validação de valor >0 e ≤1M com mensagens de erro claras. (b) receitaReal/receitaMes (GET financeiro) e receitaTotal/serie (fin-insights) agora somam pagamentos cujo email não pertence a nenhum usuário (categoria receitaAvulsa, sem inflar qtdPagantes). (c) add_pagamento e add_gasto gravam na trilha alteracoes[] (_logAdd) — TODO lançamento agora auditado. (d) GET financeiro devolve repasses no topo + receitaAvulsa. FRONT: (e) Form v2 com seletor 'Tipo de entrada' (cliente|avulsa) — avulsa esconde email/plano/ativar, exige descrição, NUNCA ativa VIP; 'Ativar VIP' default virou 'Não' (ativação canônica é pelos Pedidos). (f) ERRO INLINE dentro do form (caixa vermelha grande, scrollIntoView) — validação e recusa do servidor impossíveis de não ver; falha do servidor agora dá return (antes seguia e ATIVAVA VIP mesmo sem salvar a entrada!). (g) Card Acerto v2: TABELA passo a passo por sócio — (+)Recebeu, (−)Gastos que bancou, (−)½ empresa, (±)Repasses, (=)Está na mão, 🎯Deveria ficar (½ lucro) — e a linha final 'X repassa R$Y'. (h) Indicadores inline enxugados 20→8 essenciais + card Receita por plano + gráfico 6m + Top5; botão 'ver análise completa' abre o modal com as 20. (i) Fórmula do acerto do robô de auditoria HARMONIZADA com a do painel (held = recebeu − gastos próprios − ½empresa ± repasses). (j) Badges 💠AVULSA e →ANDRIO/→DIEGO em cada linha de entrada. (k) finLoadFromServer captura receitaAvulsa e repasses com fallback. Validado com os números reais: Andrio recebeu 1.468 − gastos 676 = segura 792 (bate com o extrato dele); soma dos 'segura' = lucro; transferência leva os dois exatamente à metade.",
      impacto:"Diego abre o painel e vê SOZINHO: o que cada um recebeu (incluindo o PicPay do Andrio), o que cada um gastou, quanto cada um segura e quem repassa quanto — sem precisar de explicação por áudio. Lições permanentes: (1) validação que só avisa por toast NÃO É validação em mobile — erro de formulário tem que ser inline, dentro do form; (2) todo cálculo de receita que itera USUÁRIOS é cego para dinheiro sem usuário — receita canônica precisa de um coletor para lançamentos órfãos; (3) toda mutação financeira (inclusive ADD) entra na trilha de auditoria; (4) a MESMA conta (acerto) nunca pode ter duas fórmulas em dois lugares; (5) fluxo com efeito colateral (ativar VIP) jamais continua após falha da gravação principal.",
      modulos:["server.js: add_pagamento (avulsa+validação+trilha), add_gasto (validação+trilha), GET /api/admin/financeiro (receitaAvulsa, repasses top-level), /api/admin/fin-insights (avulsas na receita e na série)","admin.html: form entrada v2 (tipo cliente/avulsa, erro inline), _registrarPagamentoInner (validação+return em falha), tabela Acerto passo a passo, loadFinanceiro (held por sócio), indicadores inline 8 essenciais, badges avulsa/recebidoPor, runAnalysis (fórmula harmonizada), finLoadFromServer (receitaAvulsa+repasses)"],
      tags:["financeiro","entrada-avulsa","acerto-sócios","auditoria","trilha","validação-inline","receita","picpay","fonte-única","indicadores","painel-v2"]
    },
    {
      id:"KB-066",versao:"V949",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"TESTE DE CADASTRO NO SERVIDOR 2 TRAVADO EM LOOP + LANDING INVISÍVEL. (1) No h2b-teste, conta nova era recusada com o modal 'Este servidor está lotado... crie conta no Servidor 2' — estando NO Servidor 2. Causa raiz: env SERVER_ID não definida no Render do h2b-teste → default 1 → o deploy se identifica como Servidor 1 (status 'lotado' na config), recusa TODO cadastro e aponta como 'aberto' o Servidor 2 — a própria URL dele. (2) 'Já tenho conta AQUI — Entrar' fazia OAuth, mas a conta de teste é NOVA → recusada de novo pela mesma trava → 'autentica mas não entra', loop infinito. (3) UX: visitante deslogado NUNCA via a landing — maybeShowServerSelect abria o auth gate automaticamente por cima de tudo, e ?entrar=1 abria o modal do Google sozinho. Ordem do dono: a landing DEVE ser vista; a pessoa clica ELA MESMA em 'Entrar com Google' na landing.",
      solucao:"OPERACIONAL (obrigatório): definir SERVER_ID=2 nas envs do Render do h2b-teste. CÓDIGO (blindagem): (a) startup grita no log se process.env.SERVER_ID não existe; (b) GUARDA no callback OAuth: se o host do request é o host do servidor 'aberto' da config mas SERVER_ID aponta pra um 'lotado', é config contraditória → FAIL-OPEN (cadastro liberado) com console.error explicando o conserto — melhor um cadastro passar num servidor mal configurado do que TODOS os cadastros travarem em loop; (c) GUARDA no front (showSrvBlockModal): se a URL de destino do modal é o próprio location.host, remove o botão de redirecionamento absurdo. LANDING: (d) maybeShowServerSelect NÃO abre mais openAuthGate automaticamente — deslogado vê a landing inteira; entrada só por clique (navbar Entrar + 2 CTAs); (e) ?entrar=1 não dispara mais o modal do Google — rola até o CTA principal e o pulsa (_pulseLandingCTA); (f) botão da seção demo que ia DIRETO pro OAuth (pulando termos + aviso do Google) agora passa por showGoogleWarnModal como todos os outros.",
      impacto:"Cadastro no Servidor 2 destravado (após corrigir a env) e imune a repetição do erro de config; landing page finalmente cumpre o papel de vender o produto antes do login. Lições permanentes: (1) toda env crítica de identidade do deploy precisa de guarda dupla — warning na inicialização + verificação em runtime cruzando a config com a realidade (host do request); (2) trava que depende de config tem que decidir o comportamento em config CONTRADITÓRIA — aqui fail-open logado; (3) redirecionamento nunca pode apontar para o próprio host — sempre validar destino ≠ origem; (4) fluxo de autenticação jamais abre sozinho por cima da landing — conversão começa na página, login é ação do usuário.",
      modulos:["server.js: warning de SERVER_ID ausente no boot, guarda de config contraditória no callback OAuth (fail-open por host)","index.html: maybeShowServerSelect (sem auth automático), _pulseLandingCTA (?entrar=1 destaca CTA), showSrvBlockModal (guarda destino=origem), CTA da demo via showGoogleWarnModal"],
      tags:["multi-servidor","server-id","env","lotado","loop","fail-open","landing","auth-gate","ux","cadastro","config-contraditória"]
    },
    {
      id:"KB-067",versao:"V950",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"AUDITORIA GERAL (comando de rearquitetura do dono) encontrou: (1) CÓDIGO MORTO na home — o bloco do streak em renderHome era inerte (`calcStreak&&typeof calcStreak==='function'?0:0` sempre 0, e a função calcStreak nem existia; o elemento #home-stat-streak também não existia no HTML) → a feature de gamificação 'dias seguidos' nunca funcionou; (2) os stat cards Manual/Auto da home mostravam só o número X/Y sem leitura visual de progresso da meta diária; (3) toLocaleDateString('pt-BR','pt-BR') com segundo argumento inválido (string no lugar do objeto options) no detalhe de e-mail vinculado.",
      solucao:"(1) calcStreak() REAL implementada: deduplica dias com envio a partir de HIST (h.date com fallback h.sentAt), conta dias consecutivos terminando hoje OU ontem (não zera o streak de quem ainda não enviou hoje); chip '🔥 N dias seguidos enviando' no hero da home (#home-streak-chip), visível só com streak>=2 — código morto removido. (2) Barras de progresso da meta diária adicionadas aos cards Manual e Auto (#home-prog-manual/#home-prog-auto), preenchidas em renderHome com todaySent/limit (cap 100%, admin ∞ não mostra %). (3) toLocaleDateString corrigido. (4) sw.js CACHE_NAME v10→v11 para o PWA não servir a home antiga do cache.",
      impacto:"Gamificação de constância finalmente viva (streak visível motiva envio diário) e leitura instantânea de quanto da meta do dia já foi usada — ambos aditivos, envoltos em try/catch, zero risco para o fluxo de envio. Lição permanente: bloco de código que referencia função/elemento inexistente é feature FANTASMA — na auditoria, todo `typeof f==='function'?x:x` com os dois ramos iguais é código morto e deve ser implementado de verdade ou removido; e toda entrega que muda index.html DEVE bumpar o CACHE_NAME do sw.js, senão parte dos usuários PWA nunca vê a mudança.",
      modulos:["index.html: calcStreak(), renderHome (streak+metas), #home-streak-chip, #home-prog-manual/auto, toLocaleDateString","sw.js: CACHE_NAME v11"],
      tags:["home","streak","gamificação","meta-diária","código-morto","pwa","cache","auditoria"]
    },
    {
      id:"KB-068",versao:"V951",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"PARTE 1 DO PLANO 10/10 (performance percebida pelo usuário). A due diligence encontrou ZERO compressão HTTP no sistema: serveHtml entregava index.html (1,18MB) CRU com Cache-Control:no-cache → ~1,2MB baixados a CADA visita fora do PWA, no 4G do público-alvo. Pior: o helper json() também não comprimia — a rota de vagas H-2A serve JSON de ~4,5MB por carga. Sem ETag, nem a revalidação economizava banda (no-cache sem validador = redownload integral).",
      solucao:"(1) Motor de assets estáticos (getStaticAsset/sendAsset): comprime brotli(q5)+gzip(6) UMA vez por arquivo/mtime, guarda em cache de memória com ETag sha1; responde 304 sem corpo em If-None-Match e negocia br>gzip>raw por Accept-Encoding, sempre com Vary. Aplicado a: index.html/admin.html/guia/diagnostico/admin-v2 (serveHtml), sw.js (preservando Service-Worker-Allowed; update-check do SW agora é 304), manifest.json e h2b-extras-*.js. (2) json() ganhou gzip automático nível 5 para respostas >16KB quando o cliente aceita — via res._req anexado no início do handler (1 linha, sem tocar 400+ call sites); try/catch com fallback sem compressão. (3) sw.js tinha no-store que conflitava com validador — normalizado para no-cache,must-revalidate+ETag.",
      impacto:"index.html: ~1,18MB → ~190KB (br) na 1ª visita e 304 (zero corpo) nas seguintes; lista de vagas H-2A: ~4,5MB → ~600KB. No 4G real do usuário: app abrindo em 1-2s em vez de 6-10s, e economia de banda de ~85% no tráfego pesado. Custo: compressão de estáticos é 1x por boot (cache por mtime); gzip dinâmico só em payloads grandes (~40ms num JSON de 4MB). Lição permanente: TODO texto >16KB servido por HTTP precisa de (a) compressão negociada com Vary e (b) validador ETag — 'no-cache' sem ETag é a pior combinação possível: não protege contra staleness E força redownload integral.",
      modulos:["server.js: getStaticAsset/sendAsset (novo motor), serveHtml, rotas /sw.js, /manifest.json, /h2b-extras-*.js, json() com gzip>16KB, res._req no handler"],
      tags:["performance","compressão","brotli","gzip","etag","304","banda","4g","mobile","parte-1"]
    },
    {
      id:"KB-069",versao:"V952",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"PARTE 2 DO PLANO 10/10 — acabamento do wizard de boas-vindas email-first. A auditoria mostrou que o wizard (openAuthGate/agLookup/GET /api/auth/where) JÁ existia completo front+back (testado ao vivo, endpoint respondendo certo), mas com 3 pontas soltas: (1) FRICÇÃO CROSS-SERVER — quem clicava 'Ir para o Servidor X e entrar' chegava lá, via a landing pulsando e tinha que DIGITAR O E-MAIL DE NOVO no wizard do destino (o redirect só levava ?entrar=1, sem contexto); (2) 3 CTAs da landing (ln-rank-cta, 'Começar agora' do ranking deslogado, botão da seção demo) pulavam o wizard indo direto ao showGoogleWarnModal — inconsistente com o email-first; (3) 2 comentários stale afirmavam que 'o login do Google abre direto' no destino — mentira desde a v949, e comentário errado induz regressão futura.",
      solucao:"(1) agRedirect agora leva ag_email+ag_go (l/s) na URL; na chegada, maybeShowServerSelect valida o e-mail (regex+120 chars), preenche _agEmail/_agIntent e abre openAuthGate('arrived') — novo passo do wizard: chip do e-mail + 'Você chegou ao servidor da sua conta ✅' (login) ou 'Quase lá! Crie sua conta aqui 🟢' (signup) + botão Google (que passa pelo showGoogleWarnModal normal) + 'Usar outro e-mail'. REGRA v949 PRESERVADA: o OAuth continua sendo clique do usuário — o que abre sozinho é o wizard com contexto, nunca o Google. (2) Os 3 CTAs unificados em openAuthGate('choice'). (3) Comentários corrigidos descrevendo o fluxo real. srvGo (seletor antigo, sem e-mail) mantém ?entrar=1 puro de propósito.",
      impacto:"Fluxo cross-server sem repetição: e-mail digitado UMA vez, servidor certo, um clique no Google — a jornada 'landing → email → servidor → Google' está completa de ponta a ponta. Entrada 100% consistente: TODO caminho de login/cadastro da landing passa pelo email-first. Lição permanente: redirect entre servidores deve SEMPRE carregar o contexto do fluxo (o que o usuário já informou) — obrigar a redigitar é onde funil de conversão morre; e comentário desatualizado sobre comportamento de auth é dívida perigosa: descreva o fluxo REAL ou apague.",
      modulos:["index.html: agRedirect (ag_email+ag_go), maybeShowServerSelect (chegada arrived), agRender (passo arrived), 3 CTAs → openAuthGate, comentários","sw.js: CACHE_NAME v12"],
      tags:["wizard","email-first","auth-gate","multi-servidor","cross-server","conversão","funil","ux","parte-2"]
    },
    {
      id:"KB-070",versao:"V953",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"PARTE 3 DO PLANO 10/10 — busca de vagas. Os filtros existentes (q/estado/cidade/salário-mín/qtd/categoria/grupo/status ETA) já eram fortes, mas faltavam 3 coisas que o trabalhador sazonal realmente usa: (1) FILTRO POR MÊS DE INÍCIO — quem está no Brasil planeja por data ('vagas que começam em setembro') e não tinha como; (2) ORDENAR POR SALÁRIO e POR DATA DE INÍCIO — só existia aleatório/recentes/antigas; (3) LIMPAR FILTROS — com 8+ filtros combináveis, resetar exigia mexer um por um. Achados de dados no caminho: salários vêm em unidades mistas (16.262 'h', 184 'mo', 2.806 vazios) e há dado SUJO na fonte (mensal rotulado como hora, ex.: $2.058,31/h).",
      solucao:"SERVER (/api/sheet-meta + searchSheet): (1) beginMonth=1..12 (aceita lista '6,7,8'), filtra pelo mês do Begin Date r.d; (2) sort=wage com NORMALIZAÇÃO por unidade → equivalente/hora (mo÷173, wk÷40, d÷8, ano÷2080) + guarda de sanidade: rotulado hora com valor >200 é tratado como mensal (teto real do DOL é ~$75/h de piloto); sort=start (começa antes primeiro, sem data vai pro fim); ambos determinísticos → paginação estável. FRONT: select Mês de início, botões 💰 Salário e 📅 Começa antes, botão ✕ Limpar (aparece SÓ com filtro ativo — _updClearBtn ligado em applyF/onSearch/setTab) que reseta tudo incluindo grupos/status ETA e chips. HONESTIDADE DE UX: os controles novos aparecem só nas abas de PLANILHA — a aba Seasonal (API DOL ao vivo) não suporta, então esconder > fingir; trocar pra seasonal com sort=wage/start ativo reverte pra aleatório. Testado ao vivo: beginMonth=9 → 31/5000 vagas corretas; topo do sort=wage limpo ($75/h piloto, sem o falso $2.058/h); combinado mês+salário funcionando.",
      impacto:"O trabalhador agora responde em 2 toques as duas perguntas que mais importam: 'quais vagas começam quando eu posso ir?' e 'quais pagam mais?'. Lições permanentes: (1) NUNCA ordenar valores com unidades mistas pelo número cru — normalizar primeiro, senão o sort mente; (2) dado de fonte externa precisa de guarda de sanidade documentada (limite físico do domínio); (3) controle de filtro que o backend da aba não suporta deve SUMIR da aba, nunca ficar clicável sem efeito.",
      modulos:["server.js: /api/sheet-meta beginMonth, searchSheet sort wage/start normalizado","index.html: f-month, so-wage, so-start, f-clear, clearAllFilters, _updClearBtn, applyF/onSearch/setSort/setTab, fMonth","sw.js: CACHE_NAME v13"],
      tags:["busca","filtros","mês-início","salário","normalização","unidades","dado-sujo","ux-honesta","limpar-filtros","parte-3"]
    },
    {
      id:"KB-071",versao:"V954",data:"2026-07-05",autor:"Claude/Andrio",
      problema:"PARTE 4 DO PLANO 10/10 — ranking gamificado. O ranking tinha períodos (dia/semana/mês/geral = temporadas), categorias, podium, perfil público e badges, mas era PLACAR, não gamificação: sem XP, sem níveis, sem conquistas — nada que desse ao usuário uma sensação de progressão própria além da posição relativa.",
      solucao:"DECISÃO DE ARQUITETURA: tudo DERIVADO do histórico existente — XP e conquistas são funções puras de getHist() (manual=10 XP, auto=4, resposta recebida=25), zero estado novo, zero migração, sempre recomputável (fórmula errada amanhã = corrige e recalcula sozinho). SERVER: tabela XP_NIVEIS (10 níveis, Iniciante 0 → Lenda 50.000), xpFromCounts/levelForXP (com % até o próximo nível), calcConquistas com 15 conquistas derivadas (marcos de envio 1/50/100/500/1k/5k, respostas 1/10, streak 7/30, estados 5/15, 100 auto, 100 manual, madrugador 4-7h); GET /api/gamification (auth) devolve xp+nivel+streak+conquistas; calcRanking ganhou xp por linha (barato: contadores totais já existiam) e nivel {n,nome,emoji} calculado SÓ no top-50 devolvido. FRONT: card Meu Nível no topo do ranking (emoji, barra de XP, quanto falta pro próximo, legenda da fórmula) + grade retrátil de conquistas (desbloqueada dourada / bloqueada 🔒 cinza com dica de como ganhar); chip de nível em cada linha do ranking; chip de nível no hero da home (clica → ranking), cache compartilhado de 2 min. Testado ao vivo com seed: 121 manuais+50 autos+3 respostas → 1.485 XP = Nv4 Persistente (conta manual confere: 1210+200+75).",
      impacto:"O usuário agora tem progressão PRÓPRIA (nível/XP/conquistas) além da competição relativa — motivos para voltar amanhã mesmo sem alcançar o topo. As conquistas de estados/madrugador/streak empurram os comportamentos que geram resultado real (diversificar destinos, constância). Lição permanente: gamificação sobre dados DERIVADOS é ordens de magnitude mais segura que sobre contadores novos — sem risco de dessincronia, sem migração, e a fórmula pode evoluir retroativamente; só materialize XP em estado próprio quando houver gasto/consumo de XP (loja, boosts).",
      modulos:["server.js: XP_NIVEIS, xpFromCounts, levelForXP, calcConquistas, GET /api/gamification, calcRanking (xp+nivel)","index.html: #gami-card, loadGamification, toggleConquistas, chip nas linhas, #home-level-chip, renderHome","sw.js: CACHE_NAME v14"],
      tags:["gamificação","xp","níveis","conquistas","ranking","retenção","dados-derivados","parte-4"]
    },
    {
      id:"KB-072",versao:"V955",data:"2026-07-06",autor:"Claude/Andrio",
      problema:"Robô Monitor de Anúncios DOL (mod-dol-monitor.js, KB não numerada anterior) tinha 3 problemas encontrados numa auditoria pedida pelo dono: (1) HTTP 403 real no download do dol.gov mesmo depois de uma correção anterior de Accept-Encoding — sinal de WAF (Akamai/similar) ainda desconfiando do robô; (2) BUG CRÍTICO DE SEGURANÇA descoberto na auditoria (não pedido explicitamente): como dol_monitor_state.json ainda não existe em produção, a 1ª execução real do ciclo de 5min ia encontrar o relatório de Janeiro/2026 (já publicado, ainda na página hoje) como 'nunca visto' e ia IMPORTAR E AVISAR OS PAGANTES DE VERDADE com notícia velha; (3) o log do botão de teste (Janeiro) e o log do ciclo automático de produção (vai buscar Julho) se misturavam na MESMA janela/array, dificultando diferenciar o que é teste do que é produção — pedido explícito do dono por 'duas janelas separadas'.",
      solucao:"(1) httpGet reforçado: Agent https keep-alive (reaproveita conexão TCP/TLS, menos sinal de bot que abrir conexão nova a cada request), conjunto completo de headers que um Chrome real manda (Sec-Fetch-Dest/Mode/Site/User, sec-ch-ua, Upgrade-Insecure-Requests), Referer apontando pra página de anúncios, RETRY automático (até 3 tentativas com backoff incremental+jitter) especificamente pra 403/429/5xx/timeout — erros tipicamente transitórios de WAF —, e quando esgota as tentativas o erro agora carrega o STATUS HTTP + um trecho do corpo da resposta (antes só 'HTTP 403' sem contexto, impossível diagnosticar). (2) Novo campo persistido state.baselined: na 1ª checagem real (arquivo de estado ainda não existe em disco), o robô marca TODOS os relatórios já publicados na página como 'conhecidos' SEM baixar e SEM notificar ninguém, logando isso claramente; só um relatório GENUINAMENTE NOVO dali em diante aciona importação + aviso a pagantes. Se o arquivo de estado já existia (deploy anterior já rodou de verdade), baselined assume true automaticamente — sem regressão pra quem já estava em produção. (3) state.log (produção) e state.testLog (teste) viraram arrays 100% independentes, com funções log()/logTest() separadas; GET /api/admin/dolmonitor/status devolve os dois; admin.html ganhou uma 2ª caixa de log dedicada (#dm-test-log) dentro do card de teste, reiniciada a cada clique em 'Rodar teste completo' pra sempre mostrar só a rodada atual, com poll rápido (900ms) enquanto a requisição está em andamento. Para a lógica de negócio NUNCA divergir entre teste e produção (pedido do dono: 'toda vez que editar um, edita o outro igual'), o download+parse+merge de grupos foi extraído pra uma função única (runGruposPipeline) chamada fisicamente pelos dois caminhos — daqui pra frente uma correção nessa função vale pros dois automaticamente, sem precisar lembrar de replicar.",
      impacto:"O dono pode agora testar o pipeline inteiro (download real + parse + merge de grupos) usando o relatório real de Janeiro, com confiança de que é EXATAMENTE o mesmo caminho que vai rodar em Julho — e ver os passos numa janela isolada, sem ruído do robô de produção. O robô de produção não vai mais mandar e-mail de pagantes com notícia velha assim que for ligado pela primeira vez. E se o 403 persistir mesmo com os reforços de disfarce de navegador (limite físico de um WAF corporativo bloqueando IP de datacenter), agora o log mostra o suficiente pra diagnosticar sem adivinhar. Lição permanente: (a) todo robô que 'chega e já roda' precisa pensar no que acontece na SUA PRIMEIRA EXECUÇÃO quando o estado persistido ainda não existe — o cenário mais perigoso não é o robô rodando errado depois, é o robô rodando 'certo' contra dados que já são história; (b) duas superfícies (teste e produção) que devem ter o MESMO comportamento devem compartilhar a MESMA função de negócio, nunca duas cópias paralelas — cópia paralela é dívida técnica que diverge sozinha com o tempo.",
      modulos:["mod-dol-monitor.js: httpGet (keep-alive+headers+retry+diagnóstico), state.baselined, tick() baseline, state.testLog/logTest(), runGruposPipeline compartilhado","admin.html: #dm-test-log, dolMonitorPoll (renderiza testLog), dolMonitorRunTest (poll rápido + reset da janela de teste)","sw.js: CACHE_NAME v11"],
      tags:["dol-monitor","403","waf","baseline","anti-spam","janelas-separadas","teste-vs-produção","retry","robô"]
    },
    {
      id:"KB-073",versao:"V956",data:"2026-07-06",autor:"Claude/Andrio",
      problema:"INCIDENTE REAL em produção poucas horas depois do KB-072: a página de anúncios do DOL lista TAMBÉM relatórios históricos (FY23, FY24, FY25), não só o atual. Como o baseline da V3 só cobre a 1ª checagem depois de um dol_monitor_state.json inexistente, e o arquivo de estado JÁ EXISTIA (de uma execução real anterior, com só 1 relatório marcado como importado), o robô encontrou de uma vez vários relatórios históricos 'nunca vistos' e tratou CADA UM como notícia nova: importou e disparou e-mail real '🚨 SAIU A LISTA RANDOMIZADA' pros 17 pagantes, 5 VEZES SEGUIDAS, uma vez por relatório antigo (2023–2025) — sem confirmação de que isso pararia sozinho. Além disso, o relatório FY23_JulyPeak (392KB) quebrou o processamento com 'Cannot read properties of undefined (reading includes)', pedido explícito do dono revelou que faltava também um jeito deliberado de importar TODO o histórico (FY23–FY26) de uma vez, com ícone de estação (❄️ Jan/☀️ Jul), sem depender de o robô descobrir sozinho aos poucos.",
      solucao:"(1) CAUSA DO CRASH: parseSheetRows monta cada linha como array esparso (cells[colIdx]=valor) — quando uma coluna fica sem <c> no XML (célula vazia, comum em relatório mais antigo com menos colunas preenchidas), o array fica com BURACO nesse índice. Array.prototype.map/filter PULAM buracos, mas findIndex NÃO pula — chama o callback com `undefined`, causando `undefined.includes(...)`. Corrigido densificando a linha (preenche todo buraco com '') antes de devolver. (2) CAUSA DO SPAM: nada no sistema comparava 'esse relatório é o mais recente de todos' antes de notificar — qualquer link 'nunca visto' virava notificação. Criado reportRank(nomeArquivo) que extrai FY+Jan/Jul do nome (aceita 'Jul' e 'July', a nomenclatura do DOL varia por ano) e devolve um número comparável (FY*2+meio). Novo campo persistido state.latestKnownRank: só um relatório com rank MAIOR que o mais recente já confirmado dispara importReport(url,ctx,DATA_DIR,notify=true) de verdade; qualquer coisa igual ou mais antiga é importada em silêncio (notify=false) — mesma mescla de grupos, mesma persistência, SEM o bloco de aviso a pagantes. Migração retroativa: se o arquivo de estado é de antes desse campo existir, latestKnownRank é reconstruído a partir do maior rank já presente em state.imported (protege quem já estava rodando antes do fix). tick() agora ordena os relatórios novos por rank crescente antes de processar, garantindo que só o de rank mais alto no fim vire 'notícia nova'. (3) ESTRUTURA NOVA — pedido explícito do dono: HIST_CANDIDATES (tabela FY23 Jan/Jul → FY26 Jan, ícone ❄️/☀️, com 2 variações de nome tentadas em Jul/July já que o DOL não é consistente) + nova rota POST /api/admin/dolmonitor/import-historico que baixa e mescla TUDO em ordem cronológica usando o MESMO runGruposPipeline compartilhado, nunca notifica, é idempotente (pula o que já foi importado, então pode clicar de novo à vontade) + 3ª janela de log totalmente separada (state.histLog/logHist(), #dm-hist-log) + tabela visual no admin com ícone de estação e badge ✅/⏳ por período (#dm-hist-table).",
      impacto:"O robô nunca mais confunde relatório antigo com notícia nova — a proteção por ranking cronológico é estrutural (funciona mesmo se a página do DOL trouxer vários de uma vez, ou pó todo backfill manual). O crash de parsing que travava a importação do histórico está corrigido — histórico completo (FY23–FY26 Jan) agora processa sem erro. O dono ganhou uma ação deliberada e auditável (botão + tabela + log próprio) pra garantir que o registro de grupos está 100% completo, em vez de depender só da descoberta orgânica e passiva do ciclo de 5min. Lição permanente e cara: quando uma fonte de dados 'lista o mais recente' pode na verdade listar VÁRIOS itens de datas diferentes de uma vez, 'nunca visto antes' NUNCA é critério suficiente pra disparar uma ação irreversível (e-mail em massa) — é preciso comparar explicitamente CONTRA o que já se sabe ser o mais recente, com um critério ORDENÁVEL (aqui, um rank cronológico), não apenas presença/ausência num Set.",
      modulos:["mod-dol-monitor.js: parseSheetRows (densificação anti-crash), reportRank(), HIST_CANDIDATES, state.latestKnownRank, importReport(notify), tick() ranking+ordenação, rota import-historico, state.histLog/logHist()","admin.html: card 📚 Histórico de Relatórios (#dm-hist-table, #dm-hist-log), dolMonitorImportHistorico()","sw.js: CACHE_NAME v12"],
      tags:["dol-monitor","incidente-real","spam-email","ranking-cronológico","backfill-histórico","crash-fix","array-esparso","findIndex","pagantes"]
    },
    {
      id:"KB-074",versao:"V957",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"Suposição errada no KB-073: eu tinha avaliado que o PublicFacingReport.xlsx só tem 'Case Number' + 'Randomization Group', e por isso disse ao dono que não dava pra enriquecer o histórico além do grupo. O dono mandou o arquivo real (FY26_JanPeak) como exemplo — inspecionado com openpyxl, o arquivo tem 9 colunas: Case Number, Business Name, Agent Attorney Name, Worksite State, Randomization Group, Randomization Email Date, Submitted Date, Begin Date, Case Status. Ou seja, tem empresa, estado e data de início oficiais do DOL pra TODO case H-2B do período — dado valioso que o parser antigo descartava.",
      solucao:"xlsxExtractCaseAndGroup renomeado/expandido pra xlsxExtractFullReport: além de Case Number+Grupo (obrigatórios), extrai Business Name/Worksite State/Begin Date/Case Status (OPCIONAIS — se um relatório mais antigo não tiver a coluna, o campo fica vazio sem quebrar o import). Datas do Excel vêm como número serial puro (dias desde 1899-12-30, ex.: 46113), sem atributo de tipo no XML — criada excelSerialToISODate() com checagem de faixa plausível (20000–60000) antes de converter, pra nunca converter texto por engano. Nova função em server.js, etaSeedFromPublicFacingReport(rows), mescla empresa/estado/begin/grupo no registro DB_ETA.cases com a MESMA regra de não-regressão do etaSeedFromSheets já existente (nunca sobrescreve status depois que o robô de verificação já consultou o DOL de verdade pelo menos 1x; nunca duplica, chave = case number). runGruposPipeline (compartilhado pelos 3 caminhos — produção/teste/histórico) agora chama essa função automaticamente depois de mesclar os grupos, então TODOS os caminhos ganham o enriquecimento de graça, sem precisar duplicar em lugar nenhum. Testado com o arquivo real enviado pelo dono: 10.062 linhas, 0 campos vazios, datas convertidas batendo exatamente com o que o Python (openpyxl) mostrou (ex.: serial 46113 → 2026-04-01). Aproveitado o arquivo real como cópia de backup em test-fixtures/ (pasta que o botão de teste já esperava mas não existia).",
      impacto:"O registro ETA (Case Monitor) agora pode ser alimentado com empresa/estado/data de início oficiais direto do DOL pra QUALQUER período histórico (FY23–FY26), sem depender do scraper de vagas (seasonaljobs.dol.gov) ter rodado pra aquele caso — uma fonte bulk, oficial, muito mais barata que checar caso a caso. Ainda não é vaga completa pro trabalhador buscar (falta cidade específica, salário, ocupação, contato — isso só vem do job order de verdade), mas é MUITO mais que só 'grupo'. Lição permanente: antes de dizer 'os dados não têm X', ler o arquivo de verdade — minha suposição anterior sobre o formato do PublicFacingReport era baseada só no que o parser JÁ extraía, não no que o arquivo realmente contém; a diferença entre 'o que o código lê hoje' e 'o que a fonte de dados realmente tem' é exatamente onde fica o valor não aproveitado.",
      modulos:["mod-dol-monitor.js: xlsxExtractFullReport (era xlsxExtractCaseAndGroup), excelSerialToISODate, runGruposPipeline chama etaSeedFromPublicFacingReport","server.js: etaSeedFromPublicFacingReport (nova), _dolMonitorCtx","test-fixtures/FY26_JanPeak_PublicFacingReport.xlsx (novo — arquivo real enviado pelo dono)","sw.js: CACHE_NAME v13"],
      tags:["dol-monitor","enriquecimento","business-name","worksite-state","begin-date","excel-serial-date","eta-case-monitor","correção-de-suposição"]
    },
    {
      id:"KB-075",versao:"V958",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"Dono corrigiu 2 suposições erradas minhas em sequência: (1) eu tinha dito que dava pra enriquecer o histórico só com empresa/estado/data (via PublicFacingReport), mas NÃO dava pra montar vaga completa com e-mail pros períodos antigos — errado: o bot 'Nova Planilha do DOL' (_runDolBuildBot) já existe e coleta via seasonaljobs.dol.gov/archive (literalmente um endpoint de ARQUIVO histórico, aceita start_date de qualquer período) com e-mail, salário, cidade — o mesmo bot que já montou jan2026/jul2025/h2a. (2) o dono pediu pra 'postar lá pra todos' as 6 temporadas que faltam (FY23–FY25, Jan+Jul) com ícone e data, 'separado do H-2A', e reestruturar CADA lugar onde planilhas aparecem pra ficar organizado — o sistema hoje só tinha 3 fontes fixas (jan2026/jul2025/h2a) + 1 mecanismo genérico (loadDynamicSheets) que injeta extras direto na MESMA lista plana, o que ficaria poluído/confuso com mais 6 penduradas ali.",
      solucao:"BACKEND: HISTORICAL_SEASONS (6 períodos: jul2022→jan2025, mapeando cada filing pro start_date real — Jan filed mira 1º Abril, Jul filed mira 1º Outubro, mesma regra dos pares jan2026/jul2025 já existentes) + orquestrador _runHistoricoOrchestrator() que roda o MESMO _runDolBuildBot (zero duplicação) uma temporada de cada vez (bot é singleton), aguarda cada uma terminar (await direto, sem polling — _runDolBuildBot já é uma função contínua que só resolve ao fim), PUBLICA automaticamente (DB_SHEETS_META[key].published=true + historico:true) e pula o que já foi coletado antes (idempotente). Rotas novas: GET .../historico-status (tabela de progresso) e POST .../historico-collect-all (dispara). /api/sheets-list ganhou o campo historico + emoji correto herdado do DB_SHEETS_META (antes toda extra caía no genérico 📋). CORREÇÃO DE CONSISTÊNCIA: os ícones que eu tinha usado no card de histórico de GRUPOS (KB-073) estavam invertidos — corrigido pra bater com o padrão real do site (Jan=☀️Verão, Jul=❄️Inverno, confirmado no CSS .stab-sheet-jan/.stab-sheet-jul e em /api/sheets-list). FRONTEND: nova seção recolhível '📅 Temporadas Anteriores' — separada da barra principal de abas (.stabs) no Manual e do grid principal (.source-btns) no Automático — fechada por padrão, abre sob demanda, só aparece quando existe pelo menos 1 temporada histórica publicada. loadDynamicSheets() agora separa extras 'atuais' (ex.: Julho 2026 assim que sair — continuam indo pra barra principal, sem mudança) de 'históricas' (historico:true — vão pro container novo), reaproveitando as MESMAS classes/funções (.stab+setTab, .source-btn+selectSource) então funcionam idênticas por baixo, só organizadas visualmente à parte. ADMIN: card '📅 Coletar Temporadas Históricas' com tabela de progresso (ícone+status ✅/⏳ por período) + botão + log em janela própria, no mesmo estilo dos outros painéis desta sessão.",
      impacto:"O site agora tem estrutura pronta pra publicar as 6 temporadas históricas com vagas COMPLETAS (empresa, e-mail, salário, cidade) assim que o admin clicar 'Coletar todas' — e elas aparecem organizadas, numa seção própria, sem lotar a navegação principal nem se misturar com H-2A. Zero regressão: as abas atuais (Seasonal/Jan2026/Jul2025/H-2A) continuam exatamente onde estavam, com o mesmo comportamento; só quem tiver histórico publicado vê a seção nova. A coleta de verdade (milhares de vagas × 6 temporadas, rate-limited de propósito) precisa rodar ao vivo em produção — não dá pra simular no sandbox (sem acesso de rede ao seasonaljobs.dol.gov) e pode levar bastante tempo por temporada. Lição permanente: antes de dizer 'não dá' sobre uma fonte de dados, verificar se já existe uma ferramenta NO PRÓPRIO sistema que resolve por um caminho diferente do que eu estava olhando — o bot de coleta de vagas e o robô de PublicFacingReport são dois caminhos completamente separados pro mesmo objetivo geral, e eu só tinha considerado um deles.",
      modulos:["server.js: HISTORICAL_SEASONS, _histSearchUrl, _runHistoricoOrchestrator, rotas historico-status/historico-collect-all, /api/sheets-list (+historico+emoji)","mod-dol-monitor.js: HIST_CANDIDATES (ícones corrigidos)","admin.html: card 📅 Coletar Temporadas Históricas (#hist-build-table, #hist-build-log), histBuildStart/histBuildPoll","index.html: #hist-seasons-wrap (Manual) + #hist-seasons-wrap-auto (Automático), toggleHistSeasons/toggleHistSeasonsAuto, loadDynamicSheets separando atuais×históricas","sw.js: CACHE_NAME v14"],
      tags:["planilhas-históricas","coleta-completa","email","seasonaljobs-archive","reestruturação-frontend","temporadas-anteriores","ícones-consistentes","orquestrador","correção-de-suposição"]
    },
    {
      id:"KB-076",versao:"V959",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"Pedido do dono: 'a quantidade de vagas são a quantidade de eta case number diferentes' — a planilha publicada pro usuário tem que ter EXATAMENTE a mesma quantidade e o MESMO conjunto de vagas que foi baixado, nem mais nem menos, e o case number é o ID único de cada vaga. Auditoria encontrou o bug de verdade: h2a_jun2026_compact.json (a planilha H-2A built-in, coletada pelo bot 'Nova Planilha do DOL' _runDolBuildBot com alvo de 5000) tinha 5000 linhas para só 4964 ETA case numbers únicos — 36 case numbers apareciam 2x. Causa-raiz: _runDolBuildBot pagina a API do DOL via $skip/$top sobre um dataset ordenado por dhTimestamp desc que MUDA AO VIVO (novos casos entram o tempo todo) — clássico bug de 'offset pagination sobre dado mutante': o mesmo registro pode legitimamente aparecer em 2 páginas diferentes se itens novos empurrarem os já vistos, e o código empilhava (push) sem checar se aquele case number já tinha sido coletado antes.",
      solucao:"Criado mod-vagas-integrity.js (módulo compartilhado, zero dependência externa) com dedupeVagas() (mescla registros do mesmo case number SEM perder dado — mantém o mais completo e preenche os campos vazios com o outro), verifyIntegrity() (confere 1 linha = 1 case number, retorna duplicatas encontradas) e buildManifest() (hash SHA-256 da lista ordenada de case numbers + contagem — um 'recibo' que prova, sem reprocessar nada, que 'baixado'==='publicado'). Usado em 4 pontos, SEM duplicar lógica: (1) build-sheets.js (cron oficial jan2026/jul2025) — dedupe dos registros brutos do feed ANTES de filtrar/compactar, guarda final antes de gravar, manifesto .manifest.json ao lado de cada *_compact.json; (2) _runDolBuildBot (server.js, usado tanto pelo botão admin quanto por _runHistoricoOrchestrator — mesma função, correção vale pros dois automaticamente) — trocado o push cego por um Map caseIndex que mescla duplicata em vez de duplicar linha, com detecção de 'pool esgotado' (3 páginas seguidas sem NENHUM case number novo → para e loga que a fonte só tem X vagas reais, nunca infla pra bater o alvo pedido); (3) loadSheets() — auto-cura: toda vez que uma planilha é lida do disco (built-in OU extra), roda verifyIntegrity() e, se achar duplicata (como o h2a_jun2026_compact.json de produção), MESCLA e regrava o arquivo corrigido sozinho, sem precisar de migração manual; (4) upload manual de planilha (/api/admin/sheet/upload) — dedupe antes de salvar. Novo endpoint GET /api/admin/sheet/integrity lista, por planilha carregada agora, totalRows/uniqueCaseCount/ok/duplicateCases — forma do admin conferir ao vivo. Arquivo h2a_jun2026_compact.json corrigido nesta entrega (5000→4964 vagas únicas, testado e confirmado).",
      impacto:"Garantia permanente, em TODOS os caminhos que criam ou carregam planilha de vagas: 1 vaga = 1 ETA case number, nunca duplicada, nunca inflada além do que existe de verdade na fonte, nunca menos do que foi baixado. Planilha com 8 mil vagas reais fica com 8 mil; com 2 mil, fica com 2 mil — o 'alvo' que o admin pede numa coleta (ex.: 5000) é só um teto, nunca uma quantidade fabricada. Lições permanentes: (1) paginação por $skip/$top sobre uma fonte que muda ao vivo SEMPRE precisa de dedupe por chave de negócio (aqui, o case number) — nunca confiar que 'página nova = registro novo'; (2) quando a mesma regra de negócio (dedupe/merge de vaga) é usada por processos diferentes (build-sheets.js standalone e server.js), a regra tem que morar num módulo compartilhado sem estado, senão ela diverge silenciosamente com o tempo; (3) autocura no load (em vez de exigir migração manual) é o jeito mais seguro de corrigir dado histórico corrompido — ela roda toda vez que o servidor sobe, documentada e logada, então nunca fica 'escondida'.",
      modulos:["mod-vagas-integrity.js (novo): normCase, scoreRecord, mergeRecords, dedupeVagas, verifyIntegrity, buildManifest","build-sheets.js: dedupe dos registros brutos por case number, guarda final, manifesto .manifest.json","server.js: _runDolBuildBot (Map caseIndex + merge + detecção de pool esgotado + manifesto), loadSheets/_selfHealSheetIntegrity (auto-cura), /api/admin/sheet/upload (dedupe), /api/admin/sheet/integrity (novo, diagnóstico), _saveEnrichedSheet (checagem leve não-bloqueante)","h2a_jun2026_compact.json: corrigido de 5000→4964 vagas únicas nesta entrega"],
      tags:["eta-case-number","integridade","dedupe","paginação","planilha-dol","case-number-único","auto-cura","manifesto","correção-de-bug-real","kb-076"]
    },
    {
      id:"KB-077",versao:"V960",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"2 pedidos do dono no wizard de entrada por e-mail (openAuthGate/agLookup): (1) toda vez que a pessoa ia entrar, tinha que digitar o e-mail de novo — queria uma caixinha 'lembrar', marcada ela guarda o último e-mail usado neste aparelho e na próxima visita o campo já vem preenchido, só clica Continuar; (2) para os e-mails ADMIN (Andrio e Diego), o fluxo deveria reconhecer que é admin e oferecer escolha de servidor — no Servidor 1 vai direto pra autenticação normal aqui mesmo; no Servidor 2, redireciona pra lá com o login JÁ pronto pra confirmar (sem precisar clicar 'Entrar' de novo do outro lado). Admin é um caso especial porque, ao contrário do usuário comum ('cada conta pertence a um único servidor', regra dura do sistema), o admin PRECISA conseguir entrar em QUALQUER servidor pra administrar/testar os dois — o fluxo normal só mostra 'sua conta está no servidor X' e não dava esse acesso direto ao outro.",
      solucao:"LEMBRAR E-MAIL: checkbox '☐ Lembrar meu e-mail neste aparelho' abaixo do campo (marcada por padrão), usando localStorage (h2bLastEmail + h2bRememberEmail) — puramente no aparelho, nunca no servidor. Ao renderizar o passo 'email', se não há e-mail em memória (_agEmail vazio), pré-preenche com o valor salvo. agLookup() salva ou apaga o e-mail salvo conforme o estado da checkbox no momento do clique em Continuar (desmarcar = esquece, some do aparelho). ATALHO ADMIN: /api/auth/where (server.js) ganhou isAdmin (via isAdminEmail() já existente em mod-config.js) e, quando true, também devolve servers (lista COMPLETA de servidores com self, não só onde a conta 'pertence'). No front, agRender('result') detecta d.isAdmin e mostra uma tela própria '🛡️ Acesso Admin detectado' com um card por servidor: clique no self chama exatamente o mesmo caminho do usuário comum (closeAuthGate + showGoogleWarnModal — o aviso legal do Google NUNCA é pulado, nem para admin); clique no remoto chama agAdminGoTo(url,false) → agRedirectAdmin() → redireciona com ?adminlogin=1 (parâmetro NOVO e específico, nunca confundido com o ?entrar=1 comum). maybeShowServerSelect() (mesmo arquivo, roda no boot do servidor de destino) reconhece adminlogin=1 e chama showGoogleWarnModal() sozinho — só para esse parâmetro explícito; o ?entrar=1 normal de qualquer outra pessoa continua só pulsando o CTA da landing, exatamente como a v949 decidiu (regra de não-regressão preservada, nada mudou pro fluxo de usuário comum).",
      impacto:"Login fica mais rápido pra todo mundo que volta ao site (e-mail já vem preenchido, 1 clique a menos) sem perder a opção de desmarcar em aparelho compartilhado. Para os admins, entrar em qualquer um dos 2 servidores agora é 2 cliques (e-mail → escolher servidor) em vez de precisar saber a URL de cada um de cor e repetir o login manualmente lá. Lição permanente: quando um atalho precisa pular uma etapa de UX que existe por decisão explícita anterior do dono (aqui, o ?entrar=1 não abrir mais o Google sozinho, v949), a forma segura de fazer isso é um parâmetro NOVO e restrito ao caso específico (adminlogin=1), nunca reaproveitar/alterar o parâmetro genérico — assim o atalho não vaza pra ninguém que não pediu e a decisão antiga continua valendo pra todo o resto do sistema.",
      modulos:["server.js: /api/auth/where (+isAdmin, +servers quando admin)","index.html: agRender('email') com checkbox+localStorage, agRender('result') com tela admin, agLookup (salva/apaga e-mail), agAdminGoTo/agRedirectAdmin (novas), maybeShowServerSelect (+?adminlogin=1)"],
      tags:["login","lembrar-e-mail","localStorage","admin","atalho","multi-servidor","auth-gate","ux","não-regressão"]
    },
    {
      id:"KB-078",versao:"V961",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"Pedido explícito do dono: 'toda vez que eu fizer deploy eu quero que deslogue todos os usuários... eles não podem perder token, pq o automático deles não para em deploy, apenas o login eles devem fazer novamente'. Isto é o OPOSTO do que a V955 (KB não numerada, comentário 'sessões sobrevivem a deploy') tinha implementado antes: sessions.json persistia o login em disco pra sobreviver a deploy, exatamente pra ninguém precisar entrar de novo. Auditoria confirmou que essa reversão é segura: o token que o envio AUTOMÁTICO usa é 100% independente da sessão de login — getAutoQueue()/scheduleAuto() já tenta, em ordem, (1) sessão ativa em memória, (2) cached_access_token em DB_USERS, (3) refresh_token em DB_USERS via refreshTokenForUser(email) — e essa Prioridade 3 já é o caminho usado 'sem sessão ativa' (comentário original do próprio código). Ou seja: mesmo com sessions vazio, o automático continua rodando via DB_USERS, arquivo totalmente separado (users.json) de sessions.json.",
      solucao:"_loadSessionsFromDisk() (chamada 1x no boot) agora DESCARTA de propósito toda sessão de LOGIN encontrada no sessions.json — só preserva entradas __sender__ (OAuth de 'adicionar Gmail extra' em andamento, janela de 10min, não é login) que ainda estejam dentro do prazo. persistSessions() (chamada periodicamente e no shutdown) espelha a mesma regra: só __sender__ é gravado em disco daqui pra frente — sessão de login normal nunca mais é escrita em sessions.json, então não sobra nada de login pra um boot futuro encontrar. Log claro no boot avisa quantas sessões de login foram descartadas de propósito e reforça que DB_USERS não foi tocado. NENHUMA linha de DB_USERS, refresh_token, cached_access_token ou da engine de envio automático (scheduleAuto/refreshTokenForUser) foi alterada — a mudança é cirúrgica, só no carregamento/persistência do objeto `sessions` em memória.",
      impacto:"A partir de agora, todo deploy (novo processo do Node sobe do zero) força todo mundo a clicar em 'Entrar' de novo — sem exceção — mas o envio automático de ninguém para, porque ele nunca dependeu da sessão de login pra funcionar, só do refresh_token salvo em DB_USERS. Efeito colateral aceito conscientemente: como Render reinicia o processo tanto em deploy quanto ao 'acordar' de inatividade (free tier), qualquer restart do processo (não só deploy manual) também vai pedir novo login — o dono foi avisado desse detalhe. Lição permanente: antes de reverter uma decisão de UX anterior (aqui, 'sessão sobrevive a deploy'), vale a pena auditar SE a funcionalidade que dependia dela (aqui, o motivo real por trás do pedido — não perder o automático) já tem um caminho independente — evita reintroduzir o problema que a decisão original tinha resolvido, enquanto ainda entrega exatamente o que foi pedido.",
      modulos:["server.js: _loadSessionsFromDisk (descarta login, preserva __sender__), persistSessions (só grava __sender__), comentário de SESSIONS_FILE atualizado"],
      tags:["sessões","logout","deploy","login","refresh_token","envio-automático","segurança","reversão-de-decisão","kb-078"]
    },
    {
      id:"KB-079",versao:"V962",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"3 pedidos do dono numa auditoria olhando pro painel: (1) as 6 temporadas históricas (FY22 Jul–FY25 Jan) foram coletadas ANTES do KB-076 (bug de duplicata por case number) — provavelmente têm vaga duplicada como o h2a_jun2026 tinha, e o dono não tinha como refazer nenhuma nem ver que elas precisavam de conserto ('não consigo apagar pra refazer, nem aparecem as planilhas antigas'); (2) o robô de anúncios do DOL mandou um ALERTA FALSO de e-mail pros pagantes sobre uma planilha de 2024 — mesmo depois do KB-073 (V4) ter corrigido o incidente parecido; (3) garantir que a coleta de Julho 2026 (a próxima temporada real) vai puxar a URL/data certas, e que nenhuma planilha nova é enviada pro cliente sem o admin baixar E publicar de propósito. Auditoria dos 2º incidente encontrou 2 falhas em reportRank()/tick() que sobreviveram ao KB-073: (a) reportRank só normalizava ano de 2 dígitos — um nome com ano de 4 dígitos (ex. 'FY2024') ainda casa no regex mas gera um rank absurdamente inflado (2024*2 em vez de 24*2), parecendo 'o mais novo do universo'; (b) PIOR: quando o nome do arquivo não batia com NENHUM padrão reconhecido (rank=null), o código tratava isso como 'notícia nova por segurança' e disparava e-mail de verdade — ou seja, qualquer nome fora do padrão sempre furava a proteção. Auditoria também achou que o teto de 'quantidade de vagas' em TODA coleta (build-from-dol, histórico, refazer) estava hardcoded em 5000 — isso não é só sobre duplicata: uma temporada com mais de 5000 vagas REAIS (ex. Jan 2026 tem 9.240) seria TRUNCADA por esse teto, o mesmo problema de fundo do KB-076 ('a planilha tem que ter a quantidade real, nem mais nem menos') só que na direção contrária.",
      solucao:"HISTÓRICO: nova rota POST /api/admin/sheet/historico-refazer (key) — apaga a planilha+meta 'published' atual daquela temporada especificamente e recoleta do zero com o bot JÁ CORRIGIDO (KB-076: dedupe + detecção de pool esgotado). GET /api/admin/sheet/historico-status agora também devolve uniqueCaseCount+integrityOk por temporada (via _vagasVerify) — o admin.html mostra ⚠️ vermelho (em vez de ✅ verde) na temporada que tem duplicata E um botão '🔁 Refazer' em cada card já publicado. ALERTA FALSO: reportRank() normaliza ano de 4 dígitos pros últimos 2 (2024→24, nunca mais infla o rank); tick() agora NUNCA aciona aviso automático quando rank=null (nome fora do padrão) OU quando o salto de rank em relação ao último conhecido é maior que 2 (mais que 1 temporada de diferença, sinal de nome mal-parseado) — nesses dois casos importa em SILÊNCIO e loga pedindo confirmação manual do admin via 'Avisar agora' (rota que já existia). TETO DE VAGAS: os 3 lugares com '5000' hardcoded (build-from-dol, _runHistoricoOrchestrator, historico-refazer) viraram '20000' — deixando claro em comentário e na UI que isso é um TETO de segurança contra clique acidental, nunca um alvo artificial (quem já garante a quantidade real é o dedupe+detecção de pool esgotado do KB-076). JULHO 2026: botão '📅 Preencher pra Julho 2026' no card de coleta preenche URL/nome/chave/quantidade corretos (start_date 1º de Outubro/2026, job_type H-2B, mesma convenção já usada em jan2026/jul2025/histórico) — o admin só confere e clica 'Iniciar Coleta'; o fluxo de 'Publicar Planilha para Usuários' continua manual e obrigatório (build-publish já existia), garantindo que nenhuma planilha nova/incompleta é exposta a clientes sem o admin decidir explicitamente.",
      impacto:"O dono agora consegue refazer qualquer temporada histórica com 2 cliques e ENXERGAR quais tinham duplicata antes de decidir. O robô de anúncios não vai mais mandar e-mail real de 'saiu a lista' baseado em suposição — só dispara sozinho quando o rank é reconhecível E cronologicamente plausível; qualquer coisa ambígua vira decisão humana. Nenhuma temporada (passada ou futura, incluindo Julho 2026) fica mais limitada a 5000 vagas por um teto artificial — a contagem final é sempre a real, podendo ser maior ou menor que isso. Lições permanentes: (1) todo 'teto de quantidade' num coletor de dados precisa ser auditado quanto a SER, DE FATO, maior que o pior caso real conhecido — um teto esquecido vira o mesmo tipo de bug que uma duplicata, só que subtraindo em vez de somando; (2) uma proteção contra falso positivo (aqui, reportRank+latestKnownRank) precisa ser reauditada sempre que aparecer um NOVO incidente parecido — a correção anterior (KB-073) resolveu o caso que ela via, mas deixou uma porta (rank=null → confia cegamente) que só apareceu num padrão de nome de arquivo diferente; (3) 'importar em silêncio, notificar manualmente' é sempre mais seguro que 'notificar automaticamente por segurança' quando a decisão envolve mandar e-mail de verdade pra clientes pagantes.",
      modulos:["server.js: /api/admin/sheet/historico-refazer (novo), /api/admin/sheet/historico-status (+uniqueCaseCount/integrityOk), teto de vagas 5000→20000 em build-from-dol/_runHistoricoOrchestrator/historico-refazer","mod-dol-monitor.js: reportRank (normaliza ano de 4 dígitos), tick() (nunca auto-notifica com rank null ou salto>2)","admin.html: botão 🔁 Refazer por temporada histórica (com aviso ⚠️ de duplicata), botão 📅 Preencher pra Julho 2026, teto de UI 5000→20000"],
      tags:["kb-079","alerta-falso","dol-monitor","reportRank","refazer","temporada-histórica","teto-de-vagas","julho-2026","publicação-manual","segurança"]
    },
    {
      id:"KB-080",versao:"V963",data:"2026-07-07",autor:"Claude/Andrio",
      problema:"O dono clicou no botão azul 'Coletar todas as temporadas que faltam' esperando que refizesse as 6 temporadas históricas (coletadas com o bot antigo, com duplicata) — mas esse botão, por design (KB-076/KB-079), PULA qualquer temporada já marcada como publicada, então o log só mostrou 'já publicada — pulando' 6 vezes e nada foi refeito. O botão individual '🔁 Refazer' (por temporada, do KB-079) funciona, mas exigiria 6 cliques separados — o dono queria refazer as 6 de uma vez só, com a confirmação explícita de que cada uma vai ser apagada e recoletada do zero, e queria ver, ao final de cada uma, quantas vagas ÚNICAS de verdade existem e quantas empresas diferentes estão contratando — não só '5000 vagas' genérico.",
      solucao:"_runHistoricoOrchestrator ganhou parâmetro force (default false, comportamento antigo intacto): force=true NÃO pula temporada publicada — apaga a planilha+meta antiga (mesma limpeza do historico-refazer individual) e recoleta do zero antes de seguir pra próxima, uma de cada vez (bot é singleton). Nova rota POST /api/admin/sheet/historico-refazer-todas dispara o orquestrador com force=true. Novo botão vermelho '🔁 Refazer TODAS as 6 do zero' no admin, ao lado do botão azul original (que continua intacto pro caso normal de 'só falta uma'), com confirm() explicando que TODAS serão apagadas e recoletadas. Log de conclusão de cada temporada agora mostra: contagem de vagas ÚNICAS (via _vagasVerify, mesma garantia do KB-076), se sobrou alguma duplicata (não deveria, mas avisa se sobrar), quantas empresas diferentes (Set de nomes normalizados) e cobertura de e-mail/cidade/telefone — dá pro dono ver, sem abrir o JSON, que a planilha está completa e correta antes de decidir publicar pros usuários.",
      impacto:"Um clique só refaz as 6 temporadas históricas do zero, cada uma com prova de integridade e completude no próprio log — sem precisar confiar cegamente que '5000' significa 5000 vagas de verdade. Lição permanente: quando dois botões parecidos existem pro mesmo card ('coletar o que falta' vs 'refazer tudo'), o texto do botão e o comportamento têm que deixar CLARÍSSIMO qual dos dois é — a confusão aqui não foi um bug de código, foi um botão certo fazendo exatamente o que sempre fez, mas não o que o dono queria naquele momento; a solução certa não é mudar o comportamento do botão existente (quebraria quem usa 'só o que falta' de propósito), é adicionar um SEGUNDO botão, visualmente distinto (vermelho vs azul), com sua própria confirmação explícita.",
      modulos:["server.js: _runHistoricoOrchestrator (+parâmetro force, log de integridade/empresas/completude), /api/admin/sheet/historico-refazer-todas (novo)","admin.html: botão 🔁 Refazer TODAS as 6 do zero (#hist-refazer-todas-btn), histRefazerTodas(), reset de estado dos 2 botões no poll"],
      tags:["kb-080","refazer-todas","temporada-histórica","integridade","empresas","completude","ux","confirmação","um-clique"]
    }

  ];
  for(const entry of _kbFounding){
    if(!_kbFoundingIds.has(entry.id)) DB_KB.entries.unshift(entry);
  }
  // ── Política de KB: NUNCA apagar entradas únicas ────────────────────────
  // Só remove duplicatas exatas (mesmo id E mesma versão).
  // Entradas antigas com dados diferentes são MANTIDAS como histórico.
  // Versões V820 das KB-001..014 são substituídas pelas V900 (mesmo id, versão nova).
  const _dedup = new Map();
  for(const e of DB_KB.entries){
    const key = e.id + '|' + (e.versao||'');
    if(!_dedup.has(key)) _dedup.set(key, e); // mantém a primeira ocorrência
    // Se já existe o mesmo id mas versão diferente, MANTÉM AMBAS
  }
  // Contar entradas por id — se mesmo id aparece com versões diferentes, mantém tudo
  const _idCount = {};
  for(const e of DB_KB.entries) _idCount[e.id] = (_idCount[e.id]||0)+1;
  DB_KB.entries = DB_KB.entries.filter((e,idx,arr)=>{
    // Remover duplicata exata (mesmo id, mesma versão, não é a primeira ocorrência)
    const key = e.id+'|'+(e.versao||'');
    const firstIdx = arr.findIndex(x=>x.id===e.id&&(x.versao||'')===(e.versao||''));
    return idx === firstIdx;
  });
  persist(KB_FILE, DB_KB);
  console.log(`[kb] ✅ Base de Conhecimento v900: ${DB_KB.entries.length} entrada(s) (sem exclusões)`);

  console.log(`[kb] ✅ Base de Conhecimento: ${DB_KB.entries.length} entrada(s) carregada(s)`);
  // ─────────────────────────────────────────────────────────────────────────
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
  // Fase 4: SQLite atômico (WAL) + espelho JSON (STORAGE_MIRROR=off desliga o espelho)
  // V955: users.json passa pelo cifrador de campos sensíveis (cópia — runtime intocado)
  if (file === USERS_FILE) data = _encUsersForDisk(data);
  return storagePersist(file, data); // true/false — ver storage.js
}
function persistSent() {
  const out={};for(const[k,v]of Object.entries(DB_SENT))out[k]=[...v];persist(SENT_FILE,out);
}
function persistSentDebounced() {
  const out={};for(const[k,v]of Object.entries(DB_SENT))out[k]=[...v];persistDebounced(SENT_FILE,out,2000);
}
function persistLogs() { persistDebounced(LOGS_FILE, DB_LOGS, 3000); }
function persistLogsImmediate() { persist(LOGS_FILE, DB_LOGS); }

// CRUD
const getUser    = e => DB_USERS[e]||null;
// FIX-CRASH: setUser usa debounce de 3s para evitar escrita excessiva no disco
// (markOnline chamado em todo /api/status causava persist() a cada request)
const _setUserPersistDebounce = { tid: null };
const setUser    = (e,d) => {
  DB_USERS[e]={...(DB_USERS[e]||{}),...d};
  // Persiste imediatamente apenas para campos críticos (token, vip, admin)
  const isCritical = d.refresh_token || d.cached_access_token || d.vip || d.isAdmin || d.plan || d.cvs || d.profiles || d.senderEmails;
  if (isCritical) {
    persist(USERS_FILE, DB_USERS);
  } else {
    persistDebounced(USERS_FILE, DB_USERS, 5000);
  }
};
const delUser    = e => { delete DB_USERS[e]; persist(USERS_FILE,DB_USERS); };
const getHist    = e => DB_HIST[e]||[];
const addHist    = (e,entry) => { if(!DB_HIST[e])DB_HIST[e]=[]; DB_HIST[e].unshift(entry); if(DB_HIST[e].length>10000)DB_HIST[e]=DB_HIST[e].slice(0,10000); invalidateUserStatsCache(e); persistDebounced(HIST_FILE,DB_HIST,1500); }; // FIX-BUG8
const delHist    = e => { delete DB_HIST[e]; persist(HIST_FILE,DB_HIST); };
const getAutoJob = e => DB_AUTO[e]||null;
const setAutoJob = (e,d) => { DB_AUTO[e]={...(DB_AUTO[e]||{}),...d}; persist(AUTO_FILE,DB_AUTO); };
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

// Set completo do que o usuário JÁ enviou (DB_SENT + fallback do histórico),
// construído UMA vez por chamada — para checar milhares de vagas sem custo
// (hasSent() sozinho reescanearia o histórico inteiro a cada vaga).
const buildUserSentSet = (u) => {
  const set = new Set(DB_SENT[u] ? [...DB_SENT[u]] : []);
  for (const h of (DB_HIST[u] || [])) { const n = _normEmail(h.to); if (n) set.add(n); }
  return set;
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
function normalizeEmail(raw){ return _normEmailMod(raw); } // corpo em src/gmail.js (Fase 1 · Módulo 2)

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
  if (DB_LOGS[userEmail].length > 2000) DB_LOGS[userEmail] = DB_LOGS[userEmail].slice(0, 2000);
  const critical = ["enviado","falhou","pausado","cancelado","erro_anexo"].includes(record.status);
  if (critical) persistLogsImmediate();
  else if (DB_LOGS[userEmail].length % 20 === 0) persistLogs();
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

// ── BACKUP COMPLETO AUTOMÁTICO (2026-07-08, a pedido do Andrio) ────────────
// O backup.json acima é só uma rede de segurança de usuários, sobrescrita a
// cada 10min — não cobre financeiro/pedidos e não guarda histórico (não dá
// pra "voltar no tempo"). Já existia um sistema de backup completo (copia
// TODOS os .json em pastas com data + restauração), só que vivia dentro do
// painel /admin-v2 — uma URL separada que não é a que o Andrio usa no dia a
// dia (/admin). Ou seja: existia, mas não "enraizado" — dependia de alguém
// visitar uma página que ninguém visita. Agora roda sozinho, todo dia, sem
// precisar de ninguém clicar em nada, e fica visível/restaurável também no
// painel principal (ver aba Configurações em admin.html).
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_RETENCAO = 20; // guarda os últimos 20 backups completos (~20 dias)
function criarBackupCompleto(){
  try{
    if(!fs.existsSync(DATA_DIR)) return {ok:false,error:"DATA_DIR inexistente"};
    fs.mkdirSync(BACKUP_DIR,{recursive:true});
    const stamp=new Date(Date.now()-3*3600_000).toISOString().replace(/[:T]/g,"-").slice(0,19); // nome já em horário BRT
    const dir=path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dir,{recursive:true});
    let n=0;
    for(const f of fs.readdirSync(DATA_DIR)){
      if(!f.endsWith(".json")) continue;
      try{ fs.copyFileSync(path.join(DATA_DIR,f), path.join(dir,f)); n++; }
      catch(e){ console.warn("[backup] falhou copiar",f,e.message); }
    }
    // Poda: mantém só os BACKUP_RETENCAO mais recentes, apaga o resto
    try{
      const todos=fs.readdirSync(BACKUP_DIR).filter(d=>/^\d{4}-/.test(d)).sort();
      const excedente=todos.length-BACKUP_RETENCAO;
      if(excedente>0) for(const velho of todos.slice(0,excedente)){
        try{ fs.rmSync(path.join(BACKUP_DIR,velho),{recursive:true,force:true}); }catch(e){}
      }
    }catch(e){}
    console.log(`[backup] ✅ backup completo: ${stamp} (${n} arquivo(s))`);
    return {ok:true,name:stamp,files:n};
  }catch(e){ console.error("[backup] FALHA ao criar backup completo:",e.message); return {ok:false,error:e.message}; }
}
(function agendarBackupDiario(){
  // 1x por dia, ~03:00 BRT (06:00 UTC) — horário de menor uso.
  const now=new Date();
  const proxima=new Date(now);
  proxima.setUTCHours(6,5,0,0);
  if(proxima<=now) proxima.setUTCDate(proxima.getUTCDate()+1);
  setTimeout(function tickDiario(){
    criarBackupCompleto();
    setInterval(criarBackupCompleto, 24*3600_000);
  }, proxima-now);
  // Backup também logo no boot (rede de segurança se o servidor ficar dias
  // sem passar pelas 3h — ex.: redeploys frequentes).
  setTimeout(criarBackupCompleto, 2*60_000);
})();

// FIX-BUG15 v2: limpeza inteligente de DB_SENT por data de envio
// Remove apenas emails enviados há mais de 6 meses, preservando os recentes.
// NUNCA apaga tudo — evita reenvio para empresas antigas.
setInterval(()=>{
  try {
    const SIX_MONTHS = 180 * 86400_000;
    const cutoff = Date.now() - SIX_MONTHS;
    let cleaned = 0;
    for(const [ue, sentSet] of Object.entries(DB_SENT)){
      const u = getUser(ue); const j = getAutoJob(ue);
      // Só processa usuários sem automático ativo e que não aparecem há 6 meses
      if(j?.active || !u?.lastSeenAt || u.lastSeenAt >= cutoff) continue;
      // Reconstrói Set mantendo só emails enviados nos últimos 6 meses (via HIST)
      const hist = getHist(ue);
      const recentEmails = new Set();
      for(const entry of hist){
        let ts = 0;
        if(entry.sentAt){ const p=new Date(entry.sentAt).getTime(); if(!isNaN(p)) ts=p; }
        if(!ts && entry.dateStr){
          const pts=entry.dateStr.split("/");
          if(pts.length===3){ const r=new Date(`${pts[2]}-${pts[1]}-${pts[0]}T12:00:00Z`).getTime(); if(!isNaN(r)) ts=r; }
        }
        if(ts >= cutoff){ const nd=_normEmail(entry.to||""); if(nd) recentEmails.add(nd); }
      }
      const removed = sentSet.size - recentEmails.size;
      if(removed > 0){
        DB_SENT[ue] = recentEmails;
        cleaned += removed;
        console.log(`[mem-clean] ${ue}: ${removed} antigos removidos (${recentEmails.size} recentes mantidos)`);
      }
    }
    if(cleaned>0){persistSent();console.log(`[mem-clean] Total: ${cleaned} entradas antigas removidas`);}
  }catch(e){console.warn("[mem-clean]",e.message);}
}, 6*60*60*1000);

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
    } catch(e) {
      // FIX: se token expirado, tenta refresh silencioso antes de desistir
      if(e.message==="TOKEN_EXPIRED"||e.message.includes("TOKEN_EXPIRED")||e.message.includes("Sessão expirada")){
        const sessArr=Object.entries(sessions).filter(([,s])=>s.user_email===email&&s.access_token);
        if(sessArr.length){
          const [sid]=sessArr[0];
          try{ await refreshToken(sid); }catch(re){ console.warn(`[push-poll] refresh falhou para ${email}:`,re.message); }
        }
      } else {
        console.warn(`[push-poll] erro para ${email}:`,e.message);
      }
    }
  }
}
// Executa poll a cada 2 minutos
setInterval(serverPushPoll, 2 * 60 * 1000);


// Verifica se manual VIP está ativo
function isAdminVip(u) {
  // Admin sempre tem VIP ativo infinito (sem expiração)
  return !!(u?.isAdmin || isAdminEmail(u?.email||""));
}

function isManualVipActive(u) {
  if (isAdminVip(u)) return true; // Admin = infinito
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
  if (isAdminVip(u)) return true; // Admin = infinito
  const now = Date.now();
  // Stack novo: vip.autoExpires
  if (u.vip?.autoExpires && now < u.vip.autoExpires) return true;
  // Compatibilidade com sistema antigo
  if (u.vip?.active && now < (u.vip.expiresAt||0) && ["pro","vipro"].includes(u.vip?.plan||"")) return true;
  return false;
}
function isVipActive(u) { return isManualVipActive(u) || isAutoVipActive(u); }

// Admin tem plano máximo para fins de limites diários
function getAdminPlan() { return "doublepro"; }

// Retorna plano efetivo baseado no stack
function getPlan(u) {
  if (isAdminVip(u)) return getAdminPlan(); // Admin = plano máximo sempre
  const manual = isManualVipActive(u);
  const auto   = isAutoVipActive(u);
  // doublepro é o ÚNICO que precisa do plano salvo (limites 400/400) — atalho só p/ ele
  if (u.plan === 'doublepro' && isVipActive(u)) return 'doublepro';
  // Calcula pelo que está REALMENTE ativo (corrige o caso VIP+Pro = vipro, antes
  // o atalho 'return u.plan' devolvia "vip" e travava o automático em 10/dia).
  if (manual && auto) return 'vipro';
  if (auto)           return 'vipro'; // auto ativo (inclui legado "pro") → limite auto 200
  if (manual)         return 'vip';
  return 'free';
}

const getManualLimit = u => PLAN_LIMITS[getPlan(u)]?.manual || 20;
const getAutoLimit   = u => {
  if (isAdminVip(u)) {
    // Admin: respeita senderLimits se configurado, senão 9999
    return 9999;
  }
  return PLAN_LIMITS[getPlan(u)]?.auto || 10;
};

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

// ── EXTRATO DE DIAS (ledger de proveniência) ──────────────────────────
// Registra CADA concessão de dias VIP com sua história: pago vs grátis,
// de onde veio (origem), quem deu (dadoPor), por quê (motivo) e quando.
// Fonte única para exibir "60 pagos + 2 indicação" no perfil e no modal.
// Append-only — nunca apaga, só soma (mesma política do KB).
// Importante: chamar SEMPRE depois do setUser principal do vip, para que
// o spread ...(tgt.vip||{}) já tenha preservado os créditos anteriores.
function addCredito(email, c){
  const u = getUser(email) || {};
  const vip = u.vip || {};
  const creditos = Array.isArray(vip.creditos) ? vip.creditos.slice(-299) : [];
  const credito = {
    id: "cred_"+Date.now().toString(36)+"_"+crypto.randomBytes(3).toString("hex"),
    quando: Date.now(),
    dias: Math.round(Number(c.dias)||0),
    tipo: c.tipo === "pago" ? "pago" : "gratis",        // pago | gratis
    origem: c.origem || "admin",                         // pagamento|bonus|trial|indicacao|admin|codigo
    motivo: String(c.motivo||"").slice(0,200),
    dadoPor: c.dadoPor || "sistema",                     // Andrio | Diego | sistema | email
    pedidoId: c.pedidoId || null,
    valor: c.tipo === "pago" ? (Number(c.valor)||0) : 0,
  };
  if(credito.dias === 0) return null; // não registra concessão vazia
  creditos.push(credito);
  setUser(email, { vip: { ...vip, creditos } });
  return credito;
}

const todayStr = () => todayStrBRT();
// Manual = type "manual" apenas (NÃO conta auto, NÃO conta reply)
const countManualToday = h => (h||[]).filter(x=>(x.dateStr||"")===todayStr()&&x.type==="manual").length;
// Auto = type "auto" apenas
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
let SHEET_JAN = [], SHEET_JUL = [], SHEET_H2A = [];
let SHEET_EXTRAS = {}; // { "jul2026": [...vagas] } — planilhas extras carregadas via admin
const SHEETS_DIR = path.join(DATA_DIR, "sheets");
const SHEETS_META_FILE = path.join(DATA_DIR, "sheets_meta.json");
let DB_SHEETS_META = {}; // { "jul2026": { name, file, uploaded, count, enriched, enrichedAt } }

// ── Bot de Enriquecimento de Planilhas ──────────────────
// ══════════════════════════════════════════════════════════════════════════
//  📜 LOG UNIFICADO DE TODOS OS ROBÔS — pedido do dono (07/07/2026):
//  "preciso de logs inteligentes pra eu visualizar na página adm" pra saber
//  o que cada robô do sistema fez, quando e como. Ring buffer global — cada
//  robô empurra uma linha aqui além do log próprio dele (não substitui,
//  soma). Lido pela aba nova "📜 Logs dos Robôs" no admin.
// ══════════════════════════════════════════════════════════════════════════
const DB_BOT_LOGS = [];
const BOT_LOG_CAP = 1500;
function botLog(botId, botLabel, msg, type='info'){
  DB_BOT_LOGS.unshift({ ts:Date.now(), bot:botId, botLabel, msg:String(msg||'').slice(0,400), type });
  if(DB_BOT_LOGS.length>BOT_LOG_CAP) DB_BOT_LOGS.length=BOT_LOG_CAP;
}

const _enrichBot = {
  running: false,
  sheetKey: null,
  total: 0,
  done: 0,
  ok: 0,
  noEmail: 0,
  errors: 0,
  startedAt: null,
  log: [],         // últimas 100 linhas de log
  savedAt: null,
};

function _enrichLog(msg, type='info'){
  const line = { ts: Date.now(), msg, type };
  _enrichBot.log.push(line);
  if(_enrichBot.log.length > 200) _enrichBot.log.shift();
  console.log(`[enrich] ${msg}`);
  botLog('enrich','Enriquecimento de Planilha',msg,type);
}

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
  // ── Categorias H-2A (agricultura) ──
  crop:         { label:"🌱 Lavoura / Colheita",      en:"Crop / Field" },
  equipment_op: { label:"🚜 Operador de Máquinas",    en:"Equipment Operator" },
  livestock:    { label:"🐄 Pecuária / Animais",      en:"Livestock" },
  sheepherder:  { label:"🐑 Pastor de Ovelhas",       en:"Sheepherder" },
  nursery:      { label:"🪴 Viveiro / Estufa",        en:"Nursery / Greenhouse" },
  irrigation:   { label:"💧 Irrigação",               en:"Irrigation" },
  mechanic:     { label:"🔧 Mecânico Agrícola",       en:"Farm Mechanic" },
  supervisor:   { label:"👷 Supervisor de Fazenda",   en:"Farm Supervisor" },
  driver:       { label:"🚐 Motorista / Transporte",  en:"Driver" },
  truck_driver: { label:"🚛 Motorista de Caminhão",   en:"Truck Driver" },
  grader_sorter:{ label:"📦 Classificador / Seleção", en:"Grader / Sorter" },
  packer:       { label:"📦 Embalador",               en:"Packer" },
  carpenter:    { label:"🔨 Carpinteiro",             en:"Carpenter" },
  ironworker:   { label:"🏗️ Estrutura Metálica",     en:"Ironworker" },
  fence:        { label:"🚧 Cercas",                  en:"Fence" },
  cook:         { label:"👨‍🍳 Cozinheiro",            en:"Cook" },
  meat:         { label:"🥩 Frigorífico / Abate",     en:"Meat / Slaughter" },
  logging:      { label:"🪵 Extração de Madeira",     en:"Logging" },
  inspector:    { label:"🔎 Inspetor Agrícola",       en:"Ag Inspector" },
  other:        { label:"📋 Outros",                  en:"Other" },
};

// 🔒 Auto-cura de integridade (KB-076): toda vez que uma planilha é lida do
// disco, confere se tem case number duplicado. Se tiver (arquivo antigo,
// gerado antes desta correção — ex.: h2a_jun2026_compact.json tinha 36
// duplicados), MESCLA e GRAVA de volta corrigido, para o boot seguinte já
// carregar limpo. Nunca precisa de intervenção manual — o sistema se
// autocorrige e deixa registrado no log exatamente o que fez.
function _selfHealSheetIntegrity(label, rows, persistPath){
  const check = _vagasVerify(rows, {caseField:'c'});
  if(check.ok) return rows;
  const { rows: cleaned, duplicatesMerged } = _vagasDedupe(rows, {caseField:'c'});
  console.warn(`[sheet] 🩹 AUTO-CURA ${label}: ${rows.length} linhas → ${cleaned.length} vagas únicas (${duplicatesMerged} case number(s) duplicado(s) mesclado(s), NENHUM dado perdido)`);
  if(persistPath){
    try{
      fs.writeFileSync(persistPath, JSON.stringify(cleaned));
      console.warn(`[sheet] 🩹 ${label}: arquivo corrigido salvo em ${persistPath}`);
    }catch(e){ console.warn(`[sheet] ⚠️ Auto-cura ${label}: não consegui salvar o arquivo corrigido: ${e.message}`); }
  }
  return cleaned;
}

function loadSheets() {
  // ── Carrega DB_SHEETS_META do disco ──
  if(fs.existsSync(SHEETS_META_FILE)){
    try{ DB_SHEETS_META = JSON.parse(fs.readFileSync(SHEETS_META_FILE,"utf8")); }catch{}
  }

  // 🩹 Auto-cura (09/07/2026): deploys anteriores podem ter gravado uma
  // entrada de planilha EXTRA em sheets_meta.json sem o campo "file" (bug
  // do seed automático de jul2026, corrigido acima). Sem "file", o loop de
  // carregamento abaixo pula a planilha e ela nunca recupera o
  // enriquecimento já salvo em /data/sheets/ — reseta pra 0% pra sempre.
  // Cura sozinho, sem precisar de passo manual do admin: se a entrada não
  // tem "file" mas o arquivo <chave>.json existe em /data/sheets/, aponta
  // pra ele.
  for(const[metaKey,meta]of Object.entries(DB_SHEETS_META)){
    if(metaKey==="jan2026"||metaKey==="jul2025") continue;
    if(meta && !meta.file){
      const guess = `${metaKey}.json`;
      if(fs.existsSync(path.join(SHEETS_DIR,guess))){
        meta.file = guess;
        console.warn(`[sheet] 🩹 sheets_meta.json: "${metaKey}" estava sem campo "file" — corrigido sozinho para "${guess}".`);
      }
    }
  }

  let anyLoaded = false;
  for(const[key,file]of[["jan","jan2026_compact.json"],["jul","jul2025_compact.json"],["h2a","h2a_jun2026_compact.json"]]){
    // PRIORIDADE: /data/ (disco persistente, sobrevive deploys)
    // FALLBACK: __dirname (arquivo original do código, sem enriquecimento)
    const pData = path.join(DATA_DIR, file);   // /data/jan2026_compact.json
    const pSrc  = path.join(__dirname, file);   // /opt/render/.../jan2026_compact.json
    const p = fs.existsSync(pData) ? pData : pSrc; // preferir /data/
    if(p===pData) console.log(`[sheet] 📂 Carregando ${file} de /data/ (enriquecido)`);
    else console.log(`[sheet] 📂 Carregando ${file} de código (original)`);
    if(fs.existsSync(p)){
      try {
        let d=JSON.parse(fs.readFileSync(p,"utf8"));
        if(!Array.isArray(d) || d.length === 0) {
          console.warn(`[sheet] ⚠️ ${file} existe mas está vazio ou inválido`);
          continue;
        }
        // 🔒 Garante 1 vaga = 1 ETA case number ANTES de publicar em memória.
        d = _selfHealSheetIntegrity(key, d, p);
        if(key==="jan") SHEET_JAN=d; else if(key==="jul") SHEET_JUL=d; else SHEET_H2A=d;
        (key==="jan"?SHEET_JAN:key==="jul"?SHEET_JUL:SHEET_H2A).forEach(r=>{if(!r.k)r.k=detectCategory(`${r.n||""} ${r.t||""}`);});
        console.log(`[sheet] ✅ ${key}: ${d.length} vagas (ETA case numbers únicos)`);
        anyLoaded = true;
      } catch(e) {
        console.warn(`[sheet] ❌ Erro ao ler ${file}:`, e.message);
      }
    } else {
      console.warn(`[sheet] ⚠️ ${file} não encontrado. Execute: node build-sheets.js`);
    }
  }
  if (!anyLoaded) {
    console.warn("[sheet] ❌ NENHUMA planilha builtin carregada. Execute 'node build-sheets.js'.");
  }

  // ── Carrega planilhas EXTRAS do disco (/data/sheets/*.json) ──
  if(fs.existsSync(SHEETS_DIR)){
    let extrasLoaded = 0;
    for(const [metaKey, meta] of Object.entries(DB_SHEETS_META)){
      if(metaKey==="jan2026"||metaKey==="jul2025") continue;
      if(!meta?.file) continue;
      const fp = path.join(SHEETS_DIR, meta.file);
      if(!fs.existsSync(fp)) continue;
      try{
        let d = JSON.parse(fs.readFileSync(fp,"utf8"));
        if(!Array.isArray(d)||d.length===0) continue;
        // 🔒 Mesma garantia de integridade pras planilhas extras/históricas.
        d = _selfHealSheetIntegrity(`extra:${metaKey}`, d, fp);
        d.forEach(r=>{if(!r.k)r.k=detectCategory(`${r.n||""} ${r.t||""}`);r._sheet=metaKey;});
        SHEET_EXTRAS[metaKey] = d;
        extrasLoaded++;
        console.log(`[sheet] ✅ extra ${metaKey}: ${d.length} vagas (ETA case numbers únicos)`);
      }catch(e){ console.warn(`[sheet] ❌ Erro ao ler extra ${metaKey}:`, e.message); }
    }
    if(extrasLoaded>0) console.log(`[sheet] ✅ ${extrasLoaded} planilha(s) extra(s) carregada(s) do disco`);
  }

  // 🌱 Seed automático da planilha de Julho 2026 (ver função abaixo pro
  // porquê da checagem ser sobre DADO REAL, não sobre a existência de uma
  // entrada no meta — KB-086).
  seedJul2026FromBundle();
}

// ── 🌱 SEED "jul2026" — pedido do dono (08/07/2026): a lista randomizada de
// Julho 2026 acabou de sair e foi enviada pra mim. Deixo um
// jul2026_compact.json BUNDLED no código (mesma ideia do jan2026/jul2025/
// h2a) com os 2.625 case numbers + grupo oficial + empresa/estado já
// extraídos do PublicFacingReport real. Se ainda NÃO existe vaga de
// verdade carregada pra "jul2026" (ou se `force`=true, chamado manualmente
// pelo admin), carrega esse arquivo, publica na hora (usuário já pode se
// candidatar) e entrega pro Enriquecimento automático completar o resto.
//
// 🔒 KB-086 (dono, 08/07/2026): a checagem NÃO pode ser só "existe uma
// entrada em DB_SHEETS_META['jul2026']?" — um bot antigo (já apagado,
// aquele que baixava planilha errada) deixou uma entrada órfã/vazia no
// /data/sheets_meta.json de um deploy passado, e essa checagem antiga
// ficava "true" pra sempre sem NUNCA semear de verdade — foi exatamente
// isso que bloqueou o primeiro deploy. Agora a checagem é sobre DADO REAL
// carregado (SHEET_EXTRAS["jul2026"] com linha de verdade).
function seedJul2026FromBundle(force){
  const hasRealJul2026 = Array.isArray(SHEET_EXTRAS["jul2026"]) && SHEET_EXTRAS["jul2026"].length>0;
  if(hasRealJul2026 && !force) return { ok:true, skipped:true, reason:'já existe dado real', count:SHEET_EXTRAS["jul2026"].length };
  if(DB_SHEETS_META["jul2026"] && !hasRealJul2026) console.log(`[sheet] ⚠️ jul2026 tinha uma entrada em sheets_meta.json mas SEM vaga real carregada (provavelmente resquício de bot antigo) — semeando do zero mesmo assim.`);
  try{
    const seedPath = path.join(__dirname, "jul2026_compact.json");
    if(!fs.existsSync(seedPath)){
      console.warn(`[sheet] ⚠️ jul2026_compact.json não encontrado em ${seedPath} — nada pra semear.`);
      return { ok:false, reason:'arquivo bundled não encontrado no deploy' };
    }
    let seed = JSON.parse(fs.readFileSync(seedPath,"utf8"));
    if(!Array.isArray(seed) || !seed.length) return { ok:false, reason:'arquivo bundled vazio ou inválido' };
    seed = _selfHealSheetIntegrity("jul2026", seed, seedPath);
    seed.forEach(r=>{ if(!r.k) r.k=detectCategory(`${r.n||""} ${r.t||""}`); r._sheet="jul2026"; });
    SHEET_EXTRAS["jul2026"] = seed;
    DB_SHEETS_META["jul2026"] = {
      name: "Julho 2026 (H-2B)", key: "jul2026", emoji: "❄️",
      // 🐛 KB-FIX (09/07/2026): faltava "file" aqui. Sem isso, o loop que
      // recarrega planilhas EXTRAS de /data/sheets/*.json (loadSheets, ao
      // ler DB_SHEETS_META) pulava "jul2026" com `if(!meta?.file) continue`
      // — então SHEET_EXTRAS["jul2026"] nascia VAZIO em todo restart/deploy,
      // hasRealJul2026 dava false, e seedJul2026FromBundle() re-semeava do
      // zero (0% e-mail) TODA VEZ, jogando fora todo o enriquecimento já
      // salvo em disco. É exatamente por isso que o enriquecimento "não ia
      // pra frente": cada deploy resetava o progresso antes de terminar.
      file: "jul2026.json",
      published: true, publishedAt: Date.now(), visaType: "H-2B",
      count: seed.length, uniqueCaseCount: seed.length,
      source: "seed-bundled-publicfacingreport",
      uploaded: Date.now(),
    };
    try{ fs.writeFileSync(SHEETS_META_FILE, JSON.stringify(DB_SHEETS_META,null,2)); }catch{}
    try{
      if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
      fs.writeFileSync(path.join(SHEETS_DIR,"jul2026.json"), JSON.stringify(seed));
    }catch(e){ console.warn("[sheet] ⚠️ jul2026 seed: falha ao gravar em /data/sheets:", e.message); }
    console.log(`[sheet] 🌱 jul2026 semeada do arquivo bundled: ${seed.length} vagas publicadas (sem e-mail ainda — Enriquecimento automático completa sozinho a partir de 15s após o boot).`);

    // Também alimenta o mapa de grupos oficiais (mesmos dados, mesma
    // fonte) — assim o card "Grupos — Julho 2026" já mostra as
    // estatísticas certas sem precisar reimportar nada.
    let novosGrupos=0;
    try{
      for(const r of seed){
        const cn=String(r.c||"").toUpperCase();
        if(r.g && /^[A-H]$/.test(r.g) && !DB_GRUPOS_J26.mapa[cn]){
          DB_GRUPOS_J26.mapa[cn] = { grupo:r.g, manual:false, empresa:r.n||"", estado:r.s||"", status:r.st||"", importadoEm:Date.now(), fonte:'seed-bundled' };
          novosGrupos++;
        }
      }
      if(novosGrupos>0){
        DB_GRUPOS_J26.meta.ultimaImportacao = { at:Date.now(), fonte:'seed-bundled', arquivo:'jul2026_compact.json', novos:novosGrupos, atualizados:0, rejeitados:0, totalNoRelatorio:seed.length };
        DB_GRUPOS_J26.meta.historicoImportacoes.unshift(DB_GRUPOS_J26.meta.ultimaImportacao);
        persistGruposJ26();
        console.log(`[grupos-j26] 🌱 ${novosGrupos} grupo(s) semeado(s) junto com a planilha jul2026.`);
      }
    }catch(e){ console.warn("[grupos-j26] ⚠️ falha ao semear grupos junto com jul2026:", e.message); }
    return { ok:true, skipped:false, count:seed.length, novosGrupos };
  }catch(e){
    console.warn("[sheet] ⚠️ Falha ao semear jul2026 do arquivo bundled:", e.message);
    return { ok:false, reason:e.message };
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
  // ⚠️ V960 (correção do bug Housekeeper↔Cook): faltavam palavras de CARGO
  // aqui — antes só tinha nome de lugar (restaurant/grill/...), então um
  // título "Cook"/"Chef"/"Kitchen" nunca vencia "hotel/resort" quando o
  // nome da empresa também aparecia no texto analisado.
  food:         ['restaurant','grill','tavern','cantina','bistro','brewpub','cafeteria','diner','foodservice','food service','food prep','bartend','cook','chef','kitchen','dishwasher','waiter','waitress','server','banquet','busser','baker','barista'],
  ski:          ['ski ','snowboard','winter resort','mountain resort'],
};

// Prioridade: cargo (r.t) sempre vale mais que nome da empresa (r.n). Um
// título "Cook" deve ganhar de "resort" no nome da empresa. Construído a
// partir de JOB_TITLE_TO_CAT (mais abaixo) na primeira chamada de detectCategory.
let _jobTitlePriorityKeys = null;

function detectCategory(name) {
  const n = (name||"").toLowerCase();
  // 1) Match por CARGO específico primeiro (mais confiável que nome de empresa)
  if(!_jobTitlePriorityKeys) _jobTitlePriorityKeys = Object.entries(JOB_TITLE_TO_CAT).sort((a,b)=>b[0].length-a[0].length);
  for(const[title,cat] of _jobTitlePriorityKeys){ if(n.includes(title)) return cat; }
  // 2) Fallback: palavras-chave genéricas (nome de empresa, tipo de negócio etc.)
  for(const[cat,kws]of Object.entries(CATEGORY_KEYWORDS)){if(kws.some(k=>n.includes(k)))return cat;}
  return "other";
}

function getSheet(n) { return n==="jan2026"?SHEET_JAN:n==="jul2025"?SHEET_JUL:(n==="h2a-jun2026"||n==="h2ajun2026")?SHEET_H2A:SHEET_EXTRAS[n]||[]; }
function getAllSheets() {
  // Retorna TODAS as planilhas combinadas (jan + jul + extras)
  return [...SHEET_JAN,...SHEET_JUL,...SHEET_H2A,...Object.values(SHEET_EXTRAS).flat()];
}

function getSheetCategories(sheetName) {
  const arr = getSheet(sheetName);
  const counts = {};
  arr.forEach(r => { const k=r.k||"other"; counts[k]=(counts[k]||0)+1; });
  return Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .map(([k,count])=>({key:k,label:CATEGORY_LABELS[k]?.label||k,count}));
}

// ── TAXONOMIA REAL DE CARGOS (por título exato da vaga, não categoria fixa) ──
// Pedido do dono: os filtros de categoria (só ~11 grupos) são grossos demais
// e causam contaminação (ex.: Cook caindo em Housekeeper). Esta função monta
// a lista de TODOS os títulos que realmente existem na planilha, contados,
// e agrupa em "Outros" todo título que aparece 3x ou menos (cargo isolado) —
// exatamente como pedido, pra não gerar uma lista de milhares de checkboxes
// com 1 vaga cada. Usada pelo modal grande de filtros (manual + automático).
function buildTitleTaxonomy(rows) {
  const counts = new Map(); // chave: título normalizado (lowercase) → {label, count}
  for (const r of rows) {
    const raw = String(r.t || "").trim().replace(/\s+/g, " ");
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!counts.has(key)) counts.set(key, { label: raw, count: 0 });
    counts.get(key).count++;
  }
  const all = [...counts.values()];
  const principais = all.filter(x => x.count > 3).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const raros = all.filter(x => x.count <= 3).sort((a, b) => a.label.localeCompare(b.label));
  const outrosCount = raros.reduce((s, x) => s + x.count, 0);
  return {
    titulos: principais.map(x => ({ title: x.label, count: x.count })),
    outros: { count: outrosCount, titulos: raros.map(x => x.label) },
    totalTitulosDistintos: all.length,
    totalVagas: rows.length,
  };
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
  "kitchen staff":"food",kitchen:"food",server:"food",restaurant:"food",
  banquet:"food",busser:"food","food prep":"food","cafeteria worker":"food",
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
    // Busca direta: empresa, cargo, case number, estado, cidade, descrição

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
  // para evitar que vários usuários enviem para as mesmas empresas simultaneamente.
  // NOTA: o shuffle real acontece no /api/auto/start após coletar todas as vagas.
  // Na busca paginada usamos ordem estável para garantir que skip/top
  // retornem registros corretos sem duplicatas ou lacunas entre páginas.
  if (sort==="desc") list=[...list].reverse();
  else if (sort==="shuffle") { list=shuffleArray(list); } // shuffle explícito (uso não-paginado)
  // ── V953: ordenações determinísticas novas (estáveis p/ paginação) ──
  // wage  → maior salário primeiro, NORMALIZADO por unidade: dados reais têm
  //         'h' (16k), 'mo' (184) e vazio. Mensal ÷173h e semanal ÷40h viram
  //         equivalente/hora — senão $4.938/mês "ganha" de $30/h no sort.
  // start → começa antes primeiro (r.d ISO; sem data vai pro fim)
  else if (sort==="wage") {
    const pw=r=>{
      if(!r.w)return -1;
      const m=String(r.w).match(/[0-9.]+/);if(!m)return -1;
      const v=parseFloat(m[0]);
      const un=String(r.wunit||"h").toLowerCase();
      if(un.startsWith("mo"))return v/173;   // mês ≈ 173h
      if(un.startsWith("w"))return v/40;     // semana ≈ 40h
      if(un.startsWith("d"))return v/8;      // dia ≈ 8h
      if(un.startsWith("y")||un.startsWith("a"))return v/2080; // ano ≈ 2080h
      // Dado sujo da fonte: valor rotulado "hora" mas >200 é quase certamente
      // mensal sem unidade ($2.058/h não existe no DOL; $75/h de piloto é o teto real)
      if(v>200)return v/173;
      return v; // "h" ou desconhecido → trata como hora
    };
    list=[...list].sort((a,b)=>pw(b)-pw(a));
  }
  else if (sort==="start") {
    list=[...list].sort((a,b)=>String(a.d||"9999").localeCompare(String(b.d||"9999")));
  }
  // sort="asc", "random", "" → ordem estável para paginação correta
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
  return{id:String(j.case_number||j.case_id||("j"+i)),caseNum:String(j.case_number||j.case_id||""),title,company:j.employer_business_name||j.employer_trade_name||"–",city:j.employer_city||j.worksite_city||"–",state:j.employer_state||j.worksite_state||"–",wage:wg,workers:parseInt(j.total_positions||1),start:(j.begin_date||"–").slice(0,10),end:(j.end_date||"–").slice(0,10),email:em,phone:ph,url:ur,active:j.active===true,visa:j.visa_class||"H-2B",jobType:j.visa_class==="H-2A"?"agricultural":"non-agricultural",soc:j.soc_title||"",desc:(j.job_duties||"").replace(/\*\*[^*]+\*\*\n?/g,"").trim(),hasEmail:!!em,category:detectCategory(`${j.employer_business_name||""} ${title} ${j.soc_title||""}`)};
}

async function fetchDOL(skip,top,opts={}) {
  const{query="",state="",jobType="all",jobStatus="all",beginDate="",sort="desc"}=opts;
  const p=new URLSearchParams({"api-version":"2020-06-30"});
  if(query)p.append("$search",'"'+query.replace(/"/g,"")+'"');
  const f=[];
  if(jobStatus==="active")f.push("active eq true");if(jobStatus==="inactive")f.push("active eq false");
  if(jobType==="agricultural")f.push("visa_class eq 'H-2A'");if(jobType==="non-agricultural")f.push("visa_class eq 'H-2B'");
  if(state)f.push(`(employer_state eq '${state}' or worksite_state eq '${state}')`);
  if(beginDate)f.push(`begin_date ge ${beginDate}T00:00:00Z`);
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

  // ── PASSO 1: cache em memória ──────────────────────────
  const toFetch=cases.filter(c=>{
    const cc=sheetCache.get(c);
    if(cc&&Date.now()-cc.ts<SHEET_TTL){results[c]=cc.job;return false;}
    return true;
  });
  if(!toFetch.length)return results;

  // ── PASSO 2: planilha local (SEMPRE, sem depender do DOL) ──
  // Constrói um mapa case→row de todos os sheets carregados
  const allSheets = getAllSheets(); // jan2026 + jul2025 + todas as extras
  const sheetByCase=new Map(allSheets.map(r=>[String(r.c||"").toUpperCase(),r]));
  const stillMissing=[];
  for(const c of toFetch){
    const row=sheetByCase.get(c.toUpperCase());
    if(row&&row.e&&row.e.includes("@")){
      // Monta job no mesmo formato que normJob() retorna
      const job={
        id:row.c,caseNum:row.c,title:row.t||"Seasonal Worker",
        company:row.n||"–",city:row.ci||"–",state:row.s||"–",
        wage:row.w?`$${row.w}/${row.wunit||"h"}`:"–",
        workers:row.wk||null,start:row.d||"–",end:row.de||"–",
        email:row.e,phone:row.ph||"",
        url:row.c&&row.c.startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${row.c}`:"",
        active:true,
        visa:row.visa||"H-2B",jobType:"non-agricultural",
        soc:"",desc:"",hasEmail:true,category:row.k||"other",
        fromSheet:true
      };
      results[c]=job;
      sheetCache.set(c,{job,ts:Date.now()});
    } else {
      stillMissing.push(c);
    }
  }

  // ── PASSO 3: DOL só para o que não está na planilha local ──
  // Se o DOL estiver fora do ar, simplesmente ignora — não trava nada
  if(stillMissing.length){
    const HDR={"Accept":"application/json","Accept-Encoding":"identity","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36","Cache-Control":"no-cache","Referer":"https://seasonaljobs.dol.gov/"};
    for(let i=0;i<stillMissing.length;i+=10){
      const batch=stillMissing.slice(i,i+10);
      try{
        const p=new URLSearchParams({"api-version":"2020-06-30"});
        p.append("$filter",batch.map(c=>`case_number eq '${c}'`).join(" or "));
        p.append("$top",String(batch.length));
        const{status,body}=await httpsReq({hostname:"api.seasonaljobs.dol.gov",path:"/datahub/?"+p,method:"GET",headers:HDR});
        if(status===200){const raw=body.value||body.results||body.data||(Array.isArray(body)?body:[]);for(const r of raw){const job=normJob(r,0);const cn=(r.case_number||r.case_id||"").toUpperCase();if(cn){results[cn]=job;sheetCache.set(cn,{job,ts:Date.now()});}}}
      }catch(e){console.warn("[fetchByCase/DOL offline]",e.message);}
      // Fallback individual (só tenta se DOL responder)
      const miss2=batch.filter(c=>!results[c]);
      for(const c of miss2){
        try{const p2=new URLSearchParams({"api-version":"2020-06-30"});p2.append("$search",`"${c}"`);p2.append("$top","1");const{status,body}=await httpsReq({hostname:"api.seasonaljobs.dol.gov",path:"/datahub/?"+p2,method:"GET",headers:HDR});if(status===200){const raw=body.value||body.results||body.data||(Array.isArray(body)?body:[]);if(raw.length>0){const job=normJob(raw[0],0);results[c]=job;sheetCache.set(c,{job,ts:Date.now()});}}}catch{}
      }
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

// isAutoHour REMOVIDA: automático não tem mais janela de horário

function getAutoStats(email) {
  return autoStats.get(email) || { sent:0, failed:0, skipped:0, startedAt:null };
}
function updateAutoStats(email, delta) {
  const s = getAutoStats(email);
  autoStats.set(email, { ...s, ...delta });
}

function scheduleAuto(email) {
  if(autoTimers.has(email))clearTimeout(autoTimers.get(email));
  const job=getAutoJob(email);
  if(!job||!job.active){autoTimers.delete(email);return;}
  // Fila zerada: finalizar com status correto
  if(!job.queue?.length){
    setAutoJob(email,{...job,active:false,queue:[],finishedAt:Date.now(),status:"finished"});
    autoTimers.delete(email);
    addLog(email,{status:"sistema",jobTitle:"✅ Fila finalizada",company:`Total: ${job.originalCount||0} vagas processadas.`});
    console.log(`[auto] ${email} fila zerada no scheduleAuto — marcado como finished`);
    sendNotifEmail(email,"finished").catch(()=>{});
    return;
  }

  // ── Sem janela de horário: roda 24/7 até zerar a fila ────────────────────
  // Ao atingir o limite diário, aguarda a meia-noite BRT (00:00 = 03:00 UTC)
  // e retoma imediatamente — sem parar por horário, nunca.

  function nextMidnightBRT() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3,0,1,0); // 00:00 BRT = 03:01 UTC (1s após meia-noite)
    if (next <= now) next.setUTCDate(next.getUTCDate()+1);
    return next;
  }

  const p=getUser(email)||{};

  // ── Conta deletada pelo próprio usuário: nunca mandar e-mail em nome dela ──
  // Defesa extra (o timer já é limpo no momento do delete, mas um setTimeout
  // pode estar em voo numa corrida rara — esta checagem garante que nada sai).
  if(p.accountDeleted){
    setAutoJob(email,{...job,active:false,status:"paused_account_deleted",finishedAt:Date.now()});
    autoTimers.delete(email);
    return;
  }

  // ── REGRA: 10 envios automáticos GRÁTIS/dia para TODOS ──────────────────
  // Antes, quem não tinha VIP automático era PAUSADO ("plano expirou"), o que
  // bloqueava até os 10/dia grátis. Agora NÃO bloqueia por falta de plano: o
  // limite diário (getAutoLimit) já devolve 10 p/ free e 200 p/ VIPro, e o
  // bloco de "waiting_limit" abaixo segura no teto e retoma à meia-noite.
  // (Sem hard-stop por VIP — só o limite diário regula.)

  // Limite: usa o atual do plano (não o lockedAutoLimit) para que expiração surta efeito
  const autoLimit = isAdminVip(p) ? 9999 : getAutoLimit(p);
  // Admin pode ter limite diário por sender customizado
  const adminSenderLimits = (isAdminVip(p) && p.adminSettings?.senderLimits) ? p.adminSettings.senderLimits : null;
  const todayAuto=countAutoToday(getHist(email));

  if(!isAdminVip(p) && todayAuto>=autoLimit){
    const next = nextMidnightBRT();
    const delay = Math.max(60_000, Math.min(next - Date.now(), 24*60*60*1000)); // entre 1min e 24h
    setAutoJob(email,{...job,status:"waiting_limit",nextSendAt:next.getTime()});
    autoTimers.set(email,setTimeout(()=>scheduleAuto(email),delay));
    const retomaBRT = next.toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit"});
    addLog(email,{status:"limite",jobTitle:`📊 Limite diário atingido: ${todayAuto}/${autoLimit} envios hoje`,company:`Retoma automaticamente às 00:00 BRT (${Math.round(delay/60000)}min). Fila: ${job.queue?.length||0} vagas restantes.`,error:""});
    console.log(`[auto] ${email} limite diário (${todayAuto}/${autoLimit}) — aguarda meia-noite BRT (${Math.round(delay/60000)}min)`);
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
  if (autoSendLock.has(email)) { console.warn(`[auto] ${email} já enviando`); return; }
  autoSendLock.add(email);
  try {
    await _doAutoSendInner(email);
  } catch(unexpectedErr) {
    // FIX-BUG12: captura exceções não tratadas — sempre reagenda
    console.error(`[auto] ERRO INESPERADO ${email}:`, unexpectedErr?.message||unexpectedErr);
    const curJob = getAutoJob(email);
    if (curJob?.active && curJob?.queue?.length > 0) {
      addLog(email, { status:"sistema", jobTitle:"⚠️ Erro interno recuperado", company:String(unexpectedErr?.message||"erro").slice(0,200) });
      autoTimers.set(email, setTimeout(()=>scheduleAuto(email), 60_000));
    }
  } finally {
    autoSendLock.delete(email);
  }
}

async function _doAutoSendInner(email) {
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
      // ── VERIFICAR BASE GLOBAL DE EMAILS INVÁLIDOS (bounce intelligence) ──
      if (isEmailInvalid(_ce.email)) {
        const invInfo = DB_INVALID_EMAILS[_ce.email];
        const motivo = invInfo?.motivo || 'Email permanentemente inválido (bounce detectado)';
        addLog(email, { status:"pulado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:`⚫ Email inválido removido da fila: ${motivo} (${invInfo?.count||1}x detectado)` });
        queue.shift(); continue;
      }
      candidate.to = _ce.email; // normalizado
      target = Object.assign({}, candidate); break;
    }
    addLog(email, { status:"duplicado", company:candidate.company||"", to:candidate.to, jobTitle:candidate.title||"", category:candidate.category||"other", state:candidate.state||"", source:job.source||"", error:"Email já enviado anteriormente", senderEmail:email });
    queue.shift();
  }

  // FIX-BUG6: finaliza APENAS quando !target
  if (!target) {
    setAutoJob(email, { ...job, active:false, queue:[], finishedAt:Date.now(), status:"finished" });
    autoTimers.delete(email);
    addLog(email, { status:"sistema", jobTitle:"✅ Fila finalizada", company:`Total: ${job.originalCount||0} vagas processadas. Todas enviadas!` });
    console.log(`[auto] ${email} finalizado — todas as vagas enviadas`);
    sendNotifEmail(email, "finished").catch(e => console.warn("[notif/finished]", e.message));
    return;
  }

  // Remove target da fila e salva ANTES de tentar envio (evita reprocessamento em crash)
  queue.shift();
  setAutoJob(email, { ...job, queue, lastSentAt:Date.now(), status:"sending", currentJob:target });

  // ── Token — nunca pausa sem tentar renovar primeiro ──────
  const logEntry = { company:target.company||"", to:target.to||"", jobTitle:target.title||"", category:target.category||"other", state:target.state||"", city:target.city||"", source:job.source||"", resumeName:"", error:"", profileUsed:"", selectedProfileName:"" };
  let accessToken = null;
  let _autoSenderEmail = email; // email que vai realmente enviar (principal ou extra)

  // ── Round-robin REAL: inclui email principal + todos os extras
  // getSenderToken decide quem envia baseado em menor contagem hoje
  // Se retornar token=null → principal escolhido, fluxo normal de sessão/refresh
  // Se retornar token!=null → extra escolhido, usa diretamente
  try {
    const {token:sndTok0, senderEmail:sndEmail0} = await getSenderToken(email, null, job.senders);
    _autoSenderEmail = sndEmail0; // já define o sender (principal ou extra)
    if (sndTok0) {
      accessToken = sndTok0; // extra: tem token direto
      console.log(`[auto] 🔄 Round-robin → extra: ${sndEmail0}`);
    } else {
      console.log(`[auto] 🔄 Round-robin → principal: ${sndEmail0}`);
      // token=null → fluxo normal de sessão/refresh abaixo para o principal
    }
  } catch(e) {
    console.warn("[auto] round-robin erro:", e.message);
    // Usuário SELECIONOU e-mails específicos e nenhum está disponível:
    // NÃO cair no principal (pode estar bloqueado — foi excluído de propósito).
    if (Array.isArray(job.senders) && job.senders.length &&
        !job.senders.map(x=>String(x).toLowerCase()).includes(email.toLowerCase())) {
      queue.unshift(target); // devolve a vaga à fila — nada foi enviado
      setAutoJob(email, { ...job, queue, active:false, status:"paused_auth_error", finishedAt:Date.now() });
      autoTimers.delete(email);
      addLog(email, { status:"pausado", jobTitle:"⛔ E-mails de envio indisponíveis", company:"Os e-mails que você selecionou estão com token expirado ou bloqueados. Reconecte-os em Configurações → E-mails de envio e retome.", error:e.message });
      return;
    }
  }

  // Prioridade 1: sessão ativa em memória (só se não usou sender extra)
  const sessArr = Object.values(sessions).filter(s => s.user_email === email && s.access_token);
  const sess    = sessArr[0] || null;
  const sessId  = sess ? Object.keys(sessions).find(k => sessions[k] === sess) : null;
  if (!accessToken) {
    if (sess && sess.expires_at && Date.now() > sess.expires_at - 120_000) {
      try { await refreshToken(sessId); } catch(e) { console.warn("[auto] refresh sessão:", e.message); }
    }
    if (sess?.access_token) accessToken = sess.access_token;
  }

  // Prioridade 2: token cacheado no banco ainda válido
  if (!accessToken) {
    const userData = getUser(email);
    if (userData?.cached_access_token && userData.cached_token_expiry && Date.now() < userData.cached_token_expiry - 120_000) {
      accessToken = userData.cached_access_token;
    }
  }

  // (round-robin já decidiu o sender acima — principal ou extra)

  // Prioridade 3: renovar via refresh_token (sempre tenta antes de pausar)
  if (!accessToken) {
    const userData = getUser(email);
    if (userData?.refresh_token) {
      try {
        accessToken = await refreshTokenForUser(email);
        console.log(`[auto] ✅ Token renovado via refresh_token para ${email}`);
      } catch(e) {
        const msg = e.message || "";
        const isRevoked = msg.includes("invalid_grant") || msg.includes("revoked") || msg.includes("Token has been expired or revoked");
        // Só pausa definitivamente se o usuário revogou o acesso no Google
        // Para erros de rede/timeout, mantém ativo e tenta de novo no próximo ciclo
        if (isRevoked) {
          setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_token_revoked" });
          autoTimers.delete(email);
          addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle:"🔐 Acesso Google revogado — faça login novamente", error: msg });
          console.warn(`[auto] ❌ Token revogado para ${email} — pausa definitiva`);
          // Notifica usuário por email APENAS se ativo nos últimos 10 dias
          { const _u = getUser(email);
            const _lastSeen = _u?.lastSeenAt || new Date(_u?.created_at||0).getTime();
            const _inactiveDays = (Date.now() - _lastSeen) / 86400000;
            if (_inactiveDays <= 10) {
              sendNotifEmail(email, "token_revoked").catch(e => console.warn("[notif/token_revoked]", e.message));
            } else {
              console.log(`[notif] token_revoked ignorado — ${email} inativo ${Math.round(_inactiveDays)}d`);
            }
          }
        } else {
          // Erro temporário (rede, timeout) — agenda nova tentativa em 5min sem pausar
          const curJob = getAutoJob(email);
          if (curJob) {
            const retryDelay = 5 * 60 * 1000;
            setAutoJob(email, { ...curJob, status:"waiting_token_retry", nextSendAt: Date.now() + retryDelay });
            autoTimers.set(email, setTimeout(() => scheduleAuto(email), retryDelay));
            addLog(email, { status:"sistema", jobTitle:"⏳ Erro temporário de token — tentando novamente em 5min", company: msg });
            console.warn(`[auto] ⚠️ Erro temporário de token para ${email}, retry em 5min:`, msg);
          }
        }
        return;
      }
    } else {
      // Sem refresh_token nenhum — usuário nunca deu permissão offline ou dados foram perdidos
      setAutoJob(email, { ...getAutoJob(email), active:false, status:"paused_no_session" });
      autoTimers.delete(email);
      addLog(email, { status:"pausado", company:"Sistema", to:"", jobTitle:"🔐 Sem token salvo — faça login novamente", error:"Nenhum refresh_token disponível" });
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
      vaga:       String(target.title    || ""),
      empresa:    String(target.company  || ""),
      nome:       String(p.name || sess?.user_name || ""),
      pais:       String(p.country || "Brazil"),
      telefone:   String(p.phone || ""),
      email:      String(email),                        // email do usuário/candidato
      cidade:     String(target.city    || p.city || ""),
      estado:     String(target.state   || ""),
      wage:       String(target.wage    || ""),
      salario:    String(target.wage    || ""),
      inicio:     String(target.start   || ""),
      fim:        String(target.end     || ""),
      case_number:String(target.caseNum || ""),
      eta_case:   String(target.caseNum || ""),         // alias
      url_vaga:   target.caseNum && target.caseNum.startsWith("H-")
                    ? `https://seasonaljobs.dol.gov/jobs/${target.caseNum}`
                    : (target.url || ""),               // link direto para a vaga no DOL
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
        senderEmail: _autoSenderEmail || email,
        attachCount: attachments.length,
        category:  target.category,
        state:     target.state,
        city:      target.city      || "",
        wage:      target.wage      || "",
        visa:      target.visa      || target.visaType || "",
        workers:   target.workers   || null,
        start:     target.start     || target.beginDate || "",
        end:       target.end       || target.endDate   || "",
        caseNum:   target.caseNum   || target.case_number || "",
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

      addLog(email, { ...logEntry, status:"enviado", appId, profileUsed:selectedProfile?.name||"", subjectUsed:subject.slice(0,120), attachCount:attachments.length, attempt:retryCount+1, senderEmail:_autoSenderEmail||email, wage:target.wage||"", city:target.city||"", workers:target.workers||null, start:target.start||"", caseNum:target.caseNum||"" });
      updateAutoStats(email, { sent:(getAutoStats(email).sent||0)+1, startedAt:getAutoStats(email).startedAt||Date.now() });
      // ✅ Heartbeat: registra atividade para o watchdog
      { const h=getHealth(email); h.lastSent=Date.now(); h.errors=0; h.stalledAt=null; h.status="ok"; }
      // Limpa _rl_* keys do job para o destinatário atual (evita crescimento infinito do objeto)
      { const _cj=getAutoJob(email); if(_cj){ const _rlKey="_rl_"+(target.to||"").replace(/[^a-z0-9]/gi,""); if(_cj[_rlKey]){ const {[_rlKey]:_rm,..._rest}=_cj; setAutoJob(email,_rest); } } }
      console.log(`[auto] ✅ ${email} → ${target.to} anexos=${attachments.length} [${appId}]`);
      sendOk = true;
      break;

    } catch(e) {
      const errMsg = String(e.message);

      // ── Traduz erros técnicos do Gmail em mensagens claras para o usuário ──
      function translateGmailError(msg) {
        if (msg.includes("rateLimitExceeded") || msg.includes("userRateLimitExceeded") || msg.includes("User-rate limit"))
          return { type:"rate_limit", friendly:"⏳ Gmail bloqueou temporariamente os envios (limite de taxa). O sistema vai aguardar e tentar novamente automaticamente." };
        if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked"))
          return { type:"auth", friendly:"🔐 Sua sessão Google expirou ou o acesso foi revogado. Faça login novamente no H2BApply para o automático continuar." };
        if (msg.includes("insufficientPermissions") || msg.includes("Request had insufficient"))
          return { type:"permission", friendly:"🔐 Permissão insuficiente no Gmail. Faça logout e login novamente, aceitando todas as permissões solicitadas." };
        if (msg.includes("suspended") || msg.includes("Account has been suspended") || msg.includes("Suspended"))
          return { type:"suspended", friendly:"⛔ Sua conta Google foi suspensa temporariamente. Acesse gmail.com para verificar se há algum alerta de segurança." };
        if (msg.includes("sendDisabled") || msg.includes("Mail sending is disabled"))
          return { type:"send_disabled", friendly:"⛔ O envio de e-mails está desativado nesta conta Google. Verifique o painel do Gmail." };
        if (msg.includes("StorageQuotaExceeded") || msg.includes("quota"))
          return { type:"quota", friendly:"📦 Sua conta Gmail atingiu o limite de armazenamento. Libere espaço no Google Drive/Gmail para continuar." };
        if (msg.includes("Invalid") && msg.includes("To"))
          return { type:"invalid_email", friendly:`📧 E-mail do empregador inválido: "${logEntry.to}". Esta vaga foi pulada automaticamente.` };
        if (msg.includes("554") || msg.includes("550") || msg.includes("rejected"))
          return { type:"rejected", friendly:"📧 O servidor de e-mail do empregador rejeitou a mensagem. Vaga pulada, continuando com a próxima." };
        if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET"))
          return { type:"network", friendly:"🌐 Erro de conexão temporário. O sistema vai tentar novamente automaticamente." };
        if (msg.includes("500") || msg.includes("503") || msg.includes("Service Unavailable"))
          return { type:"server_error", friendly:"⚠️ Erro temporário no servidor do Gmail. Tentando novamente automaticamente." };
        return { type:"unknown", friendly:`❌ Erro ao enviar: ${msg.slice(0, 200)}` };
      }

      const { type: errType, friendly: errFriendly } = translateGmailError(errMsg);
      const isRateLimit = errType === "rate_limit";
      const isAuth      = errType === "auth" || errType === "permission";
      const isSuspended = errType === "suspended" || errType === "send_disabled";
      const isTransient = errType === "network" || errType === "server_error";
      const isSkippable = errType === "invalid_email" || errType === "rejected" || errType === "quota";

      if (isRateLimit) {
        // Rate limit: respeita o Retry-After e devolve vaga à fila
        let retryAfterMs = 60 * 60 * 1000; // 1h fallback
        const retryMatch = errMsg.match(/Retry after ([0-9T:.Z+-]+)/i);
        if (retryMatch) {
          try {
            const retryTs = new Date(retryMatch[1]).getTime();
            const waitMs = retryTs - Date.now();
            if (waitMs > 0 && waitMs < 12 * 3600_000) retryAfterMs = waitMs + 60_000;
          } catch(_) {}
        }
        const retryAtStr = new Date(Date.now() + retryAfterMs).toLocaleTimeString("pt-BR", {timeZone:"America/Sao_Paulo"});
        const waitMin = Math.round(retryAfterMs / 60000);
        const curJob = getAutoJob(email);
        if (curJob) {
          // Devolve a vaga para frente da fila — não perde
          const restoredQ = [target, ...(curJob.queue||[])];
          setAutoJob(email, { ...curJob, queue: restoredQ, status:"waiting_rate_limit", nextSendAt:Date.now()+retryAfterMs });
        }
        addLog(email, { ...logEntry, status:"pausado", error: errFriendly + ` Retomando às ${retryAtStr} BRT (${waitMin}min).` });
        trackJourney(email,'auto_fail',{ok:false,error:errFriendly,detail:`Rate limit → ${target?.company||"?"}`});
        console.warn(`[auto] ⏳ Rate limit ${email} — pausando ${waitMin}min`);
        autoTimers.set(email, setTimeout(() => scheduleAuto(email), retryAfterMs));
        return;
      }

      if (isAuth || isSuspended) {
        // Problema de autenticação: pausa o automático e avisa claramente
        const curJob = getAutoJob(email);
        if (curJob) {
          // Devolve vaga à fila para quando o usuário logar de novo
          const restoredQ = [target, ...(curJob.queue||[])];
          setAutoJob(email, { ...curJob, queue: restoredQ, active:false, status: isSuspended ? "paused_account_suspended" : "paused_auth_error" });
        }
        if (autoTimers.has(email)) { clearTimeout(autoTimers.get(email)); autoTimers.delete(email); }
        addLog(email, { ...logEntry, status:"pausado", error: errFriendly });
        trackJourney(email,'auto_fail',{ok:false,error:errFriendly,critical:true,detail:`Auth error → auto pausado`});
        console.warn(`[auto] ❌ Auth/suspended ${email} — auto pausado`);
        return;
      }

      if (isTransient && retryCount < MAX_RETRIES) {
        retryCount++;
        console.warn(`[auto] ⚠️ Erro temporário (${errMsg}), retry ${retryCount}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 8000 * retryCount));
        continue;
      }

      // Erro definitivo para esta vaga (invalid email, rejected, quota, unknown)
      // Pula a vaga e continua com a próxima — NÃO para o automático
      addLog(email, { ...logEntry, status: isSkippable ? "pulado" : "falhou", error: errFriendly, profileUsed:selectedProfile?.name||"", subjectUsed:(subject||"").slice(0,120), attachCount:attachments.length, attempt:retryCount+1, senderEmail:_autoSenderEmail||email, wage:target.wage||"", city:target.city||"" });
      trackJourney(email,'auto_fail',{ok:false,error:errFriendly,detail:`${target?.company||"?"} → ${target?.to||"?"}`});
      updateAutoStats(email, { failed:(getAutoStats(email).failed||0)+1 });
      break;
    }
  }

  // Agenda próximo envio — sempre relê job do banco
  const updJob = getAutoJob(email);
  if (!updJob || !updJob.active) { autoTimers.delete(email); return; }
  const interval = calcSmartInterval(email);
  setAutoJob(email, { ...updJob, status:"waiting_interval", nextSendAt:Date.now()+interval });
  autoTimers.set(email, setTimeout(() => scheduleAuto(email), interval));
}

const genSubject=title=>{const pfx=["Application for","Interest in","Applying for","H-2B Application:","Candidature for"];return`${pfx[Math.floor(Math.random()*pfx.length)]} ${title}`;};
// fillTpl: substitui TODAS as variáveis de template — incluindo {email}, {cidade}, {estado}
const fillTpl=(tpl,v)=>(tpl||"")
  .replace(/{vaga}/g,       v.vaga||"")
  .replace(/{empresa}/g,    v.empresa||"")
  .replace(/{url_vaga}/g,   v.url_vaga||"")
  .replace(/{case_number}/g,v.case_number||"")
  .replace(/{eta_case}/g,   v.eta_case||"")
  .replace(/{salario}/g,    v.salario||"")
  .replace(/{fim}/g,        v.fim||"")
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

async function reactivateAutoJobs(){
  let n=0;
  const now = Date.now();

  // Passo 1: renova tokens de TODOS os usuários com auto ativo ANTES de agendar
  // FIX-CRASH: pré-aquecimento em background com lotes de 3 (não bloqueia o boot)
  const emailsToWarm = Object.entries(DB_AUTO)
    .filter(([,j]) => j.active && j.queue?.length > 0)
    .map(([e]) => e);

  console.log(`[boot] Pré-aquecendo tokens para ${emailsToWarm.length} usuário(s) com auto ativo...`);
  // Fire-and-forget: não bloqueia o boot — tokens são renovados em background
  (async () => {
    for (let i = 0; i < emailsToWarm.length; i += 3) {
      const lote = emailsToWarm.slice(i, i + 3);
      await Promise.allSettled(lote.map(async email => {
        const u = getUser(email);
        if (!u?.refresh_token) return;
        try {
          await refreshTokenForUser(email);
          console.log(`[boot] ✅ Token pré-aquecido: ${email}`);
        } catch(e) {
          console.warn(`[boot] ⚠️ Token falhou para ${email}:`, e.message);
        }
      }));
      if (i + 3 < emailsToWarm.length) await new Promise(r => setTimeout(r, 1000));
    }
  })();

  // Passo 2: agenda os jobs
  for(const[email,job]of Object.entries(DB_AUTO)){
    if(!job.active||!job.queue?.length) continue;
    // FIX-BUG13: valida estrutura da fila
    if(!Array.isArray(job.queue)){
      console.error(`[boot/auto] ${email}: queue corrompida — resetando`);
      setAutoJob(email,{...job,active:false,status:"paused_corrupt_queue"});
      addLog(email,{status:"pausado",jobTitle:"❌ Fila corrompida no boot",company:"Reinicie o automático.",error:"queue não é array"});
      continue;
    }

    const waitStatuses=new Set(["waiting_rate_limit","waiting_limit","waiting_interval"]);
    const hasNextSend = job.nextSendAt && job.nextSendAt > now;

    if(job.status === "waiting_limit"){
      // Para waiting_limit: sempre verifica se o limite já zerou (novo dia)
      if(hasNextSend){
        const delay = Math.max(1000, job.nextSendAt - now);
        console.log(`[boot/auto] ${email} aguardando limite — retoma em ${Math.round(delay/60000)}min`);
        autoTimers.set(email, setTimeout(()=>scheduleAuto(email), delay));
      } else {
        // nextSendAt passou → meia-noite cruzou → novo dia → dispara imediatamente
        console.log(`[boot/auto] ${email} limite de ontem expirou — disparando imediatamente`);
        scheduleAuto(email);
      }
    } else if(waitStatuses.has(job.status) && hasNextSend){
      const delay = Math.max(1000, job.nextSendAt - now);
      console.log(`[boot/auto] reativado com delay ${Math.round(delay/1000)}s para ${email} (status: ${job.status})`);
      autoTimers.set(email, setTimeout(()=>scheduleAuto(email), delay));
    } else {
      scheduleAuto(email);
    }
    n++;
  }
  if(n) console.log(`[boot/auto] ${n} job(s) reativados após restart`);
}

// ══════════════════════════════════════════════════════════
//  SESSION
// ══════════════════════════════════════════════════════════
// ══ SESSÕES — LOGOUT FORÇADO A CADA DEPLOY (pedido do dono, 07/07/2026) ═════
// Decisão INVERTIDA da V955 (que fazia sessões de login sobreviverem a
// deploy): agora, toda vez que o processo sobe (deploy ou restart), TODAS as
// sessões de LOGIN são descartadas — a pessoa precisa clicar em "Entrar" de
// novo. Isso NUNCA toca em DB_USERS[email].refresh_token/cached_access_token
// (arquivo separado, users.json) — o envio AUTOMÁTICO usa esse token direto
// do banco (refreshTokenForUser, ver Prioridade 3 mais abaixo) e continua
// rodando 100% normalmente, sem qualquer interrupção, mesmo com todo mundo
// deslogado do navegador. Única exceção preservada: __sender__ (token
// temporário de "adicionar Gmail extra" em andamento, <10min) — não é
// "login", é um passo de UI no meio do caminho; se o servidor reiniciar
// bem nessa janela (ex.: Render "acordando"), não queremos quebrar esse
// fluxo específico.
const SESS_TTL =7*24*60*60*1000;
function _loadSessionsFromDisk(){
  const box=Object.create(null);
  try{
    let raw=storageLoad(SESSIONS_FILE,null);
    if(!raw)return box;
    if(raw.enc){const dec=decStr(raw.enc);if(!dec)return box;raw=JSON.parse(dec);} // cifrado
    const now=Date.now();let kept=0,expired=0,loggedOut=0;
    for(const[id,s]of Object.entries(raw)){
      if(!s){expired++;continue;}
      // Só __sender__ (OAuth de Gmail extra em andamento) pode sobreviver,
      // e só se ainda estiver dentro da janela de 10min dele.
      if(id.startsWith("__sender__")){
        if(s.pending||now-(s.created||0)>600_000){expired++;continue;}
        box[id]=s;kept++;continue;
      }
      // Qualquer outra coisa (login normal, __p__ pendente de login) é
      // descartada de propósito — é exatamente isso que "logout no deploy" significa.
      loggedOut++;
    }
    console.log(`[sessions] 🔒 Deploy detectado: ${loggedOut} sessão(ões) de login descartada(s) de propósito (pedido do dono — todos precisam entrar de novo). ${kept} entrada(s) temporária(s) de OAuth em andamento preservada(s), ${expired} expirada(s)/inválida(s). ⚠️ Tokens em DB_USERS (refresh_token) NÃO foram tocados — o envio automático continua rodando normalmente para todo mundo.`);
  }catch(e){console.warn("[sessions] restauração falhou (seguindo vazio):",e.message);}
  return box;
}
const sessions=_loadSessionsFromDisk();
const rateMap  =Object.create(null);
function persistSessions(){
  try{
    const snap={};
    for(const[id,s]of Object.entries(sessions)){
      if(!s)continue;
      // [FIX] __sender__ precisa sobreviver a restart/cold-start (Render free tier
      // "dorme" com inatividade — se o servidor reiniciar entre o usuário clicar em
      // "Conectar Gmail Extra" e voltar do OAuth do Google, esse estado em memória
      // se perdia e o e-mail extra nunca era salvo). Expira sozinho em 10min (ver
      // checagem de idade no callback), então é seguro persistir.
      if(id.startsWith("__sender__")){snap[id]=s;continue;}
      // 🔒 Pedido do dono: sessões de LOGIN (e o __p__ pendente de login) NUNCA
      // são gravadas em disco — elas só existem em memória durante o processo
      // atual. Assim, o próximo boot (deploy ou restart) já não encontra nada
      // pra restaurar, e todo mundo precisa entrar de novo. Isso não afeta o
      // envio automático em nada: o token dele mora em DB_USERS, arquivo à parte.
      continue;
    }
    const payload=_encKey?{enc:encStr(JSON.stringify(snap))}:snap;
    persist(SESSIONS_FILE,payload);
  }catch(e){console.warn("[sessions] persist:",e.message);}
}
let _sessPersistT=null;
function persistSessionsDebounced(ms=2000){
  if(_sessPersistT)clearTimeout(_sessPersistT);
  _sessPersistT=setTimeout(()=>{_sessPersistT=null;persistSessions();},ms);
}

function rateLimit(k,max,ms){const n=Date.now();if(!rateMap[k]||rateMap[k].r<n)rateMap[k]={n:0,r:n+ms};return++rateMap[k].n>max;}
const makeCookieStr=id=>{const b=`h2b_session=${id}; Path=/; HttpOnly; Max-Age=${30*86400}`;return IS_PROD?b+"; Secure; SameSite=Lax":b+"; SameSite=Lax";};
const clearCookieStr=()=>{const b="h2b_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";return IS_PROD?b+"; Secure; SameSite=Lax":b;};
const getSessId=req=>{const m=(req.headers.cookie||"").match(/(?:^|;\s*)h2b_session=([^;]+)/);return m?m[1]:null;};
const getSess  =req=>{const id=getSessId(req);return id?sessions[id]:null;};

function makeCallbackPage(sessId){
  return`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Entrando...</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;font-family:sans-serif;color:#fff}.box{text-align:center}.spin{width:40px;height:40px;border:3px solid rgba(255,255,255,.2);border-top-color:#60a5fa;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div><div style="font-size:18px;font-weight:600">Entrando na sua conta...</div><div style="font-size:13px;color:rgba(255,255,255,.5);margin-top:8px">Aguarde um momento</div></div><script>setTimeout(function(){window.location.replace('/')},150);</script></body></html>`;
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

// httpsReq: extraído para src/gmail.js (Fase 1 · Módulo 2)
const { httpsReq, normalizeEmail: _normEmailMod, buildMime: _buildMimeMod } = require("./mod-gmail.js");
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB — suficiente para PDFs base64
function readBody(req){return new Promise((res,rej)=>{const p=[];let sz=0;req.on("data",c=>{sz+=c.length;if(sz>MAX_BODY_SIZE){rej(new Error("Payload too large"));return;}p.push(c);});req.on("end",()=>res(Buffer.concat(p).toString()));req.on("error",rej);});}
function json(res,status,data){
  const b=JSON.stringify(data);
  const raw=Buffer.byteLength(b);
  // V951: gzip automático para respostas >16KB quando o cliente aceita.
  // A lista de vagas (H-2A ~4,5MB) cai ~85% — só nesta rota já paga a Parte 1.
  // Compressão nível 5: ~40ms num payload de 4MB, imperceptível e vale o tráfego.
  const _rq=res._req;
  if(_rq && raw>16384 && /\bgzip\b/.test(String(_rq.headers["accept-encoding"]||""))){
    try{
      const gz=zlib.gzipSync(b,{level:5});
      res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Encoding":"gzip","Content-Length":gz.length,"Vary":"Accept-Encoding"});
      return res.end(gz);
    }catch(e){/* fallback sem compressão */}
  }
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":raw});
  res.end(b);
}

// ── isAdmin helper — declarado aqui perto do getSess/json para clareza ──────
// (antes estava na linha ~4260 após os usos — funcionava por hoisting mas era confuso)
function isAdmin(req, res) {
  const s = getSess(req);
  if (!s?.user_email) { json(res, 401, { error: "Não autenticado." }); return false; }
  const p = getUser(s.user_email);
  if (!p?.isAdmin && !isAdminEmail(s.user_email)) { json(res, 403, { error: "Acesso negado." }); return false; }
  return true;
}

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

// ══════════════════════════════════════════════════════════
//  MULTI-SENDER — Gerenciamento de emails extras de envio
//  Cada usuário pode ter até MAX_SENDER_EMAILS emails (incluindo o principal)
//  Os extras ficam em p.senderEmails[] — nunca substituem o login principal
// ══════════════════════════════════════════════════════════

// Renova token de um email extra (senderEmail)
async function refreshSenderToken(ownerEmail, senderEmail) {
  const p = getUser(ownerEmail);
  const sender = (p?.senderEmails || []).find(s => s.email === senderEmail);
  if (!sender?.refresh_token) throw new Error("Sem refresh_token para " + senderEmail);
  const b = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: sender.refresh_token, grant_type: "refresh_token"
  }).toString();
  const { body: r } = await httpsReq({
    hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(b) }
  }, b);
  if (r.error) throw new Error(r.error_description || r.error);
  if (!r.access_token) throw new Error("Token não retornado pelo Google.");
  const expiresAt = Date.now() + (r.expires_in || 3600) * 1000;
  // Atualiza token do sender no banco
  const senders = (p.senderEmails || []).map(s =>
    s.email === senderEmail
      ? { ...s, access_token: r.access_token, token_expiry: expiresAt,
          ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}),
          tokenExpired: false }
      : s
  );
  setUser(ownerEmail, { senderEmails: senders });
  console.log(`[sender] ✅ Token renovado para sender ${senderEmail} de ${ownerEmail}`);
  return r.access_token;
}

// Obtém token válido para envio — tenta principal e extras em round-robin
// requestedSender: email específico pedido (manual), ou null (automático = round-robin)
// allowedSenders: lista de emails que o usuário SELECIONOU para envio (auto).
//   Se fornecida, o rodízio usa SÓ esses; se o principal NÃO está na lista,
//   ele NUNCA é usado (caso da cliente com principal bloqueado pelo Gmail).
async function getSenderToken(ownerEmail, requestedSender, allowedSenders) {
  const p = getUser(ownerEmail);
  const extras = (p?.senderEmails || []).filter(s => s.active !== false);
  const allowed = Array.isArray(allowedSenders) && allowedSenders.length
    ? allowedSenders.map(e=>String(e).toLowerCase().trim())
    : null;

  // ── Envio manual: sender específico pedido pelo usuário ──
  if (requestedSender && requestedSender !== ownerEmail) {
    const s = extras.find(x => x.email === requestedSender);
    if (!s) throw new Error("Email de envio não encontrado ou removido.");
    if (s.access_token && s.token_expiry && Date.now() < s.token_expiry - 120_000) {
      return { token: s.access_token, senderEmail: s.email };
    }
    try {
      const token = await refreshSenderToken(ownerEmail, s.email);
      return { token, senderEmail: s.email };
    } catch(e) {
      const updSenders = (p.senderEmails || []).map(x =>
        x.email === s.email ? { ...x, tokenExpired: true } : x
      );
      setUser(ownerEmail, { senderEmails: updSenders });
      console.warn(`[sender] ⚠️ Token do sender ${s.email} expirou, usando principal`);
    }
  }

  // ── Automático: round-robin REAL entre principal + extras ──
  // O email principal entra no pool junto com os extras
  // Alternância baseada em contagem de envios de hoje: menor contagem = próximo
  if (!requestedSender) {
    const hist = getHist(ownerEmail);
    const today = todayStr();
    const countBySender = {};
    for (const h of hist) {
      if (h.dateStr === today && h.senderEmail) {
        countBySender[h.senderEmail] = (countBySender[h.senderEmail] || 0) + 1;
      }
    }

    // Monta pool completo: principal + extras ativos sem erro
    // Principal representado como objeto sintético para uniformidade
    const extrasOk = extras.filter(s => !s.tokenExpired && !s.blocked);
    let pool = [
      { email: ownerEmail, isPrincipal: true },  // email principal sempre no pool
      ...extrasOk.map(s => ({ ...s, isPrincipal: false }))
    ];
    // Seleção do usuário: só os e-mails escolhidos participam do rodízio
    if (allowed) pool = pool.filter(c => allowed.includes(String(c.email).toLowerCase()));
    if (!pool.length) throw new Error("Nenhum dos e-mails selecionados está disponível para envio. Reconecte-os em Configurações.");

    // Ordena por menor contagem hoje → alterna naturalmente 1,2,1,2...
    pool.sort((a, b) => (countBySender[a.email] || 0) - (countBySender[b.email] || 0));

    for (const candidate of pool) {
      if (candidate.isPrincipal) {
        // Email principal: token vem da sessão/cache/refresh_token (tratado no fluxo principal)
        return { token: null, senderEmail: ownerEmail };
      }
      // Extra: usa token cacheado ou renova
      if (candidate.access_token && candidate.token_expiry && Date.now() < candidate.token_expiry - 120_000) {
        console.log(`[sender] 🔄 Round-robin → ${candidate.email} (${countBySender[candidate.email]||0} hoje)`);
        return { token: candidate.access_token, senderEmail: candidate.email };
      }
      try {
        const token = await refreshSenderToken(ownerEmail, candidate.email);
        console.log(`[sender] 🔄 Round-robin → ${candidate.email} (token renovado)`);
        return { token, senderEmail: candidate.email };
      } catch(e) {
        const updSenders = (p.senderEmails || []).map(x =>
          x.email === candidate.email ? { ...x, tokenExpired: true } : x
        );
        setUser(ownerEmail, { senderEmails: updSenders });
        console.warn(`[sender] ⚠️ Sender ${candidate.email} com token expirado, pulando`);
        // continua para próximo candidato
      }
    }
  }

  // ── Fallback final: email principal — SÓ se o usuário não o excluiu da seleção ──
  if (allowed && !allowed.includes(String(ownerEmail).toLowerCase())) {
    throw new Error("Os e-mails selecionados para envio estão indisponíveis (token expirado/bloqueado). O principal não foi usado porque você o excluiu da seleção.");
  }
  return { token: null, senderEmail: ownerEmail };
}


function buildMime(opts){ return _buildMimeMod(opts); } // corpo em src/gmail.js (Fase 1 · Módulo 2)

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
    for(const a of attachments){const aMime=a.mime||"application/octet-stream";L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${a.name}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${a.name}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}
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
  let token=await gmailGetToken(sid);
  let headers={"Authorization":"Bearer "+token};

  // Busca mensagens na INBOX que são respostas (tem In-Reply-To ou Reference)
  // q: in:inbox -from:me — mensagens recebidas, não enviadas por mim
  // FIX: removido "category:primary" — muitas respostas de empresas vão para Promoções/Updates
  const q=encodeURIComponent("in:inbox -from:me");
  const listPath=`/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${q}`;

  let{status:ls,body:lb}=await httpsReq({hostname:"gmail.googleapis.com",path:listPath,method:"GET",headers});

  // FIX: 401 = token expirado → tentar refresh automático antes de falhar
  if(ls===401){
    try{
      await refreshToken(sid);
      const s2=sessions[sid];
      if(s2?.access_token){
        headers={"Authorization":"Bearer "+s2.access_token};
        const retry=await httpsReq({hostname:"gmail.googleapis.com",path:listPath,method:"GET",headers});
        ls=retry.status; lb=retry.body;
      }
    }catch(re){ throw new Error("TOKEN_EXPIRED"); }
    if(ls===401)throw new Error("TOKEN_EXPIRED");
  }

  // FIX: 403 = problema de scope (falta gmail.readonly) — mensagem específica para orientar reconexão
  if(ls===403)throw new Error("TOKEN_EXPIRED");

  if(ls===429)throw new Error("Gmail: muitas requisições (429). Aguarde 1 minuto e tente novamente.");
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

  // Separar bounces para processamento e retornar só respostas reais
  const bounceMsgs = emails.filter(e => isBounceMail(e));
  const realReplies = emails.filter(e => !isBounceMail(e));

  // Processar bounces: extrair email que falhou e registrar na base global
  let _bouncesProcessed = 0;
  const _ownerEmail = sessions[sid]?.user_email || 'sistema';

  for(const bounce of bounceMsgs){
    try{
      const fullText = (bounce.subject||'') + ' ' + (bounce.body||bounce.snippet||'');

      // Extração melhorada: padrões específicos de bounce primeiro
      const specificMatches = [...fullText.matchAll(
        /(?:to|for|address|recipient|deliver(?:ing|ed)?\s+to|failed.*to|message.*to)\s*:?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})>?/gi
      )].map(m=>m[1].toLowerCase());

      const allEmails = [...fullText.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}/g)]
        .map(m => m[0].toLowerCase())
        .filter(e =>
          !e.includes('mailer-daemon') && !e.includes('postmaster') &&
          !e.includes('google') && !e.includes('noreply') && !e.endsWith('@gmail.com')
        );

      const bodyLower = fullText.toLowerCase();
      const isPermanent = PERM_PATTERNS.some(p => p.test(bodyLower));
      const isTemp = TEMP_PATTERNS.some(p => p.test(bodyLower));

      // Email candidato: padrão específico tem prioridade sobre regex geral
      const candidateEmail = specificMatches[0] || allEmails[0];

      if(isPermanent && candidateEmail){
        processBounce(candidateEmail, fullText, _ownerEmail);
        removeFromSheets(candidateEmail);
        _bouncesProcessed++;
        console.log(`[bounce] 🔴 Permanente (${_ownerEmail}): ${candidateEmail}`);
      } else if(isTemp && candidateEmail){
        if(!DB_TEMP_FAILURES[candidateEmail]) DB_TEMP_FAILURES[candidateEmail]={email:candidateEmail,errors:[],count:0,user:_ownerEmail};
        DB_TEMP_FAILURES[candidateEmail].count++;
        DB_TEMP_FAILURES[candidateEmail].errors.push({msg:fullText.slice(0,200),ts:Date.now(),user:_ownerEmail});
        try{fs.writeFileSync(TEMP_FAILURES_FILE,JSON.stringify(DB_TEMP_FAILURES,null,2));}catch{}
        console.log(`[bounce] 🟡 Temporário (${_ownerEmail}): ${candidateEmail}`);
      }
    }catch(e){ console.warn('[bounce] erro processando bounce:', e.message); }
  }

  // Expõe contagem para o startup scan
  realReplies._bouncesProcessed = _bouncesProcessed;
  return realReplies;
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
// ══════════════════════════════════════════════════════════════════════════
//  🎯 GRUPOS — JULHO 2026 (sistema novo, pedido do dono 07/07/2026)
//  ─────────────────────────────────────────────────────────────────────
//  Substitui o antigo Monitor ETA (apagado por completo). Este aqui é
//  MENOR DE PROPÓSITO — só existe pra uma coisa: guardar o grupo A–H
//  oficial de cada vaga da temporada de Julho 2026 (início 01/10/2026).
//
//  REGRA INEGOCIÁVEL (mesma lição de sempre, agora reforçada em código):
//    Grupo NUNCA é adivinhado, calculado ou herdado de outra temporada.
//    Só existe se vier do relatório oficial do DOL (PublicFacingReport)
//    — via upload manual (CSV ou XLSX de verdade) OU download automático
//    a partir do link que o próprio DOL publica. Cada linha importada é
//    VALIDADA contra a Begin Date esperada (01/10/2026); linha que não
//    bate é REJEITADA e aparece no log — nunca aceita "no chute".
//
//  Este bot NÃO participa da coleta de vagas (isso é o Enriquecimento,
//  que continua intocado) — só enriquece com grupo o que já existir na
//  planilha "jul2026" quando ela for publicada.
// ══════════════════════════════════════════════════════════════════════════

const GRUPOS_J26_FILE = path.join(DATA_DIR, "grupos_jul2026.json");
const GRUPOS_J26_SEASON = Object.freeze({
  key: "jul2026",
  label: "Julho 2026 (H-2B)",
  beginDateISO: "2026-10-01", // toda linha do relatório oficial tem que bater com isto
});
const GRUPOS_J26_NEWS_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news";

let DB_GRUPOS_J26 = {
  mapa: {}, // { "H-400-26117-XXXXXX": { grupo:"A", manual:false, empresa, estado, importadoEm, fonte } }
  meta: {
    ultimaImportacao: null,     // {at, fonte, arquivo, novos, atualizados, rejeitados, totalNoRelatorio}
    historicoImportacoes: [],   // até 30, mais recente primeiro
    autoCheckEnabled: true,
    ultimaChecagemAutoAt: null,
    proximaChecagemAutoAt: null,
    ultimoResultadoAuto: null,  // 'nao-encontrado' | 'ja-importado' | 'importado' | 'erro'
    urlJaImportada: null,       // link já processado — não reimporta o mesmo
    checksCount: 0,
  }
};

function loadGruposJ26(){
  try{
    if(fs.existsSync(GRUPOS_J26_FILE)){
      const d = JSON.parse(fs.readFileSync(GRUPOS_J26_FILE,"utf8"));
      if(d && typeof d==="object"){
        DB_GRUPOS_J26.mapa = d.mapa || {};
        DB_GRUPOS_J26.meta = { ...DB_GRUPOS_J26.meta, ...(d.meta||{}) };
      }
    }
  }catch(e){ console.warn("[grupos-j26] falha ao carregar:", e.message); }
}
function persistGruposJ26(){
  try{
    const tmp = GRUPOS_J26_FILE+".tmp";
    fs.writeFileSync(tmp, JSON.stringify(DB_GRUPOS_J26));
    fs.renameSync(tmp, GRUPOS_J26_FILE);
  }catch(e){ console.warn("[grupos-j26] falha ao salvar:", e.message); }
}
function grupoJ26Log(msg, type='info'){
  console.log(`[grupos-j26] ${msg}`);
  botLog('grupos-jul2026','Grupos — Julho 2026', msg, type);
}

// ── Conversão de data serial do Excel (ex.: 46296 → "2026-10-01") ──────────
function excelSerialToISO(serial){
  const n = parseFloat(serial);
  if(!Number.isFinite(n) || n<=0) return "";
  const ms = Date.UTC(1899,11,30) + Math.round(n)*86400000;
  const d = new Date(ms);
  if(isNaN(d.getTime())) return "";
  return d.toISOString().slice(0,10);
}
// Aceita tanto serial do Excel quanto string de data já formatada (upload manual às vezes já vem como "10/01/2026" ou "2026-10-01")
function anyDateToISO(v){
  const s = String(v||"").trim();
  if(!s) return "";
  if(/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(s); // serial puro
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // MM/DD/YYYY
  if(us) return `${us[3]}-${us[1].padStart(2,"0")}-${us[2].padStart(2,"0")}`;
  return "";
}

// ── Leitor de XLSX SEM dependência externa — só zlib/fs nativos do Node ──
// Testado contra um PublicFacingReport real do DOL (8.759 linhas, extração
// 100% correta: cabeçalho, case number, grupo e datas todos batendo).
function _zipReadEntries(buf){
  let eocdOffset = -1;
  for(let i=buf.length-22; i>=0; i--){
    if(buf.readUInt32LE(i)===0x06054b50){ eocdOffset=i; break; }
  }
  if(eocdOffset===-1) throw new Error("Arquivo não é um .xlsx/.zip válido (EOCD não encontrado)");
  const cdOffset = buf.readUInt32LE(eocdOffset+16);
  const cdCount  = buf.readUInt16LE(eocdOffset+10);
  const entries = {};
  let p = cdOffset;
  for(let i=0;i<cdCount;i++){
    if(buf.readUInt32LE(p)!==0x02014b50) throw new Error("Central directory corrompida");
    const compMethod = buf.readUInt16LE(p+10);
    const compSize    = buf.readUInt32LE(p+20);
    const nameLen     = buf.readUInt16LE(p+28);
    const extraLen    = buf.readUInt16LE(p+30);
    const commentLen  = buf.readUInt16LE(p+32);
    const localHeaderOffset = buf.readUInt32LE(p+42);
    const name = buf.toString("utf8", p+46, p+46+nameLen);
    entries[name] = { compMethod, compSize, localHeaderOffset };
    p += 46+nameLen+extraLen+commentLen;
  }
  return entries;
}
function _zipExtract(buf, entry){
  const lp = entry.localHeaderOffset;
  const nameLen  = buf.readUInt16LE(lp+26);
  const extraLen = buf.readUInt16LE(lp+28);
  const dataStart = lp+30+nameLen+extraLen;
  const compData = buf.slice(dataStart, dataStart+entry.compSize);
  if(entry.compMethod===0) return compData;
  if(entry.compMethod===8) return zlib.inflateRawSync(compData);
  throw new Error("Método de compressão .xlsx não suportado: "+entry.compMethod);
}
function _xmlDecodeEntities(s){
  return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");
}
function _xlsxParseSharedStrings(xml){
  const strings=[];
  const siRe=/<si>([\s\S]*?)<\/si>/g;
  let m;
  while((m=siRe.exec(xml))){
    const tRe=/<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm, text="";
    while((tm=tRe.exec(m[1]))) text+=tm[1];
    strings.push(_xmlDecodeEntities(text));
  }
  return strings;
}
function _colLetterToIndex(letters){
  let n=0;
  for(let i=0;i<letters.length;i++) n = n*26 + (letters.charCodeAt(i)-64);
  return n-1;
}
function _xlsxParseSheet(xml, sharedStrings){
  const rows=[];
  const rowRe=/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while((rm=rowRe.exec(xml))){
    const rowIdx = parseInt(rm[1],10)-1;
    const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm; const row=[];
    while((cm=cellRe.exec(rm[2]))){
      const attrs=cm[1], body=cm[2]||"";
      const rMatch=/r="([A-Z]+)\d+"/.exec(attrs);
      if(!rMatch) continue;
      const colIdx=_colLetterToIndex(rMatch[1]);
      const tMatch=/\bt="([a-zA-Z]+)"/.exec(attrs);
      const type=tMatch?tMatch[1]:null;
      let val="";
      const vMatch=/<v>([\s\S]*?)<\/v>/.exec(body);
      if(vMatch){ val = type==="s" ? (sharedStrings[parseInt(vMatch[1],10)]||"") : vMatch[1]; }
      else{
        const isMatch=/<is>([\s\S]*?)<\/is>/.exec(body);
        if(isMatch){ const tInner=/<t[^>]*>([\s\S]*?)<\/t>/.exec(isMatch[1]); val = tInner?_xmlDecodeEntities(tInner[1]):""; }
      }
      row[colIdx]=val;
    }
    rows[rowIdx]=row;
  }
  return rows;
}
function xlsxBufferToRows(buf){
  const entries = _zipReadEntries(buf);
  const sheetName = Object.keys(entries).find(n=>/^xl\/worksheets\/sheet1\.xml$/i.test(n)) || Object.keys(entries).find(n=>/^xl\/worksheets\/.*\.xml$/i.test(n));
  if(!sheetName) throw new Error("Nenhuma planilha (xl/worksheets/sheetN.xml) encontrada dentro do .xlsx");
  const sharedEntry = entries["xl/sharedStrings.xml"];
  const sharedStrings = sharedEntry ? _xlsxParseSharedStrings(_zipExtract(buf, sharedEntry).toString("utf8")) : [];
  const sheetXml = _zipExtract(buf, entries[sheetName]).toString("utf8");
  const rows = _xlsxParseSheet(sheetXml, sharedStrings);
  // Normaliza buracos (linhas vazias no meio) pra array denso, sem furo de índice
  const dense = [];
  for(let i=0;i<rows.length;i++) dense.push(rows[i]||[]);
  return dense;
}

// ── CSV simples (Excel → Salvar como CSV → colar/subir aqui) ──────────────
function csvTextToRows(text){
  const rows=[];
  let row=[], field="", inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuotes){
      if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQuotes=false; }
      else field+=c;
    }else{
      if(c==='"') inQuotes=true;
      else if(c===','){ row.push(field); field=""; }
      else if(c==='\r'){ /* ignore */ }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else field+=c;
    }
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(c=>String(c||"").trim()!==""));
}

// ── Detecção de cabeçalho — robusta a variação de nome (o antigo Monitor
// DOL quebrava com "Cabeçalho não tem Case Number/Randomization Group"
// porque exigia texto EXATO; aqui é por substring, sem acento, minúsculo). ──
function _normHeader(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}
function j26DetectHeaders(headerRow){
  const norm = (headerRow||[]).map(_normHeader);
  const findCol = (...needles) => norm.findIndex(h => needles.every(n=>h.includes(n)));
  const idx = {
    caseNumber: findCol("case","number"),
    grupo:      findCol("randomization","group"),
    beginDate:  findCol("begin","date"),
    empresa:    findCol("business","name"),
    estado:     findCol("worksite","state"),
    status:     findCol("case","status"),
  };
  const ok = idx.caseNumber>=0 && idx.grupo>=0;
  return { ok, idx, missing: ok?[]:["case number","randomization group"].filter((_,i)=>i===0?idx.caseNumber<0:idx.grupo<0) };
}

// ── Parser central: rows brutas (CSV ou XLSX) → linhas validadas ──────────
// NUNCA aceita uma linha sem confirmar que o case number bate com H-2B
// (H-400) e, se a coluna Begin Date existir, que a data bate EXATAMENTE
// com a temporada de Julho 2026 (01/10/2026) — senão REJEITA a linha.
function j26ParseReportRows(rows){
  if(!rows||!rows.length) return { ok:false, error:"Arquivo vazio ou ilegível." };
  // Acha a linha de cabeçalho de verdade (pode não ser a linha 0 se sobrar
  // linha de título/logo acima, comum em exports manuais do Excel)
  let headerRowIdx = -1, headers = null;
  for(let i=0;i<Math.min(5,rows.length);i++){
    const det = j26DetectHeaders(rows[i]);
    if(det.ok){ headerRowIdx=i; headers=det; break; }
  }
  if(headerRowIdx===-1){
    return { ok:false, error:`Cabeçalho não encontrado (procurei "Case Number" e "Randomization Group" nas primeiras 5 linhas). O DOL pode ter mudado o formato — confira o arquivo manualmente.` };
  }
  const { idx } = headers;
  const accepted = [];
  let rejectedWrongSeason = 0, rejectedNoCase = 0, rejectedNoGroup = 0, rejectedNotH2B = 0;
  const rejectedSamples = [];
  for(let i=headerRowIdx+1;i<rows.length;i++){
    const r = rows[i]; if(!r||!r.length) continue;
    const cn = String(r[idx.caseNumber]||"").toUpperCase().trim();
    if(!cn || !/^H-\d{3}-\d{5}-\d+$/.test(cn)){ rejectedNoCase++; continue; }
    if(!cn.startsWith("H-400")){ rejectedNotH2B++; if(rejectedSamples.length<5)rejectedSamples.push(`${cn}: não é H-2B (só H-400 entra em grupo)`); continue; }
    const grupo = String(r[idx.grupo]||"").toUpperCase().trim().slice(0,1);
    if(!/^[A-H]$/.test(grupo)){ rejectedNoGroup++; continue; }
    if(idx.beginDate>=0){
      const bd = anyDateToISO(r[idx.beginDate]);
      if(bd && bd!==GRUPOS_J26_SEASON.beginDateISO){
        rejectedWrongSeason++;
        if(rejectedSamples.length<5) rejectedSamples.push(`${cn}: begin_date="${bd}" ≠ ${GRUPOS_J26_SEASON.beginDateISO} (não é Julho 2026)`);
        continue;
      }
    }
    accepted.push({
      cn, grupo,
      empresa: idx.empresa>=0 ? String(r[idx.empresa]||"").trim().slice(0,120) : "",
      estado:  idx.estado>=0  ? String(r[idx.estado]||"").trim().slice(0,40)   : "",
      status:  idx.status>=0  ? String(r[idx.status]||"").trim().slice(0,80)   : "",
    });
  }
  return {
    ok: true, headerRowIdx, totalLinhas: rows.length-headerRowIdx-1,
    accepted, rejectedWrongSeason, rejectedNoCase, rejectedNoGroup, rejectedNotH2B, rejectedSamples,
  };
}

// ── Importação: mescla linhas validadas no mapa oficial (nunca sobrescreve
// ajuste manual do admin) e persiste. Fonte da verdade única. ──────────────
function j26ImportRows(parsed, fonte, arquivo){
  const now = Date.now();
  let novos=0, atualizados=0;
  for(const row of parsed.accepted){
    const cur = DB_GRUPOS_J26.mapa[row.cn];
    if(!cur){
      DB_GRUPOS_J26.mapa[row.cn] = { grupo:row.grupo, manual:false, empresa:row.empresa, estado:row.estado, status:row.status, importadoEm:now, fonte };
      novos++;
    } else if(!cur.manual && cur.grupo!==row.grupo){
      cur.grupo=row.grupo; cur.empresa=row.empresa||cur.empresa; cur.estado=row.estado||cur.estado; cur.status=row.status||cur.status; cur.importadoEm=now; cur.fonte=fonte;
      atualizados++;
    }
  }
  const entry = {
    at: now, fonte, arquivo: arquivo||"", novos, atualizados,
    rejeitados: parsed.rejectedWrongSeason+parsed.rejectedNoCase+parsed.rejectedNoGroup+parsed.rejectedNotH2B,
    rejeitadosPorTemporadaErrada: parsed.rejectedWrongSeason,
    totalNoRelatorio: parsed.totalLinhas,
    amostraRejeitados: parsed.rejectedSamples,
  };
  DB_GRUPOS_J26.meta.ultimaImportacao = entry;
  DB_GRUPOS_J26.meta.historicoImportacoes.unshift(entry);
  if(DB_GRUPOS_J26.meta.historicoImportacoes.length>30) DB_GRUPOS_J26.meta.historicoImportacoes.length=30;
  persistGruposJ26();
  grupoJ26Log(`📥 Importação (${fonte}${arquivo?': '+arquivo:''}): ${novos} novo(s), ${atualizados} atualizado(s), ${entry.rejeitados} rejeitado(s) (${parsed.rejectedWrongSeason} de outra temporada, ${parsed.rejectedNotH2B} não-H-2B) — total no mapa: ${Object.keys(DB_GRUPOS_J26.mapa).length}`, entry.rejeitados>0?'warn':'ok');
  if(parsed.rejectedSamples.length){
    for(const s of parsed.rejectedSamples) grupoJ26Log(`🚫 Rejeitada: ${s}`,'warn');
  }
  j26ApplyGroupsToSheet();
  return entry;
}

// ── Download binário (preserva bytes — httpsReq genérico faz .toString()
// e corromperia um .xlsx binário) ──────────────────────────────────────────
function httpsGetBuffer(url, extraHeaders){
  return new Promise((resolve,reject)=>{
    let u; try{ u=new URL(url); }catch(e){ return reject(new Error("URL inválida: "+url)); }
    // 🔧 KB-085 (dono, 08/07/2026): dol.gov devolveu HTTP 403 — sites .gov
    // costumam ter WAF (Akamai/F5) que bloqueia requisição "de script" (só
    // User-Agent, sem o resto dos headers que um navegador de verdade manda
    // sempre junto). Isso aqui deixa a requisição bem mais parecida com uma
    // aba de Chrome de verdade — não é garantia de passar por um WAF sério
    // (isso pode exigir TLS fingerprint que o Node não replica), mas reduz
    // bastante a chance de bloqueio por header incompleto, que é o motivo
    // mais comum.
    const req = https.request({
      hostname:u.hostname, path:u.pathname+u.search, method:"GET",
      headers:{
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language":"en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
        "Accept-Encoding":"identity", // sem gzip — não descomprimimos, então pedir só o texto puro
        "Connection":"keep-alive",
        "Upgrade-Insecure-Requests":"1",
        "Sec-Fetch-Dest":"document",
        "Sec-Fetch-Mode":"navigate",
        "Sec-Fetch-Site":"none",
        "Sec-Fetch-User":"?1",
        "Cache-Control":"no-cache",
        "Referer":`https://${u.hostname}/`,
        ...extraHeaders,
      },
    }, resp=>{
      if(resp.statusCode>=300 && resp.statusCode<400 && resp.headers.location){
        return httpsGetBuffer(new URL(resp.headers.location,url).toString(), extraHeaders).then(resolve,reject);
      }
      const chunks=[];
      resp.on("data",c=>chunks.push(c));
      resp.on("end",()=>resolve({status:resp.statusCode, buffer:Buffer.concat(chunks), headers:resp.headers}));
    });
    req.on("error",reject);
    req.setTimeout(30000,()=>{ req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Checador automático: acha o link do relatório de Julho 2026 na página
// de anúncios do DOL, baixa e importa sozinho. Escopo ÚNICO: só aceita link
// cujo nome sugira Julho 2026 (evita importar o report errado por engano). ──
async function j26CheckDolNewsAndImport(){
  DB_GRUPOS_J26.meta.checksCount = (DB_GRUPOS_J26.meta.checksCount||0)+1;
  DB_GRUPOS_J26.meta.ultimaChecagemAutoAt = Date.now();
  try{
    const { status, buffer } = await httpsGetBuffer(GRUPOS_J26_NEWS_URL);
    if(status!==200){
      DB_GRUPOS_J26.meta.ultimoResultadoAuto='erro';
      grupoJ26Log(`⚠️ Checagem do DOL: HTTP ${status} ao acessar a página de anúncios.`,'warn');
      persistGruposJ26(); return { ok:false, reason:'http-'+status };
    }
    const html = buffer.toString("utf8");
    // Procura qualquer link .xlsx com "PublicFacingReport" no nome, prioriza
    // o que mencionar "Jul" (Julho) e "26" (2026) — nome real do DOL costuma
    // ser algo como ".../FY26_JulPeak_PublicFacingReport.xlsx"
    const hrefRe = /href="([^"]+PublicFacingReport[^"]*\.xlsx)"/gi;
    const links = [];
    let m; while((m=hrefRe.exec(html))) links.push(m[1]);
    const candidate = links.find(l=>/jul/i.test(l) && /26/.test(l)) || links.find(l=>/jul/i.test(l));
    if(!candidate){
      DB_GRUPOS_J26.meta.ultimoResultadoAuto='nao-encontrado';
      persistGruposJ26();
      return { ok:true, found:false };
    }
    const fullUrl = candidate.startsWith("http") ? candidate : new URL(candidate, GRUPOS_J26_NEWS_URL).toString();
    if(DB_GRUPOS_J26.meta.urlJaImportada===fullUrl){
      DB_GRUPOS_J26.meta.ultimoResultadoAuto='ja-importado';
      persistGruposJ26();
      return { ok:true, found:true, jaImportado:true };
    }
    grupoJ26Log(`🔗 Relatório de Julho 2026 encontrado no site do DOL: ${fullUrl}`,'ok');
    const dl = await httpsGetBuffer(fullUrl);
    if(dl.status!==200 || dl.buffer.length<1000){
      DB_GRUPOS_J26.meta.ultimoResultadoAuto='erro';
      grupoJ26Log(`❌ Falha ao baixar o relatório (HTTP ${dl.status}, ${dl.buffer.length} bytes).`,'error');
      persistGruposJ26(); return { ok:false, reason:'download-failed' };
    }
    grupoJ26Log(`⬇️ Download concluído (${(dl.buffer.length/1024).toFixed(0)} KB). Processando...`,'info');
    const rows = xlsxBufferToRows(dl.buffer);
    const parsed = j26ParseReportRows(rows);
    if(!parsed.ok){
      DB_GRUPOS_J26.meta.ultimoResultadoAuto='erro';
      grupoJ26Log(`❌ Falha ao processar o .xlsx baixado: ${parsed.error}`,'error');
      persistGruposJ26(); return { ok:false, reason:'parse-failed', error:parsed.error };
    }
    j26ImportRows(parsed, 'auto-dol', fullUrl.split("/").pop());
    DB_GRUPOS_J26.meta.urlJaImportada = fullUrl;
    DB_GRUPOS_J26.meta.ultimoResultadoAuto = 'importado';
    persistGruposJ26();
    return { ok:true, found:true, imported:true };
  }catch(e){
    DB_GRUPOS_J26.meta.ultimoResultadoAuto='erro';
    grupoJ26Log(`❌ Erro na checagem automática: ${e.message}`,'error');
    persistGruposJ26();
    return { ok:false, reason:'exception', error:e.message };
  }
}
async function j26AutoTick(){
  if(DB_GRUPOS_J26.meta.autoCheckEnabled===false) return;
  if(DB_GRUPOS_J26.meta.ultimoResultadoAuto==='importado' && DB_GRUPOS_J26.meta.urlJaImportada) return; // já achou e importou — não precisa mais varrer
  await j26CheckDolNewsAndImport();
}

// ── Aplica os grupos importados direto nas vagas da planilha "jul2026" (se
// ela já tiver sido publicada) — grava o campo `g` linha a linha e persiste
// no mesmo arquivo/local que o resto do sistema já usa pra essa planilha. ──
function j26ApplyGroupsToSheet(){
  const arr = SHEET_EXTRAS["jul2026"];
  if(!arr || !arr.length) return { applied:0, sheetExists:false };
  let applied=0;
  for(const r of arr){
    const cn = String(r.c||"").toUpperCase();
    const g = DB_GRUPOS_J26.mapa[cn];
    if(g && r.g!==g.grupo){ r.g=g.grupo; applied++; }
  }
  if(applied>0){
    try{
      const meta = DB_SHEETS_META["jul2026"];
      const fp = path.join(SHEETS_DIR, meta?.file||"jul2026.json");
      fs.writeFileSync(fp, JSON.stringify(arr));
      grupoJ26Log(`📋 Grupo aplicado em ${applied} vaga(s) da planilha "Julho 2026" já publicada.`,'ok');
    }catch(e){ grupoJ26Log(`⚠️ Grupos aplicados em memória mas falhou salvar no arquivo da planilha: ${e.message}`,'warn'); }
  }
  return { applied, sheetExists:true };
}


// ══════════════════════════════════════════════════════════════════════════
//  📰 VIGIA DE ANÚNCIOS — DOL NEWS (bot novo, pedido do dono 08/07/2026)
//  ─────────────────────────────────────────────────────────────────────
//  Troca a ideia de "baixar a planilha sozinho" (que deu trabalho demais)
//  por algo bem mais simples e confiável: só FICAR DE OLHO na página de
//  anúncios do DOL e AVISAR POR E-MAIL todo admin assim que aparecer
//  publicação nova — quem baixa/confere é humano, o robô só vigia.
//
//  https://www.dol.gov/agencies/eta/foreign-labor/news
//
//  Checa a cada 10 minutos. O último anúncio conhecido no momento em que
//  este bot foi criado (08/07/2026) foi o de 29/06/2026 ("OFLC Issues
//  Technical Release Notes for the Occupational Employment and Wage
//  Statistics Update for the July 2026 through June 2027 Wage Year") —
//  isso vira o ponto de partida (baseline). Qualquer anúncio com data
//  MAIS NOVA que essa dispara o e-mail. Nunca reenvia o mesmo aviso 2x.
// ══════════════════════════════════════════════════════════════════════════

const DOL_NEWS_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news";
const DOL_NEWS_WATCH_FILE = path.join(DATA_DIR, "dol_news_watch.json");
// Baseline conhecido na hora em que o dono pediu esse bot — "decore essa
// publicação" (pedido explícito, 08/07/2026, JulPeak.png com data 29/06/2026).
const DOL_NEWS_KNOWN_BASELINE = Object.freeze({
  date: "2026-06-29",
  title: "OFLC Issues Technical Release Notes for the Occupational Employment and Wage Statistics Update for the July 2026 through June 2027 Wage Year",
});

let DB_DOL_NEWS_WATCH = {
  ultimaConhecida: { ...DOL_NEWS_KNOWN_BASELINE, detectadaEm: null, origem: "baseline-inicial" },
  autoCheckEnabled: true,
  ultimaChecagemAt: null,
  proximaChecagemAt: null,
  checksCount: 0,
  ultimoResultado: null, // 'sem-novidade' | 'nova-encontrada' | 'erro-http' | 'erro-parse'
  ultimoErro: null,
  ultimoErroDetalhe: null, // {status, headers, corpoAmostra, at} — pro botão "Analisar com Gemini"
  historicoAlertas: [],  // {at, date, title, emailsEnviados:[...]}
};

function loadDolNewsWatch(){
  try{
    if(fs.existsSync(DOL_NEWS_WATCH_FILE)){
      const d = JSON.parse(fs.readFileSync(DOL_NEWS_WATCH_FILE,"utf8"));
      if(d && typeof d==="object") DB_DOL_NEWS_WATCH = { ...DB_DOL_NEWS_WATCH, ...d };
    }
  }catch(e){ console.warn("[dol-news-watch] falha ao carregar:", e.message); }
}
function persistDolNewsWatch(){
  try{
    const tmp = DOL_NEWS_WATCH_FILE+".tmp";
    fs.writeFileSync(tmp, JSON.stringify(DB_DOL_NEWS_WATCH));
    fs.renameSync(tmp, DOL_NEWS_WATCH_FILE);
  }catch(e){ console.warn("[dol-news-watch] falha ao salvar:", e.message); }
}
function dolNewsLog(msg, type='info'){
  console.log(`[dol-news-watch] ${msg}`);
  botLog('dol-news-watch','Vigia de Anúncios DOL', msg, type);
}

// ── Todo mundo que conta como "administrador" no sistema: o Set fixo
// (ADMIN_EMAILS) + qualquer usuário com isAdmin:true no cadastro. ──────────
function getAllAdminEmails(){
  const set = new Set(ADMIN_EMAILS);
  try{
    for(const [email,u] of Object.entries(DB_USERS||{})){
      if(u?.isAdmin) set.add(String(email).trim().toLowerCase());
    }
  }catch{}
  return [...set].filter(Boolean);
}

// ── Envia um e-mail simples de admin pra admin, reaproveitando o MESMO
// esquema de token que já existe pros avisos de pedido de plano: tenta o
// token do admin principal, se não tiver tenta qualquer outro admin —
// nunca deixa de avisar só porque uma conta específica deslogou. ──────────
async function sendAdminAlertEmail(subject, text){
  const admins = getAllAdminEmails();
  if(!admins.length){ dolNewsLog("⚠️ Nenhum admin cadastrado — e-mail não enviado.","warn"); return { ok:false, enviados:[] }; }
  let adminToken=null, adminTokenFrom=null;
  const sessEntry = Object.values(sessions).find(ss=>ss.user_email===ADMIN_EMAIL && ss.access_token);
  if(sessEntry?.access_token){ adminToken=sessEntry.access_token; adminTokenFrom=ADMIN_EMAIL; }
  if(!adminToken){ try{ const t=await refreshTokenForUser(ADMIN_EMAIL); if(t){ adminToken=t; adminTokenFrom=ADMIN_EMAIL; } }catch{} }
  if(!adminToken){
    for(const ae of admins){
      if(ae===ADMIN_EMAIL) continue;
      const se=Object.values(sessions).find(ss=>ss.user_email===ae && ss.access_token);
      if(se?.access_token){ adminToken=se.access_token; adminTokenFrom=ae; break; }
      try{ const t=await refreshTokenForUser(ae); if(t){ adminToken=t; adminTokenFrom=ae; break; } }catch{}
    }
  }
  if(!adminToken){
    dolNewsLog("❌ Nenhum admin com token do Gmail válido no momento — e-mail NÃO enviado. Faça login de novo com uma conta admin.","error");
    return { ok:false, enviados:[] };
  }
  const enviados=[], falhas=[];
  for(const toEmail of admins){
    try{
      const raw = buildMime({ to:toEmail, subject, fromName:"H2BApply 📰", fromEmail:adminTokenFrom, text });
      await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+adminToken,"Content-Type":"application/json"}},{raw});
      enviados.push(toEmail);
    }catch(e){ falhas.push(toEmail); dolNewsLog(`❌ Falha ao enviar pra ${toEmail}: ${e.message}`,'error'); }
  }
  dolNewsLog(`✉️ E-mail "${subject}" enviado via ${adminTokenFrom} para: ${enviados.join(", ")||"ninguém"}${falhas.length?` (falhou pra: ${falhas.join(", ")})`:""}`, enviados.length?'ok':'error');
  return { ok:enviados.length>0, enviados, falhas };
}

// ── Extrai a data+título do anúncio mais recente da página do DOL. Duas
// estratégias (a página é HTML de verdade, não uma API — sem garantia de
// estrutura fixa, então tenta achar em heading tags primeiro, e cai pro
// texto puro se não achar nada assim). ─────────────────────────────────────
const _MESES_EN = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function _parseEnDateToISO(mesNome, dia, ano){
  const m = _MESES_EN[String(mesNome||"").toLowerCase()];
  if(!m) return "";
  return `${ano}-${String(m).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
}
function dolNewsParseLatest(html){
  const DATE_TITLE_RE = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\.\s*([^<\r\n]{8,300})/;
  // Estratégia A: dentro de headings (h1–h4) — mais confiável, é onde o DOL
  // normalmente coloca "Mês DD, AAAA. Título do anúncio".
  const headingRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let hm;
  while((hm=headingRe.exec(html))){
    const text = hm[1].replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").trim();
    const dm = DATE_TITLE_RE.exec(text);
    if(dm){
      const iso = _parseEnDateToISO(dm[1], dm[2], dm[3]);
      if(iso) return { ok:true, date:iso, title:dm[4].trim(), estrategia:"heading" };
    }
  }
  // Estratégia B (reserva): varre o texto puro da página inteira (tira tag)
  // e pega a PRIMEIRA ocorrência do padrão "Mês DD, AAAA. Texto" — a página
  // lista do mais novo pro mais antigo, então a primeira ocorrência real
  // (depois do menu/cabeçalho do site) deve ser o anúncio mais recente.
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ");
  const globalRe = new RegExp(DATE_TITLE_RE.source, "g");
  let gm;
  while((gm=globalRe.exec(plain))){
    const iso = _parseEnDateToISO(gm[1], gm[2], gm[3]);
    if(iso){
      // Ignora datas absurdas (proteção contra casar com algo tipo rodapé "January 1, 1970")
      const y = parseInt(gm[3],10);
      if(y>=2024 && y<=2030) return { ok:true, date:iso, title:gm[4].trim(), estrategia:"texto-puro" };
    }
  }
  return { ok:false };
}

// ── Checagem principal: busca a página, extrai o anúncio mais recente,
// compara com o que já é conhecido. Só dispara e-mail se a data for
// GENUINAMENTE mais nova — nunca "no chute", nunca reenvia a mesma. ────────
async function dolNewsCheckNow(){
  DB_DOL_NEWS_WATCH.checksCount = (DB_DOL_NEWS_WATCH.checksCount||0)+1;
  DB_DOL_NEWS_WATCH.ultimaChecagemAt = Date.now();
  DB_DOL_NEWS_WATCH.proximaChecagemAt = Date.now()+10*60*1000;
  try{
    const { status, buffer, headers } = await httpsGetBuffer(DOL_NEWS_URL);
    if(status!==200){
      DB_DOL_NEWS_WATCH.ultimoResultado='erro-http';
      DB_DOL_NEWS_WATCH.ultimoErro=`HTTP ${status}`;
      // 🩺 Guarda contexto rico do erro (pro botão "Analisar com Gemini")
      DB_DOL_NEWS_WATCH.ultimoErroDetalhe = {
        status, headers: headers||{},
        corpoAmostra: buffer.toString("utf8").slice(0,800),
        at: Date.now(),
      };
      dolNewsLog(`⚠️ Checagem: HTTP ${status} ao acessar a página de anúncios do DOL.`,'warn');
      persistDolNewsWatch();
      return { ok:false, reason:'http-'+status };
    }
    const html = buffer.toString("utf8");
    const found = dolNewsParseLatest(html);
    if(!found.ok){
      DB_DOL_NEWS_WATCH.ultimoResultado='erro-parse';
      DB_DOL_NEWS_WATCH.ultimoErro='Não consegui achar nenhum anúncio com data no HTML da página — o DOL pode ter mudado o layout.';
      DB_DOL_NEWS_WATCH.ultimoErroDetalhe = { status, headers: headers||{}, corpoAmostra: html.slice(0,800), at: Date.now() };
      dolNewsLog(`⚠️ Checagem: página carregou (${(buffer.length/1024).toFixed(0)}KB) mas não consegui identificar nenhum anúncio com data. Confira manualmente — o DOL pode ter mudado o layout.`,'warn');
      persistDolNewsWatch();
      return { ok:false, reason:'parse-failed' };
    }
    DB_DOL_NEWS_WATCH.ultimoErroDetalhe = null;
    const baseline = DB_DOL_NEWS_WATCH.ultimaConhecida;
    if(found.date > baseline.date || (found.date===baseline.date && found.title!==baseline.title)){
      // 🚨 Anúncio novo!
      dolNewsLog(`🚨 ANÚNCIO NOVO detectado (via ${found.estrategia}): "${found.date}" — "${found.title}"`,'ok');
      const admins = getAllAdminEmails();
      const subject = `🚨 DOL publicou anúncio novo — confira agora!`;
      const text = `O robô do H2BApply detectou uma publicação NOVA na página de anúncios do DOL.

📅 Data: ${found.date}
📰 Título: ${found.title}

🔗 Confira e baixe o que for preciso: ${DOL_NEWS_URL}

Se for a lista randomizada de Julho 2026, faça o download logo!

— Vigia de Anúncios DOL · H2BApply 🤖`;
      const sendResult = await sendAdminAlertEmail(subject, text);
      DB_DOL_NEWS_WATCH.ultimaConhecida = { date:found.date, title:found.title, detectadaEm:Date.now(), origem:found.estrategia };
      DB_DOL_NEWS_WATCH.ultimoResultado='nova-encontrada';
      DB_DOL_NEWS_WATCH.ultimoErro=null;
      DB_DOL_NEWS_WATCH.historicoAlertas.unshift({ at:Date.now(), date:found.date, title:found.title, emailsEnviados:sendResult.enviados||[] });
      if(DB_DOL_NEWS_WATCH.historicoAlertas.length>30) DB_DOL_NEWS_WATCH.historicoAlertas.length=30;
      persistDolNewsWatch();
      return { ok:true, novo:true, date:found.date, title:found.title, emailsEnviados:sendResult.enviados };
    }
    DB_DOL_NEWS_WATCH.ultimoResultado='sem-novidade';
    DB_DOL_NEWS_WATCH.ultimoErro=null;
    persistDolNewsWatch();
    return { ok:true, novo:false, date:found.date, title:found.title };
  }catch(e){
    DB_DOL_NEWS_WATCH.ultimoResultado='erro-http';
    DB_DOL_NEWS_WATCH.ultimoErro=e.message;
    dolNewsLog(`❌ Erro na checagem: ${e.message}`,'error');
    persistDolNewsWatch();
    return { ok:false, reason:'exception', error:e.message };
  }
}
async function dolNewsAutoTick(){
  if(DB_DOL_NEWS_WATCH.autoCheckEnabled===false) return;
  await dolNewsCheckNow();
}


// ════════════════════════════════════════════════════════════
//  BOT DE ENRIQUECIMENTO DE PLANILHAS
//  Acessa DOL API para cada ETA case number e preenche todos
//  os campos que faltam: ci, d, de, wk, ph, desc, url
// ════════════════════════════════════════════════════════════
async function _runEnrichBot(sheetKey, resume=false){
  if(_enrichBot.running && !resume){
    _enrichLog("Bot já está rodando","warn"); return;
  }
  const sheet = sheetKey==="jan2026" ? SHEET_JAN
              : sheetKey==="jul2025" ? SHEET_JUL
              : SHEET_EXTRAS[sheetKey];
  if(!sheet || !sheet.length){
    _enrichLog(`Planilha não encontrada: ${sheetKey}`,"error"); return;
  }

  // startIdx real: conta vagas que JÁ TÊM email no disco
  // Assim, após deploy/reinício, retoma exatamente de onde o disco parou
  const alreadyDone = sheet.filter(r => r.e && r.e.includes("@")).length;
  const startIdx = resume
    ? Math.max(0, alreadyDone > 0 ? alreadyDone - 5 : 0) // volta 5 para garantir sem gap
    : 0;

  _enrichBot.running   = true;
  _enrichBot.sheetKey  = sheetKey;
  _enrichBot.total     = sheet.length;
  _enrichBot.done      = startIdx;
  _enrichBot.ok        = resume ? alreadyDone : 0;
  _enrichBot.noEmail   = resume ? (_enrichBot.noEmail||0) : 0;
  _enrichBot.errors    = resume ? (_enrichBot.errors||0) : 0;
  _enrichBot.startedAt = (resume && _enrichBot.startedAt) ? _enrichBot.startedAt : Date.now();
  _enrichBot.log       = resume ? _enrichBot.log : [];
  _enrichBot.savedAt   = null;

  _enrichLog(`📌 Ponto de retomada: ${startIdx}/${sheet.length} (${alreadyDone} vagas já têm email no disco)`, "info");

  _enrichLog(`🚀 Bot iniciado: ${sheet.length} vagas — planilha "${sheetKey}"${resume?` (retomando de ${startIdx})`:''}`, "ok");
  _enrichLog(`🔍 Buscando: email, cidade, datas, workers, telefone, funções, URL`, "info");

  // Rotação de User-Agents para evitar fingerprinting do DOL
  const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  ];
  let _uaIdx = Math.floor(Math.random() * USER_AGENTS.length);

  const getHDR = () => {
    _uaIdx = (_uaIdx + 1) % USER_AGENTS.length;
    return {
      "Accept":"application/json, text/plain, */*",
      "Accept-Language":"en-US,en;q=0.9",
      "Accept-Encoding":"identity",
      "User-Agent": USER_AGENTS[_uaIdx],
      "Cache-Control":"no-cache",
      "Pragma":"no-cache",
      "Referer":"https://seasonaljobs.dol.gov/",
      "Origin":"https://seasonaljobs.dol.gov",
      "sec-fetch-dest":"empty",
      "sec-fetch-mode":"cors",
      "sec-fetch-site":"same-site",
    };
  };

  // Delay entre vagas — aumenta dinamicamente ao pegar 403
  let _interDelay = 800;
  let _consecutive403 = 0;

  // Processar UMA VAGA POR VEZ — garante que cada case number é buscado individualmente
  for(let i = startIdx; i < sheet.length; i++){
    if(!_enrichBot.running) break;

    const row = sheet[i];
    const cn  = (row.c||"").toUpperCase();
    _enrichBot.done = i + 1;

    // Loop de retry com backoff exponencial para 403/429
    let attempt = 0;
    let processed = false;

    while(attempt < 6 && !processed && _enrichBot.running){
      if(attempt > 0){
        // Backoff: 15s, 30s, 60s, 120s, 240s
        const waitMs = Math.min(15000 * Math.pow(2, attempt - 1), 240000);
        _enrichLog(`⏳ [${i+1}/${sheet.length}] ${cn} — retry ${attempt}/5, aguardando ${Math.round(waitMs/1000)}s...`, "warn");
        await new Promise(r=>setTimeout(r, waitMs));
        if(!_enrichBot.running) break;
      }
      attempt++;

    try{
      // Buscar case number específico na API do DOL
      const params = new URLSearchParams({"api-version":"2020-06-30"});
      params.append("$filter", `case_number eq '${row.c}'`);
      params.append("$top", "1");

      const {status, body} = await httpsReq({
        hostname:"api.seasonaljobs.dol.gov",
        path:"/datahub/?"+params,
        method:"GET",
        headers:getHDR()
      });

      if(status===200){
        _consecutive403 = 0;
        // Recupera velocidade gradualmente após 403s
        if(_interDelay > 800) _interDelay = Math.max(800, _interDelay - 300);
        const raw = body.value||body.results||body.data||[];
        const dol = raw[0]||null;
        processed = true;

        if(dol){
          // ═══ COLETAR TODOS OS CAMPOS DO SITE seasonaljobs.dol.gov ═══
          // Visíveis na página: salário, cidade, datas, workers, funções,
          // telefone, email, endereço worksite, horário, SOC, experiência, requisitos

          // Localização
          row.ci    = (dol.worksite_city||dol.employer_city||row.ci||"").trim();
          row.st_ab = (dol.worksite_state||dol.employer_state||row.st_ab||"").trim(); // estado abreviado
          row.addr  = (dol.worksite_address||dol.employer_address||row.addr||"").trim(); // endereço worksite
          row.zip   = (dol.worksite_postal_code||dol.employer_postal_code||row.zip||"").trim();

          // Período e vagas
          row.d     = (dol.begin_date||dol.start_date||row.d||"").slice(0,10);
          row.de    = (dol.end_date||dol.expiration_date||row.de||"").slice(0,10);
          row.wk    = parseInt(dol.total_positions||dol.nbr_workers_requested||0)||row.wk||0;

          // Salário
          row.w     = row.w||(dol.basic_rate_from?String(parseFloat(dol.basic_rate_from).toFixed(2)):"");
          row.wmax  = dol.basic_rate_to?String(parseFloat(dol.basic_rate_to).toFixed(2)):(row.wmax||"");
          row.wunit = row.wunit||(dol.pay_range_desc==="Month"?"mês":"h");
          row.winfo = (dol.wage_offer_description||dol.additional_wage_information||row.winfo||"").slice(0,300);

          // Contato
          row.ph    = ((dol.apply_phone||dol.employer_phone||row.ph||"")).replace(/[^0-9+()\- ]/g,"").trim();
          row.ph2   = (dol.employer_phone||row.ph2||"").replace(/[^0-9+()\- ]/g,"").trim();
          row.site  = (dol.employer_website||dol.apply_url||row.site||"").trim();

          // Cargo e empresa
          row.s     = (dol.worksite_state||dol.employer_state||row.s||"").toUpperCase().trim();
          if(dol.job_title) row.t = dol.job_title.trim();
          row.n     = (dol.employer_business_name||dol.employer_trade_name||row.n||"").trim();
          row.st    = (dol.case_status||row.st||"").trim();
          row.soc   = (dol.soc_code||dol.onet_code||row.soc||"").trim(); // código SOC
          row.socT  = (dol.soc_title||row.socT||"").trim(); // título SOC

          // Descrição das funções (completa)
          if(dol.job_duties)
            row.desc = dol.job_duties.replace(/\*\*[^*]+\*\*/g,"").trim().slice(0,1500);

          // Requisitos
          row.exp   = dol.experience_required==="Yes"?1:0;
          row.req   = (dol.special_requirements||row.req||"").slice(0,400);
          row.hrs   = dol.nbr_hours_per_week?String(dol.nbr_hours_per_week):(row.hrs||"");
          row.sched = (dol.work_schedule||row.sched||"").trim(); // horário (ex: 7:00 A.M. - 1:00 P.M.)
          row.ft    = dol.full_time_position==="Yes"?"sim":""; // full time?

          // URL oficial da vaga
          row.url   = `https://seasonaljobs.dol.gov/jobs/${row.c}`;

          // Tipo de visto
          row.visa  = row.c.startsWith("H-300")?"H-2A":row.c.startsWith("H-400")?"H-2B":(row.visa||"H-2B");

          // Email — todos os campos possíveis do DOL
          const emails = [
            dol.apply_email, dol.employer_email,
            dol.employer_poc_email, dol.attorney_agent_email,
            dol.employer_contact_email,
          ].map(e=>(e||"").trim().toLowerCase())
           .filter(e=>e && e.includes("@") && e!=="n/a" && !e.startsWith("n/a"));
          if(!row.e && emails.length>0){
            row.e = emails[0];
            _enrichLog(`📧 [${i+1}/${sheet.length}] ${cn}: email → ${row.e}`, "ok");
          } else if(row.e && emails.length>0 && !emails.includes(row.e)){
            // Manter o existente mas logar que há outros
          }

          _enrichBot.ok++;
          if(!row.e||!row.e.includes("@")){
            _enrichBot.noEmail++;
            _enrichLog(`⚠️ [${i+1}/${sheet.length}] ${cn} SEM EMAIL | ${(row.t||"?").slice(0,40)} | ${row.ci||row.s||"?"}`, "warn");
          } else {
            // Log de cada vaga OK — em tempo real
            _enrichLog(`✅ [${i+1}/${sheet.length}] ${cn} | ${(row.t||"?").slice(0,35)} | ${row.ci||"?"}, ${row.s||"?"} | $${row.w||"?"}/h | ${row.e}`, "info");
          }
        } else {
          // Não encontrou na API — case number inválido ou expirado
          _enrichBot.errors++;
          _enrichLog(`❌ [${i+1}/${sheet.length}] ${cn} — não encontrado no DOL`, "warn");
        }

      } else if(status===403 || status===429){
        // DOL bloqueia com 403 (rate limit/anti-bot) ou 429 (rate limit explícito)
        // Não conta como erro — vai retry com backoff
        _consecutive403++;
        // Aumenta delay permanente proporcionalmente
        _interDelay = Math.min(3000 + _consecutive403 * 500, 8000);
        // Não marca processed → while faz retry automático
        _enrichLog(`🚫 [${i+1}/${sheet.length}] ${cn} — HTTP ${status} (bloqueio DOL, tentativa ${attempt}/5, delay→${_interDelay}ms)`, "warn");
      } else {
        // Qualquer outro erro HTTP (404, 500, etc.) — conta como erro, não faz retry
        processed = true;
        _enrichBot.errors++;
        _enrichLog(`⚠️ [${i+1}/${sheet.length}] ${cn} — DOL retornou HTTP ${status}`, "warn");
      }
    }catch(e){
      // Erro de rede — pode tentar de novo
      if(attempt < 6){
        _enrichLog(`🔌 [${i+1}/${sheet.length}] ${cn} — erro de rede (retry ${attempt}/5): ${e.message}`, "warn");
        // processed continua false → while faz retry
      } else {
        processed = true;
        _enrichBot.errors++;
        _enrichLog(`❌ [${i+1}/${sheet.length}] ${cn} — falhou após 5 tentativas: ${e.message}`, "error");
      }
    }
    } // fim while retry

    // Se esgotou retries sem processar (ex: 5x 403 seguidos)
    if(!processed && _enrichBot.running){
      _enrichBot.errors++;
      _enrichLog(`❌ [${i+1}/${sheet.length}] ${cn} — desistindo após 5 tentativas (DOL bloqueando)`, "error");
    }

    // Salvar após CADA VAGA processada — zero perda de dados
    // O disco persistente /data/ garante que sobrevive a deploy, reinício e fechamento do browser
    _saveEnrichedSheet(sheetKey, sheet);
    _enrichBot.savedAt = Date.now();
    // Log de progresso a cada 10 vagas (não poluir o log a cada 1)
    if(_enrichBot.done % 10 === 0){
      const pct = Math.round((_enrichBot.done/sheet.length)*100);
      _enrichLog(`💾 [${_enrichBot.done}/${sheet.length}] ${pct}% — ok:${_enrichBot.ok} semEmail:${_enrichBot.noEmail} delay:${_interDelay}ms`, "ok");
    }

    // Delay adaptativo entre vagas (aumenta quando DOL bloqueia, reduz quando ok)
    await new Promise(r=>setTimeout(r, _interDelay));
  }

  // Finalizar
  _enrichBot.done    = sheet.length;
  _enrichBot.running = false;
  _saveEnrichedSheet(sheetKey, sheet);
  _enrichBot.savedAt = Date.now();

  // Atualizar meta para planilhas builtin também (jan2026, jul2025)
  if(!DB_SHEETS_META[sheetKey]){
    DB_SHEETS_META[sheetKey] = {name: sheetKey==="jan2026"?"Janeiro 2026 (H-2B)":"Julho 2025 (H-2B)", file:sheetKey+".json"};
  }
  DB_SHEETS_META[sheetKey].enriched    = _enrichBot.ok;
  DB_SHEETS_META[sheetKey].enrichedAt  = Date.now();
  DB_SHEETS_META[sheetKey].enrichedTotal = _enrichBot.total;
  fs.writeFileSync(SHEETS_META_FILE, JSON.stringify(DB_SHEETS_META,null,2));

  const semEmail = sheet.filter(r=>!r.e||!r.e.includes("@")).length;
  _enrichLog(`🏁 CONCLUÍDO! ok:${_enrichBot.ok} | semEmail:${semEmail} | erros:${_enrichBot.errors}`, "ok");
  _enrichLog(`📥 Baixe a planilha enriquecida no botão "⬇️ Baixar JSON"`, "ok");
}

function _saveEnrichedSheet(sheetKey, sheet){
  try{
    // 🔒 Checagem leve de integridade (não bloqueia salvamento — o bot de
    // enriquecimento só EDITA campos das linhas já existentes, não deveria
    // nunca introduzir duplicata; se acontecer, só avisa no log pra
    // investigar, já que abortar aqui perderia o progresso do enriquecimento).
    const _chk = _vagasVerify(sheet, {caseField:'c'});
    if(!_chk.ok){
      _enrichLog(`⚠️ Integridade: ${_chk.duplicateCases.length} case number(s) duplicado(s) detectado(s) em "${sheetKey}" — investigar (não deveria acontecer no bot de enriquecimento).`, "warn");
    }
    // Salva SEMPRE em /data/ (disco persistente — sobrevive a deploys)
    // E também em __dirname para leitura imediata sem precisar recarregar
    const dataPath = path.join(DATA_DIR, sheetKey==="jan2026"?"jan2026_compact.json":"jul2025_compact.json");
    const srcPath  = path.join(__dirname, sheetKey==="jan2026"?"jan2026_compact.json":"jul2025_compact.json");
    const payload  = JSON.stringify(sheet);

    if(sheetKey==="jan2026"||sheetKey==="jul2025"){
      // Salva no disco persistente (/data/) — não é sobrescrito no deploy
      fs.writeFileSync(dataPath, payload);
      // Salva também na pasta do código (para leitura imediata neste boot)
      try{fs.writeFileSync(srcPath, payload);}catch{}
      _enrichLog(`💾 Salvo em /data/ e código: ${sheet.length} vagas`, "ok");
    } else if(SHEET_EXTRAS[sheetKey]){
      const meta = DB_SHEETS_META[sheetKey];
      const fp = path.join(SHEETS_DIR, meta?.file||`${sheetKey}.json`);
      fs.writeFileSync(fp, payload); // extras já ficam em /data/sheets/
    }
    _enrichBot.savedAt = Date.now();
  }catch(e){ _enrichLog(`❌ Erro ao salvar: ${e.message}`,"error"); }
}


const server=http.createServer(async(req,res)=>{
  res._req=req; // V951: permite ao helper json() negociar gzip sem mudar 400+ call sites
  let u,pathname;try{u=new URL(req.url,"http://x");pathname=u.pathname;}catch{res.writeHead(400);return res.end();}
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Content-Security-Policy",[
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net https://unpkg.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://oauth2.googleapis.com https://gmail.googleapis.com https://api.seasonaljobs.dol.gov https://fcm.googleapis.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  const org=req.headers.origin||"";const ao=(org===APP_URL||/^https?:\/\/localhost/.test(org))?org:APP_URL;
  res.setHeader("Access-Control-Allow-Origin",ao);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,PATCH,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}

  const serveHtml=f=>sendAsset(req,res,f,"text/html; charset=utf-8","no-cache"); // V951: brotli/gzip + ETag
  if(pathname==="/"||pathname==="/index.html")return serveHtml("index.html");
  if(pathname==="/admin"||pathname==="/admin.html")return serveHtml("admin.html");
  if(pathname==="/admin-v2"||pathname==="/admin-v2.html")return serveHtml("admin-v2.html");
  if(pathname==="/guia"||pathname==="/guia.html")return serveHtml("guia.html");
  if(pathname==="/diagnostico"||pathname==="/diagnostico.html")return serveHtml("diagnostico.html");

  // ── /ad — painel admin protegido ──────────────────────────
  // Só emails admin podem acessar. Qualquer outro usuário recebe
  // uma tela de acesso negado sem revelar que existe um painel.
  if(pathname==="/ad"||pathname==="/ad.html"){
    // Verificar sessão do usuário atual
    const adSess = getSess(req);
    if(!adSess?.user_email){
      // Não logado — redirecionar para login com next=/ad
      res.writeHead(302,{"Location":"/?next=ad"});
      return res.end();
    }
    const adUser = getUser(adSess.user_email);
    if(!isAdminEmail(adSess.user_email) && !isAdminVip(adUser)){
      // Logado mas não é admin — tela de erro
      const errorPage = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Acesso Negado — H2BApply</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#020617;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;padding:20px}
    .card{background:#0f172a;border:1.5px solid rgba(239,68,68,.3);border-radius:20px;padding:40px 32px;max-width:420px;width:100%;text-align:center}
    .icon{font-size:64px;margin-bottom:20px}
    .title{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}
    .sub{font-size:14px;color:#94a3b8;line-height:1.6;margin-bottom:24px}
    .badge{display:inline-block;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;color:#ef4444;margin-bottom:24px}
    .btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px}
    .email{font-size:11px;color:#475569;margin-top:20px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <div class="badge">⛔ ACESSO RESTRITO</div>
    <div class="title">Área exclusiva</div>
    <div class="sub">
      Esta área é exclusiva para <strong style="color:#fff">funcionários da plataforma H2BApply</strong>.<br><br>
      Se você é um candidato, acesse o painel principal abaixo.
    </div>
    <a href="/" class="btn">← Ir para o app</a>
    <div class="email">Você está logado como: ${adSess.user_email}</div>
  </div>
</body>
</html>`;
      res.writeHead(403,{"Content-Type":"text/html; charset=utf-8"});
      return res.end(errorPage);
    }
    // É admin — servir o painel
    return serveHtml("admin.html");
  }

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
    <div class="date">Última atualização: Junho de 2026 — Versão 3.0</div>

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
      <li>Email: <a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
    </ul>
  </div>
  <div class="footer">
    © 2026 H2BApply · <a href="/" style="color:#64748b">h2bapply.com</a>
    &nbsp;|&nbsp; <a href="/privacy" style="color:#64748b">Privacidade</a>
    &nbsp;|&nbsp; <a href="/terms" style="color:#64748b">Termos</a>
    &nbsp;|&nbsp; <a href="/contact" style="color:#64748b">Contato</a>
    <br><small style="color:#94a3b8">suporte@h2bapply.com</small>
  </div>
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
    <div class="date">Última atualização: Junho de 2026 — Versão 3.0</div>

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

    <h2 id="gmail-aviso">8. Aviso sobre uso do Gmail — Responsabilidade do Usuário</h2>
    <div class="warning">⚠️ <strong>Leia com atenção antes de usar o envio automático.</strong></div>
    <p>O H2BApply utiliza sua conta Gmail para enviar candidaturas. O Google pode <strong>bloquear temporariamente</strong> contas Gmail que enviam muitos emails em curto período, especialmente quando:</p>
    <ul>
      <li>Você usa apenas <strong>1 conta Gmail</strong> para todos os envios</li>
      <li>O volume de emails é muito alto em um único dia</li>
      <li>Os emails são enviados para muitos destinatários desconhecidos</li>
    </ul>
    <p><strong>Recomendação:</strong> Adicione 2 ou mais contas Gmail na aba Perfil → Gmail para distribuir os envios e reduzir o risco de bloqueio.</p>
    <p><strong>Isenção de responsabilidade:</strong> O H2BApply não se responsabiliza por bloqueios, suspensões ou limitações impostas pelo Google às contas dos usuários. O risco de bloqueio do Gmail é de <strong>inteira responsabilidade do usuário</strong>. Ao usar o envio automático, você declara estar ciente deste risco e assume total responsabilidade pelo uso da sua conta Gmail.</p>

    <h2>9. Contato</h2>
    <ul>
      <li>Email: <a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></li>
      <li>WhatsApp: +55 53 98145-3496</li>
      <li>Instagram: <a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></li>
      <li>Site: <a href="https://h2bapply.com">h2bapply.com</a></li>
    </ul>
  </div>
  <div class="footer">
    © 2026 H2BApply · <a href="/" style="color:#64748b">h2bapply.com</a>
    &nbsp;|&nbsp; <a href="/privacy" style="color:#64748b">Privacidade</a>
    &nbsp;|&nbsp; <a href="/terms" style="color:#64748b">Termos</a>
    &nbsp;|&nbsp; <a href="/contact" style="color:#64748b">Contato</a>
    <br><small style="color:#94a3b8">suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // Página de Exclusão de Dados — exigida pelo Google OAuth
  if(pathname==="/delete-account"||pathname==="/excluir-conta"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Excluir Conta — H2BApply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
.container{max-width:640px;margin:0 auto;padding:40px 20px}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:800}
h1{font-size:26px;font-weight:800;color:#1e293b;margin-bottom:8px}
h2{font-size:16px;font-weight:700;color:#374151;margin:24px 0 8px}
p{font-size:14px;color:#4b5563;margin-bottom:12px}
ul{font-size:14px;color:#4b5563;margin:0 0 12px 20px}
ul li{margin-bottom:6px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;margin-bottom:20px}
.warning{background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:14px;font-size:13px;color:#991b1b;margin-bottom:20px}
.email-link{color:#4f46e5;font-weight:700}
.btn{display:inline-block;background:#4f46e5;color:#fff;padding:11px 24px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-top:8px}
.footer{text-align:center;margin-top:40px;font-size:12px;color:#94a3b8}
.date{font-size:12px;color:#94a3b8;margin-top:4px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div>
      <div style="font-size:20px;font-weight:800">H2BApply</div>
      <div class="date">h2bapply.com</div>
    </div>
  </div>

  <h1>Exclusão de Conta e Dados</h1>
  <p style="color:#64748b;margin-bottom:24px">Esta página explica como solicitar a exclusão da sua conta e de todos os seus dados pessoais na plataforma H2BApply.</p>

  <div class="warning">
    ⚠️ <strong>Atenção:</strong> A exclusão de conta é permanente e irreversível. Todos os seus dados serão removidos e não poderão ser recuperados.
  </div>

  <div class="card">
    <h2>📋 O que será removido</h2>
    <ul>
      <li>Seu perfil e informações pessoais (nome, email, cidade, WhatsApp)</li>
      <li>Todos os currículos e arquivos enviados</li>
      <li>Histórico completo de candidaturas enviadas</li>
      <li>Templates de email e perfis de candidatura</li>
      <li>Configurações da conta e preferências</li>
      <li>Dados de plano e assinatura</li>
      <li>Autorização de acesso ao Gmail (revogada automaticamente)</li>
    </ul>
  </div>

  <div class="card">
    <h2>🔐 Acesso ao Google</h2>
    <p>O H2BApply utiliza o <strong>Google OAuth</strong> apenas para autenticação e envio de emails via Gmail. Ao excluir sua conta, revogamos o token de acesso ao seu Gmail. Para garantia adicional, você também pode revogar o acesso diretamente em:</p>
    <p><a href="https://myaccount.google.com/permissions" target="_blank" class="email-link">myaccount.google.com/permissions</a></p>
    <p>Busque por "H2BApply" e clique em "Remover acesso".</p>
  </div>

  <div class="card">
    <h2>📧 Como solicitar a exclusão</h2>
    <p><strong>Opção 1 — Pelo aplicativo (mais rápido):</strong></p>
    <ul>
      <li>Acesse <a href="https://h2bapply.com" class="email-link">h2bapply.com</a></li>
      <li>Faça login com sua conta Google</li>
      <li>Vá em <strong>Configurações → Excluir minha conta</strong></li>
      <li>Confirme a exclusão — seus dados são removidos imediatamente</li>
    </ul>
    <p style="margin-top:12px"><strong>Opção 2 — Por email:</strong></p>
    <ul>
      <li>Envie um email para <a href="mailto:suporte@h2bapply.com" class="email-link">suporte@h2bapply.com</a></li>
      <li>Assunto: "Exclusão de conta — [seu email]"</li>
      <li>Responderemos em até 48 horas confirmando a exclusão</li>
    </ul>
    <a href="mailto:suporte@h2bapply.com?subject=Solicitar exclusão de conta H2BApply" class="btn">📧 Solicitar exclusão por email</a>
  </div>

  <div class="card">
    <h2>⏱️ Prazo de exclusão</h2>
    <p>Após a solicitação, seus dados são excluídos <strong>em até 30 dias</strong>. Durante esse período, sua conta fica desativada e você não recebe nenhuma comunicação da plataforma.</p>
    <p>Dados de logs de sistema (sem informação pessoal) podem ser mantidos por até 90 dias por questões de segurança.</p>
  </div>

  <div class="footer">
    © 2026 H2BApply · <a href="/privacy" style="color:#94a3b8">Privacidade</a> · <a href="/terms" style="color:#94a3b8">Termos</a> · <a href="/contact" style="color:#94a3b8">Contato</a>
    <br>suporte@h2bapply.com
  </div>
</div>
</body>
</html>`);
  }

  // Página de Contato
  if(pathname==="/contact"||pathname==="/contato"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=3600"});
    return res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contato — H2BApply</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc;line-height:1.7}
  .container{max-width:600px;margin:0 auto;padding:40px 20px}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,#4f46e5,#0891b2);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800}
  .logo-text{font-size:22px;font-weight:800;color:#1e293b}
  h1{font-size:28px;font-weight:800;color:#1e293b;margin-bottom:8px}
  .sub{font-size:14px;color:#64748b;margin-bottom:28px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;margin-bottom:16px}
  .contact-item{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f5f9}
  .contact-item:last-child{border-bottom:none}
  .contact-icon{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
  .contact-label{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
  .contact-value{font-size:15px;font-weight:600;color:#1e293b}
  .contact-value a{color:#4f46e5;text-decoration:none}
  .footer{text-align:center;margin-top:32px;font-size:13px;color:#94a3b8}
  .back-btn{display:inline-flex;align-items:center;gap:6px;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:24px}
  .badge{display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:20px}
</style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">H</div>
    <div class="logo-text">H2BApply</div>
  </div>
  <a href="/" class="back-btn">← Voltar ao App</a>
  <div class="badge">🌐 Plataforma de candidaturas H-2B/H-2A</div>
  <h1>Fale Conosco</h1>
  <p class="sub">Estamos aqui para ajudar com dúvidas sobre o app, planos ou candidaturas.</p>
  <div class="card">
    <div class="contact-item">
      <div class="contact-icon" style="background:#eff6ff">📧</div>
      <div>
        <div class="contact-label">Email de suporte</div>
        <div class="contact-value"><a href="mailto:suporte@h2bapply.com">suporte@h2bapply.com</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#f0fdf4">💬</div>
      <div>
        <div class="contact-label">WhatsApp</div>
        <div class="contact-value"><a href="https://wa.me/5553981453496" target="_blank">+55 53 98145-3496</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#fdf4ff">📸</div>
      <div>
        <div class="contact-label">Instagram</div>
        <div class="contact-value"><a href="https://instagram.com/andrio.k" target="_blank">@andrio.k</a></div>
      </div>
    </div>
    <div class="contact-item">
      <div class="contact-icon" style="background:#fefce8">🌐</div>
      <div>
        <div class="contact-label">Site</div>
        <div class="contact-value"><a href="https://h2bapply.com">h2bapply.com</a></div>
      </div>
    </div>
  </div>
  <div class="card" style="background:#fefce8;border-color:#fde68a">
    <h2 style="font-size:16px;color:#92400e;margin-bottom:10px">⚠️ Aviso sobre Gmail</h2>
    <p style="font-size:14px;color:#78350f">O uso intensivo de uma única conta Gmail pode gerar bloqueio pelo Google. Sempre adicione 2+ contas Gmail ao app para maior segurança. <a href="/terms#gmail-aviso" style="color:#92400e;font-weight:700">Ver termos de uso →</a></p>
  </div>
  <div class="footer">
    © 2026 H2BApply &nbsp;·&nbsp; <a href="/privacy" style="color:#94a3b8">Privacidade</a> &nbsp;·&nbsp; <a href="/terms" style="color:#94a3b8">Termos</a>
    <br><small>suporte@h2bapply.com</small>
  </div>
</div>
</body>
</html>`);
  }

  // Corrigir valor de um pedido (admin)
  if(pathname==="/api/admin/pedido-set-valor"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const {pedidoId,valor}=body;
    if(!pedidoId||!valor)return json(res,400,{error:"pedidoId e valor obrigatórios"});
    const pd=DB_PEDIDOS.find(x=>x.id===pedidoId);
    if(!pd)return json(res,404,{error:"Pedido não encontrado"});
    const vAntes=pd.valorTotal;
    pd.valorTotal=parseFloat(valor)||0;
    pd.valorCorrigidoPor=s.user_email;
    pd.valorCorrigidoEm=Date.now();
    pd.valorOriginal=pd.valorOriginal||vAntes;
    if(!persistPedidos()){
      // Desfaz — não pode "parecer" corrigido se não gravou no disco.
      pd.valorTotal=vAntes; delete pd.valorCorrigidoPor; delete pd.valorCorrigidoEm;
      return json(res,500,{error:"⚠️ Não consegui gravar no disco — o valor NÃO foi corrigido. Tente de novo."});
    }
    // Atualizar também no financeiro se existir (mesmo pedido, mesmo dinheiro)
    let finSyncOk=true;
    try{
      const finP=DB_FINANCEIRO.pagamentos.find(x=>x.pedidoId===pedidoId);
      if(finP){
        const finAntes=finP.valor;
        finP.valor=pd.valorTotal;finP.notaCorrecao=`Valor corrigido de R$${vAntes} para R$${pd.valorTotal} por ${s.user_email}`;
        if(!persistFinanceiro()){ finP.valor=finAntes; finSyncOk=false; console.error(`[pedido-set-valor] pedido ${pedidoId} salvo, mas SINCRONIZAÇÃO com financeiro falhou — valores podem divergir até nova tentativa.`); }
      }
    }catch(e){ finSyncOk=false; console.error('[pedido-set-valor] erro ao sincronizar financeiro:',e.message); }
    console.log(`[pedido] valor corrigido: ${pedidoId} R$${vAntes}→R$${pd.valorTotal} por ${s.user_email}`);
    return json(res,200,{ok:true,valorAntes:vAntes,valorNovo:pd.valorTotal,finSyncOk});
  }

  // ════ BOT DE ENRIQUECIMENTO DE PLANILHAS ════════════════════
  // [enrich endpoints consolidados abaixo]

  // POST /api/admin/enrich/stop — para o bot
  if(pathname==="/api/admin/enrich/stop"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    _enrichBotState.running=false;
    _enrichLog("⏹️ Bot parado pelo admin", "warn");
    return json(res,200,{ok:true});
  }

  // ════ GESTÃO DE PLANILHAS DE VAGAS ════════════════════════
  // GET /api/admin/sheets — lista todas as planilhas
  if(pathname==="/api/admin/sheets"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    // Calcular stats reais de enriquecimento contando campos preenchidos
    const _enrichStats=(arr)=>{
      if(!arr||!arr.length)return{withCity:0,withPhone:0,withDesc:0,withDate:0};
      return{
        withCity:arr.filter(r=>r.ci).length,
        withPhone:arr.filter(r=>r.ph).length,
        withDesc:arr.filter(r=>r.desc).length,
        withDate:arr.filter(r=>r.d&&r.d!=="–").length,
      };
    };
    const janStats=_enrichStats(SHEET_JAN);
    const julStats=_enrichStats(SHEET_JUL);
    const sheets = [
      {key:"jan2026",name:"Janeiro 2026 (H-2B)",count:SHEET_JAN.length,builtin:true,active:true,
        enriched:DB_SHEETS_META["jan2026"]?.enriched||janStats.withCity,
        enrichedAt:DB_SHEETS_META["jan2026"]?.enrichedAt||null,
        stats:janStats,
        enrichPct:SHEET_JAN.length>0?Math.round((janStats.withCity/SHEET_JAN.length)*100):0},
      {key:"jul2025",name:"Julho 2025 (H-2B)",count:SHEET_JUL.length,builtin:true,active:true,
        enriched:DB_SHEETS_META["jul2025"]?.enriched||julStats.withCity,
        enrichedAt:DB_SHEETS_META["jul2025"]?.enrichedAt||null,
        stats:julStats,
        enrichPct:SHEET_JUL.length>0?Math.round((julStats.withCity/SHEET_JUL.length)*100):0},
      ...Object.entries(SHEET_EXTRAS).map(([key,arr])=>{
        const st=_enrichStats(arr);
        return{key,name:DB_SHEETS_META[key]?.name||key,count:arr.length,builtin:false,
          active:true,uploaded:DB_SHEETS_META[key]?.uploaded,
          enriched:DB_SHEETS_META[key]?.enriched||st.withCity,
          enrichedAt:DB_SHEETS_META[key]?.enrichedAt,
          stats:st,
          enrichPct:arr.length>0?Math.round((st.withCity/arr.length)*100):0};
      })
    ];
    const totalVagas = SHEET_JAN.length + SHEET_JUL.length + Object.values(SHEET_EXTRAS).reduce((s,a)=>s+a.length,0);
    const totalEnriched = sheets.reduce((s,sh)=>s+(sh.stats?.withCity||0),0);
    // Status do bot em tempo real
    const botStatus={running:_enrichBot.running,sheetKey:_enrichBot.sheetKey,done:_enrichBot.done,total:_enrichBot.total,pct:_enrichBot.total>0?Math.round((_enrichBot.done/_enrichBot.total)*100):0};
    return json(res,200,{ok:true,sheets,totalVagas,totalEnriched,botStatus});
  }

  // GET /api/admin/sheet/integrity — diagnóstico sob demanda (KB-076): confere,
  // para CADA planilha carregada em memória agora, se a contagem de linhas
  // bate com a contagem de ETA case numbers únicos. Não deveria nunca dar
  // "false" em produção (loadSheets já se autocura no boot), mas é a forma
  // do admin CONFERIR ao vivo, sem precisar reprocessar nada, que "quantas
  // vagas tem" é sempre igual a "quantos case numbers diferentes existem".
  if(pathname==="/api/admin/sheet/integrity"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const checkOne=(key,arr)=>{
      const r=_vagasVerify(arr,{caseField:'c'});
      return{key,totalRows:r.totalRows,uniqueCaseCount:r.uniqueCaseCount,
        ok:r.ok,duplicateCases:r.duplicateCases.slice(0,20),
        rowsWithoutCase:r.rowsWithoutCase};
    };
    const results=[
      checkOne("jan2026",SHEET_JAN),
      checkOne("jul2025",SHEET_JUL),
      checkOne("h2a",SHEET_H2A),
      ...Object.entries(SHEET_EXTRAS).map(([k,arr])=>checkOne(k,arr)),
    ];
    const allOk = results.every(r=>r.ok);
    return json(res,200,{ok:true,allOk,results});
  }

  // POST /api/admin/sheet/upload — recebe nova planilha (JSON compacto ou CSV)
  if(pathname==="/api/admin/sheet/upload"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    // FIX v941: `body` não existia neste escopo → ReferenceError → request pendurado
    // pra sempre (mesma classe do bug #819). Agora lê o corpo corretamente.
    let _upBody;
    try{ _upBody=JSON.parse(await readBody(req)); }
    catch(e){ return json(res,400,{error:"Corpo inválido: "+e.message}); }
    const{name,key,data}=_upBody;
    if(!name||!key||!data)return json(res,400,{error:"name, key e data obrigatórios"});
    // Sanitizar key (só letras, números, hífen, underscore)
    const safeKey=key.toLowerCase().replace(/[^a-z0-9_-]/g,"");
    if(!safeKey)return json(res,400,{error:"key inválida"});
    // Validar dados
    let vagas;
    try{ vagas = typeof data==="string"?JSON.parse(data):data; }
    catch(e){return json(res,400,{error:"JSON inválido: "+e.message});}
    if(!Array.isArray(vagas))return json(res,400,{error:"data deve ser um array de vagas"});
    // Garantir campos obrigatórios
    const validRaw = vagas.filter(v=>v.c&&v.e&&v.e.includes("@"));
    if(validRaw.length<1)return json(res,400,{error:`Nenhuma vaga válida (com case_number e email). Encontradas: ${vagas.length}`});
    // 🔒 DEDUPE por ETA case number — mesma regra do resto do sistema (KB-076):
    // 1 vaga = 1 case number único. Se o admin subir um arquivo com o mesmo
    // case number 2x, mescla em vez de publicar linha duplicada.
    const { rows: valid, duplicatesMerged } = _vagasDedupe(validRaw, {caseField:'c'});
    // Enriquecer categorias
    valid.forEach(r=>{if(!r.k)r.k=detectCategory(`${r.n||""} ${r.t||""}`);r._sheet=safeKey;});
    // Salvar arquivo
    const fname=`${safeKey}.json`;
    const fpath=path.join(SHEETS_DIR,fname);
    fs.writeFileSync(fpath,JSON.stringify(valid));
    SHEET_EXTRAS[safeKey]=valid;
    DB_SHEETS_META[safeKey]={name,file:fname,uploaded:Date.now(),count:valid.length,uniqueCaseCount:valid.length,enriched:0};
    fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
    console.log(`[sheet] ✅ Nova planilha carregada: ${safeKey} (${valid.length} vagas únicas de ${vagas.length} recebidas${duplicatesMerged?`, ${duplicatesMerged} duplicata(s) mesclada(s)`:''})`);
    addLog(s.user_email,{status:"sistema",jobTitle:`📋 Nova planilha adicionada: ${name}`,company:`${valid.length} vagas únicas — Chave: ${safeKey}${duplicatesMerged?` (${duplicatesMerged} duplicata mesclada)`:''}`});
    // Dispara enriquecimento automático imediato (não espera o watchdog de 30min)
    if(typeof _autoEnrichCycle === "function"){
      setTimeout(()=>_autoEnrichCycle().catch(e=>console.error("[auto-enrich] trigger upload erro:",e.message)), 3000);
      console.log(`[auto-enrich] 🔔 Enriquecimento de "${safeKey}" agendado em 3s`);
    }
    // 🎯 Se essa é a planilha de Julho 2026 e já existem grupos oficiais
    // importados, aplica na hora — não precisa esperar a próxima importação.
    if(safeKey==="jul2026" && typeof j26ApplyGroupsToSheet==="function"){
      const r = j26ApplyGroupsToSheet();
      if(r.applied>0) console.log(`[grupos-j26] ✅ ${r.applied} grupo(s) já existente(s) aplicado(s) na planilha recém-publicada.`);
    }
    return json(res,200,{ok:true,key:safeKey,count:valid.length,total:vagas.length,duplicatesMerged});
  }

  // DELETE /api/admin/sheet/:key — remove planilha extra
  if(pathname.startsWith("/api/admin/sheet/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=pathname.split("/").pop();
    if(!SHEET_EXTRAS[key])return json(res,404,{error:"Planilha não encontrada"});
    delete SHEET_EXTRAS[key];
    const meta=DB_SHEETS_META[key];
    if(meta?.file){try{fs.unlinkSync(path.join(SHEETS_DIR,meta.file));}catch{}}
    delete DB_SHEETS_META[key];
    fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
    return json(res,200,{ok:true});
  }

  // POST /api/admin/sheet/test-publish-jan — TESTE do dono (07/07/2026): clona
  // a planilha de Jan 2026 (vagas reais já enriquecidas) e publica com a chave
  // "jul2026-teste", só pra validar que o fluxo de "planilha nova aparece pro
  // usuário no Manual e no Automático" funciona de ponta a ponta — sem
  // precisar esperar a coleta real de Julho. Some quando o admin apagar pelo
  // DELETE /api/admin/sheet/:key que já existe (mesmo botão "Excluir" de
  // qualquer planilha extra em Planilhas & Coleta DOL).
  if(pathname==="/api/admin/sheet/test-publish-jan"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    if(!SHEET_JAN.length)return json(res,400,{error:"Planilha de Jan 2026 está vazia — nada pra clonar."});
    const testKey="jul2026-teste";
    const clone=SHEET_JAN.map(r=>({...r,_sheet:testKey}));
    try{
      if(!fs.existsSync(SHEETS_DIR))fs.mkdirSync(SHEETS_DIR,{recursive:true});
      const fname=`${testKey}.json`;
      fs.writeFileSync(path.join(SHEETS_DIR,fname),JSON.stringify(clone));
      SHEET_EXTRAS[testKey]=clone;
      DB_SHEETS_META[testKey]={
        name:"🧪 TESTE — Jul 2026 (cópia de Jan 2026)", file:fname,
        uploaded:Date.now(), count:clone.length, enriched:clone.filter(r=>r.ci).length,
        published:true, publishedAt:Date.now(), visaType:"H-2B", isTest:true,
      };
      fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
      console.log(`[test] 🧪 Planilha de teste "${testKey}" publicada (${clone.length} vagas, cópia de Jan 2026)`);
      return json(res,200,{ok:true,key:testKey,count:clone.length});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  📜 LOGS UNIFICADOS DE TODOS OS ROBÔS — pedido do dono (07/07/2026):
  //  "preciso de logs inteligentes pra eu visualizar" — 1 feed só, todo robô
  //  do sistema, filtrável, pra saber o que cada um fez e quando.
  // ══════════════════════════════════════════════════════════════════════
  const BOT_REGISTRY = [
    {id:'enrich',        label:'Enriquecimento de Planilha', desc:'Completa e-mail/telefone/cidade/salário de vagas já coletadas, por ETA case number.'},
    {id:'grupos-jul2026',label:'Grupos — Julho 2026',        desc:'Grupo A–H só de Julho 2026, só do relatório oficial do DOL (upload manual ou download automático) — nunca adivinhado.'},
    {id:'dol-news-watch', label:'Vigia de Anúncios DOL',      desc:'Checa dol.gov/agencies/eta/foreign-labor/news a cada 10min. Anúncio novo = e-mail pra todos os admins na hora.'},
    {id:'robot-teste',   label:'Robô de Teste',               desc:'Simula um usuário real (QA) e limpa os dados de teste no final.'},
    {id:'robo-auditoria',label:'Robô de Auditoria',           desc:'Coleta dados do sistema e manda pro Gemini analisar — só lê, nunca altera.'},
    {id:'sentinel',      label:'Health Sentinel',             desc:'Detecta VIP com robô parado, VIP expirando, planilha desatualizada — notifica sozinho.'},
    {id:'token-guardian',label:'Token Guardian',              desc:'Renova o token do Gmail de cada usuário ativo a cada 10min, antes que expire.'},
    {id:'auth-watchdog', label:'Auth Error Watchdog',         desc:'Avisa usuário cujo robô parou por erro de autenticação há mais de 12h.'},
  ];

  // GET /api/admin/bots/logs — feed unificado (opcional ?bot=chave, ?limit=)
  if(pathname==="/api/admin/bots/logs"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const botFilter=(u.searchParams.get("bot")||"").trim();
    const limit=Math.min(500,Math.max(1,parseInt(u.searchParams.get("limit")||"200",10)));
    let logs=DB_BOT_LOGS;
    if(botFilter) logs=logs.filter(l=>l.bot===botFilter);
    // Conta por robô (pro filtro em chips na tela, com número)
    const counts={};
    for(const l of DB_BOT_LOGS){ counts[l.bot]=(counts[l.bot]||0)+1; }
    return json(res,200,{ok:true, bots:BOT_REGISTRY, counts, logs:logs.slice(0,limit)});
  }

  // POST /api/admin/bots/log-run — robôs client-driven (Robô de Teste, Robô
  // de Auditoria) reportam um resumo da rodada aqui quando terminam.
  if(pathname==="/api/admin/bots/log-run"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      const bot=String(d.bot||"").slice(0,40);
      const known=BOT_REGISTRY.find(b=>b.id===bot);
      if(!known) return json(res,400,{error:"Robô desconhecido: "+bot});
      botLog(bot, known.label, String(d.msg||"").slice(0,400), ["info","ok","warn","error"].includes(d.type)?d.type:"info");
      return json(res,200,{ok:true});
    }catch(e){ return json(res,400,{error:"Corpo inválido: "+e.message}); }
  }


  // ══════════════════════════════════════════════════════════════════════
  //  🎯 GRUPOS — JULHO 2026 — rotas admin
  // ══════════════════════════════════════════════════════════════════════

  // GET /api/admin/grupos-j26/status — visão geral + distribuição + histórico
  if(pathname==="/api/admin/grupos-j26/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const entries = Object.entries(DB_GRUPOS_J26.mapa);
    const byGrupo = {};
    for(const [,v] of entries) byGrupo[v.grupo]=(byGrupo[v.grupo]||0)+1;
    const manuais = entries.filter(([,v])=>v.manual).length;
    return json(res,200,{ok:true,
      season: GRUPOS_J26_SEASON,
      total: entries.length,
      byGrupo, manuais,
      meta: DB_GRUPOS_J26.meta,
    });
  }

  // GET /api/admin/grupos-j26/lookup?cn=H-400-... — consulta 1 case number
  if(pathname==="/api/admin/grupos-j26/lookup"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const cn=(u.searchParams.get("cn")||"").toUpperCase().trim();
    if(!cn) return json(res,400,{error:"Informe ?cn="});
    const c=DB_GRUPOS_J26.mapa[cn];
    if(!c) return json(res,404,{error:"Case number não está no mapa de grupos de Julho 2026 (relatório oficial ainda não importado ou vaga fora da temporada)."});
    return json(res,200,{ok:true,cn,...c});
  }

  // POST /api/admin/grupos-j26/upload — {csv:"..."} OU {xlsxBase64:"...", filename}
  if(pathname==="/api/admin/grupos-j26/upload"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      let rows;
      let filename = String(d.filename||"upload").slice(0,120);
      if(d.xlsxBase64){
        let buf;
        try{ buf=Buffer.from(d.xlsxBase64,"base64"); }
        catch(e){ return json(res,400,{error:"Base64 inválido."}); }
        try{ rows = xlsxBufferToRows(buf); }
        catch(e){ grupoJ26Log(`❌ Falha ao ler .xlsx enviado (${filename}): ${e.message}`,'error'); return json(res,400,{error:"Falha ao ler o .xlsx: "+e.message}); }
      } else if(typeof d.csv==="string" && d.csv.trim()){
        rows = csvTextToRows(d.csv);
      } else {
        return json(res,400,{error:"Envie 'csv' (texto) ou 'xlsxBase64' (arquivo .xlsx em base64)."});
      }
      const parsed = j26ParseReportRows(rows);
      if(!parsed.ok){
        grupoJ26Log(`❌ Upload manual (${filename}) rejeitado: ${parsed.error}`,'error');
        return json(res,400,{error:parsed.error});
      }
      if(!parsed.accepted.length){
        grupoJ26Log(`⚠️ Upload manual (${filename}): 0 linhas aceitas de ${parsed.totalLinhas} no arquivo (todas rejeitadas — confira se é mesmo o relatório de Julho 2026).`,'warn');
        return json(res,200,{ok:true,novos:0,atualizados:0,rejeitados:parsed.totalLinhas,detalhe:"Nenhuma linha aceita — confira se o arquivo é do período certo."});
      }
      const entry = j26ImportRows(parsed, 'upload-manual', filename);
      return json(res,200,{ok:true,...entry});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/grupos-j26/check-now — força checagem imediata no site do DOL
  if(pathname==="/api/admin/grupos-j26/check-now"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    grupoJ26Log(`🔍 Checagem manual disparada por ${s.user_email}...`,'info');
    const r = await j26CheckDolNewsAndImport();
    return json(res,200,{ok:true,result:r});
  }

  // POST /api/admin/grupos-j26/toggle-auto — liga/desliga a checagem automática
  if(pathname==="/api/admin/grupos-j26/toggle-auto"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      DB_GRUPOS_J26.meta.autoCheckEnabled = !!d.enabled;
      persistGruposJ26();
      grupoJ26Log(`Checagem automática ${d.enabled?'LIGADA':'PAUSADA'} por ${s.user_email}`,'info');
      return json(res,200,{ok:true,enabled:DB_GRUPOS_J26.meta.autoCheckEnabled});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/grupos-j26/set-manual — força grupo de 1 case (protegido contra reimportação)
  if(pathname==="/api/admin/grupos-j26/set-manual"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      const cn=String(d.cn||"").toUpperCase().trim();
      const grupo=String(d.grupo||"").toUpperCase().trim().slice(0,1);
      if(!cn) return json(res,400,{error:"cn obrigatório"});
      if(!/^[A-H]$/.test(grupo)) return json(res,400,{error:"grupo deve ser uma letra de A a H"});
      const cur = DB_GRUPOS_J26.mapa[cn] || {empresa:"",estado:"",status:""};
      DB_GRUPOS_J26.mapa[cn] = { ...cur, grupo, manual:true, importadoEm:Date.now(), fonte:'manual-admin' };
      persistGruposJ26();
      grupoJ26Log(`✏️ Grupo de ${cn} definido manualmente para ${grupo} por ${s.user_email} (protegido — reimportação não sobrescreve)`,'info');
      return json(res,200,{ok:true,cn,grupo});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/grupos-j26/clear-manual — remove a trava manual (volta a aceitar reimportação)
  if(pathname==="/api/admin/grupos-j26/clear-manual"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      const cn=String(d.cn||"").toUpperCase().trim();
      const cur = DB_GRUPOS_J26.mapa[cn];
      if(!cur) return json(res,404,{error:"Case number não encontrado."});
      cur.manual=false;
      persistGruposJ26();
      grupoJ26Log(`🔓 Trava manual removida de ${cn} por ${s.user_email}`,'info');
      return json(res,200,{ok:true});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/grupos-j26/delete-case — remove 1 entrada do mapa
  if(pathname==="/api/admin/grupos-j26/delete-case"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      const cn=String(d.cn||"").toUpperCase().trim();
      if(!DB_GRUPOS_J26.mapa[cn]) return json(res,404,{error:"Case number não encontrado."});
      delete DB_GRUPOS_J26.mapa[cn];
      persistGruposJ26();
      grupoJ26Log(`🗑️ ${cn} removido do mapa por ${s.user_email}`,'info');
      return json(res,200,{ok:true});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/grupos-j26/reset — apaga TUDO (confirmação no front)
  if(pathname==="/api/admin/grupos-j26/reset"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const totalAntes = Object.keys(DB_GRUPOS_J26.mapa).length;
    DB_GRUPOS_J26.mapa = {};
    DB_GRUPOS_J26.meta.ultimaImportacao = null;
    DB_GRUPOS_J26.meta.historicoImportacoes = [];
    DB_GRUPOS_J26.meta.urlJaImportada = null;
    DB_GRUPOS_J26.meta.ultimoResultadoAuto = null;
    persistGruposJ26();
    grupoJ26Log(`🔁 RESET completo por ${s.user_email} — ${totalAntes} case(s) apagado(s). Pronto pra recomeçar do zero.`,'warn');
    return json(res,200,{ok:true,apagados:totalAntes});
  }

  // GET /api/admin/grupos-j26/export — mapa completo (backup/auditoria)
  if(pathname==="/api/admin/grupos-j26/export"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    return json(res,200,{ok:true,season:GRUPOS_J26_SEASON,exportedAt:Date.now(),mapa:DB_GRUPOS_J26.mapa});
  }

  // POST /api/admin/sheet/seed-jul2026 — força a semeadura da planilha
  // Julho 2026 a partir do jul2026_compact.json bundled, mesmo que já
  // exista uma entrada (zoada ou não) no registro. Botão de segurança pra
  // não depender só do boot funcionar direito (KB-086).
  if(pathname==="/api/admin/sheet/seed-jul2026"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const r = seedJul2026FromBundle(true);
    if(!r.ok) return json(res,400,{error:r.reason||"Falha ao semear"});
    return json(res,200,{ok:true, count:r.count, novosGrupos:r.novosGrupos, skipped:r.skipped});
  }

  // GET /api/admin/grupos-j26/list — lista paginada (pra tela de admin)
  if(pathname==="/api/admin/grupos-j26/list"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const skip=Math.max(0,parseInt(u.searchParams.get("skip")||"0",10));
    const top=Math.min(200,Math.max(1,parseInt(u.searchParams.get("top")||"50",10)));
    const filterGrupo=(u.searchParams.get("grupo")||"").toUpperCase().slice(0,1);
    const q=(u.searchParams.get("q")||"").toUpperCase().trim();
    let list = Object.entries(DB_GRUPOS_J26.mapa).map(([cn,v])=>({cn,...v}));
    if(filterGrupo) list=list.filter(x=>x.grupo===filterGrupo);
    if(q) list=list.filter(x=>x.cn.includes(q)||String(x.empresa||"").toUpperCase().includes(q));
    list.sort((a,b)=>b.importadoEm-a.importadoEm);
    return json(res,200,{ok:true,total:list.length,items:list.slice(skip,skip+top)});
  }

  // ══════════════════════════════════════════════════════════════════════
  //  📰 VIGIA DE ANÚNCIOS — DOL NEWS — rotas admin
  // ══════════════════════════════════════════════════════════════════════

  // GET /api/admin/dol-news-watch/status
  if(pathname==="/api/admin/dol-news-watch/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    return json(res,200,{ok:true, ...DB_DOL_NEWS_WATCH, url:DOL_NEWS_URL, admins:getAllAdminEmails()});
  }

  // POST /api/admin/dol-news-watch/check-now
  if(pathname==="/api/admin/dol-news-watch/check-now"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    dolNewsLog(`🔍 Checagem manual disparada por ${s.user_email}...`,'info');
    const r = await dolNewsCheckNow();
    return json(res,200,{ok:true,result:r});
  }

  // POST /api/admin/dol-news-watch/toggle-auto
  if(pathname==="/api/admin/dol-news-watch/toggle-auto"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      DB_DOL_NEWS_WATCH.autoCheckEnabled=!!d.enabled;
      persistDolNewsWatch();
      dolNewsLog(`Vigia ${d.enabled?'LIGADO':'PAUSADO'} por ${s.user_email}`,'info');
      return json(res,200,{ok:true,enabled:DB_DOL_NEWS_WATCH.autoCheckEnabled});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/dol-news-watch/set-baseline — corrige manualmente o
  // "último anúncio conhecido" (usado se a extração automática errar).
  if(pathname==="/api/admin/dol-news-watch/set-baseline"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{
      const d=JSON.parse(await readBody(req));
      const date=String(d.date||"").trim();
      const title=String(d.title||"").trim().slice(0,300);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res,400,{error:"Data deve estar em formato AAAA-MM-DD."});
      if(!title) return json(res,400,{error:"Título obrigatório."});
      DB_DOL_NEWS_WATCH.ultimaConhecida = { date, title, detectadaEm:Date.now(), origem:'manual-admin' };
      persistDolNewsWatch();
      dolNewsLog(`✏️ Baseline ajustado manualmente por ${s.user_email}: "${date}" — "${title}"`,'info');
      return json(res,200,{ok:true});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // POST /api/admin/dol-news-watch/send-test-email — confirma que o envio
  // de verdade funciona, sem esperar uma publicação nova de verdade.
  if(pathname==="/api/admin/dol-news-watch/send-test-email"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const r = await sendAdminAlertEmail(
      "✅ Teste — Vigia de Anúncios DOL",
      `Isto é um e-mail de teste do Vigia de Anúncios DOL do H2BApply.\n\nSe você recebeu isto, o envio está funcionando — quando o DOL publicar um anúncio novo de verdade, o aviso vai chegar exatamente assim.\n\n🔗 Página vigiada: ${DOL_NEWS_URL}\n\n— H2BApply 🤖`
    );
    return json(res,200,{ok:r.ok, enviados:r.enviados, falhas:r.falhas});
  }

  // POST /api/admin/dol-news-watch/gemini-analyze — pedido do dono (08/07/2026):
  // botão que manda o erro real (status HTTP, headers de resposta, pedaço do
  // corpo, log recente do bot) pro Gemini analisar e explicar o que fazer.
  if(pathname==="/api/admin/dol-news-watch/gemini-analyze"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    if(!getGeminiKey())return json(res,503,{error:"Gemini API não configurada (GEMINI_API_KEY) neste servidor."});
    try{
      const logsRecentes = DB_BOT_LOGS.filter(l=>l.bot==='dol-news-watch').slice(0,25)
        .map(l=>`[${new Date(l.ts).toLocaleString('pt-BR')}] ${l.type.toUpperCase()}: ${l.msg}`).join("\n");
      const det = DB_DOL_NEWS_WATCH.ultimoErroDetalhe;
      const systemPrompt = `Você é um engenheiro backend Node.js sênior, especialista em scraping/HTTP e em bloqueios de WAF (Akamai, Cloudflare, F5) de sites governamentais dos EUA (.gov). Um robô Node.js está tentando fazer um GET simples (https.request nativo do Node, sem headless browser) na URL https://www.dol.gov/agencies/eta/foreign-labor/news a cada 10 minutos, só pra ler o HTML e achar o anúncio mais recente. Ele está recebendo erro. Analise o que foi capturado abaixo e produza um relatório em português do Brasil, direto e prático, estruturado assim:

1. DIAGNÓSTICO (o que provavelmente está causando isso, com base no status HTTP e nos headers de resposta — ex.: WAF/bot-detection, rate limit, geo-block, TLS fingerprint, User-Agent, falta de headers de navegador, etc.)
2. É CONTORNÁVEL A PARTIR DE UM SERVIDOR NODE.JS PURO? (seja honesto — se for um bloqueio de fingerprint TLS/JA3 que exige browser real, diga isso claramente, não invente solução que não existe)
3. O QUE TENTAR PRIMEIRO (passos concretos e realistas, em ordem)
4. SE NADA FUNCIONAR — ALTERNATIVA (ex.: usar um serviço de proxy/browser headless tipo Browserless/ScrapingBee, ou trocar a estratégia pra um RSS/API oficial se existir, ou avisar o admin pra checar manualmente)
5. NOTA DE CONFIANÇA (0-10) de que esse tipo de bloqueio é contornável só com ajuste de código.

Seja honesto — não prometa que qualquer ajuste de header vai resolver se os sinais (ex: bloqueio mesmo com headers de navegador completos) sugerem um bloqueio mais sério.`;
      const contextText = `STATUS HTTP recebido: ${det?.status ?? '(não registrado)'}
HEADERS de resposta do servidor:
${det?.headers ? JSON.stringify(det.headers, null, 2) : '(não capturado)'}

PRIMEIROS ~800 CARACTERES DO CORPO DA RESPOSTA:
${det?.corpoAmostra || '(vazio ou não capturado)'}

ÚLTIMO RESULTADO: ${DB_DOL_NEWS_WATCH.ultimoResultado || '?'}
ÚLTIMO ERRO: ${DB_DOL_NEWS_WATCH.ultimoErro || '?'}

LOG RECENTE DO ROBÔ (mais novo primeiro):
${logsRecentes || '(sem logs ainda)'}

HEADERS QUE O ROBÔ ENVIOU NA REQUISIÇÃO:
User-Agent: Chrome 124 desktop (Windows)
Accept, Accept-Language, Accept-Encoding: identity, Sec-Fetch-*, Referer — conjunto completo estilo navegador real (não é só User-Agent sozinho)`;
      const GEMINI_MODELS=["gemini-2.5-flash","gemini-2.0-flash","gemini-2.5-flash-lite"];
      let text="", lastErr="";
      for(const modelName of GEMINI_MODELS){
        try{
          const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiKey()}`;
          const payload={system_instruction:{parts:[{text:systemPrompt}]},contents:[{role:"user",parts:[{text:contextText}]}],generationConfig:{temperature:0.4,maxOutputTokens:2000,topP:0.95}};
          const result = await new Promise((resolve,reject)=>{
            const body=JSON.stringify(payload); const gurl=new URL(geminiUrl);
            const opts={hostname:gurl.hostname,path:gurl.pathname+gurl.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
            const req2=https.request(opts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida do Gemini"));}});});
            req2.on("error",reject); req2.setTimeout(40000,()=>{req2.destroy();reject(new Error("Timeout"));});
            req2.write(body); req2.end();
          });
          if(result.status===200){ text=result.body?.candidates?.[0]?.content?.parts?.[0]?.text||""; if(text){ console.log(`[dol-news-watch] ✅ Análise Gemini via ${modelName}`); break; } }
          else{ lastErr = result.body?.error?.message || `HTTP ${result.status}`; }
        }catch(e){ lastErr=e.message; }
      }
      if(!text){ dolNewsLog(`❌ Análise Gemini falhou: ${lastErr}`,'error'); return json(res,502,{error:"Erro na análise: "+lastErr}); }
      dolNewsLog(`🤖 Análise Gemini gerada por ${s.user_email} (${text.length} caracteres)`,'info');
      return json(res,200,{ok:true,report:text,generatedAt:new Date().toISOString()});
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // GET /api/admin/enrich/status — status do bot em tempo real
  if(pathname==="/api/admin/enrich/status"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const b=_enrichBot;
    const elapsed = b.startedAt ? Math.round((Date.now()-b.startedAt)/1000) : 0;
    const ratePerSec = elapsed>0 ? (b.done/elapsed).toFixed(1) : 0;
    const remaining = b.total-b.done;
    const etaSec = ratePerSec>0 ? Math.round(remaining/ratePerSec) : null;
    return json(res,200,{
      ok:true, running:b.running, sheetKey:b.sheetKey,
      total:b.total, done:b.done, ok:b.ok,
      noEmail:b.noEmail, errors:b.errors,
      pct:b.total>0?Math.round((b.done/b.total)*100):0,
      elapsed, ratePerSec, etaSec,
      savedAt:b.savedAt,
      log: b.log.slice(-50), // últimas 50 linhas
    });
  }

  // POST /api/admin/enrich/start — iniciar bot
  if(pathname==="/api/admin/enrich/start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    let _eb={sheetKey:"jan2026",resume:false};
    try{const _d=JSON.parse(await readBody(req));_eb.sheetKey=_d.sheetKey||"jan2026";_eb.resume=!!_d.resume;}catch{}
    const {sheetKey,resume}=_eb;
    if(_enrichBot.running) return json(res,409,{error:"Bot já está rodando. Aguarde ou pare primeiro."});
    // Validar sheetKey
    const validSheets=["jan2026","jul2025",...Object.keys(SHEET_EXTRAS)];
    if(!validSheets.includes(sheetKey)) return json(res,400,{error:`Planilha "${sheetKey}" não encontrada. Disponíveis: ${validSheets.join(", ")}`});
    const sheetArr = sheetKey==="jan2026"?SHEET_JAN:sheetKey==="jul2025"?SHEET_JUL:SHEET_EXTRAS[sheetKey];
    if(!sheetArr||!sheetArr.length) return json(res,400,{error:"Planilha vazia ou não carregada"});
    json(res,200,{ok:true,message:`Bot iniciado para "${sheetKey}" (${sheetArr.length} vagas)`,total:sheetArr.length});
    _runEnrichBot(sheetKey, resume).catch(e=>_enrichLog("Erro fatal: "+e.message,"error"));
    return;
  }

  // POST /api/admin/enrich/stop — parar bot
  if(pathname==="/api/admin/enrich/stop"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    try{await readBody(req);}catch{} // consumir body
    _enrichBot.running=false;
    _enrichLog("⏹️ Bot parado pelo admin","warn");
    return json(res,200,{ok:true,message:"Bot parado"});
  }

  // POST /api/admin/sheet/enrich/:key — redireciona para o bot central
  if(pathname.startsWith("/api/admin/sheet/enrich/")&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=pathname.split("/").pop();
    if(_enrichBot.running) return json(res,409,{error:"Bot já está rodando. Use /api/admin/enrich/stop para parar."});
    const sheet = key==="jan2026"?SHEET_JAN:key==="jul2025"?SHEET_JUL:SHEET_EXTRAS[key];
    if(!sheet)return json(res,404,{error:"Planilha não encontrada"});
    try{await readBody(req);}catch{} // consumir body
    json(res,200,{ok:true,message:`Enriquecimento de ${sheet.length} vagas iniciado`});
    _runEnrichBot(key,false).catch(e=>_enrichLog("Erro: "+e.message,"error"));
    return;
  }

    // GET /api/admin/sheet/download/:key — baixar planilha enriquecida como JSON
  if(pathname.startsWith("/api/admin/sheet/download/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=decodeURIComponent(pathname.split("/").pop());
    const sheet=key==="jan2026"?SHEET_JAN:key==="jul2025"?SHEET_JUL:SHEET_EXTRAS[key];
    if(!sheet)return json(res,404,{error:"Planilha não encontrada"});
    const fname=`${key}_enriquecida_${new Date().toISOString().slice(0,10)}.json`;
    res.writeHead(200,{
      "Content-Type":"application/json; charset=utf-8",
      "Content-Disposition":`attachment; filename="${fname}"`,
      "Cache-Control":"no-cache",
    });
    return res.end(JSON.stringify(sheet,null,2));
  }

  // GET /api/admin/sheet/stats/:key — estatísticas da planilha
  if(pathname.startsWith("/api/admin/sheet/stats/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const key=pathname.split("/").pop();
    const sheet=key==="jan2026"?SHEET_JAN:key==="jul2025"?SHEET_JUL:SHEET_EXTRAS[key];
    if(!sheet)return json(res,404,{error:"Planilha não encontrada"});
    const cats={};sheet.forEach(r=>{const c=r.k||"other";cats[c]=(cats[c]||0)+1;});
    const states={};sheet.forEach(r=>{const c=r.s||"?";states[c]=(states[c]||0)+1;});
    const comCity=sheet.filter(r=>r.ci).length;
    const comDesc=sheet.filter(r=>r.desc).length;
    return json(res,200,{ok:true,key,
      total:sheet.length,comEmail:sheet.filter(r=>r.e).length,comCity,comDesc,
      categorias:Object.entries(cats).sort((a,b)=>b[1]-a[1]),
      estados:Object.entries(states).sort((a,b)=>b[1]-a[1]).slice(0,10),
      meta:DB_SHEETS_META[key]||null,
    });
  }

  // ── API: Email Intelligence (bounces globais) ──────────
  if(pathname==="/api/admin/email-intelligence"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const invalids = Object.values(DB_INVALID_EMAILS).map(e=>({
      ...e, users: [...(e.users instanceof Set ? e.users : new Set(e.users||[]))]
    })).sort((a,b)=>b.count-a.count);
    const corrections = Object.values(DB_EMAIL_CORRECTIONS).sort((a,b)=>b.count-a.count);
    const tempFails   = Object.values(DB_TEMP_FAILURES).sort((a,b)=>b.count-a.count).slice(0,50);
    // Domínios com mais erros
    const byDomain={};
    invalids.forEach(e=>{ byDomain[e.domain]=(byDomain[e.domain]||0)+1; });
    const topDomains=Object.entries(byDomain).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([d,c])=>({domain:d,count:c}));
    return json(res,200,{
      ok:true,
      totalInvalid:invalids.length,
      totalCorrections:corrections.length,
      totalTemp:Object.keys(DB_TEMP_FAILURES).length,
      invalids: invalids.slice(0,200),
      corrections: corrections.slice(0,100),
      tempFails,
      topDomains,
      lastUpdated: Date.now()
    });
  }

  // Marcar email como inválido manualmente
  if(pathname==="/api/admin/email-intelligence/mark-invalid"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const {email,motivo}=body;if(!email)return json(res,400,{error:"email obrigatório"});
    const now=Date.now();
    DB_INVALID_EMAILS[email.toLowerCase()]={
      email:email.toLowerCase(),domain:email.split('@')[1]||'',
      motivo:motivo||'Marcado manualmente pelo admin',tipo:'manual',
      first:now,last:now,count:1,users:new Set(['admin']),msg:'Manual',status:'invalid'
    };
    const toSave={};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){toSave[k]={...v,users:[...(v.users instanceof Set?v.users:new Set(v.users||[]))]}}
    try{fs.writeFileSync(INVALID_EMAILS_FILE,JSON.stringify(toSave,null,2));}catch{}
    return json(res,200,{ok:true});
  }

  // Remover email da lista negra
  if(pathname.startsWith("/api/admin/email-intelligence/remove/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const email=decodeURIComponent(pathname.split('/').pop());
    delete DB_INVALID_EMAILS[email];
    const toSave={};
    for(const [k,v] of Object.entries(DB_INVALID_EMAILS)){toSave[k]={...v,users:[...(v.users instanceof Set?v.users:new Set(v.users||[]))]}}
    try{fs.writeFileSync(INVALID_EMAILS_FILE,JSON.stringify(toSave,null,2));}catch{}
    return json(res,200,{ok:true});
  }

  // ── PWA: manifest, service worker e ícones ────────────
  if(pathname==="/manifest.json"){
    return sendAsset(req,res,"manifest.json","application/manifest+json","public, max-age=86400"); // V951
  }
  if(pathname==="/sw.js"){
    // V951: ETag faz o update-check do SW virar 304; Service-Worker-Allowed preservado
    let a;try{a=getStaticAsset("sw.js");}catch{res.writeHead(404);return res.end("sw.js não encontrado");}
    if(req.headers["if-none-match"]===a.etag){res.writeHead(304,{ETag:a.etag,"Service-Worker-Allowed":"/","Cache-Control":"no-cache, must-revalidate",Vary:"Accept-Encoding"});return res.end();}
    const ae=String(req.headers["accept-encoding"]||"");
    const h={"Content-Type":"application/javascript","Cache-Control":"no-cache, must-revalidate","Service-Worker-Allowed":"/",ETag:a.etag,Vary:"Accept-Encoding"};
    let body=a.raw;
    if(/\bbr\b/.test(ae)){h["Content-Encoding"]="br";body=a.br;}
    else if(/\bgzip\b/.test(ae)){h["Content-Encoding"]="gzip";body=a.gz;}
    h["Content-Length"]=body.length;
    res.writeHead(200,h);return res.end(body);
  }
  // 🔧 FIX CRÍTICO (03/07): extras nunca eram servidos (404) — blindagem não carregava
  if(pathname==="/h2b-extras-user.js"||pathname==="/h2b-extras-admin.js"){
    return sendAsset(req,res,pathname.slice(1),"application/javascript; charset=utf-8","no-cache, must-revalidate"); // V951
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
  // Print real do aviso do Google — usado no modal educativo pré-login
  if(pathname==="/google-aviso.jpg"){
    try{const img=fs.readFileSync(path.join(__dirname,"google-aviso.jpg"));res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public, max-age=604800"});return res.end(img);}catch{res.writeHead(404);return res.end();}
  }
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

  // ── /api/sheets-list — planilhas disponíveis para o usuário (fixas + extras publicadas) ──
  if(pathname==="/api/sheets-list"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    // DISPONIBILIDADE POR USUÁRIO (2026-07-09): antes cada fonte mostrava só o
    // total bruto da planilha ("2.625 vagas") mesmo que o usuário já tivesse
    // enviado pra metade delas — dava a impressão de que nada era descontado.
    // Agora cada planilha informa também quantas ainda estão DISPONÍVEIS pra
    // ESTE usuário (têm e-mail e ele nunca enviou pra aquele empregador) e
    // quantas ele já enviou. Regra de contagem = a MESMA regra anti-duplicata
    // do motor de envio (por e-mail do empregador), então o número que o
    // usuário vê é o número que de fato vai pra fila.
    const _sentSet = buildUserSentSet(s.user_email);
    const _avail = (rows) => {
      let withEmail=0, sent=0;
      for(const r of rows){ const e=_normEmail(r.e); if(!e||!e.includes("@"))continue; withEmail++; if(_sentSet.has(e))sent++; }
      return {withEmail, sent, available: withEmail-sent};
    };
    const _mk=(key,name,visa,emoji)=>{const rows=getSheet(key)||[];return {key,name,visa,count:rows.length,builtin:true,emoji,..._avail(rows)};};
    const out=[
      _mk("jan2026","Jan 2026","H-2B","☀️"),
      _mk("jul2025","Jul 2025","H-2B","❄️"),
      _mk("h2a-jun2026","H-2A Agricultura","H-2A","🌾"),
    ];
    for(const [k,meta] of Object.entries(DB_SHEETS_META)){
      if(k==="jan2026"||k==="jul2025") continue;
      if(!meta || meta.published!==true) continue;
      const arr=SHEET_EXTRAS[k]||[];
      if(!arr.length) continue;
      const visa=(meta.visaType||arr[0]?.visa||"H-2B").toUpperCase().includes("H-2A")?"H-2A":"H-2B";
      out.push({key:k,name:meta.name||k,visa,count:arr.length,builtin:false,emoji:meta.emoji||(visa==="H-2A"?"🌾":"📋"),historico:meta.historico===true,..._avail(arr)});
    }
    return json(res,200,{ok:true,sheets:out});
  }

  // ── /api/my-availability?sheet=X ─────────────────────────
  // Disponibilidade da planilha PARA ESTE USUÁRIO, por categoria — alimenta
  // os chips do wizard do automático (antes mostravam totais globais).
  if(pathname==="/api/my-availability"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sheet=(u.searchParams.get("sheet")||"").trim();
    const rows=getSheet(sheet)||[];
    const _sentSet=buildUserSentSet(s.user_email);
    let withEmail=0, sent=0;
    const byCategory={};
    for(const r of rows){
      const e=_normEmail(r.e);
      if(!e||!e.includes("@")) continue;
      withEmail++;
      if(_sentSet.has(e)){ sent++; continue; }
      const cat=r.k||"other";
      byCategory[cat]=(byCategory[cat]||0)+1;
    }
    return json(res,200,{ok:true,sheet,total:rows.length,withEmail,sent,available:withEmail-sent,byCategory});
  }

  // ── /api/jobs ─────────────────────────────────────────
  if(pathname==="/api/jobs"){
    const opts={query:(u.searchParams.get("q")||"").trim(),state:(u.searchParams.get("state")||"").trim(),jobType:(u.searchParams.get("jobType")||"all"),jobStatus:(u.searchParams.get("jobStatus")||"all"),beginDate:(u.searchParams.get("beginDate")||""),sort:(u.searchParams.get("sort")||"desc")};
    const _minWageJobs=parseFloat(u.searchParams.get("minWage")||"0")||0;
    const skip=Math.max(0,parseInt(u.searchParams.get("skip")||"0",10));const top=Math.min(50,Math.max(1,parseInt(u.searchParams.get("top")||"25",10)));
    if(Date.now()-lastFetch>CACHE_TTL)refreshCache().catch(()=>{});
    try{const{jobs,total}=await fetchDOL(skip,top,opts);return json(res,200,{jobs,total,skip,from_cache:false});}
    catch(e){
      // DOL offline → planilha local como fallback principal
      const _shRows=getAllSheets().filter(r=>r.e&&r.e.includes("@"));
      // FIX: usar todos os campos enriquecidos (ci, de, ph, desc, url) — não hardcoded
      const _shJobs=_shRows.map(r=>({id:r.c,caseNum:r.c,title:r.t||"Seasonal Worker",company:r.n||"–",city:r.ci||"–",state:r.s||"–",wage:r.w?`$${r.w}/${r.wunit||"h"}`:"–",workers:r.wk||null,start:r.d||"–",end:r.de||"–",email:r.e,phone:r.ph||"",phone2:r.ph2||"",url:r.c&&r.c.startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${r.c}`:"",desc:r.desc||"",soc:r.soc||"",active:true,visa:r.visa||"H-2B",hasEmail:true,category:r.k||"other",fromSheet:true}));
      let src=_shJobs.length?_shJobs:jobsCache.length?[...jobsCache]:[...FALLBACK_JOBS];
      const{query:q,state,jobType,jobStatus,beginDate}=opts;
      if(q){const ql=q.toLowerCase();src=src.filter(j=>(j.title||"").toLowerCase().includes(ql)||(j.company||"").toLowerCase().includes(ql)||(j.state||"").toLowerCase().includes(ql)||(j.city||"").toLowerCase().includes(ql)||(j.desc||"").toLowerCase().includes(ql)||(j.phone||"").includes(ql));}
      if(state)src=src.filter(j=>j.state.toUpperCase()===state.toUpperCase());
      if(jobType==="agricultural")src=src.filter(j=>j.visa==="H-2A");if(jobType==="non-agricultural")src=src.filter(j=>j.visa==="H-2B");
      if(jobStatus==="active")src=src.filter(j=>j.active);if(jobStatus==="inactive")src=src.filter(j=>!j.active);
      if(beginDate)src=src.filter(j=>j.start>=beginDate);
      if(_minWageJobs>0){const _pw=w=>{if(!w)return 0;const m=String(w).replace(/[$,/hrday\s]/gi,"");return parseFloat(m)||0;};src=src.filter(j=>_pw(j.wage)>=_minWageJobs);}
      return json(res,200,{jobs:src.slice(skip,skip+top),total:src.length,skip,from_cache:true});
    }
  }

  // ── Sheet routes com categorias dinâmicas ─────────────
  if(pathname==="/api/sheet-meta"){
    const sheet=u.searchParams.get("sheet")||"";const arr=getSheet(sheet);
    const skip=Math.max(0,parseInt(u.searchParams.get("skip")||"0",10));const top=Math.min(2000,Math.max(1,parseInt(u.searchParams.get("top")||"25",10)));
    const q=(u.searchParams.get("q")||"").trim();const state=(u.searchParams.get("state")||"").trim();const sort=u.searchParams.get("sort")||"random";
    const category=(u.searchParams.get("category")||"").trim();
    const minWage=parseFloat(u.searchParams.get("minWage")||"0")||0;
    const minWorkers=parseInt(u.searchParams.get("minWorkers")||"0")||0;
    const filterVisa=(u.searchParams.get("visa")||"").trim();
    const filterHasEmail=(u.searchParams.get("hasEmail")||"").trim();
    const filterJobStatus=(u.searchParams.get("jobStatus")||"").trim();
    const filterCity=(u.searchParams.get("city")||"").trim().toLowerCase();
    const filterCompany=(u.searchParams.get("company")||"").trim().toLowerCase();
    // DB_SENT has email addresses (not case numbers), so we DON'T filter by caseNum
    // Instead we show all available jobs (sent ones are hidden via HIST in frontend)
    const baseArr=arr; // No server-side sent filtering (would break search)
    const catTitles={landscape:"Landscape Worker",construction:"Construction Worker",
      housekeeper:"Housekeeper",seafood:"Seafood Processor",farm:"Farm Worker",
      golf:"Golf Course Worker",amusement:"Amusement Park Worker",
      forest:"Forestry Worker",lifeguard:"Lifeguard",
      food:"Food Service / Bartender",ski:"Ski Resort Worker",other:"Seasonal Worker"};
    const parseW=w=>{if(!w)return 0;const m=String(w).match(/[0-9.]+/);return m?parseFloat(m[0]):0;};
    // FIX WAGE: aplicar filtros pesados ANTES da paginação para retornar total correto
    let preFiltered=baseArr;
    if(minWage>0) preFiltered=preFiltered.filter(r=>parseW(r.w)>=minWage);
    if(minWorkers>0) preFiltered=preFiltered.filter(r=>(r.wk||0)>=minWorkers);
    if(filterVisa) preFiltered=preFiltered.filter(r=>(r.st||"").toUpperCase().includes(filterVisa));
    if(filterHasEmail==="1") preFiltered=preFiltered.filter(r=>r.e&&r.e.includes("@"));
    if(filterHasEmail==="0") preFiltered=preFiltered.filter(r=>!r.e);
    if(filterJobStatus==="active") preFiltered=preFiltered.filter(r=>{const st=(r.st||"").toUpperCase();return !st.includes("WITHDRAWN")&&!st.includes("DENIED")&&!st.includes("EXPIRED");});
    if(filterJobStatus==="inactive") preFiltered=preFiltered.filter(r=>{const st=(r.st||"").toUpperCase();return st.includes("WITHDRAWN")||st.includes("DENIED")||st.includes("EXPIRED");});
    if(filterCompany) preFiltered=preFiltered.filter(r=>(r.n||"").toLowerCase().includes(filterCompany));
    if(filterCity) preFiltered=preFiltered.filter(r=>(r.ci||"").toLowerCase().includes(filterCity));
    // ── FILTRO POR CARGO EXATO (taxonomia real por título da vaga) ──
    // titles=Cook,Line Cook,__outros__ — vem do modal grande de filtros (todo
    // título de fato existente na planilha, não mais só as ~11 categorias fixas).
    // __outros__ junta todo cargo que aparece 3x ou menos na planilha inteira.
    const filterTitles=(u.searchParams.get("titles")||"").trim();
    if(filterTitles){
      const wantedRaw=filterTitles.split(",").map(t=>t.trim().toLowerCase()).filter(Boolean);
      const wantOutros=wantedRaw.includes("__outros__");
      const wantedSet=new Set(wantedRaw.filter(t=>t!=="__outros__"));
      if(wantedSet.size||wantOutros){
        const freq=new Map();
        for(const r of baseArr){ const t=(r.t||"").trim().toLowerCase(); if(t) freq.set(t,(freq.get(t)||0)+1); }
        preFiltered=preFiltered.filter(r=>{
          const t=(r.t||"").trim().toLowerCase();
          if(!t) return false;
          if(wantedSet.has(t)) return true;
          if(wantOutros && (freq.get(t)||0)<=3) return true;
          return false;
        });
      }
    }
    // ── V953: FILTRO POR MÊS DE INÍCIO — "vagas que começam em setembro" ──
    // O trabalhador sazonal planeja a vida pela data de início (r.d = Begin Date).
    // Aceita lista: beginMonth=6,7,8. Vaga sem data não casa com o filtro.
    const filterBeginMonth=(u.searchParams.get("beginMonth")||"").replace(/[^0-9,]/g,"").trim();
    if(filterBeginMonth){
      const _months=new Set(filterBeginMonth.split(",").map(x=>parseInt(x,10)).filter(m=>m>=1&&m<=12));
      if(_months.size)preFiltered=preFiltered.filter(r=>{
        const m=String(r.d||"").match(/^\d{4}-(\d{2})/);
        return m&&_months.has(parseInt(m[1],10));
      });
    }
    // searchSheet faz q/state/category + paginação no array já pré-filtrado
    const{total,items}=searchSheet(preFiltered,q,state,category,skip,top,sort);
    let filtered=items; // já paginado corretamente
    // total já é o total filtrado (pré-filtro + searchSheet)
    return json(res,200,{jobs:filtered.map(r=>{
      const st=(r.st||"").toUpperCase();
      const visa=(r.visa||"").includes("H-2A")||st.includes("H-2A")?"H-2A":"H-2B";
      const active=!st.includes("WITHDRAWN")&&!st.includes("DENIED")&&!st.includes("EXPIRED")&&!st.includes("INVALIDATED");
      const cat=r.k||"other";
      const occupation=r.t||catTitles[cat]||"Seasonal Worker";
      const emailVal=(r.e||"").toLowerCase().trim();
      return{
        id:r.c, caseNum:r.c,
        company:r.n||"–", state:r.s||"–", city:r.ci||"",
        zip:r.zip||"", addr:r.addr||"",
        start:r.d||"–", end:r.de||"–",
        status:r.st||"–", category:cat, visa, active,
        title:occupation, occupation,
        wage:r.w?`$${r.w}/${r.wunit||"h"}`:null,
        wageRaw:r.w||null, wageMax:r.wmax||null,
        wageInfo:r.winfo||null,
        workers:r.wk||null,
        email:emailVal||null, hasEmail:!!(emailVal&&emailVal.includes("@")),
        phone:r.ph||null, phone2:r.ph2||null,
        website:r.site||null,
        desc:r.desc||null,
        req:r.req||null,
        soc:r.soc||null, socTitle:r.socT||null,
        hours:r.hrs||null, schedule:r.sched||null,
        fullTime:r.ft||null,
        url:r.c&&r.c.startsWith("H-")?`https://seasonaljobs.dol.gov/jobs/${r.c}`:(r.url||null),
        fromSheet:true
      };
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
    const filterCityCount=(u.searchParams.get("city")||"").trim().toLowerCase();
    if(state)filtered=filtered.filter(r=>(r.s||"").toUpperCase()===state);
    if(category&&category!=="all"){const cats=category.split(",").map(c=>c.trim());filtered=filtered.filter(r=>cats.includes(r.k||"other"));}
    if(hasEmail==="yes")filtered=filtered.filter(r=>r.e&&String(r.e).includes("@"));
    if(filterCityCount)filtered=filtered.filter(r=>(r.ci||"").toLowerCase().includes(filterCityCount));
    const total=filtered.length;
    // Parse wage consistente com /api/sheet-meta
    const parseW=w=>{if(!w)return 0;const m=String(w).match(/[0-9.]+/);return m?parseFloat(m[0]):0;};
    const withWage=filtered.filter(r=>parseW(r.w)>=minWage&&parseW(r.w)>0);
    return json(res,200,{total,filtered:minWage>0?withWage.length:total});
  }
  if(pathname==="/api/sheet-categories"){
    const sheet=u.searchParams.get("sheet")||"";
    return json(res,200,{categories:getSheetCategoriesCached(sheet)});
  }
  // GET /api/sheet-titles?sheet=jan2026 — taxonomia real de cargos (todos os
  // títulos que existem de fato na planilha, contados, com "Outros" agrupando
  // os isolados ≤3 ocorrências). Alimenta o modal grande de filtros.
  if(pathname==="/api/sheet-titles"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sheet=(u.searchParams.get("sheet")||"").trim();
    const rows = sheet==="all" ? getAllSheets() : getSheet(sheet);
    return json(res,200,{ok:true,sheet,...buildTitleTaxonomy(rows)});
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
    const totalAuto   = h.filter(x=>x.type==="auto").length;
    const totalManual = h.filter(x=>x.type==="manual").length;
    const totalSent   = totalAuto + totalManual; // respostas NÃO entram aqui
    const todayManual = countManualToday(h);
    const todayAuto   = countAutoToday(h);
    const totalFailed=logs.filter(l=>l.status==="falhou").length;
    const totalDup=logs.filter(l=>l.status==="duplicado").length;
    const byState={};h.forEach(x=>{if(x.state&&x.type!=="reply"){byState[x.state]=(byState[x.state]||0)+1;}});
    const topStates=Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const streak=calcStreak(h);const sentLast7=last7Days(h);
    const autoJob=getAutoJob(s.user_email);
    return json(res,200,{
      totalSent,totalAuto,totalManual,
      todayManual,todayAuto,
      totalFailed,totalDup,
      topStates,streak,sentLast7,
      autoQueueSize: autoJob?.active ? (autoJob.queue||[]).length : 0
    });
  }
  // calcStreak e last7Days agora estão no escopo global (definidas acima do server.listen)

  // ── Ranking: inRankPeriod / calcRanking definidas no escopo global ──

  // ── OAuth ─────────────────────────────────────────────
  if(pathname==="/oauth/start"){if(rateLimit((req.headers["x-forwarded-for"]||"anon")+"_oauth",30,900_000)){res.writeHead(302,{Location:"/?err="+encodeURIComponent("Muitas tentativas de login. Aguarde 15 minutos e tente novamente.")});return res.end();}if(!CONFIGURED){res.writeHead(302,{Location:"/?err="+encodeURIComponent("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.")});return res.end();}const st=crypto.randomBytes(20).toString("hex");
  sessions["__p__"+st]={pending:true,ts:Date.now()};
  // Se o usuário já tem refresh_token salvo, não força consent (login silencioso).
  // Se é a primeira vez (sem refresh_token), exige consent para obter o refresh_token.
  // FIX v2: se usuário não tem scopeVersion>=2 (novos escopos gmail.readonly+modify), força consent
  const _loginHint=(u.searchParams.get("login_hint")||"").trim().toLowerCase();
  const _hintUser=_loginHint?getUser(_loginHint):null;
  const _hasRt=!!(_hintUser?.refresh_token);
  const _hasNewScopes=(_hintUser?.scopeVersion||0)>=2;
  const _promptVal=(_hasRt&&_hasNewScopes)?"select_account":"consent select_account";
  const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:"code",scope:"openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",access_type:"offline",prompt:_promptVal,state:st});res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs});return res.end();}

  if(pathname==="/oauth/callback"){
    const code=u.searchParams.get("code"),error=u.searchParams.get("error");
    const fail=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)});res.end();};
    if(error)return fail(error==="access_denied"?"Login cancelado.":"Erro OAuth: "+error);
    if(!code)return fail("Código OAuth inválido.");
    // [FIX redirect_uri_mismatch] — detecta se é fluxo add-sender pelo state
    const _st=u.searchParams.get("state")||"";
    if(sessions["__sender__"+_st]){
      const fail2=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)+"&tab=profile"});res.end();};
      const pending2=sessions["__sender__"+_st];
      if(Date.now()-pending2.created>600_000){delete sessions["__sender__"+_st];return fail2("Sessão expirada. Tente novamente.");}
      const ownerEmail2=pending2.ownerEmail;
      delete sessions["__sender__"+_st];
      try{
        const tb2=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:REDIRECT_URI,grant_type:"authorization_code"}).toString();
        const{body:tk2}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tb2)}},tb2);
        if(tk2.error)return fail2(tk2.error_description||tk2.error);
        if(!tk2.access_token)return fail2("Token não recebido.");
        const{body:ui2}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tk2.access_token}});
        if(!ui2.email)return fail2("E-mail não obtido.");
        const newEmail2=ui2.email.toLowerCase().trim();
        if(newEmail2===ownerEmail2)return fail2("Este é seu email principal. Adicione um Gmail diferente.");
        if(getUser(newEmail2))return fail2("Este Gmail já tem conta no H2BApply. Use outro email.");
        const owner2=getUser(ownerEmail2)||{};
        const existing2=owner2.senderEmails||[];
        const jaExiste2=existing2.find(s=>s.email===newEmail2);
        if(jaExiste2){
          const renovados2=existing2.map(s=>s.email===newEmail2?{...s,access_token:tk2.access_token,token_expiry:Date.now()+(tk2.expires_in||3600)*1000,refresh_token:tk2.refresh_token||s.refresh_token||null,tokenExpired:false,blocked:false,active:true,reauthedAt:Date.now()}:s);
          setUser(ownerEmail2,{senderEmails:renovados2});
          console.log(`[sender] 🔄 ${newEmail2} RE-AUTENTICADO para ${ownerEmail2}`);
          trackJourney(ownerEmail2,'sender_reauthed',{detail:`Sender reautenticado: ${newEmail2}`});
          const _safeRe2=JSON.stringify(newEmail2);
          const pageRe2=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail reativado!</title></head><body><script>sessionStorage.setItem('senderReauthed',${_safeRe2});window.location.href='/';<\/script></body></html>`;
          res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(pageRe2),"Cache-Control":"no-cache"});return res.end(pageRe2);
        }
        const maxSnd3=getMaxSenders(getUser(ownerEmail2)||{});
        if(1+existing2.length>=maxSnd3)return fail2(`Limite de ${maxSnd3} emails atingido.`);
        const newSender2={email:newEmail2,label:ui2.name||newEmail2,access_token:tk2.access_token,token_expiry:Date.now()+(tk2.expires_in||3600)*1000,refresh_token:tk2.refresh_token||null,addedAt:Date.now(),active:true,tokenExpired:false,blocked:false};
        if(!newSender2.refresh_token)console.warn(`[sender] ⚠️ refresh_token não recebido para ${newEmail2}`);
        setUser(ownerEmail2,{senderEmails:[...existing2,newSender2]});
        console.log(`[sender] ✅ ${newEmail2} adicionado como sender de ${ownerEmail2}`);
        trackJourney(ownerEmail2,'sender_added',{detail:`Sender adicionado: ${newEmail2}`});
        const _safeEmail2=JSON.stringify(newEmail2);
        const page2=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail adicionado!</title></head><body><script>sessionStorage.setItem('senderAdded',${_safeEmail2});window.location.href='/';<\/script></body></html>`;
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(page2),"Cache-Control":"no-cache"});return res.end(page2);
      }catch(e2){return fail2("Erro ao adicionar email: "+e2.message);}
    }
    try{
      const tb=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:REDIRECT_URI,grant_type:"authorization_code"}).toString();
      const{body:tk}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tb)}},tb);
      if(tk.error)return fail(tk.error_description||tk.error);if(!tk.access_token)return fail("Token não recebido.");
      const{body:ui}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tk.access_token}});
      if(!ui.email)return fail("E-mail não obtido.");
      // ── Verificar se email está banido permanentemente ──
      if(DB_BLOCKED.emails.includes(ui.email.trim().toLowerCase())){
        return fail("Conta suspensa permanentemente. Contate o suporte.");
      }
      const sid="sess_"+crypto.randomBytes(24).toString("hex");
      // FIX: preserva o refresh_token existente no banco se o Google não mandou um novo
      // O Google só envia refresh_token na primeira autenticação; re-logins omitem.
      const _existingRt = getUser(ui.email)?.refresh_token || null;
      const _rtToUse = tk.refresh_token || _existingRt;
      sessions[sid]={access_token:tk.access_token,refresh_token:_rtToUse,expires_at:Date.now()+(tk.expires_in||3600)*1000,user_email:ui.email,user_name:ui.name||ui.email,picture:ui.picture||"",created_at:Date.now()};
      persistSessionsDebounced(500); // V955: login sobrevive a restart imediato
      // Salva refresh_token e access_token no banco para uso pelo automático sem sessão
      const tokenData={cached_access_token:tk.access_token,cached_token_expiry:Date.now()+(tk.expires_in||3600)*1000};
      // CRÍTICO: nunca sobrescrever refresh_token existente com null.
      // O Google só envia refresh_token na 1a autenticação (prompt=consent).
      // Em re-logins, tk.refresh_token vem undefined — usa o do banco.
      if(tk.refresh_token){
        tokenData.refresh_token=tk.refresh_token;
      } else {
        const _existingUser = getUser(ui.email);
        if(_existingUser?.refresh_token) tokenData.refresh_token = _existingUser.refresh_token;
      }
      const ex=getUser(ui.email);
      // ══ MULTI-SERVIDOR: TRAVA DE CONTA ÚNICA (só para conta NOVA) ══════
      // Login de quem já existe AQUI segue 100% normal — as travas abaixo
      // valem apenas para cadastro novo. Bloqueio é feito ANTES de criar
      // qualquer registro; a sessão pré-criada é descartada.
      if(!ex){
        // (1) Este servidor está LOTADO? Fechado para contas novas de verdade
        //     (não só no visual do seletor).
        // ── V951: identidade única pelo host, resolvida pelo helper
        // compartilhado _resolveServerId() (usado agora em TODA rota, não só
        // aqui) — auto-curável mesmo que SERVER_ID fique ausente/errada no
        // Render, pois o servidor se identifica pelo próprio domínio.
        const _cfgList=_getServersConfig();
        const _selfId=_resolveServerId(req);
        const _selfCfg=_cfgList.find(sv=>sv.id===_selfId);
        if(_selfCfg&&_selfCfg.status==="lotado"){
          const _open=_cfgList.find(sv=>sv.id!==_selfCfg.id&&sv.status==="aberto"&&sv.url);
          delete sessions[sid];
          console.log(`[servers] 🚫 Cadastro recusado (Servidor ${_selfCfg.id} lotado): ${ui.email}`);
          const _q=_open?`&srv_id=${_open.id}&srv_nome=${encodeURIComponent(_open.nome)}&srv_url=${encodeURIComponent(_open.url)}`:"";
          res.writeHead(302,{Location:`/?err=srv_lotado${_q}`});return res.end();
        }
        // (2) Já tem conta em OUTRO servidor? Consulta os irmãos por hash do
        //     e-mail. Se sim, recusa e manda a pessoa para o servidor dela.
        const _peer=await checkAccountOnPeers(ui.email,_selfId);
        if(_peer){
          delete sessions[sid];
          console.log(`[servers] 🚫 Cadastro recusado: ${ui.email} já tem conta no Servidor ${_peer.id} (${_peer.url})`);
          res.writeHead(302,{Location:`/?err=conta_outro_srv&srv_id=${_peer.id}&srv_nome=${encodeURIComponent(_peer.nome)}&srv_url=${encodeURIComponent(_peer.url)}`});return res.end();
        }
      }
      if(!ex){
        const now=Date.now();
        // ── Anti-abuse: verificar se este IP ou Google ID já recebeu trial ────
        const _clientIp = (req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"").split(",")[0].trim();
        const _googleId = String(ui.id||"").trim(); // ID único da conta Google
        const _ipPrevEmails = DB_TRIAL_USED.ips[_clientIp]||[];
        const _ipAbuse = _ipPrevEmails.length >= 4; // mesmo IP, 4+ contas (CGNAT/redes móveis compartilham IP; googleId é a regra forte)
        const _googleAbuse = _googleId && !!DB_TRIAL_USED.googleIds[_googleId]; // mesma conta Google reativada
        const _trialBlocked = _ipAbuse || _googleAbuse;
        if(_trialBlocked){
          console.log(`[trial] ⚠️ Trial bloqueado para ${ui.email} — IP abuse:${_ipAbuse} googleId abuse:${_googleAbuse}`);
        }
        // NOVA REGRA: 1 dia MANUAL apenas (sem automático no trial)
        const trialDays = (DB_ADMIN_SETTINGS.newUserTrialEnabled && !_trialBlocked) ? 1 : 0;
        const newUserVip = trialDays > 0
          ? {manualExpires:now+trialDays*86400_000,autoExpires:0,active:true,activatedAt:now,plan:"vip",note:`Trial boas-vindas 1d VIP Manual`,source:'trial',days:trialDays,autoDays:0}
          : null;
        // Registrar IP e Google ID no histórico de trial
        if(trialDays>0){
          if(!DB_TRIAL_USED.ips[_clientIp]) DB_TRIAL_USED.ips[_clientIp]=[];
          if(!DB_TRIAL_USED.ips[_clientIp].includes(ui.email)) DB_TRIAL_USED.ips[_clientIp].push(ui.email);
          if(_googleId) DB_TRIAL_USED.googleIds[_googleId] = ui.email;
          try{fs.writeFileSync(TRIAL_USED_FILE,JSON.stringify(DB_TRIAL_USED,null,2));}catch{}
        } else if(_googleId && !DB_TRIAL_USED.googleIds[_googleId]) {
          // Mesmo sem trial, registra o Google ID para futuras verificações
          DB_TRIAL_USED.googleIds[_googleId] = ui.email;
          try{fs.writeFileSync(TRIAL_USED_FILE,JSON.stringify(DB_TRIAL_USED,null,2));}catch{}
        }
        setUser(ui.email,{...tokenData,email:ui.email,name:ui.name||ui.email,picture:ui.picture||"",country:"Brazil",phone:"",cc:"",city:"",language:"pt-BR",cvs:[],created_at:new Date().toISOString(),plan:newUserVip?"vip":"free",vip:newUserVip||null,googleId:_googleId||undefined,saved:[],onboarded:false,isAdmin:isAdminEmail(ui.email),scopeVersion:2,lastLoginAt:Date.now(),_trialBlockedByIp:_ipAbuse||undefined,_trialBlockedByGoogleId:_googleAbuse||undefined,settings:{subject:"Application for {vaga} – {nome}",body:"Dear Hiring Manager,\n\nMy name is {nome} and I am writing to express my strong interest in the {vaga} position at {empresa}.\n\nI am from {pais} and fully available to start on the requested date.\n\nPlease find my resume attached.\n\nBest regards,\n{nome}\n{telefone}",followupSubject:"Following up: {vaga} at {empresa}",followupBody:"Dear Hiring Manager,\n\nFollowing up on {vaga} at {empresa}.\n\nBest regards,\n{nome}"}});
        if(trialDays>0) addCredito(ui.email,{dias:trialDays,tipo:"gratis",origem:"trial",motivo:"Trial boas-vindas",dadoPor:"sistema"});
        console.log("[oauth] ✅ Novo:",ui.email,"| trial:",trialDays,"d VIP Manual (sem auto)");
        trackJourney(ui.email,'first_login',{detail:`Novo. Trial:${trialDays}d Manual`,meta:{name:ui.name}});
        pushGlobalEvent('new_user',ui.email,`Novo: ${ui.name||ui.email}`,"info");
        // (Sistema de indicação removido definitivamente em 2026-07-03 — ver KB-059)
      }
      else{
        // BUG-003 CORRIGIDO: usa isVipActive() em vez de comparar expiresAt diretamente
        // Evita revogar VIP de usuários com schema misto (manualExpires novo + expiresAt legado)
        const vipStillActive = isVipActive(ex);
        const vipDowngrade = ex.vip?.active && !vipStillActive ? {vip:{...ex.vip,active:false},plan:"free"} : {};
        // ── Conta deletada pelo próprio usuário: relogar RESTAURA automaticamente ──
        // "a conta simplesmente volta ao normal" — mesmos dados, mesmo VIP, sem
        // recriar nada e SEM re-conceder trial (ex já existe, não passa pelo
        // ramo de usuário novo). Só limpa a flag e registra o retorno.
        const wasDeleted = !!ex.accountDeleted;
        const restoreFields = wasDeleted ? {accountDeleted:false, deletedAt:null} : {};
        setUser(ui.email,{...tokenData,picture:ui.picture||ex.picture,isAdmin:isAdminEmail(ui.email),...vipDowngrade,...restoreFields,scopeVersion:2,lastLoginAt:Date.now()});
        if(wasDeleted){
          console.log("[account] ♻️ Conta restaurada ao relogar:",ui.email);
          try{ trackJourney(ui.email,'account_restored',{detail:'Usuário relogou após deletar a própria conta — restaurada automaticamente'}); }catch{}
        }
        console.log("[oauth] Login:",ui.email,"| refresh_token salvo:",!!tokenData.refresh_token,"| vip:",vipStillActive?"ativo":"inativo","| Total:",Object.keys(DB_USERS).length);

        // ── FIX: re-login DEVE retomar o automático pausado por erro de auth/token ──
        // O banner de erro promete "Faça login novamente no H2BApply para o automático
        // continuar". Antes, o login só atualizava o token e o job continuava parado em
        // paused_auth_error / paused_oauth_expired / paused_no_session — o usuário
        // relogava e "o erro voltava". Agora, se o token novo é válido e o usuário tem
        // VIP automático ativo, limpamos o estado de pausa e re-armamos o envio.
        // NÃO retoma: paused_account_suspended (bloqueio real do Google) nem
        // paused_no_vip (plano expirado — precisa renovar, não relogar).
        try {
          const _freshUser = getUser(ui.email) || ex;
          const _hasRt   = !!_freshUser.refresh_token;
          const _autoVip = isAutoVipActive(_freshUser);
          const _job     = getAutoJob(ui.email);
          const _authPaused = _job && !_job.active &&
            ["paused_auth_error","paused_oauth_expired","paused_no_session"].includes(_job.status);
          if (_authPaused && _hasRt && _autoVip && (_job.queue?.length || 0) > 0) {
            if (autoTimers.has(ui.email)) { clearTimeout(autoTimers.get(ui.email)); autoTimers.delete(ui.email); }
            setAutoJob(ui.email, { ...getAutoJob(ui.email), active:true, status:"resuming", resumedAt:Date.now() });
            addLog(ui.email, { status:"sistema", jobTitle:"🔓 Acesso renovado — envio automático retomado", company:"Login refeito com sucesso. O robô voltou a enviar suas candidaturas.", error:"" });
            try { trackJourney(ui.email,'auto_resume',{detail:`Re-login limpou ${_job.status}`}); } catch {}
            console.log(`[oauth] 🔓 ${ui.email} relogou — auto retomado (estava ${_job.status}, fila:${_job.queue.length})`);
            scheduleAuto(ui.email);
          }
        } catch(_e){ console.warn("[oauth] resume-after-login falhou:", _e.message); }
      }
      const cookieStr=makeCookieStr(sid);const page=makeCallbackPage(sid);
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(page),"Set-Cookie":cookieStr,"Cache-Control":"no-cache, no-store"});
      return res.end(page);
    }catch(e){return fail("Erro: "+e.message);}
  }

  // ══════════════════════════════════════════════════════════
  //  MULTI-SENDER — OAuth para adicionar email extra de envio
  // ══════════════════════════════════════════════════════════

  // Inicia OAuth do email extra — só para quem já está logado
  if(pathname==="/oauth/add-sender"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!CONFIGURED){res.writeHead(302,{Location:"/?err="+encodeURIComponent("OAuth não configurado.")});return res.end();}
    const p=getUser(s.user_email)||{};
    const totalSenders=1+(p.senderEmails||[]).length;
    const maxSnd=getMaxSenders(p);
    const _reauth=String(u.searchParams.get("reauth")||"")==="1";
    if(totalSenders>=maxSnd && !_reauth){res.writeHead(302,{Location:"/?err="+encodeURIComponent(`Limite de ${maxSnd} emails atingido.`)});return res.end();}
    const st=crypto.randomBytes(20).toString("hex");
    // Salva o state com o email do dono para vincular no callback
    sessions["__sender__"+st]={ownerEmail:s.user_email,created:Date.now()};
    persistSessions(); // grava no disco (ver ajuste em persistSessions: __sender__ agora sobrevive a restart)
    const qs=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:"code",scope:"openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",access_type:"offline",prompt:"consent select_account",state:st});
    res.writeHead(302,{Location:"https://accounts.google.com/o/oauth2/v2/auth?"+qs});return res.end();
  }

  // [FIX] Alias legado — redireciona para /oauth/callback (unificado)
  if(pathname==="/oauth/add-sender/callback"){
    const _rparams=u.search||"";
    res.writeHead(302,{Location:"/oauth/callback"+_rparams});return res.end();
  }
  // Callback do OAuth do email extra (CÓDIGO LEGADO — mantido como fallback, nunca atingido)
  if(false&&pathname==="/oauth/add-sender/callback-legacy"){
    const code=u.searchParams.get("code"),error=u.searchParams.get("error"),st=u.searchParams.get("state")||"";
    const fail=m=>{res.writeHead(302,{Location:"/?err="+encodeURIComponent(m)+"&tab=profile"});res.end();};
    if(error)return fail(error==="access_denied"?"Adição de email cancelada.":"Erro OAuth: "+error);
    if(!code||!st)return fail("Código ou state inválido.");
    const pending=sessions["__sender__"+st];
    if(!pending||Date.now()-pending.created>600_000){delete sessions["__sender__"+st];return fail("Sessão expirada. Tente novamente.");}
    const ownerEmail=pending.ownerEmail;
    delete sessions["__sender__"+st];
    try{
      const tb=new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:REDIRECT_URI,grant_type:"authorization_code"}).toString();
      const{body:tk}=await httpsReq({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(tb)}},tb);
      if(tk.error)return fail(tk.error_description||tk.error);
      if(!tk.access_token)return fail("Token não recebido.");
      const{body:ui}=await httpsReq({hostname:"www.googleapis.com",path:"/oauth2/v2/userinfo",method:"GET",headers:{"Authorization":"Bearer "+tk.access_token}});
      if(!ui.email)return fail("E-mail não obtido.");
      const newEmail=ui.email.toLowerCase().trim();
      // Bloquear: email extra igual ao principal
      if(newEmail===ownerEmail)return fail("Este é seu email principal. Adicione um Gmail diferente.");
      // Bloquear: email extra já é conta principal de outro usuário
      if(getUser(newEmail))return fail("Este Gmail já tem conta no H2BApply. Use outro email.");
      const owner=getUser(ownerEmail)||{};
      const existing=owner.senderEmails||[];
      // Bloquear: email já adicionado
      if(existing.find(s=>s.email===newEmail))return fail("Este Gmail já está adicionado à sua conta.");
      // Verificar limite
      const maxSnd2=getMaxSenders(getUser(ownerEmail)||{});
      if(1+existing.length>=maxSnd2)return fail(`Limite de ${maxSnd2} emails atingido.`);
      const newSender={email:newEmail,label:ui.name||newEmail,access_token:tk.access_token,token_expiry:Date.now()+(tk.expires_in||3600)*1000,refresh_token:tk.refresh_token||null,addedAt:Date.now(),active:true,tokenExpired:false,blocked:false};
      if(!newSender.refresh_token)console.warn(`[sender] ⚠️ refresh_token não recebido para ${newEmail} — pode expirar sem renovar`);
      setUser(ownerEmail,{senderEmails:[...existing,newSender]});
      console.log(`[sender] ✅ ${newEmail} adicionado como sender de ${ownerEmail}`);
      trackJourney(ownerEmail,'sender_added',{detail:`Sender adicionado: ${newEmail}`});
      // Redireciona de volta ao perfil com toast de sucesso
      const _safeEmail=JSON.stringify(newEmail);
      const page=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail adicionado!</title></head><body><script>sessionStorage.setItem('senderAdded',${_safeEmail});window.location.href='/';<\/script></body></html>`;
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(page),"Cache-Control":"no-cache"});return res.end(page);
    }catch(e){return fail("Erro ao adicionar email: "+e.message);}
  }

  // Remove email extra de envio
  if(/^\/api\/sender\/[^/]+$/.test(pathname)&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const emailToRemove=decodeURIComponent(pathname.replace("/api/sender/","")).toLowerCase().trim();
    if(emailToRemove===s.user_email)return json(res,400,{error:"Não é possível remover seu email principal."});
    const p=getUser(s.user_email)||{};
    const existing=p.senderEmails||[];
    if(!existing.find(x=>x.email===emailToRemove))return json(res,404,{error:"Email não encontrado."});
    setUser(s.user_email,{senderEmails:existing.filter(x=>x.email!==emailToRemove)});
    console.log(`[sender] 🗑 ${emailToRemove} removido de ${s.user_email}`);
    return json(res,200,{ok:true});
  }

  // Atualiza label ou active de um email extra
  if(/^\/api\/sender\/[^/]+$/.test(pathname)&&req.method==="PATCH"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const emailToUpdate=decodeURIComponent(pathname.replace("/api/sender/","")).toLowerCase().trim();
    if(emailToUpdate===s.user_email)return json(res,400,{error:"Não é possível editar o email principal aqui."});
    try{
      const d=JSON.parse(await readBody(req));
      const p=getUser(s.user_email)||{};
      const senders=(p.senderEmails||[]).map(x=>x.email===emailToUpdate?{...x,...(d.label!==undefined?{label:String(d.label).slice(0,40)}:{}),...(d.active!==undefined?{active:!!d.active}:{})}:x);
      setUser(s.user_email,{senderEmails:senders});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: Central de Incidentes ─────────────────────────
  if(pathname==="/api/admin/incidents"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const now=Date.now();
      const allUsers=Object.values(DB_USERS||{});
      const incidents=[];
      const missions=[];
      // (TOKEN_INACTIVE_IGNORE_MS/TOKEN_ACTIVE_ALERT_MS removidos — só eram
      // usados pelos blocos de incidente de token, que foram desativados acima.)

      for(const u of allUsers){
        if(!u||!u.email)continue;
        const email=u.email;
        const job=getAutoJob(email);
        const lastSeen=u.lastSeenAt||new Date(u.created_at||0).getTime();
        const inactiveMs=now-lastSeen;

        // ── Token/OAuth expirado: NÃO é mais um "incidente" acionável ──────
        // Decisão do dono (2026-06-28): "token não é um problema" — quem resolve
        // é o USUÁRIO (relogando em h2bapply.com), não o admin. Não há ação real
        // possível aqui (nem "Resolver" faz sentido, nem o dono quer ficar
        // clicando "Notificar"). O aviso automático por e-mail já existe e roda
        // sozinho via authErrorWatchdog (a cada 3h, sem intervenção humana) —
        // então nem a notificação manual fazia falta. Saúde do token continua
        // 100% rastreada em healthState/oauthOk para diagnóstico (Robô de
        // Auditoria, painel de saúde) — só PAROU de poluir a fila de incidentes
        // que o dono precisa revisar e decidir algo sobre. (Blocos antigos que
        // geravam incidents.push/missions.push para 'tok_'/'auth_err_' removidos.)

        // ── Automático travado ───────────────────────────────────
        const WAIT_STATUSES=["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"];
        if(job&&job.active&&job.lastSentAt&&(now-job.lastSentAt)>7200000&&!WAIT_STATUSES.includes(job?.status)){
          const horas=Math.round((now-job.lastSentAt)/3600000);
          incidents.push({
            id:'stuck_'+email, type:'auto_stuck', severity:'warn', status:'open',
            robot:'Automático Gmail', module:'Envio',
            userEmail:email, name:u.name||email,
            title:'Automático travado — sem envios',
            description:`Último envio há ${horas}h. O robô está ativo mas não processa a fila. Pode estar bloqueado silenciosamente pelo Gmail.`,
            suggestedAction:`Verifique os logs do usuário. Se há erros de rate limit, aguarde. Se não há atividade, reinicie o automático.`,
            humanExplanation:`O robô está marcado como ativo mas não envia há ${horas} horas. Isso geralmente indica bloqueio silencioso pelo Gmail ou fila vazia.`,
            options:[
              {label:'Reiniciar automático',action:'restart_auto'},
              {label:'Ignorar por agora',action:'ignore'}
            ],
            createdAt:now
          });
        }

        // ── VIP vencido mas marcado ativo → AUTO-CORREÇÃO (sem incidente) ──
        // FALSO ALARME removido: vip.active é só um rótulo; a fonte da verdade
        // são as expirações (isManualVipActive/isAutoVipActive). getPlan e os
        // limites já voltam ao free sozinhos quando vence — NÃO há acesso
        // indevido a nada pago. E com a regra "10 automáticos grátis/dia para
        // todos", vencer plano não exige nenhuma ação humana. O robô agora
        // apenas sincroniza o rótulo sozinho (o que a sugestão mandava o admin
        // fazer manualmente).
        if(u.vip&&u.vip.active){
          const exp=Math.max(u.vip.manualExpires||0,u.vip.autoExpires||0);
          if(exp>0&&exp<now){
            try{ setUser(email,{vip:{...u.vip,active:false}});
              console.log(`[robô-contábil] 🔄 rótulo vip.active sincronizado (vencido) para ${email}`);
            }catch(e){}
          }
        }

        // ── Sem currículo com automático ativo ───────────────────
        if(job&&job.active&&(!u.cvs||u.cvs.length===0)){
          incidents.push({
            id:'nocv_'+email, type:'no_cv', severity:'info', status:'open',
            robot:'Automático Gmail', module:'Currículo',
            userEmail:email, name:u.name||email,
            title:'Automático ativo sem currículo',
            description:`${u.name||email} está com o automático ligado mas não tem nenhum currículo (PDF) cadastrado. Os envios estão sendo pulados.`,
            suggestedAction:'Instrua o usuário a fazer upload do currículo na aba Perfil.',
            humanExplanation:'O robô não consegue enviar candidaturas porque não há PDF de currículo para anexar. Todos os envios estão sendo ignorados silenciosamente.',
            options:[
              {label:'Notificar usuário',action:'notify_no_cv'},
              {label:'Ignorar',action:'ignore'}
            ],
            createdAt:now
          });
        }

        // ── Muitos erros consecutivos ────────────────────────────
        const health=global._healthMap&&global._healthMap[email];
        if(health&&health.errors>=5){
          incidents.push({
            id:'errs_'+email, type:'too_many_errors', severity:'error', status:'open',
            robot:'Automático Gmail', module:'Envio',
            userEmail:email, name:u.name||email,
            title:`Muitos erros consecutivos: ${health.errors}`,
            description:`O robô de ${u.name||email} acumulou ${health.errors} erros consecutivos. Último erro: ${health.lastError||'desconhecido'}.`,
            suggestedAction:'Verifique os logs do usuário para identificar o tipo de erro predominante.',
            humanExplanation:`Erros repetidos geralmente indicam problema persistente de autenticação, rate limit ou configuração incorreta.`,
            options:[
              {label:'Ver logs',action:'view_logs'},
              {label:'Reiniciar automático',action:'restart_auto'},
              {label:'Ignorar',action:'ignore'}
            ],
            createdAt:now
          });
        }
      }

      // ── Incidentes de sistema ────────────────────────────────
      if(!getGeminiKey()){
        incidents.push({
          id:'sys_gemini', type:'gemini_fail', severity:'error', status:'open',
          robot:'Robô de Auditoria', module:'Configuração do Sistema',
          title:'Gemini API não configurada',
          description:'A variável GEMINI_API_KEY está ausente no Render. O Robô de Auditoria, a IA de Incidentes e o Chat IA Admin estão inoperantes.',
          suggestedAction:'Render Dashboard → Environment → adicionar GEMINI_API_KEY com a chave da API do Google.',
          humanExplanation:'Sem a chave da Gemini, nenhuma análise inteligente pode ser feita. O sistema funciona mas sem diagnóstico automático.',
          options:[{label:'Marcar como pendente',action:'ignore'}],
          createdAt:Date.now()
        });
        missions.push({
          id:'mis_gemini', incidentId:'sys_gemini', type:'system', status:'pending',
          severity:'error', robot:'Robô de Auditoria',
          title:'Configurar GEMINI_API_KEY no Render',
          action:'Render Dashboard → Environment → adicionar GEMINI_API_KEY'
        });
      }

      // ── Incidentes de emails inválidos ───────────────────────
      const bounceCount=Object.keys(DB_TEMP_FAILURES||{}).length;
      if(bounceCount>=10){
        incidents.push({
          id:'sys_bounces', type:'banco_erro', severity:'warn', status:'open',
          robot:'Robô de Bounce', module:'Emails Inválidos',
          title:`${bounceCount} emails com falha acumulados`,
          description:`A base de emails inválidos acumulou ${bounceCount} entradas. Isso pode indicar problema de qualidade na planilha de vagas.`,
          suggestedAction:'Acesse ⛔ Emails Inválidos para revisar e limpar entradas antigas.',
          humanExplanation:'Emails que retornam erro são acumulados. Se o número está alto, a planilha pode ter muitos endereços incorretos.',
          options:[{label:'Ver emails inválidos',action:'view_invalid'},{label:'Ignorar',action:'ignore'}],
          createdAt:Date.now()
        });
      }

      // ── Aplicar resoluções/exclusões (persistência em memória) ──
      const resolved=global._resolvedIncidents||{};
      const finalIncidents=incidents
        .filter(i=>!resolved[i.id]?.deleted)
        .map(i=>resolved[i.id]
          ?{...i,status:'resolved',resolvedAt:resolved[i.id].resolvedAt,resolvedBy:resolved[i.id].resolvedBy,adminNote:resolved[i.id].note||''}
          :i);
      const finalMissions=missions.filter(m=>!resolved[m.incidentId]);

      // ── Regras aprendidas ────────────────────────────────────
      const rules=global._incidentRules||{};

      const open=finalIncidents.filter(i=>i.status==='open').length;
      const missionsPending=finalMissions.length;

      // ── Painel de saúde do sistema ───────────────────────────
      const health={
        gmail:  allUsers.some(u=>u.cached_token_expiry&&u.cached_token_expiry<Date.now())?'yellow':'green',
        gemini: getGeminiKey()?'green':'red',
        oauth:  allUsers.some(u=>getAutoJob(u.email)?.status==='paused_auth_error')?'yellow':'green',
        bounces: bounceCount>=20?'red':bounceCount>=5?'yellow':'green',
        users:  allUsers.length
      };

      // ── Validação anti-divergência: contador = registros ─────
      const divergencia=(open>0&&finalIncidents.filter(i=>i.status==='open').length===0);

      return json(res,200,{
        ok:true,
        incidents:finalIncidents,
        missions:finalMissions,
        rules,
        health,
        open,
        pending:open,
        missionsPending,
        total:finalIncidents.length,
        divergencia,
        generatedAt:Date.now()
      });
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: resolver incidente específico ──────────────────
  if(pathname.startsWith("/api/admin/incidents/")&&pathname.endsWith("/resolve")&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const id=decodeURIComponent(pathname.split("/api/admin/incidents/")[1].replace("/resolve",""));
      // Persiste resolução em memória (os incidentes são gerados dinamicamente, então apenas logamos)
      if(!global._resolvedIncidents)global._resolvedIncidents={};
      global._resolvedIncidents[id]={resolvedAt:Date.now(),resolvedBy:s.user_email,note:d?.note||""};
      const saveAsRule=d?.saveAsRule;
      if(saveAsRule&&d?.ruleText){
        if(!global._incidentRules)global._incidentRules={};
        const ruleKey=(d.incidentType||id.split('_')[0])+'__'+(d.decision||'ignore');
        if(!global._incidentRules[ruleKey]) global._incidentRules[ruleKey]={count:0};
        global._incidentRules[ruleKey].ruleText=d.ruleText;
        global._incidentRules[ruleKey].decision=d.decision||'ignore';
        global._incidentRules[ruleKey].learnedAt=Date.now();
        global._incidentRules[ruleKey].count=(global._incidentRules[ruleKey].count||0)+1;
        console.log(`[incidents] Regra aprendida: ${ruleKey} — ${d.ruleText}`);
      }
      console.log(`[incidents] Incidente ${id} resolvido por ${s.user_email}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: deletar incidente ──────────────────────────────
  if(pathname.startsWith("/api/admin/incidents/")&&req.method==="DELETE"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const id=decodeURIComponent(pathname.split("/api/admin/incidents/")[1]);
      if(!global._resolvedIncidents)global._resolvedIncidents={};
      global._resolvedIncidents[id]={resolvedAt:Date.now(),resolvedBy:s.user_email,deleted:true};
      console.log(`[incidents] Incidente ${id} deletado por ${s.user_email}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: limpar todos incidentes resolvidos ─────────────
  if(pathname==="/api/admin/incidents/clear"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    global._resolvedIncidents={};
    console.log(`[incidents] Todos incidentes limpos por ${s.user_email}`);
    return json(res,200,{ok:true});
  }

  // ── Admin: desbanir email ─────────────────────────────────
  if(pathname==="/api/admin/unban-email"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins podem desbanir."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const emailLow=email.trim().toLowerCase();
      DB_BLOCKED.emails=DB_BLOCKED.emails.filter(e=>e!==emailLow);
      persist(BLOCKED_FILE,DB_BLOCKED);
      console.log(`[admin] ✅ Email desbanido: ${emailLow}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: ver histórico anti-abuse de trial ──────────────
  if(pathname==="/api/admin/trial-abuse"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    // IPs com múltiplas contas usando trial
    const suspectIps=Object.entries(DB_TRIAL_USED.ips||{})
      .filter(([,emails])=>emails.length>1)
      .map(([ip,emails])=>({ip,emails,count:emails.length}))
      .sort((a,b)=>b.count-a.count);
    return json(res,200,{ok:true,phones:DB_TRIAL_USED.phones||{},ips:DB_TRIAL_USED.ips||{},suspectIps,totalPhones:Object.keys(DB_TRIAL_USED.phones||{}).length,totalIps:Object.keys(DB_TRIAL_USED.ips||{}).length});
  }

  // ── Admin: revogar trial de usuário específico ────────────
  if(pathname==="/api/admin/revoke-trial"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,reason}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const u=getUser(email);if(!u)return json(res,404,{error:"Usuário não encontrado"});
      // Para o automático imediatamente
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      const job=getAutoJob(email);
      if(job?.active) setAutoJob(email,{...job,active:false,status:"paused_no_vip",finishedAt:Date.now()});
      // Revoga VIP/trial
      setUser(email,{plan:"free",vip:{active:false,manualExpires:0,autoExpires:0,revokedAt:Date.now(),revokedBy:s.user_email,revokeReason:reason||"Trial abuse"}});
      addLog(email,{status:"sistema",jobTitle:"⛔ Trial revogado pelo admin",company:reason||"Uso indevido de trial detectado"});
      console.log(`[trial] ⛔ Trial de ${email} revogado por ${s.user_email}: ${reason||"abuse"}`);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: notificar usuário com paused_auth_error (1-click) ──────────────
  if(pathname==="/api/admin/notify-auth-error"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      await sendNotifEmail(email,"auth_error");
      console.log(`[admin] 📧 Email auth_error enviado para ${email} por ${s.user_email}`);
      return json(res,200,{ok:true,message:`Email enviado para ${email}`});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: pedidos críticos (pendentes >24h) ──────────────────────────────
  if(pathname==="/api/admin/pedidos-criticos"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const now=Date.now();
    const criticos=(DB_PEDIDOS||[]).filter(pd=>pd.status==="pendente"&&(now-(pd.createdAt||0))>24*3600_000)
      .map(pd=>({id:pd.id,userEmail:pd.userEmail,plano:pd.plano,valor:pd.valorTotal,
        horas:Math.round((now-(pd.createdAt||0))/3600000),createdAt:pd.createdAt}))
      .sort((a,b)=>b.horas-a.horas);
    return json(res,200,{ok:true,criticos,total:criticos.length});
  }

  // ── ADMIN: configurações pessoais de admin (intervalo, limites por sender) ──

  // ── 🩺 ROTAS DE SAÚDE/OPERAÇÃO — extraídas para src/routes/admin-health.js (Fase 1 · Módulo 5)
  if(await handleAdminHealthRoutes(req,res,pathname)) return;
  if(await handleAdminV2Routes(req,res,pathname)) return;

  // ── M04: Exportar usuários como CSV ──────────────────────
  if(pathname==="/api/admin/users/export"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    const now=Date.now();
    const rows=[["Email","Nome","Plano","VIP Ativo","VIP Expira","Criado em","Último acesso","Total Enviados","Auto Rodando","Token OK"]];
    for(const u of Object.values(DB_USERS||{})){
      if(!u?.email)continue;
      const job=getAutoJob(u.email);
      const vipOk=isVipActive(u);
      const vipExp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);
      const tokenOk=u.cached_token_expiry&&u.cached_token_expiry>now;
      const hist=getHist(u.email);
      const total=Object.values(hist||{}).reduce((a,arr)=>a+(arr?.length||0),0);
      rows.push([u.email,u.name||"",u.plan||"free",vipOk?"Sim":"Não",vipExp?new Date(vipExp).toLocaleDateString("pt-BR"):"",u.created_at?u.created_at.slice(0,10):"",u.lastSeenAt?new Date(u.lastSeenAt).toLocaleDateString("pt-BR"):"",total,job?.active?"Sim":"Não",tokenOk?"Sim":"Não"]);
    }
    const csv=rows.map(r=>r.map(c=>'"'+String(c||"").replace(/"/g,'""')+'"').join(",")).join("\n");
    res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="usuarios_${new Date().toISOString().slice(0,10)}.csv"`});
    return res.end("\uFEFF"+csv); // BOM para Excel
  }

  // ── M05: Métricas diárias para gráfico (últimos 30 dias) ─
  if(pathname==="/api/admin/metrics/daily"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const days=parseInt(new URL("http://x"+pathname+new URL("http://x"+(s.user_email||"")+"?"+req.url.split("?")[1]||"").search).searchParams.get("days")||"30");
    const result=[];
    for(let i=days-1;i>=0;i--){
      const d=new Date();d.setDate(d.getDate()-i);
      const ds=d.toISOString().slice(0,10).replace(/-/g,"");
      let total=0,manual=0,auto=0,newUsers=0;
      for(const u of Object.values(DB_USERS||{})){
        if(!u)continue;
        if(u.created_at&&u.created_at.slice(0,10)===d.toISOString().slice(0,10))newUsers++;
        const hist=getHist(u.email);
        for(const arr of Object.values(hist||{})){
          for(const h of (arr||[])){
            if((h.dateStr||"").replace(/-/g,"")===ds){total++;if(h.type==="auto")auto++;else manual++;}
          }
        }
      }
      result.push({date:d.toISOString().slice(0,10),total,manual,auto,newUsers});
    }
    return json(res,200,{ok:true,metrics:result});
  }

  // ── M06: Stats detalhados do usuário logado ───────────────
  if(pathname==="/api/me/stats"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const u=getUser(s.user_email);if(!u)return json(res,404,{error:"Usuário não encontrado."});
    const hist=getHist(s.user_email);
    const allEntries=Object.values(hist||{}).flat();
    const now=Date.now();
    const last7=allEntries.filter(h=>h.dateStr&&new Date(h.dateStr)>new Date(Date.now()-7*86400000));
    const last30=allEntries.filter(h=>h.dateStr&&new Date(h.dateStr)>new Date(Date.now()-30*86400000));
    const byState={};allEntries.forEach(h=>{if(h.state){byState[h.state]=(byState[h.state]||0)+1;}});
    const topStates=Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,c])=>({state:s,count:c}));
    return json(res,200,{ok:true,total:allEntries.length,manual:allEntries.filter(h=>h.type!=="auto").length,auto:allEntries.filter(h=>h.type==="auto").length,last7days:last7.length,last30days:last30.length,topStates,memberSince:u.created_at,streak:calcStreak(allEntries)});
  }

  // ── M07: Verificar vagas sem resposta há 7d (follow-up) ──
  if(pathname==="/api/followup/check"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const hist=getHist(s.user_email);
    const now=Date.now();
    const sevenDaysAgo=now-7*86400_000;
    // INBOX_EMAILS nunca foi declarado globalmente — referência direta lança
    // ReferenceError ("INBOX_EMAILS is not defined"). typeof protege; || não.
    const _inboxArr = (typeof INBOX_EMAILS !== "undefined" && Array.isArray(INBOX_EMAILS)) ? INBOX_EMAILS : [];
    const inboxEmails=new Set(_inboxArr.map(e=>(e.from||"").toLowerCase()));
    const followups=[];
    for(const [key,entries] of Object.entries(hist||{})){
      if(!entries?.length)continue;
      const last=entries[0];
      const lastDate=new Date(last.date||0).getTime()||0;
      if(lastDate<sevenDaysAgo&&lastDate>0){
        const toEmail=(last.to||"").toLowerCase();
        const hasReply=inboxEmails.has(toEmail);
        if(!hasReply)followups.push({jobId:last.jobId||key,job:last.job||"",company:last.company||"",to:last.to||"",sentAt:last.date,daysSince:Math.round((now-lastDate)/86400000)});
      }
    }
    return json(res,200,{ok:true,followups:followups.slice(0,50),total:followups.length});
  }

  // ── M08: Marcar ação admin no log ─────────────────────────
  // (helper usado internamente, mas também exposto como webhook)
  function _logAdminAction(adminEmail,action,target,detail){
    if(!global._adminActionLog)global._adminActionLog=[];
    global._adminActionLog.unshift({ts:Date.now(),admin:adminEmail,action,target:target||"",detail:detail||""});
    if(global._adminActionLog.length>500)global._adminActionLog.length=500;
  }

  // ── Admin: financeiro (entradas + gastos) ────────────────
  if(pathname==="/api/admin/financeiro"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    // Retornar sem imagens (muito pesado) — imagens ficam nos pedidos
    // Retorna SEMPRE sem imagem base64 (imagens só via /api/pedido/:id)
    const stripImg = arr => (arr||[]).map(p=>{const c={...p};delete c.img;delete c.comprovante;return c;});
    const slim={
      pagamentos: stripImg(DB_FINANCEIRO.pagamentos),
      gastos:     stripImg(DB_FINANCEIRO.gastos),
      repasses:   (DB_FINANCEIRO.repasses||[]), // repasses entre sócios (sem imagens)
    };
    // ── Resumo GIFT/CÓDIGO: NÃO conta dinheiro nem como pagante. Categoria
    // separada — quantos usuários ativaram por código e quantos dias no total.
    // Fonte da verdade: vip.source==='code'.
    const now=Date.now();
    let codGift={usuarios:0, ativos:0, diasTotal:0, lista:[]};
    for(const u of Object.values(DB_USERS)){
      if((u.vip?.source||"")!=="code") continue;
      codGift.usuarios++;
      const ativo=isVipActive(u);
      if(ativo) codGift.ativos++;
      // dias concedidos pelo código (preferir vip.days; senão derivar da expiração)
      let dias=u.vip?.days||0;
      if(!dias){
        const exp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);
        const base=u.vip?.activatedAt||u.created_at?new Date(u.vip?.activatedAt||u.created_at).getTime():now;
        if(exp>base) dias=Math.round((exp-base)/86400000);
      }
      codGift.diasTotal+=dias;
      codGift.lista.push({email:u.email,nome:u.name||u.email,codigo:u.vip?.usedCode||null,dias,ativo,plano:u.vip?.plan||"vip"});
    }
    // ── RECEITA REAL: soma TODOS os pagantes (inclui os aceitos antes do
    // livro-caixa automático). Por pagante usa UMA fonte (sem dupla contagem):
    // livro-caixa (DB_FINANCEIRO) → pedido pago/ativo (DB_PEDIDOS) → paymentAmount.
    const _pv=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
    const _ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
    const _finBy={}, _pedBy={};
    for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){ if(!pg||!pg.email)continue; const e=String(pg.email).toLowerCase(); (_finBy[e]=_finBy[e]||[]).push({valor:_pv(pg.valor),date:_ts(pg.dataPagamento)||_ts(pg.data)||pg.criadoEm||0}); }
    for(const ped of Object.values(DB_PEDIDOS||{})){ if(!ped||!ped.userEmail)continue; const st=String(ped.status||"").toLowerCase(); if(st!=="pago"&&st!=="ativo")continue; const e=String(ped.userEmail).toLowerCase(); (_pedBy[e]=_pedBy[e]||[]).push({valor:_pv(ped.valorTotal),date:_ts(ped.ativadoEm)||_ts(ped.pagoEm)||0}); }
    const _msD=new Date();_msD.setDate(1);_msD.setHours(0,0,0,0);const _monthStart=_msD.getTime();
    let receitaReal=0, receitaMes=0, qtdPagantes=0;
    for(const u of Object.values(DB_USERS||{})){
      if(!u||!u.email)continue; const elc=u.email.toLowerCase(); const vip=u.vip||{}; const src=String(vip.source||"").toLowerCase();
      if(src==="code"||src==="trial") continue; // gift/código e trial NUNCA contam como receita
      let pags=_finBy[elc]||[]; if(!pags.length) pags=_pedBy[elc]||[]; if(!pags.length&&u.paymentAmount) pags=[{valor:_pv(u.paymentAmount),date:vip.activatedAt||0}];
      pags=pags.filter(p=>p.valor>0);
      const everPaid=(src===""||src==="admin"||src==="pago"||src==="payment")&&((vip.manualExpires||0)>0||(vip.autoExpires||0)>0||vip.activatedAt);
      if(!pags.length&&!everPaid) continue;
      const tot=pags.reduce((a,p)=>a+p.valor,0);
      if(tot>0) qtdPagantes++;
      receitaReal+=tot;
      for(const p of pags){ if((p.date||0)>=_monthStart) receitaMes+=p.valor; }
    }
    // ── ENTRADAS AVULSAS: pagamentos SEM email de usuário cadastrado (ex.:
    // Pix/PicPay recebido direto por um sócio, saldo inicial, acerto externo).
    // O loop acima itera DB_USERS, então essas entradas ficavam INVISÍVEIS na
    // receita — some da receita total, do mês e dos indicadores (bug v947).
    // Aqui elas entram como categoria própria, sem inflar a contagem de pagantes.
    let receitaAvulsa=0;
    const _userEmails=new Set(Object.keys(DB_USERS||{}).map(e=>e.toLowerCase()));
    for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
      if(!pg) continue;
      const e=String(pg.email||"").toLowerCase();
      if(e&&_userEmails.has(e)) continue; // já contado no loop por usuário
      const v=_pv(pg.valor); if(v<=0) continue;
      receitaAvulsa+=v; receitaReal+=v;
      const dt=_ts(pg.dataPagamento)||_ts(pg.data)||pg.criadoEm||0;
      if(dt>=_monthStart) receitaMes+=v;
    }
    return json(res,200,{ok:true,financeiro:slim,pagamentos:slim.pagamentos,gastos:slim.gastos,repasses:slim.repasses,codGift,receitaReal,receitaMes,receitaAvulsa,qtdPagantes});
  }
  // ── Admin: Gemini LÊ a documentação mestre e devolve as conclusões dele ──
  if(pathname==="/api/admin/gemini-doc-report"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    if(!getGeminiKey())return json(res,503,{error:"Gemini API não configurada (GEMINI_API_KEY)."});
    let doc="";
    try{ doc=fs.readFileSync(path.join(__dirname,"DOCUMENTACAO_MESTRA_H2BAPPLY.md"),"utf8"); }
    catch(e){ return json(res,404,{error:"Documentação mestre não encontrada no servidor."}); }
    const systemPrompt=`Você é um Arquiteto de Software Sênior e Auditor de Sistemas. Vou te dar a DOCUMENTAÇÃO MESTRA do H2BApply (um SaaS Node.js monólito, frontend HTML/JS vanilla, persistência em JSON, integrações Google OAuth/Gmail, Gemini e DOL). Leia TODA a documentação e produza um RELATÓRIO com as SUAS PRÓPRIAS CONCLUSÕES — não repita a documentação, analise-a criticamente. Estruture assim, em português do Brasil, direto e prático:\n\n1. RESUMO EXECUTIVO (3-5 linhas: o que é, em que estado está).\n2. PONTOS FORTES (o que está bem feito).\n3. RISCOS CRÍTICOS (o que pode quebrar/escalar mal, em ordem de gravidade).\n4. TOP 5 PRIORIDADES (o que atacar primeiro, com motivo).\n5. PROBLEMAS OCULTOS QUE VOCÊ NOTOU (que a doc não destacou).\n6. RECOMENDAÇÃO DE ARQUITETURA (próximo passo de escala).\n7. NOTA GERAL (0-10) com justificativa de 1 linha.\n\nSeja honesto e específico. Cite arquivos/funções/rotas quando relevante.`;
    const contents=[{role:"user",parts:[{text:"Aqui está a documentação mestre para você analisar:\n\n"+doc.slice(0,120000)}]}];
    const GEMINI_MODELS=["gemini-2.5-flash","gemini-2.0-flash","gemini-2.5-flash-lite"];
    let text="",lastErr="";
    for(const modelName of GEMINI_MODELS){
      try{
        const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiKey()}`;
        const payload={system_instruction:{parts:[{text:systemPrompt}]},contents,generationConfig:{temperature:0.6,maxOutputTokens:3000,topP:0.95}};
        const result=await new Promise((resolve,reject)=>{
          const body=JSON.stringify(payload);const url=new URL(geminiUrl);
          const opts={hostname:url.hostname,path:url.pathname+url.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
          const req2=https.request(opts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida"));}});});
          req2.on("error",reject);req2.setTimeout(40000,()=>{req2.destroy();reject(new Error("Timeout"));});
          req2.write(body);req2.end();
        });
        if(result.status===200){text=result.body?.candidates?.[0]?.content?.parts?.[0]?.text||"";if(text){console.log(`[gemini-doc] ✅ ${modelName}`);break;}}
        else{lastErr=result.body?.error?.message||`HTTP ${result.status}`;}
      }catch(e){lastErr=e.message;}
    }
    if(!text)return json(res,502,{error:"Erro na análise: "+lastErr});
    return json(res,200,{ok:true,report:text,docBytes:doc.length,generatedAt:new Date().toISOString()});
  }

  // POST /api/admin/fin/ai-review — a IA (Gemini) analisa uma edição financeira
  // e conversa com o admin sobre ela. Corpo: {contexto:{tipo,antes,depois,motivo},
  // conversa:[{de:'admin'|'ia',texto}]}. Retorna {ok,resposta,veredito}.
  if(pathname==="/api/admin/fin/ai-review"&&req.method==="POST"){
    const s3=getSess(req);if(!s3?.user_email)return json(res,401,{error:"Não autenticado."});
    const p3=getUser(s3.user_email);if(!isAdminVip(p3))return json(res,403,{error:"Acesso negado."});
    if(!getGeminiKey())return json(res,503,{error:"Gemini API não configurada."});
    try{
      const d=JSON.parse(await readBody(req));
      const ctx=d.contexto||{};
      const conversa=Array.isArray(d.conversa)?d.conversa.slice(-8):[];
      const sys=`Você é o auditor financeiro interno do H2BApply (sócios: Andrio e Diego). Um admin acabou de EDITAR um registro financeiro e você deve revisar RAPIDINHO, em português do Brasil, em no máximo 4 frases. Analise: o valor novo faz sentido? A data faz sentido? O motivo explica a mudança? Há risco de erro (ex.: valor 10x maior/menor, moeda trocada, data no futuro)? Se estiver tudo coerente, diga que está OK e por quê em 1-2 frases. Se algo parecer estranho, FAÇA UMA PERGUNTA direta ao admin. Comece SEMPRE a resposta com [OK] ou [DÚVIDA]. Nunca invente dados.`;
      const contents=[];
      contents.push({role:"user",parts:[{text:"EDIÇÃO PARA REVISAR:\nTipo: "+String(ctx.tipo||"?")+"\nANTES: "+JSON.stringify(ctx.antes||{}).slice(0,1500)+"\nDEPOIS: "+JSON.stringify(ctx.depois||{}).slice(0,1500)+"\nMOTIVO do admin: "+String(ctx.motivo||"(não informado)").slice(0,300)}]});
      for(const m of conversa){contents.push({role:m.de==="ia"?"model":"user",parts:[{text:String(m.texto||"").slice(0,800)}]});}
      const GEMINI_MODELS=["gemini-2.5-flash","gemini-2.0-flash","gemini-2.5-flash-lite"];
      let text="",lastErr="";
      for(const modelName of GEMINI_MODELS){
        try{
          const url=new URL(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiKey()}`);
          const body=JSON.stringify({system_instruction:{parts:[{text:sys}]},contents,generationConfig:{temperature:0.3,maxOutputTokens:400}});
          const result=await new Promise((resolve,reject)=>{
            const req2=https.request({hostname:url.hostname,path:url.pathname+url.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida"));}});});
            req2.on("error",reject);req2.setTimeout(25000,()=>{req2.destroy();reject(new Error("Timeout"));});
            req2.write(body);req2.end();
          });
          if(result.status===200){text=result.body?.candidates?.[0]?.content?.parts?.[0]?.text||"";if(text)break;}
          else lastErr=result.body?.error?.message||("HTTP "+result.status);
        }catch(e){lastErr=e.message;}
      }
      if(!text)return json(res,502,{error:"IA indisponível: "+lastErr});
      const veredito=/^\s*\[OK\]/i.test(text)?"ok":"duvida";
      return json(res,200,{ok:true,resposta:text.replace(/^\s*\[(OK|DÚVIDA|DUVIDA)\]\s*/i,"").trim(),veredito});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: Inteligência Financeira — 20 análises (fonte única no servidor) ──
  if(pathname==="/api/admin/fin-insights"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const now=Date.now();
    const pv=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
    const ts=x=>{if(!x)return 0;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?0:t;};
    const PRICE={vip:100,pro:150,vipro:150,doublepro:250};
    const finBy={},pedBy={};
    // RAIZ ÚNICA DE VALOR: se o pagamento do livro-caixa está ligado a um pedido
    // (pedidoId) e o pedido foi CORRIGIDO depois, o valor do pedido vence — assim
    // a correção feita na ficha do cliente reflete no Top 5 e na receita.
    const _pedById={};for(const ped of (DB_PEDIDOS||[])){if(ped&&ped.id)_pedById[ped.id]=ped;}
    for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){if(!pg||!pg.email)continue;const e=String(pg.email).toLowerCase();
      let v=pv(pg.valor);
      const _ped=pg.pedidoId?_pedById[pg.pedidoId]:null;
      if(_ped&&pv(_ped.valorTotal)>0&&pv(_ped.valorTotal)!==v)v=pv(_ped.valorTotal);
      (finBy[e]=finBy[e]||[]).push({valor:v,date:ts(pg.dataPagamento)||ts(pg.data)||pg.criadoEm||0});}
    for(const ped of Object.values(DB_PEDIDOS||{})){if(!ped||!ped.userEmail)continue;const st=String(ped.status||"").toLowerCase();if(st!=="pago"&&st!=="ativo")continue;const e=String(ped.userEmail).toLowerCase();(pedBy[e]=pedBy[e]||[]).push({valor:pv(ped.valorTotal),date:ts(ped.ativadoEm)||ts(ped.pagoEm)||0});}
    const ms=new Date();ms.setDate(1);ms.setHours(0,0,0,0);const monthStart=ms.getTime();
    let receitaTotal=0,receitaMes=0,qtdPagantes=0,novosMes=0,vencendo7=0,vencendo7Valor=0,vencidos=0,trials=0,gift=0,giftDias=0;
    const porPlano={vip:0,vipro:0,doublepro:0,pro:0}, porPlanoQtd={vip:0,vipro:0,doublepro:0,pro:0};
    const topPagantes=[];
    for(const u of Object.values(DB_USERS||{})){
      if(!u||!u.email)continue;const elc=u.email.toLowerCase();const vip=u.vip||{};const src=String(vip.source||"").toLowerCase();
      if(src==="trial"){ if(isVipActive(u)) trials++; continue; }
      if(src==="code"){ gift++; giftDias+=(vip.days||0); continue; }
      let pags=finBy[elc]||[];if(!pags.length)pags=pedBy[elc]||[];if(!pags.length&&u.paymentAmount)pags=[{valor:pv(u.paymentAmount),date:ts(vip.activatedAt)||0}];
      pags=pags.filter(x=>x.valor>0);
      const everPaid=(src===""||src==="admin"||src==="pago"||src==="payment")&&((vip.manualExpires||0)>0||(vip.autoExpires||0)>0||vip.activatedAt);
      if(!pags.length&&!everPaid)continue;
      const tot=pags.reduce((a,x)=>a+x.valor,0);
      if(tot>0){qtdPagantes++;topPagantes.push({nome:u.name||u.email,email:u.email,valor:tot,plano:vip.plan||getPlan(u)});}
      receitaTotal+=tot;
      let firstDate=pags.length?Math.min(...pags.map(x=>x.date||now)):(ts(vip.activatedAt)||0);
      if(firstDate>=monthStart) novosMes++;
      for(const x of pags){if((x.date||0)>=monthStart)receitaMes+=x.valor;}
      const plan=vip.plan||getPlan(u); if(porPlano[plan]!==undefined){porPlano[plan]+=tot;porPlanoQtd[plan]++;}
      const nextExp=Math.max(vip.manualExpires||0,vip.autoExpires||0);
      if(nextExp>0){const dleft=Math.ceil((nextExp-now)/86400000); if(dleft<=0)vencidos++; else if(dleft<=7){vencendo7++;vencendo7Valor+=(PRICE[plan]||100);}}
    }
    topPagantes.sort((a,b)=>b.valor-a.valor);
    // ── ENTRADAS AVULSAS (sem email de usuário): entram na receita como
    // categoria própria — mesma correção do GET /api/admin/financeiro.
    let receitaAvulsa=0; const _avulsas=[];
    {
      const _uEm=new Set(Object.keys(DB_USERS||{}).map(e=>e.toLowerCase()));
      for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
        if(!pg) continue;
        const e=String(pg.email||"").toLowerCase();
        if(e&&_uEm.has(e)) continue;
        const v=pv(pg.valor); if(v<=0) continue;
        const dt=ts(pg.dataPagamento)||ts(pg.data)||pg.criadoEm||0;
        receitaAvulsa+=v; receitaTotal+=v; _avulsas.push({valor:v,date:dt});
        if(dt>=monthStart) receitaMes+=v;
      }
    }
    // Despesas
    const gastos=(DB_FINANCEIRO&&DB_FINANCEIRO.gastos)||[];
    let despTotal=0,despMes=0; const despCat={},despSocio={andrio:0,diego:0,empresa:0};
    for(const g of gastos){const v=pv(g.valor);despTotal+=v;const dt=ts(g.dataGasto)||ts(g.data)||g.criadoEm||0;if(dt>=monthStart)despMes+=v;const c=(g.categoria||g.cat||"geral");despCat[c]=(despCat[c]||0)+v;const pp=(g.pagoPor||"empresa").toLowerCase();if(despSocio[pp]!==undefined)despSocio[pp]+=v;}
    const lucro=Math.max(0,receitaTotal-despTotal);
    // Série últimos 6 meses (receita por mês, do livro-caixa+pedidos por data)
    const serie=[]; for(let i=5;i>=0;i--){const d0=new Date();d0.setMonth(d0.getMonth()-i,1);d0.setHours(0,0,0,0);const a=d0.getTime();const d1=new Date(d0);d1.setMonth(d1.getMonth()+1);const b=d1.getTime();let soma=0;for(const e in finBy)for(const x of finBy[e])if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;if(!Object.keys(finBy).length){for(const e in pedBy)for(const x of pedBy[e])if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;}for(const x of _avulsas)if((x.date||0)>=a&&(x.date||0)<b)soma+=x.valor;serie.push({mes:d0.toLocaleDateString("pt-BR",{month:"short",year:"2-digit"}),valor:soma});}
    return json(res,200,{ok:true,insights:{
      receitaTotal,receitaMes,receitaAvulsa,despTotal,despMes,lucro:Math.max(0,receitaTotal-despTotal),metade:Math.max(0,receitaTotal-despTotal)/2,
      qtdPagantes,ticketMedio:qtdPagantes?Math.round(receitaTotal/qtdPagantes):0,
      novosMes,vencendo7,vencendo7Valor,vencidos,trials,gift,giftDias,
      porPlano,porPlanoQtd,despCat,despSocio,
      topPagantes:topPagantes.slice(0,5),serie,
      mrrEstimado:porPlano.vip*0+receitaMes, // receita reconhecida no mês
      projecaoRenovacao:vencendo7Valor,
      geradoEm:new Date().toISOString()
    }});
  }

  // GET /api/admin/gasto/:id — comprovante de um gasto sob demanda (não vai na lista)
  if(pathname.startsWith("/api/admin/gasto/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const gid=decodeURIComponent(pathname.slice("/api/admin/gasto/".length));
    const gs=(DB_FINANCEIRO.gastos||[]).find(x=>x.id===gid);
    if(!gs)return json(res,404,{error:"Gasto não encontrado."});
    return json(res,200,{ok:true,gasto:gs});
  }
  // GET /api/admin/pagamento/:id — comprovante de um pagamento sob demanda (espelha o gasto)
  if(pathname.startsWith("/api/admin/pagamento/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const pid=decodeURIComponent(pathname.slice("/api/admin/pagamento/".length));
    const pg=(DB_FINANCEIRO.pagamentos||[]).find(x=>x.id===pid);
    if(!pg)return json(res,404,{error:"Pagamento não encontrado."});
    return json(res,200,{ok:true,pagamento:pg});
  }
  if(pathname==="/api/admin/financeiro"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      // SEGURANÇA: nunca substitui arrays completos — só adiciona/atualiza itens
      // Logger da trilha de auditoria (append-only) — usado também nos ADDS,
      // que antes NÃO eram auditados (só edição/exclusão apareciam no Histórico).
      const _quemAdd = s.user_email===ADMIN_EMAIL ? "Andrio"
                     : (typeof ADMIN_EMAIL_2!=="undefined"&&ADMIN_EMAIL_2&&s.user_email===ADMIN_EMAIL_2) ? "Diego"
                     : s.user_email;
      const _logAdd=(tipo,registro,motivo)=>{
        if(!Array.isArray(DB_FINANCEIRO.alteracoes)) DB_FINANCEIRO.alteracoes=[];
        const {comprovante,img,...limpo}=registro||{};
        DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          tipo, por:_quemAdd, porEmail:s.user_email, em:Date.now(),
          motivo:String(motivo||'').slice(0,300), antes:null, depois:limpo});
      };
      // GARANTIA DE VERDADE (2026-07-08): se persistFinanceiro() falhar (disco
      // cheio, sem permissão etc.), desfaz a mutação em memória (senão a tela
      // mostraria "salvo" com o dado só vivendo até o próximo restart) e avisa
      // com erro real em vez de ok:true. rollback() deve devolver o array/objeto
      // ao estado de antes da mutação, incluindo remover o log de alteracoes.
      const _persistFinOuFalha=(rollback)=>{
        if(persistFinanceiro()) return null; // gravou de verdade — segue o jogo
        try{ rollback&&rollback(); }catch(e){ console.error('[financeiro] rollback falhou:',e.message); }
        return json(res,500,{error:"⚠️ Não consegui gravar no disco — a alteração NÃO foi salva. Tente de novo; se persistir, avise o Andrio (pode ser disco cheio ou sem permissão no servidor)."});
      };
      if(d.action==='add_pagamento' && d.pagamento){
        // Adicionar um pagamento individual (mesmo padrão de proveniência do gasto)
        const pg=d.pagamento;
        // VALIDAÇÃO REAL (v948): antes, entrada inválida podia entrar muda ou
        // sumir sem explicação. Agora o servidor diz exatamente o que faltou.
        const _valor=Math.round((parseFloat(pg.valor)||0)*100)/100;
        if(_valor<=0) return json(res,400,{error:"Valor da entrada deve ser maior que zero."});
        if(_valor>1_000_000) return json(res,400,{error:"Valor da entrada inválido."});
        pg.valor=_valor;
        pg.email=String(pg.email||"").trim().toLowerCase();
        // ENTRADA AVULSA (sem email): permitida — é dinheiro recebido FORA do
        // site (Pix/PicPay direto pro sócio, saldo inicial, acerto externo).
        // Exige descrição para o outro sócio entender o que é, e NUNCA ativa VIP.
        if(!pg.email){
          if(!pg.nota||String(pg.nota).trim().length<3)
            return json(res,400,{error:"Entrada avulsa (sem email) exige uma descrição — o outro sócio precisa entender do que se trata."});
          pg.tipo='avulsa';
        } else { pg.tipo=pg.tipo==='avulsa'?'avulsa':'cliente'; }
        pg.recebidoPor=(String(pg.recebidoPor||"").toLowerCase()==='diego')?'diego':'andrio';
        if(!pg.id) pg.id='fin_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!pg.criadoEm) pg.criadoEm=Date.now();
        // Quem LANÇOU vem da sessão — não pode ser forjado pelo corpo (mesmo padrão do gasto).
        pg.lancadoPorEmail=s.user_email;
        pg.lancadoPor = s.user_email===ADMIN_EMAIL ? "Andrio"
                       : (ADMIN_EMAIL_2 && s.user_email===ADMIN_EMAIL_2) ? "Diego"
                       : (pg.lancadoPor||s.user_email);
        // Comprovante OPCIONAL, mesma validação do gasto (antes ficava só no
        // localStorage de quem lançou — o outro sócio nunca via a imagem).
        if(pg.comprovante && typeof pg.comprovante==='string'){
          if(pg.comprovante.length>10_700_000 || !/^[A-Za-z0-9+/]/.test(pg.comprovante.slice(0,10))) pg.comprovante=null;
        } else { pg.comprovante = null; }
        const _allowP=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        pg.comprovanteType = pg.comprovante ? (_allowP.includes(pg.comprovanteType)?pg.comprovanteType:'image/jpeg') : null;
        pg.temComprovante = !!pg.comprovante;
        DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos||[];
        DB_FINANCEIRO.pagamentos.unshift(pg);
        _logAdd('add_pagamento',pg,(pg.tipo==='avulsa'?'Entrada avulsa: ':'Entrada de cliente: ')+'R$'+pg.valor.toFixed(2)+' · recebido por '+pg.recebidoPor+(pg.nota?' · '+String(pg.nota).slice(0,80):''));
        const _errAP=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos.filter(x=>x.id!==pg.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAP) return _errAP;
        return json(res,200,{ok:true,id:pg.id,temComprovante:pg.temComprovante});
      }
      if(d.action==='add_gasto' && d.gasto){
        // Adicionar um gasto individual (com proveniência completa)
        const gs=d.gasto;
        const _gv=Math.round((parseFloat(gs.valor)||0)*100)/100;
        if(_gv<=0) return json(res,400,{error:"Valor do gasto deve ser maior que zero."});
        if(_gv>1_000_000) return json(res,400,{error:"Valor do gasto inválido."});
        gs.valor=_gv;
        if(!gs.id) gs.id='gst_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!gs.criadoEm) gs.criadoEm=Date.now();
        // Quem LANÇOU vem da sessão — não pode ser forjado pelo corpo.
        gs.lancadoPorEmail=s.user_email;
        gs.lancadoPor = s.user_email===ADMIN_EMAIL ? "Andrio"
                       : (ADMIN_EMAIL_2 && s.user_email===ADMIN_EMAIL_2) ? "Diego"
                       : (gs.lancadoPor||s.user_email);
        // Data do GASTO separada da data de lançamento (pertence ao mês em que ocorreu).
        gs.dataGasto = gs.dataGasto || new Date(gs.criadoEm).toISOString();
        // Quem BANCOU o gasto (acerto entre sócios): andrio | diego | empresa.
        gs.pagoPor = ["andrio","diego","empresa"].includes((gs.pagoPor||"").toLowerCase())
                     ? (gs.pagoPor||"").toLowerCase() : "empresa";
        gs.categoria = String(gs.categoria||"geral").slice(0,40);
        // Comprovante OPCIONAL (selo no front). Guarda só se válido e leve (~6MB).
        if(gs.comprovante && typeof gs.comprovante==='string'){
          if(gs.comprovante.length>10_700_000 || !/^[A-Za-z0-9+/]/.test(gs.comprovante.slice(0,10))) gs.comprovante=null;
        } else { gs.comprovante = null; }
        const _allowG=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        gs.comprovanteType = gs.comprovante ? (_allowG.includes(gs.comprovanteType)?gs.comprovanteType:'image/jpeg') : null;
        gs.temComprovante = !!gs.comprovante;
        DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos||[];
        DB_FINANCEIRO.gastos.unshift(gs);
        _logAdd('add_gasto',gs,'Gasto: R$'+gs.valor.toFixed(2)+' · pago por '+gs.pagoPor+' · '+gs.categoria+(gs.descricao?' · '+String(gs.descricao).slice(0,80):''));
        const _errAG=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos.filter(x=>x.id!==gs.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAG) return _errAG;
        return json(res,200,{ok:true,id:gs.id,temComprovante:gs.temComprovante});
      }
      // ── Trilha de auditoria: NADA é apagado/editado sem histórico ──
      // Cada alteração grava: quem (sessão, não forjável), quando, motivo,
      // valor anterior e novo. A trilha (alteracoes[]) é append-only.
      const _quem = s.user_email===ADMIN_EMAIL ? "Andrio"
                  : (typeof ADMIN_EMAIL_2!=="undefined"&&ADMIN_EMAIL_2&&s.user_email===ADMIN_EMAIL_2) ? "Diego"
                  : s.user_email;
      const _logAlt=(tipo,antes,depois,motivo)=>{
        if(!Array.isArray(DB_FINANCEIRO.alteracoes)) DB_FINANCEIRO.alteracoes=[];
        const strip=o=>{if(!o)return o;const{comprovante,img,...r}=o;return r;};
        DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          tipo, por:_quem, porEmail:s.user_email, em:Date.now(),
          motivo:String(motivo||'').slice(0,300), antes:strip(antes), depois:strip(depois)});
      };
      // ── REPASSES ENTRE SÓCIOS ─────────────────────────────────────────
      // Registra dinheiro que um sócio JÁ pagou ao outro (ex.: Diego→Andrio),
      // para o "Acerto entre sócios" descontar o que já foi acertado.
      if(d.action==='add_repasse' && d.repasse){
        const rp=d.repasse;
        const valor=Math.round((parseFloat(rp.valor)||0)*100)/100;
        if(valor<=0) return json(res,400,{error:"Valor do repasse deve ser maior que zero."});
        if(valor>1_000_000) return json(res,400,{error:"Valor do repasse inválido."});
        const de=(String(rp.de||"").toLowerCase()==="andrio")?"andrio":"diego";
        const para=de==="andrio"?"diego":"andrio";
        let dataRepasse=new Date().toISOString();
        if(rp.dataRepasse){ const t=new Date(rp.dataRepasse).getTime(); if(!isNaN(t)) dataRepasse=new Date(t).toISOString(); }
        const novo={
          id:'rep_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          de, para, valor, dataRepasse,
          nota:String(rp.nota||"").slice(0,200),
          lancadoPorEmail:s.user_email, lancadoPor:_quem, criadoEm:Date.now()
        };
        DB_FINANCEIRO.repasses=DB_FINANCEIRO.repasses||[];
        DB_FINANCEIRO.repasses.unshift(novo);
        _logAlt('add_repasse',null,novo,'Repasse registrado: '+de+' → '+para+' R$'+valor.toFixed(2));
        const _errAR=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.repasses=DB_FINANCEIRO.repasses.filter(x=>x.id!==novo.id);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errAR) return _errAR;
        console.log(`[fin] repasse ${de}→${para} R$${valor.toFixed(2)} por ${s.user_email}`);
        return json(res,200,{ok:true,id:novo.id});
      }
      if(d.action==='delete_repasse' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.repasses||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Repasse não encontrado."});
        DB_FINANCEIRO.repasses=(DB_FINANCEIRO.repasses||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_repasse',alvo,null,d.motivo);
        const _errDR=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.repasses.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDR) return _errDR;
        return json(res,200,{ok:true});
      }
      if(d.action==='delete_pagamento' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.pagamentos||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Pagamento não encontrado."});
        DB_FINANCEIRO.pagamentos=(DB_FINANCEIRO.pagamentos||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_pagamento',alvo,null,d.motivo);
        const _errDP=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.pagamentos.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDP) return _errDP;
        return json(res,200,{ok:true});
      }
      if(d.action==='delete_gasto' && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da exclusão (obrigatório para o histórico)."});
        const alvo=(DB_FINANCEIRO.gastos||[]).find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Gasto não encontrado."});
        DB_FINANCEIRO.gastos=(DB_FINANCEIRO.gastos||[]).filter(x=>x.id!==d.id);
        _logAlt('excluir_gasto',alvo,null,d.motivo);
        const _errDG=_persistFinOuFalha(()=>{
          DB_FINANCEIRO.gastos.unshift(alvo);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errDG) return _errDG;
        return json(res,200,{ok:true});
      }
      // ── Editar pagamento/gasto (valor, data, nota) com histórico ──
      if((d.action==='edit_pagamento'||d.action==='edit_gasto') && d.id){
        if(!d.motivo||String(d.motivo).trim().length<3) return json(res,400,{error:"Informe o motivo da edição (obrigatório para o histórico)."});
        const arr=d.action==='edit_pagamento'?(DB_FINANCEIRO.pagamentos||[]):(DB_FINANCEIRO.gastos||[]);
        const alvo=arr.find(x=>x.id===d.id);
        if(!alvo) return json(res,404,{error:"Registro não encontrado."});
        const antes={...alvo};
        const ALLOWED=['valor','desconto','dataPagamento','dataGasto','data','nota','descricao','categoria','plano','email','nome','pagoPor','recebidoPor','moeda','valorUSD','cambio','fonte'];
        for(const k of ALLOWED){ if(d.changes&&d.changes[k]!==undefined){ alvo[k]=['valor','desconto','valorUSD','cambio'].includes(k)?(parseFloat(d.changes[k])||0):d.changes[k]; } }
        // Moeda: gasto/entrada pode ser em DÓLAR — o valor em R$ é derivado do câmbio
        if(String(alvo.moeda||'').toUpperCase()==='USD'&&alvo.valorUSD>0){
          if(!(alvo.cambio>0))alvo.cambio=5.17; // câmbio padrão editável
          alvo.valor=Math.round(alvo.valorUSD*alvo.cambio*100)/100;
        }
        alvo.editadoEm=Date.now(); alvo.editadoPor=_quem;
        _logAlt(d.action,antes,{...alvo},d.motivo);
        const _errED=_persistFinOuFalha(()=>{
          // Restaura TODOS os campos ao estado anterior (remove os que a edição
          // adicionou e não existiam antes, restaura os que existiam).
          Object.keys(alvo).forEach(k=>delete alvo[k]);
          Object.assign(alvo,antes);
          DB_FINANCEIRO.alteracoes.pop();
        });
        if(_errED) return _errED;
        return json(res,200,{ok:true,registro:(()=>{const{comprovante,img,...r}=alvo;return r;})()});
      }
      // ── Anexar/trocar comprovante em registro existente ──
      if(d.action==='attach_comprovante' && d.id){
        const arr2=d.tipo==='pagamento'?(DB_FINANCEIRO.pagamentos||[]):(DB_FINANCEIRO.gastos||[]);
        const alvo2=arr2.find(x=>x.id===d.id);
        if(!alvo2) return json(res,404,{error:"Registro não encontrado."});
        if(!d.comprovante||typeof d.comprovante!=='string'||d.comprovante.length>10_700_000||!/^[A-Za-z0-9+/]/.test(d.comprovante.slice(0,10)))
          return json(res,400,{error:"Comprovante inválido (máx ~8MB)."});
        const _allow2=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
        alvo2.comprovante=d.comprovante;
        alvo2.comprovanteType=_allow2.includes(d.comprovanteType)?d.comprovanteType:'image/jpeg';
        alvo2.temComprovante=true;
        _logAlt('attach_comprovante',null,{id:d.id,tipo:d.tipo},'Comprovante anexado/substituído');
        persistFinanceiro();
        return json(res,200,{ok:true});
      }
      // ── Consultar trilha de alterações ──
      if(d.action==='get_alteracoes'){
        return json(res,200,{ok:true,alteracoes:(DB_FINANCEIRO.alteracoes||[]).slice(-200).reverse()});
      }
      // REMOVIDO v945: caminho legado _replace (substituição TOTAL dos arrays) —
      // era um risco de apagar gastos/pagamentos inteiros; nada no front usa.
      persistFinanceiro();
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── Admin: editar campo de usuário ───────────────────────
  if(pathname==="/api/admin/set-user-field"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,field,value}=d;
      if(!email||!field)return json(res,400,{error:"email e field obrigatórios"});
      const ALLOWED=['name','phone','city','country','isAdmin','whatsapp'];
      if(!ALLOWED.includes(field))return json(res,400,{error:"Campo não permitido: "+field});
      const target=getUser(email);if(!target)return json(res,404,{error:"Usuário não encontrado"});
      setUser(email,{[field]:value});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: revogar VIP ────────────────────────────────────
  if(pathname==="/api/admin/revoke-vip"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      setUser(email,{plan:'free',vip:{active:false,manualExpires:0,autoExpires:0}});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: definir plano ──────────────────────────────────
  if(pathname==="/api/admin/set-plan"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,plan}=d;if(!email||!plan)return json(res,400,{error:"email e plan obrigatórios"});
      const VALID_PLANS=['free','vip','vipro','doublepro','pro'];
      if(!VALID_PLANS.includes(plan))return json(res,400,{error:"Plano inválido"});
      const tgt=getUser(email);if(!tgt)return json(res,404,{error:"Usuário não encontrado"});
      if(plan!=='free'){addManualVipDays(email,30);if(['vipro','doublepro','pro'].includes(plan))addAutoVipDays(email,30);}
      setUser(email,{plan,vip:{...(tgt.vip||{}),active:plan!=='free',plan,source:'admin',activatedBy:s.user_email}});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: push para usuário ──────────────────────────────
  if(pathname==="/api/admin/push-user"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,title,body}=d;if(!email||!title)return json(res,400,{error:"email e title obrigatórios"});
      await pushToUser(email,{type:"admin_notif",title,body:body||"",icon:"/icon-192.png"});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: limpar PDFs ─────────────────────────────────────
  if(pathname==="/api/admin/reset-pdfs"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      const tgt=getUser(email);if(!tgt)return json(res,404,{error:"Usuário não encontrado"});
      (tgt.cvs||[]).forEach(c=>{try{deleteCv(email,c.idx);}catch{}});
      setUser(email,{cvs:[]});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: deletar usuário ─────────────────────────────────
  if(pathname==="/api/admin/delete-user"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins hardcoded podem deletar contas."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      if(isAdminEmail(email))return json(res,403,{error:"Não é possível deletar uma conta admin."});
      delUser(email);
      delete DB_HIST[email];persist(HIST_FILE,DB_HIST);
      delete DB_SENT[email];persistSent();
      delete DB_LOGS[email];persistLogs();
      delete DB_AUTO[email];persist(AUTO_FILE,DB_AUTO);
      // ── Banir email permanentemente — não consegue recriar conta ──
      const emailLow = email.trim().toLowerCase();
      if(!DB_BLOCKED.emails.includes(emailLow)){
        DB_BLOCKED.emails.push(emailLow);
        persist(BLOCKED_FILE, DB_BLOCKED);
      }
      console.log(`[admin] 🚫 Email banido permanentemente: ${emailLow}`);
      return json(res,200,{ok:true,banned:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: limpar sent de usuário ──────────────────────────
  if(pathname==="/api/admin/clear-sent"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email}=d;if(!email)return json(res,400,{error:"email obrigatório"});
      DB_SENT[email]=new Set();persistSent();
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── Admin: definir limite auto de usuário ──────────────────
  if(pathname==="/api/admin/set-auto-limit"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {email,limit}=d;if(!email||!limit)return json(res,400,{error:"obrigatórios: email, limit"});
      const job=getAutoJob(email);
      if(job)setAutoJob(email,{...job,lockedAutoLimit:parseInt(limit)});
      setUser(email,{customAutoLimit:parseInt(limit)});
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }

  if(pathname==="/api/admin/my-settings"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p||!isAdminVip(p))return json(res,403,{error:"Acesso negado. Apenas admins."});
    try{
      const d=JSON.parse(await readBody(req));
      const current=p.adminSettings||{};
      const updated={...current};
      // Intervalo entre envios (segundos, mín 30)
      if(d.intervalSecs!==undefined){updated.intervalSecs=Math.max(30,parseInt(d.intervalSecs)||180);}
      // Limites por sender {email: N}
      if(d.senderLimits!==undefined&&typeof d.senderLimits==="object"){
        updated.senderLimits={};
        for(const [em,lim] of Object.entries(d.senderLimits)){
          const n=parseInt(lim);if(n>0&&n<=9999)updated.senderLimits[em.toLowerCase().trim()]=n;
        }
      }
      setUser(s.user_email,{adminSettings:updated});
      return json(res,200,{ok:true,adminSettings:updated});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // ── ADMIN: ranking entre admins ──────────────────────────────────────────────
  if(pathname==="/api/admin/my-ranking"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p||!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const period=["day","week","month","all"].includes(u.searchParams.get("period"))?u.searchParams.get("period"):"day";
    const list=calcAdminRanking(period);
    const myPos=list.findIndex(r=>r.email===s.user_email);
    return json(res,200,{ok:true,list,period,myPos:myPos>=0?myPos+1:null,total:list.length});
  }

  if(pathname==="/api/admin/my-settings"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!p||!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{ok:true,adminSettings:p.adminSettings||{}});
  }

  // ── PEDIDOS DE PLANO ───────────────────────────────────────
  // POST /api/pedido — usuário cria pedido de plano
  if(pathname==="/api/pedido"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      // Por padrão, o pedido pertence a quem está logado (fluxo normal: usuário comprando seu próprio plano).
      // Exceção: ADMIN pode criar um pedido retroativo EM NOME de outro usuário (fluxo "Regularizar" do
      // Robô Contábil), enviando userEmail no corpo. Só admin pode usar esse override — usuário comum jamais
      // pode forjar o userEmail de outra pessoa.
      let targetEmail=s.user_email;
      if(d.userEmail){
        const reqUser=getUser(s.user_email);
        const reqIsAdmin=isAdminVip(reqUser)||isAdminEmail(s.user_email);
        const te=(d.userEmail||"").trim().toLowerCase();
        if(reqIsAdmin && te){
          // Admin pode criar pedido para qualquer email válido
          // (usuário pode não estar no DB local ainda)
          targetEmail=te;
        }
      }
      // ── DEDUP (#3): se o próprio usuário já tem um pedido EM ANÁLISE, não cria
      // outro — devolve o pendente existente. Regularização do admin EM NOME de
      // outro usuário (targetEmail != quem chamou) passa direto, sem dedup.
      if(targetEmail===s.user_email){
        const jaPendente=DB_PEDIDOS.find(x=>x.userEmail===targetEmail && x.status==="pendente");
        if(jaPendente){
          return json(res,200,{ok:true,duplicado:true,pedido:jaPendente,
            message:"Você já tem um pedido em análise. Acompanhe o status do pedido existente."});
        }
      }
      const pedido={
        id:"ped_"+Date.now().toString(36)+"_"+crypto.randomBytes(4).toString("hex"),
        createdAt:Date.now(),
        status:"pendente", // pendente | pago | ativo | cancelado | expirado
        userEmail:targetEmail,
        criadoPor:s.user_email, // quem de fato fez a chamada (admin ou o próprio usuário)
        userName:d.userName||"",
        userWhatsapp:d.userWhatsapp||"",
        userPhone:d.userPhone||"",
        userCity:d.userCity||"",
        userState:d.userState||"",
        userAddress:d.userAddress||"",
        plano:d.plano||"vipro",          // vip | vipro | doublepro
        dias:parseInt(d.dias)||30,        // 30 | 60 | 90 | 365
        valorTotal:parseFloat(d.valorTotal)||0,
        desconto:parseFloat(d.desconto)||0,
        comprovante:(()=>{
          const c=d.comprovante;
          if(!c) return null;
          // Limitar tamanho: max 8MB em base64 (~6MB de arquivo real)
          if(typeof c==='string' && c.length>10_700_000) return null;
          // Validar que começa com base64 válido
          if(typeof c==='string' && !/^[A-Za-z0-9+/]/.test(c.slice(0,10))) return null;
          return c;
        })(),
        comprovanteType:(()=>{
          const t=d.comprovanteType||'image/jpeg';
          const allowed=['image/jpeg','image/jpg','image/png','image/webp','application/pdf'];
          return allowed.includes(t)?t:'image/jpeg';
        })(),
        nota:d.nota||"",
        notaAdmin:"",
        ativadoPor:null,
        ativadoEm:null,
        pagoEm:d.pagoEm||null,
      };
      DB_PEDIDOS.unshift(pedido);
      persistPedidos();

      // ── PRÉ-CHECK DO COMPROVANTE (Gemini Vision) — roda na CRIAÇÃO ────────
      // Lê a imagem do comprovante, extrai valor/data e compara com o preço
      // esperado do plano. Entrega o veredito MASTIGADO pro admin no modal de
      // aprovação. Background, aditivo: se Gemini off/falhar, não trava nada.
      ;(async()=>{
        try{
          const gKey=getGeminiKey(); if(!gKey) return;
          if(!pedido.comprovante){ 
            setPedidoPreCheck(pedido.id,{veredito:"SEM_COMPROVANTE",resumo:"Pedido sem comprovante anexado.",bateComEsperado:false,alertas:["Cliente não enviou comprovante."]});
            return;
          }
          // PDF: Gemini Vision aqui só trata imagem — sinaliza revisão manual.
          if((pedido.comprovanteType||"").includes("pdf")){
            setPedidoPreCheck(pedido.id,{veredito:"REVISAR_MANUAL",resumo:"Comprovante em PDF — confira manualmente.",bateComEsperado:false,alertas:["PDF não lido automaticamente."]});
            return;
          }
          // Tabela de preços oficial
          const TAB={vip:{30:100,60:190,90:270,365:960},vipro:{30:150,60:285,90:405,365:1440},doublepro:{30:250,60:475,90:675,365:2400}};
          const precoEsp=(TAB[pedido.plano]||{})[pedido.dias]||null;
          const b64=String(pedido.comprovante).replace(/^data:[^;]+;base64,/,"");
          // ── ANTI-FRAUDE: impressão digital do comprovante (detecta reuso) ──
          let dupAlerta=null;
          try{
            const hash=crypto.createHash("sha256").update(b64).digest("hex");
            const dup=DB_PEDIDOS.find(x=>x.id!==pedido.id && x.comprovanteHash===hash);
            const i=DB_PEDIDOS.findIndex(p=>p.id===pedido.id);
            if(i>=0){ DB_PEDIDOS[i].comprovanteHash=hash; persistPedidos(); }
            if(dup) dupAlerta=`Comprovante IDÊNTICO ao pedido #${(dup.id||"").slice(-8).toUpperCase()} de ${dup.userEmail||"?"}`;
          }catch(eH){ console.warn("[precheck] hash:",eH.message); }
          const prompt=`Você é o auditor de comprovantes do H2BApply. Leia a IMAGEM do comprovante de pagamento (PIX ou transferência bancária brasileira) e confira.
ESPERADO: plano ${pedido.plano.toUpperCase()} ${pedido.dias} dias${precoEsp?` = R$ ${precoEsp.toFixed(2)}`:""}. Valor que o cliente informou: R$ ${(pedido.valorTotal||0).toFixed(2)}.
Da imagem, leia: o VALOR pago, a DATA/HORA, e se parece um comprovante REAL de PIX/transferência (e não um print qualquer ou editado).
Responda SÓ JSON, sem markdown: {"veredito":"CONFERE"|"DIVERGENCIA"|"ILEGIVEL","valorLido":número ou null,"dataLida":"texto" ou null,"bateComEsperado":true|false,"resumo":"frase curta em pt-BR","alertas":["..."]}
Regras: "CONFERE" só se o valor lido bater com o esperado (ou com o valor informado) E parecer comprovante real. Se não conseguir ler o valor, "ILEGIVEL". Se ler mas não bater, "DIVERGENCIA". Seja rigoroso: dinheiro está em jogo.`;
          const gU=new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gKey}`);
          const gB=JSON.stringify({contents:[{parts:[
            {text:prompt},
            {inline_data:{mime_type:(pedido.comprovanteType||"image/jpeg"),data:b64}}
          ]}],generationConfig:{temperature:0.1,maxOutputTokens:400}});
          const gR=await new Promise((rs,rj)=>{
            const r2=https.request({hostname:gU.hostname,path:gU.pathname+gU.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(gB)}},resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{rs(JSON.parse(Buffer.concat(ch).toString()));}catch{rj(new Error("parse"));}});});
            r2.on("error",rj);r2.setTimeout(20000,()=>{r2.destroy();rj(new Error("timeout"));});r2.write(gB);r2.end();
          });
          const raw=(gR?.candidates?.[0]?.content?.parts?.[0]?.text||"").replace(/```json|```/g,"").trim();
          const pc=JSON.parse(raw);
          pc.precoEsperado=precoEsp; pc.valorInformado=pedido.valorTotal||0;
          if(dupAlerta){
            pc.alertas=[...(Array.isArray(pc.alertas)?pc.alertas:[]),"🚨 "+dupAlerta];
            if(pc.veredito==="CONFERE") pc.veredito="DIVERGENCIA";
            pc.resumo="🚨 "+dupAlerta+(pc.resumo?" — "+pc.resumo:"");
          }
          setPedidoPreCheck(pedido.id,pc);
          console.log(`[precheck] #${pedido.id.slice(-8)}: ${pc.veredito} — leu R$${pc.valorLido} (esp R$${precoEsp}) — ${pc.resumo}`);
        }catch(eP){
          console.warn("[precheck] falhou:",eP.message);
          setPedidoPreCheck(pedido.id,{veredito:"ERRO",resumo:"Não foi possível pré-analisar (confira manual).",bateComEsperado:false,alertas:[eP.message]});
        }
      })();
      // Log interno (registrado no histórico do usuário do plano, não de quem clicou)
      addLog(targetEmail,{status:"sistema",jobTitle:`💳 ${targetEmail!==s.user_email?"Pedido regularizado pelo admin":"Novo pedido de plano"}: ${pedido.plano} ${pedido.dias}d — R$${pedido.valorTotal}`,company:"Pedido #"+pedido.id.slice(-8).toUpperCase()});
      // Push + Email para admins (em background)
      ;(async()=>{
        try{
          const admins=[...ADMIN_EMAILS];
          for(const ae of admins){
            await pushToUser(ae,{type:"new_order",title:"💳 Novo pedido de plano!",body:`${pedido.userName||pedido.userEmail} solicitou ${pedido.plano} por ${pedido.dias} dias — R$${pedido.valorTotal}`,icon:"/icon-192.png"}).catch(()=>{});
          }
        }catch(e){console.warn("[pedido] push err:",e.message);}
        // Email para admins
        try{
          let adminToken=null, adminTokenFrom=null;
          // 1) Token de sessão ativa do admin principal
          const adminSessEntry=Object.values(sessions).find(ss=>ss.user_email===ADMIN_EMAIL&&ss.access_token);
          if(adminSessEntry?.access_token){adminToken=adminSessEntry.access_token;adminTokenFrom=ADMIN_EMAIL;}
          // 2) Refresh do admin principal
          if(!adminToken){try{const t=await refreshTokenForUser(ADMIN_EMAIL);if(t){adminToken=t;adminTokenFrom=ADMIN_EMAIL;}}catch{}}
          // 3) FALLBACK ANTI-FALHA-SILENCIOSA: se o admin principal não tem token,
          //    tenta QUALQUER outro admin (sessão ou refresh). Assim o aviso de
          //    pedido nunca deixa de sair só porque uma conta deslogou.
          if(!adminToken){
            for(const ae of ADMIN_EMAILS){
              if(ae===ADMIN_EMAIL) continue;
              const se=Object.values(sessions).find(ss=>ss.user_email===ae&&ss.access_token);
              if(se?.access_token){adminToken=se.access_token;adminTokenFrom=ae;break;}
              try{const t=await refreshTokenForUser(ae);if(t){adminToken=t;adminTokenFrom=ae;break;}}catch{}
            }
          }
          if(!adminToken){console.warn("[pedido] ⚠️ NENHUM admin com token válido — aviso de pedido NÃO enviado. Reconecte o Gmail admin.");}
          if(adminToken){
            const _fromEmail = adminTokenFrom || ADMIN_EMAIL;
            const _pagoEmStr = pedido.pagoEm ? new Date(pedido.pagoEm).toLocaleDateString("pt-BR") : "Não informada";
            const emailSubject=`💳 Novo pedido de plano — ${pedido.userName||pedido.userEmail} quer ${pedido.plano} por ${pedido.dias}d`;
            const emailText=`💳 NOVO PEDIDO DE PLANO RECEBIDO!

👤 Usuário: ${pedido.userName||"?"}
📧 Email: ${pedido.userEmail||"?"}
📱 WhatsApp: ${pedido.userWhatsapp||"?"}
🏙️ Cidade: ${pedido.userCity||"?"}

📦 Plano: ${pedido.plano.toUpperCase()} — ${pedido.dias} dias — R$${pedido.valorTotal}${pedido.desconto>0?" ("+pedido.desconto+"% desconto)":""}
💰 Data de pagamento informada pelo cliente: ${_pagoEmStr}   ⬅️ CONFIRA se bate com o comprovante
📝 Nota: ${pedido.nota||"Sem observação"}
🆔 Pedido: #${pedido.id.slice(-8).toUpperCase()}
⏰ Recebido no sistema: ${new Date().toLocaleString("pt-BR")}
${pedido.comprovante?"📸 Comprovante: ANEXADO a este email":"⚠️ Comprovante: NÃO enviado ainda"}

✅ Para ativar: h2bapply.com/ad → Pedidos de Plano → Ativar
${pedido.criadoPor&&pedido.criadoPor!==pedido.userEmail?`\n🛠️ Registrado retroativamente por admin: ${pedido.criadoPor}`:""}

— Sistema H2BApply`;

            // Preparar anexo do comprovante (aceita base64 PURO — formato real salvo —
            // ou data URL). Antes só anexava se começasse com "data:", então o anexo
            // nunca ia, apesar do texto dizer "ANEXADO".
            let attachments = [];
            if(pedido.comprovante && typeof pedido.comprovante === "string"){
              try{
                let mimeType, base64Data;
                const m = pedido.comprovante.match(/^data:([^;]+);base64,(.+)$/);
                if(m){ mimeType = m[1]; base64Data = m[2]; }
                else { mimeType = pedido.comprovanteType || "image/jpeg"; base64Data = pedido.comprovante; }
                const ext = mimeType.includes("pdf")?"pdf":mimeType.includes("png")?"png":mimeType.includes("webp")?"webp":"jpg";
                if(base64Data && base64Data.length>40){
                  attachments = [{
                    name: `comprovante_${pedido.id.slice(-8).toUpperCase()}.${ext}`,
                    data: base64Data,
                    mime: mimeType,
                  }];
                }
              }catch(e){ console.warn("[pedido] erro processando comprovante:",e.message); }
            }

            for(const toEmail of [...ADMIN_EMAILS]){
              try{
                // buildMime com anexo se comprovante existir
                const raw=buildMime({
                  to:toEmail,
                  subject:emailSubject,
                  fromName:"H2BApply 💳",
                  fromEmail:_fromEmail,
                  text:emailText,
                  attachments, // array vazio se não tiver comprovante
                });
                await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+adminToken,"Content-Type":"application/json"}},{raw});
                console.log("[pedido] ✅ Email"+(attachments.length?" c/ comprovante":"")+" enviado para:",toEmail);
              }catch(e){console.warn("[pedido] email err →",toEmail,":",e.message);}
            }
          }
        }catch(e){console.warn("[pedido] email geral err:",e.message);}
      })();
      return json(res,200,{ok:true,pedidoId:pedido.id});
    }catch(e){return json(res,500,{error:e.message});}
  }
  // GET /api/pedidos — lista todos os pedidos (admin) ou só do usuário
  if(pathname==="/api/pedidos"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);
    const isAdm=isAdminVip(p);
    let list=isAdm?DB_PEDIDOS:DB_PEDIDOS.filter(pd=>pd.userEmail===s.user_email);
    // Filtros (admin)
    const statusF=u.searchParams.get("status")||"";
    const planoF=u.searchParams.get("plano")||"";
    if(statusF)list=list.filter(pd=>pd.status===statusF);
    if(planoF)list=list.filter(pd=>pd.plano===planoF);
    // Remover base64 do comprovante para listagem (muito pesado)
    const slim=list.map(pd=>({...pd,comprovante:pd.comprovante?true:false}));
    return json(res,200,{ok:true,pedidos:slim,total:list.length});
  }
  // GET /api/pedido/:id — detalhe de um pedido incluindo comprovante
  if(pathname.startsWith("/api/pedido/")&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const pid=decodeURIComponent(pathname.slice("/api/pedido/".length));
    const pd=DB_PEDIDOS.find(x=>x.id===pid);
    if(!pd)return json(res,404,{error:"Pedido não encontrado."});
    const p=getUser(s.user_email);
    if(!isAdminVip(p)&&pd.userEmail!==s.user_email)return json(res,403,{error:"Acesso negado."});
    // Admin recebe também um retrato do VIP atual do usuário, para o modal calcular
    // a validade final (com empilhamento) e exibir o extrato de dias.
    let usuario=null;
    if(isAdminVip(p)){
      const tu=getUser(pd.userEmail)||{};
      const _now=Date.now();
      usuario={
        email:pd.userEmail,
        plan:tu.plan||"free",
        manualExpires:tu.vip?.manualExpires||0,
        autoExpires:tu.vip?.autoExpires||0,
        source:tu.vip?.source||"trial",
        manualAtivo:!!(tu.vip?.manualExpires&&tu.vip.manualExpires>_now)&&tu.vip?.source!=="trial",
        diasRestantes:Math.max(0,Math.ceil(((Math.max(tu.vip?.manualExpires||0,tu.vip?.autoExpires||0))-_now)/86400000)),
        creditos:Array.isArray(tu.vip?.creditos)?tu.vip.creditos.slice(-30).reverse():[],
        totalPago:(tu.vip?.creditos||[]).filter(c=>c.tipo==="pago").reduce((a,c)=>a+(c.dias||0),0),
        totalGratis:(tu.vip?.creditos||[]).filter(c=>c.tipo==="gratis").reduce((a,c)=>a+(c.dias||0),0),
      };
    }
    return json(res,200,{ok:true,pedido:pd,usuario});
  }
  // PATCH /api/pedido/:id — admin atualiza status (v2: senha + bônus + Gemini)
  if(pathname.startsWith("/api/pedido/")&&req.method==="PATCH"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const pid=decodeURIComponent(pathname.slice("/api/pedido/".length));
    const idx=DB_PEDIDOS.findIndex(x=>x.id===pid);
    if(idx<0)return json(res,404,{error:"Pedido não encontrado."});
    try{
      const d=JSON.parse(await readBody(req));
      const pd=DB_PEDIDOS[idx];

      // Validar senha de editor ao ativar
      if(d.status==="ativo"){
        // GUARD DUPLA ATIVAÇÃO: se este pedido JÁ foi ativado, recusa com erro claro.
        // Evita que Andrew e Diego ativem o mesmo pedido e contem os dias 2×.
        // Seguro contra corrida: pd.ativadoEm é setado de forma SÍNCRONA mais abaixo,
        // antes de qualquer await — então a 2ª requisição cai aqui e é barrada.
        if(pd.ativadoEm){
          const quem=pd._ativadoEditor||pd.ativadoPor||"o outro editor";
          const quando=pd.ativadoEm?new Date(pd.ativadoEm).toLocaleString("pt-BR"):"";
          console.log(`[pedido] ⛔ dupla ativação barrada: ${pd.id} (já ativado por ${quem})`);
          return json(res,409,{error:`⛔ Este pedido JÁ FOI ATIVADO por ${quem}${quando?` em ${quando}`:""}. Não dá pra ativar de novo (evita contar os dias duas vezes).`,jaAtivado:true,ativadoPor:quem,ativadoEm:pd.ativadoEm});
        }
        const editorKey=matchEditorPassword(d.editorPassword);
        if(!editorKey)return json(res,403,{error:"Senha de editor inválida. Use a senha do Andrew ou do Diego."});
        pd._ativadoEditor=editorKey==="andrew"?"Andrew":"Diego";
        pd._ativadoEditorEmail=s.user_email;
      }

      if(d.status)pd.status=d.status;
      if(d.notaAdmin!==undefined)pd.notaAdmin=String(d.notaAdmin).slice(0,500);

      if(d.status==="ativo"&&!pd.ativadoEm){
        pd.ativadoPor=s.user_email;
        pd.ativadoEm=Date.now();
        const planoKey={vip:"vip",vipro:"vipro",doublepro:"doublepro"}[pd.plano]||"vipro";
        const diasBase=Math.max(1,Math.min(3650,parseInt(pd.dias||30,10)));
        const diasBonus=Math.max(0,Math.min(60,parseInt(d.bonusDias||0,10)));
        const diasTotal=diasBase+diasBonus;
        pd.diasBonus=diasBonus;pd.diasTotal=diasTotal;

        // ── CÁLCULO DA VALIDADE (corrigido) ───────────────────────────────
        // Regra única que vale para recuperação E renovação:
        //   início      = tem VIP ativo ? expiração_atual : data_de_pagamento
        //   vence_pago  = início + dias_pagos
        //   vence_final = max(hoje, vence_pago) + dias_bônus   (bônus nunca retroage)
        // • Sem VIP ativo (1º cadastro pós-reset / recuperação): conta da DATA DO
        //   PAGAMENTO — não dá dias grátis por demora na ativação.
        // • Com VIP ativo (renovação): empilha sobre o que ele já tem ("60 + 2").
        // • Pago muito antigo cuja validade já passou: max(hoje,...) garante que
        //   só o bônus vale (🔴 expirado).
        const now=Date.now();
        const DAY=86400_000;
        const tgt=getUser(pd.userEmail)||{};
        const _pagoTs=pd.pagoEm?new Date(pd.pagoEm).getTime():now;
        const pagoTs=(isNaN(_pagoTs)||!_pagoTs)?now:_pagoTs;
        const manualAtivo=tgt.vip?.manualExpires&&tgt.vip.manualExpires>now;
        const autoAtivo=tgt.vip?.autoExpires&&tgt.vip.autoExpires>now;
        // Trial (1 dia, source 'trial') NÃO conta como plano ativo para empilhar:
        // na recuperação queremos ANCORAR na data de pagamento, não somar o dia grátis.
        const _ehTrial=(tgt.vip?.source==="trial");
        const _manualStack=manualAtivo&&!_ehTrial;
        const _autoStack=autoAtivo&&!_ehTrial;
        const baseManual=_manualStack?tgt.vip.manualExpires:pagoTs;
        const baseAuto=_autoStack?tgt.vip.autoExpires:pagoTs;
        const isAuto=["vipro","doublepro"].includes(planoKey);
        const manualExpires=Math.max(now, baseManual+diasBase*DAY)+diasBonus*DAY;
        const autoExpires=isAuto?(Math.max(now, baseAuto+diasBase*DAY)+diasBonus*DAY):(tgt.vip?.autoExpires||0);

        // Atualizar perfil do usuário (VIP + dados financeiros CCC + contato)
        setUser(pd.userEmail,{
          plan:planoKey,
          vip:{...(tgt.vip||{}),active:true,plan:planoKey,source:"payment",
            manualExpires,autoExpires,activatedAt:now,
            activatedBy:pd._ativadoEditor||s.user_email,
            note:`Pedido #${pd.id.slice(-8).toUpperCase()} — ${diasBase}d +${diasBonus}d bônus = ${diasTotal}d`,
            days:diasTotal,autoDays:["vipro","doublepro"].includes(planoKey)?diasTotal:0,
            bonusDays:diasBonus,pedidoId:pd.id,
          },
          financialStatus:"pago",
          paymentAmount:`R$${(pd.valorTotal||0).toFixed(2)}`,
          paymentDate:pd.pagoEm?new Date(pd.pagoEm).toLocaleDateString("pt-BR"):new Date().toLocaleDateString("pt-BR"),
          paymentMethod:"pix",
          paymentReceiver:pd._ativadoEditor||"Admin",
          paymentNote:`${planoKey} ${diasBase}d${diasBonus>0?` +${diasBonus}d bônus`:""} — Pedido #${pd.id.slice(-8).toUpperCase()}`,
          adminEditHistory:[...(tgt.adminEditHistory||[]).slice(-49),{
            at:now,by:pd._ativadoEditor||"Admin",byEmail:s.user_email,
            changes:"plano,vip,financialStatus,pagamento",
            note:`Pedido #${pd.id.slice(-8).toUpperCase()} — ${diasTotal}d ${planoKey} ativado`
          }],
          ...(pd.userName&&!tgt.name?{name:pd.userName}:{}),
          ...(pd.userWhatsapp&&!tgt.whatsapp?{whatsapp:pd.userWhatsapp}:{}),
          ...(pd.userPhone&&!tgt.phone?{phone:pd.userPhone}:{}),
          ...(pd.userCity&&!tgt.city?{city:pd.userCity}:{}),
          ...(pd.userState&&!tgt.state?{state:pd.userState}:{}),
        });

        // ── EXTRATO DE DIAS: registra pago e bônus separados, com proveniência.
        // (chamado depois do setUser principal — créditos antigos preservados pelo
        //  spread ...(tgt.vip||{}) acima.)
        addCredito(pd.userEmail,{
          dias:diasBase,tipo:"pago",origem:"pagamento",
          motivo:`Pedido #${pd.id.slice(-8).toUpperCase()} — ${planoKey}`,
          dadoPor:pd._ativadoEditor||"Admin",pedidoId:pd.id,valor:pd.valorTotal||0
        });
        if(diasBonus>0) addCredito(pd.userEmail,{
          dias:diasBonus,tipo:"gratis",origem:"bonus",
          motivo:String(d.bonusMotivo||"Bônus na ativação").slice(0,120),
          dadoPor:pd._ativadoEditor||"Admin",pedidoId:pd.id
        });

        // Financeiro automático
        if(!DB_FINANCEIRO.pagamentos)DB_FINANCEIRO.pagamentos=[];
        if(!DB_FINANCEIRO.pagamentos.some(x=>x.pedidoId===pd.id)){
          DB_FINANCEIRO.pagamentos.unshift({
            id:"fin_"+Date.now().toString(36),email:pd.userEmail,
            nome:pd.userName||pd.userEmail,plano:pd.plano,
            dias:diasTotal,diasBase,diasBonus,valor:pd.valorTotal||0,
            desconto:pd.desconto||0,
            nota:`Pedido #${pd.id.slice(-8).toUpperCase()} — ${pd.plano} ${diasBase}d${diasBonus>0?` +${diasBonus}bônus`:""}`,
            data:new Date().toISOString(),
            dataPagamento:pd.pagoEm?new Date(pd.pagoEm).toISOString():new Date().toISOString(),
            pedidoId:pd.id,source:"pedido_automatico",
            ativadoPor:pd._ativadoEditor||"Admin",ativadoPorEmail:s.user_email,
            // recebidoPor: quem efetivamente recebeu o dinheiro (acerto entre sócios).
            // Override explícito do modal de aprovação (d.recebidoPor) tem prioridade;
            // senão deriva do editor que confirmou (Andrew→andrio, Diego→diego).
            recebidoPor: (["andrio","diego"].includes((d.recebidoPor||"").toLowerCase()))
              ? (d.recebidoPor||"").toLowerCase()
              : (editorKey==="diego" ? "diego" : "andrio"),
            whatsapp:pd.userWhatsapp||""
          });
          persistFinanceiro();
          console.log("[financeiro] auto registrado:",pd.userEmail,"R$",pd.valorTotal,"bonus:",diasBonus);
        }

        // Push ao usuário
        try{await pushToUser(pd.userEmail,{type:"plan_activated",
          title:"🎉 Plano ativado!",
          body:`${planoKey.toUpperCase()} ativo por ${diasTotal} dias${diasBonus>0?` (inclui ${diasBonus}d bônus)`:""}.`,
          icon:"/icon-192.png"
        });}catch{}
        addLog(pd.userEmail,{status:"sistema",
          jobTitle:`🎉 Plano ${planoKey} ativado — ${diasTotal} dias${diasBonus>0?` (+${diasBonus} bônus)`:""}`,
          company:`Ativado por ${pd._ativadoEditor||"Admin"} (${s.user_email})`
        });
        trackJourney(pd.userEmail,"plan_activated",{detail:`${planoKey} ${diasTotal}d`,meta:{editor:pd._ativadoEditor,bonus:diasBonus}});

        // (Bônus de indicação por compra removido — 2026-07-03, KB-059)

        // Gemini auditoria automática em background
        ;(async()=>{try{
          const gKey=getGeminiKey();if(!gKey)return;
          const gPr=`Audite este novo cliente H2BApply e confirme se o pagamento está correto.
CLIENTE: ${pd.userName||pd.userEmail} (${pd.userEmail})
PLANO: ${planoKey} | DIAS BASE: ${diasBase} | BÔNUS: ${diasBonus} | TOTAL: ${diasTotal}d
VALOR COBRADO: R$${(pd.valorTotal||0).toFixed(2)} | DESCONTO: ${pd.desconto||0}%
COMPROVANTE: ${pd.comprovante?"SIM":"NÃO"} | ATIVADO POR: ${pd._ativadoEditor||"Admin"}
TABELA: VIP(30d=R$100,60d=R$190,90d=R$270,1a=R$960) VIPro(30d=R$150,60d=R$285,90d=R$405,1a=R$1440) DoublePro(30d=R$250,60d=R$475,90d=R$675,1a=R$2400)
JSON APENAS (sem markdown): {"status":"OK" ou "DIVERGENCIA","resumo":"frase curta","calculoCorreto":true ou false,"alertas":[]}`;
          const gU=new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gKey}`);
          const gB=JSON.stringify({contents:[{parts:[{text:gPr}]}],generationConfig:{temperature:0.1,maxOutputTokens:300}});
          const gR=await new Promise((rs,rj)=>{
            const r2=https.request({hostname:gU.hostname,path:gU.pathname+gU.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(gB)}},resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{rs(JSON.parse(Buffer.concat(ch).toString()));}catch{rj(new Error("parse"));}}); });
            r2.on("error",rj);r2.setTimeout(15000,()=>{r2.destroy();rj(new Error("timeout"));});r2.write(gB);r2.end();
          });
          const rawAud=(gR?.candidates?.[0]?.content?.parts?.[0]?.text||"").replace(/```json|```/g,"").trim();
          const aud=JSON.parse(rawAud);
          DB_PEDIDOS[idx].geminiAuditoria=aud;DB_PEDIDOS[idx].geminiAuditoriaAt=Date.now();
          persistPedidos();
          setUser(pd.userEmail,{lastValidatedAt:Date.now(),lastValidatedBy:"Gemini Auto",lastValidationResult:aud.status==="OK"?"CLIENTE_VALIDADO":"PENDENCIAS_DETECTADAS"});
          console.log(`[gemini] Auditoria #${pd.id.slice(-8)}: ${aud.status} — ${aud.resumo}`);
        }catch(eG){console.warn("[gemini] audit err:",eG.message);}})();

        pd.ativadoEm=pd.ativadoEm||Date.now(); // garantir que está setado
        DB_PEDIDOS[idx]=pd;persistPedidos();
        return json(res,200,{ok:true,pedido:pd,diasBase,diasBonus,diasTotal,planoKey,
          manualExpiresDate:new Date(manualExpires).toLocaleDateString("pt-BR"),
          autoExpiresDate:autoExpires>now?new Date(autoExpires).toLocaleDateString("pt-BR"):null,
          ativadoPor:pd._ativadoEditor||"Admin"
        });
      }

      if(d.status==="cancelado"){pd.canceladoPor=s.user_email;pd.canceladoEm=Date.now();}
      DB_PEDIDOS[idx]=pd;persistPedidos();
      return json(res,200,{ok:true,pedido:pd});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ── /api/status ───────────────────────────────────────
  if(pathname==="/api/status"){
    const s=getSess(req);if(!s?.user_email)return json(res,200,{connected:false});
    markOnline(s.user_email);
    const p=getUser(s.user_email);if(!p)return json(res,200,{connected:false,reason:"user_not_found"});
    const vipOk=isVipActive(p);
    const planKey=getPlan(p);const {todayManual:sentManual,todayAuto:sentAuto}=getUserStatsCached(s.user_email);
    const h=getHist(s.user_email);
    const totalSent=h.length;const totalManual=h.filter(x=>x.type==="manual").length;const totalAutoHist=h.filter(x=>x.type==="auto").length;const totalReplies=h.filter(x=>x.type==="reply").length;
    const manualLimit=getManualLimit(p),autoLimit=getAutoLimit(p);
    const autoJob=getAutoJob(s.user_email);
    const stats=getAutoStats(s.user_email);
    const now2=Date.now();
    return json(res,200,{connected:true,email:s.user_email,name:p.name||s.user_name,picture:p.picture||s.picture||"",country:p.country||"Brazil",phone:p.phone||"",whatsapp:p.whatsapp||"",cc:p.cc||"",city:p.city||"",language:p.language||"pt-BR",rankName:p.rankName||"",appAvatarId:p.appAvatarId||"",h2bProfile:p.h2bProfile||{},serverId:_resolveServerId(req),publicProfile:p.publicProfile||{},age:p.age||0,isAdmin:!!p.isAdmin,plan:planKey,totalSent,totalManual,totalAutoHist,totalReplies,vip:p.vip?{active:vipOk,expiresAt:p.vip.expiresAt||Math.max(p.vip.manualExpires||0,p.vip.autoExpires||0),activatedAt:p.vip.activatedAt,days:p.vip.days||30,plan:p.vip.plan||"vip",manualExpires:p.vip.manualExpires||0,autoExpires:p.vip.autoExpires||0,manualActive:isManualVipActive(p),autoActive:isAutoVipActive(p),source:p.vip.source||"trial"}:null,todaySentManual:sentManual,manualLimit,manualRemaining:Math.max(0,manualLimit-sentManual),todaySentAuto:sentAuto,autoLimit,autoRemaining:Math.max(0,autoLimit-sentAuto),autoEnabled:true,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0,source:autoJob.source,startedAt:autoJob.startedAt,lastSentAt:autoJob.lastSentAt,nextSendAt:autoJob.nextSendAt,currentJob:autoJob.currentJob,originalCount:autoJob.originalCount}:null,autoStats:stats,cvs:(p.cvs||[]).map(c=>({idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType||"resume"})),settings:p.settings||{},onboarded:!!p.onboarded,adminMessage:p.adminMessage||null,readEmailIds:p.readEmailIds||[],profiles:p.profiles||[],senderEmails:(p.senderEmails||[]).map(s=>({email:s.email,label:s.label||"",active:s.active!==false,tokenExpired:!!s.tokenExpired,blocked:!!s.blocked,addedAt:s.addedAt})),senderMax:getMaxSenders(p),adminSettings:isAdminVip(p)?{intervalSecs:(p.adminSettings?.intervalSecs||180),senderLimits:(p.adminSettings?.senderLimits||{}),maxSenders:getMaxSenders(p)}:null});
  }

  if(pathname==="/api/onboard"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});setUser(s.user_email,{onboarded:true});return json(res,200,{ok:true});}
  // GET /api/check-rankname?name=X — verifica disponibilidade de apelido
  if(pathname==="/api/check-rankname"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const name=(u.searchParams.get("name")||"").trim();
    if(name.length<3)return json(res,200,{available:false,reason:"Mínimo 3 caracteres"});
    if(name.length>30)return json(res,200,{available:false,reason:"Máximo 30 caracteres"});
    if(!/^[a-zA-ZÀ-ú0-9 _\-]+$/.test(name))return json(res,200,{available:false,reason:"Só letras, números, espaço, _ e -"});
    const low=name.toLowerCase();
    const conflict=Object.entries(DB_USERS).find(([e,usr])=>e!==s.user_email&&(usr.rankName||"").toLowerCase()===low);
    return json(res,200,{available:!conflict,reason:conflict?"Nome já em uso":"Disponível!"});
  }

  if(pathname==="/api/settings"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));const upd={};
      if(d.name!==undefined){upd.name=String(d.name).slice(0,200);s.user_name=upd.name;}
      if(d.country!==undefined)upd.country=String(d.country).slice(0,100);
      if(d.phone!==undefined){
        upd.phone=String(d.phone).slice(0,50);
        // Registrar telefone no DB_TRIAL_USED quando usuário que teve trial cadastra phone
        const _ph=upd.phone.replace(/\D/g,"");
        if(_ph.length>=8){
          const _curU=getUser(s.user_email);
          const _hadTrial=_curU?.vip?.source==="trial"||(_curU?.vip?.note||"").includes("Trial");
          if(_hadTrial&&!DB_TRIAL_USED.phones[_ph]){
            DB_TRIAL_USED.phones[_ph]=s.user_email;
            try{fs.writeFileSync(TRIAL_USED_FILE,JSON.stringify(DB_TRIAL_USED,null,2));}catch{}
            console.log(`[trial] 📱 Telefone ${_ph} vinculado ao trial de ${s.user_email}`);
          }
        }
      }
      if(d.whatsapp!==undefined)upd.whatsapp=String(d.whatsapp).slice(0,50);
      if(d.age!==undefined){const a=parseInt(d.age)||0;if(a>=10&&a<=100)upd.age=a;}
      if(d.city!==undefined)upd.city=String(d.city).slice(0,100);
      if(d.language!==undefined)upd.language=String(d.language).slice(0,10);
      if(d.appAvatarId!==undefined)upd.appAvatarId=String(d.appAvatarId).slice(0,10);
      // rankName: validação de unicidade
      if(d.rankName!==undefined){
        const rn=String(d.rankName).trim().slice(0,30);
        if(rn.length>0){
          if(rn.length<3)return json(res,400,{error:"Apelido precisa ter ao menos 3 caracteres."});
          if(!/^[a-zA-ZÀ-ú0-9 _\-]+$/.test(rn))return json(res,400,{error:"Apelido só pode ter letras, números, espaço, _ e -"});
          // Checar unicidade (case-insensitive, ignorar o próprio usuário)
          const rnLow=rn.toLowerCase();
          const conflict=Object.entries(DB_USERS).find(([e,u])=>e!==s.user_email&&(u.rankName||"").toLowerCase()===rnLow);
          if(conflict)return json(res,409,{error:"Este apelido já está em uso. Escolha outro!"});
        }
        upd.rankName=rn;
      }
      // h2bProfile: objeto completo
      if(d.h2bProfile){
        const cur=getUser(s.user_email)||{};
        const hbp=d.h2bProfile;
        upd.h2bProfile={
          ...(cur.h2bProfile||{}),
          experiencedH2B:!!hbp.experiencedH2B,
          h2bSeasons:Math.max(0,parseInt(hbp.h2bSeasons)||0),
          englishLevel:["none","basic","intermediate","advanced"].includes(hbp.englishLevel)?hbp.englishLevel:"basic",
          preferredArea:String(hbp.preferredArea||"general").slice(0,50),
          usaTrips:!!hbp.usaTrips,
          hasDriverLicense:!!hbp.hasDriverLicense,
          availability:["immediate","1month","3months"].includes(hbp.availability)?hbp.availability:"immediate",
        };
      }
      // Perfil público OPCIONAL (aparece ao clicar no ranking). Sanitiza:
      // remove tags HTML (defesa em profundidade; o front ainda usa esc() ao renderizar).
      if(d.publicProfile&&typeof d.publicProfile==="object"){
        const cur=getUser(s.user_email)||{};
        const pp=d.publicProfile;
        const clean=t=>String(t==null?"":t).replace(/<[^>]*>/g,"").trim();
        upd.publicProfile={
          ...(cur.publicProfile||{}),
          sobre:clean(pp.sobre).slice(0,600),
          experiencias:clean(pp.experiencias).slice(0,400),
          foiContratado:["sim","nao",""].includes(pp.foiContratado)?pp.foiContratado:"",
          opiniao:clean(pp.opiniao).slice(0,300),
          mostrarFotoGoogle:pp.mostrarFotoGoogle!==false,
          atualizadoEm:Date.now()
        };
      }
      if(d.settings){const p=getUser(s.user_email)||{};upd.settings={...(p.settings||{}),...d.settings};}
      setUser(s.user_email,upd);
      return json(res,200,{ok:true});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/cv/upload"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Sessão expirada. Faça login novamente.",sessionExpired:true,code:"SESSION_EXPIRED"});if(rateLimit(s.user_email+"_cv",10,3600_000))return json(res,429,{error:"Muitos uploads. Tente novamente em 1 hora."});try{const d=JSON.parse(await readBody(req));if(!d.base64||!d.name)return json(res,400,{error:"base64 e name obrigatórios."});// Tamanho: base64 representa ~75% dos bytes reais
const estimatedBytes=Math.round(d.base64.length*0.75);if(d.base64.length>14_000_000)return json(res,400,{error:"Arquivo maior que 10MB."});if(estimatedBytes<1000)return json(res,400,{error:"Arquivo muito pequeno ou corrompido."});// Valida magic bytes %PDF (mais robusto: verifica os 4 primeiros bytes do binário real)
const pdfBuf=Buffer.from(d.base64.slice(0,8),"base64");if(pdfBuf.length<4||pdfBuf[0]!==0x25||pdfBuf[1]!==0x50||pdfBuf[2]!==0x44||pdfBuf[3]!==0x46)return json(res,400,{error:"Arquivo inválido: não é um PDF. Envie um arquivo .pdf válido."});// Nome seguro
const safeName=String(d.name).replace(/[<>"'&]/g,"").slice(0,200);if(!safeName)return json(res,400,{error:"Nome do arquivo inválido."});const p=getUser(s.user_email)||{};const cvs=p.cvs||[];const cvType=d.cvType||"resume";const typeLimit=cvType==="cover"?MAX_COVERS:MAX_RESUMES;const sameType=cvs.filter(c=>(c.cvType||"resume")===cvType);if(sameType.length>=typeLimit)return json(res,429,{error:`Limite de ${typeLimit} ${cvType==="cover"?"cover letters":"currículos"} atingido. Exclua um antes de enviar outro.`,limitReached:true,cvType,limit:typeLimit});const idx=Date.now();const meta={idx,name:safeName,size:estimatedBytes,date:new Date().toISOString(),cvType,b64:d.base64};cvs.push(meta);saveCv(s.user_email,idx,d.base64);setUser(s.user_email,{cvs});trackJourney(s.user_email,'pdf_upload',{detail:`PDF: ${safeName} ~${Math.round(estimatedBytes/1024)}KB`,meta:{name:safeName,idx,cvType}});
      return json(res,200,{ok:true,cv:{idx:meta.idx,name:meta.name,size:meta.size,date:meta.date,cvType:meta.cvType}});}catch(e){return json(res,500,{error:e.message});}}
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});const b64=loadCv(s.user_email,idx);if(!b64)return json(res,404,{error:"Arquivo não encontrado."});return json(res,200,{base64:b64,idx});}
  if(/^\/api\/cv\/\d+$/.test(pathname)&&req.method==="DELETE"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const idx=parseInt(pathname.split("/").pop(),10);const p=getUser(s.user_email);if(!p?.cvs?.find(c=>c.idx===idx))return json(res,403,{error:"CV não encontrado."});deleteCv(s.user_email,idx);const _cleanProfiles=(p.profiles||[]).map(pr=>{const np={...pr};if(np.resumeIdx===idx){delete np.resumeIdx;delete np.pdfName;delete np.pdfSize;}if(np.coverIdx===idx){delete np.coverIdx;}return np;});setUser(s.user_email,{cvs:(p.cvs||[]).filter(c=>c.idx!==idx),profiles:_cleanProfiles});return json(res,200,{ok:true});}

  if(pathname==="/api/send"&&req.method==="POST"){
    const _sendT0=Date.now(); // DIAGNÓSTICO (2026-07-09): mede onde o tempo vai num envio manual — relato de "180 envios em 3h" sem causa óbvia no código; até achar a causa definitiva, loga se demorar muito, pra próxima vez ter dado real em vez de suposição.
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
        // v16-FIX: bloqueia manual se já enviado (manual ou automático) — evita duplicata
        if(hasSent(s.user_email,toEmail))return json(res,409,{error:"Você já enviou para esta empresa. Verifique o histórico.",alreadySent:true});
        // v17-FIX: verifica se email está na fila do automático (ainda não enviado)
        const _autoQ = getAutoJob(s.user_email);
        if(_autoQ?.active && _autoQ.queue?.some(q => _normEmail(q.to) === _normEmail(toEmail)))
          return json(res,409,{error:"Esta empresa está na fila do envio automático. Aguarde ou cancele o automático primeiro.",inAutoQueue:true});
      }else{
        // Rate limit leve para respostas (50/dia) para evitar abuso
        if(rateLimit(s.user_email+"_reply",50,86400_000))return json(res,429,{error:"Muitas respostas em um dia."});
      }

      const attachments=[];const getAtt=async idx=>{if(idx==null)return null;const m=p.cvs?.find(c=>c.idx===parseInt(idx,10));return m&&loadCv(s.user_email,m.idx)?{data:loadCv(s.user_email,m.idx),name:m.name}:null;};
      if(!isReply){// Anexos só em candidaturas originais
        if(d.resumeIdx!=null){const a=await getAtt(d.resumeIdx);if(a)attachments.push(a);}else if(d.pdfBase64){attachments.push({data:d.pdfBase64,name:d.pdfName||"resume.pdf"});}
        if(d.coverIdx!=null){const a=await getAtt(d.coverIdx);if(a)attachments.push(a);}
      }

      // Cabeçalhos de threading para manter na mesma conversa
      const threadHeaders={};
      if(isReply&&d.messageId){threadHeaders["In-Reply-To"]=d.messageId;threadHeaders["References"]=d.messageId;}
      if(isReply&&d.threadId){threadHeaders["X-Gmail-Thread-Id"]=d.threadId;}

      // ── Multi-sender: selecionar email de envio ─────────────
      const requestedSender=(d.senderEmail||"").toLowerCase().trim()||null;
      const sid=getSessId(req);
      let actualSenderEmail=s.user_email;
      let r;
      if(requestedSender&&requestedSender!==s.user_email){
        // Enviar via email extra especificado manualmente pelo usuário
        try{
          const{token:senderTok,senderEmail:usedEmail}=await getSenderToken(s.user_email,requestedSender);
          if(senderTok){
            actualSenderEmail=usedEmail;
            const raw2=buildMimeWithHeaders({to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",fromEmail:usedEmail,attachments,threadHeaders});
            const payload2={raw:raw2};if(isReply&&d.threadId)payload2.threadId=d.threadId;
            const{status:gs2,body:gb2}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+senderTok,"Content-Type":"application/json"}},payload2);
            if(gb2?.error)throw new Error(gb2.error.message||JSON.stringify(gb2.error));
            if(gs2!==200)throw new Error("Gmail HTTP "+gs2);
            r=gb2;
          }else{r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments,threadHeaders,threadId:isReply?(d.threadId||null):null});}
        }catch(e2){
          console.warn("[send] Sender extra falhou, usando principal:",e2.message);
          actualSenderEmail=s.user_email;
          r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments,threadHeaders,threadId:isReply?(d.threadId||null):null});
        }
      }else if(!requestedSender && !isReply){
        // ── Round-robin automático no envio MANUAL (sem sender especificado) ──
        // Alterna entre principal e extras igualmente, igual ao automático
        try{
          const{token:rrTok,senderEmail:rrEmail}=await getSenderToken(s.user_email,null);
          actualSenderEmail=rrEmail;
          if(rrTok&&rrEmail!==s.user_email){
            // Extra escolhido pelo round-robin
            const rawRR=buildMimeWithHeaders({to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",fromEmail:rrEmail,attachments,threadHeaders});
            const payloadRR={raw:rawRR};
            const{status:gsRR,body:gbRR}=await httpsReq({hostname:"gmail.googleapis.com",path:"/gmail/v1/users/me/messages/send",method:"POST",headers:{"Authorization":"Bearer "+rrTok,"Content-Type":"application/json"}},payloadRR);
            if(gbRR?.error)throw new Error(gbRR.error.message||JSON.stringify(gbRR.error));
            if(gsRR!==200)throw new Error("Gmail HTTP "+gsRR);
            r=gbRR;
            console.log(`[send/manual] 🔄 Round-robin manual → ${rrEmail}`);
          }else{
            // Principal escolhido pelo round-robin
            r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments,threadHeaders,threadId:isReply?(d.threadId||null):null});
          }
        }catch(e3){
          console.warn("[send/manual] Round-robin falhou, usando principal:",e3.message);
          actualSenderEmail=s.user_email;
          r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments,threadHeaders,threadId:isReply?(d.threadId||null):null});
        }
      }else{
        // isReply=true: sempre usa email principal (manter conversa no mesmo remetente)
        r=await gmailSendWithThread(sid,{to:toEmail,subject:d.subject,text:d.message,fromName:d.fromName||p.name||s.user_name||"H2BApply",attachments,threadHeaders,threadId:isReply?(d.threadId||null):null});
      }

      const _tGmailMs = Date.now() - _sendT0;
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
          senderEmail: actualSenderEmail,
          sheetSource: d.sheetSource||undefined,
          // FIX: salvar caseNum para que /api/sent-ids possa filtrar a vaga da planilha
          caseNum: d.caseNum || ""
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
        const _tTotalMs = Date.now() - _sendT0;
        if (_tTotalMs > 5000) console.warn(`[send-timing] ⚠️ LENTO: ${s.user_email} → ${toEmail} | gmail=${_tGmailMs}ms | resto=${_tTotalMs-_tGmailMs}ms | total=${_tTotalMs}ms`);
        return json(res,200,{ok:true,messageId:r.id,appId,threadId:r.threadId||null,todaySent:newSent,dailyLimit:newLim,remaining:Math.max(0,newLim-newSent),countedAsManual:true,caseNum:d.caseNum||"",sheetSource:d.sheetSource||""});
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
    // FIX "volta pra estaca zero": conjunto global por case number, independente
    // de planilha — o chute por prefixo mandava H-300 (H-2A!) pro balde jul2025
    // e planilhas novas não tinham balde nenhum → enviadas reapareciam na lista.
    const sentAll=new Set();

    hist.forEach(h=>{
      const cn  = h.caseNum||"";
      const src = h.sheetSource||"";
      const id  = h.jobId||h.id||"";
      if(cn) sentAll.add(cn);

      if(src==="jan2026" || (!src && (cn.startsWith("H-4")||cn.startsWith("H-5")||cn.startsWith("H-6")))){
        if(cn) sentJan.add(cn);
      } else if(src==="jul2025" || (!src && cn.startsWith("H-3"))){
        if(cn) sentJul.add(cn);
      } else if(cn && !src){
        // caseNum sem planilha detectada — adiciona em ambas por segurança
        sentJan.add(cn); sentJul.add(cn);
      }
      // Seasonal: sempre adiciona por jobId
      if(id) sentSeasonal.add(id);
    });

    // Vagas na fila do automático também somem da planilha
    const autoJob = getAutoJob(s2.user_email);
    const autoQueue = autoJob?.active ? (autoJob.queue||[]) : [];
    const autoQueueIds = autoQueue.map(q=>q.id||q.caseNum).filter(Boolean);

    autoQueue.forEach(q => {
      if(!q.id && !q.caseNum) return;
      const id = q.id || q.caseNum;
      const cn = q.caseNum||"";
      if(cn||/^H-\d/.test(String(id)))sentAll.add(cn||id); // fila do auto some de TODA planilha
      const src = autoJob.source || "";
      if(src==="jan2026"||cn.startsWith("H-4")||cn.startsWith("H-5")) sentJan.add(id);
      else if(src==="jul2025"||cn.startsWith("H-3")) sentJul.add(id);
      else sentSeasonal.add(id);
    });

    return json(res,200,{
      all:[...sentAll],
      jan2026:[...sentJan],
      jul2025:[...sentJul],
      seasonal:[...sentSeasonal],
      autoQueueIds,
      autoQueueSize: autoQueue.length,
      autoQueueNotice: autoQueue.length > 0
        ? `⚡ ${autoQueue.length} vaga${autoQueue.length>1?"s estão":"está"} oculta${autoQueue.length>1?"s":""} da lista porque já ${autoQueue.length>1?"estão":"está"} na sua fila de envio automático.`
        : null
    });
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
      const hist_before_filter = hist; // salva para limpar o índice depois
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
      // Remove do APPLIED index — estrutura real: { byThread:{}, byMsgId:{}, byTo:{} }
      // Precisamos encontrar o appId da entrada removida e limpar todas as referências a ele
      const removedAppIds = new Set(
        hist_before_filter
          .filter(h => {
            if(jobId && h.jobId === jobId) return true;
            if(caseNum && h.caseNum === caseNum) return true;
            if(to && h.to === to) return true;
            return false;
          })
          .map(h => h.appId)
          .filter(Boolean)
      );
      if (removedAppIds.size > 0) {
        const ix = DB_APP_INDEX[s.user_email];
        if (ix) {
          // Limpa byThread
          for (const [k, v] of Object.entries(ix.byThread || {})) {
            if (removedAppIds.has(v)) delete ix.byThread[k];
          }
          // Limpa byMsgId
          for (const [k, v] of Object.entries(ix.byMsgId || {})) {
            if (removedAppIds.has(v)) delete ix.byMsgId[k];
          }
          // Limpa byTo
          for (const [k, arr] of Object.entries(ix.byTo || {})) {
            ix.byTo[k] = (arr || []).filter(id => !removedAppIds.has(id));
            if (!ix.byTo[k].length) delete ix.byTo[k];
          }
          persist(APPIDX_FILE, DB_APP_INDEX);
        }
      }
      invalidateUserStatsCache(s.user_email);
      console.log(`[sent/remove] ${s.user_email} removeu vaga jobId=${jobId||"-"} caseNum=${caseNum||"-"} (${before-hist.length} entradas)`);
      return json(res,200,{ok:true,removed:before-hist.length});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // Remove entrada do histórico por key (key = jobId || "company::job")
  // Usado pelo frontend em doDeleteHistEntry — remove do HIST e do SENT
  if(pathname==="/api/history/delete"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req));
      const {key}=d;
      if(!key)return json(res,400,{error:"key obrigatório."});
      let hist=getHist(s.user_email);
      const before=hist.length;
      // Identifica as entradas a remover (mesma lógica do frontend)
      const toRemove=hist.filter(h=>{
        const k=h.jobId||(h.company+"::"+h.job);
        return k===key;
      });
      // Remove do DB_SENT todos os emails das entradas removidas
      if(DB_SENT[s.user_email]){
        for(const h of toRemove){
          const nd=_normEmail(h.to);
          if(nd)DB_SENT[s.user_email].delete(nd);
        }
        persistSent();
      }
      // Remove do DB_HIST
      hist=hist.filter(h=>{
        const k=h.jobId||(h.company+"::"+h.job);
        return k!==key;
      });
      DB_HIST[s.user_email]=hist;
      persist(HIST_FILE,DB_HIST);
      // Limpa índice de candidaturas
      const removedAppIds=new Set(toRemove.map(h=>h.appId).filter(Boolean));
      if(removedAppIds.size>0){
        const ix=DB_APP_INDEX[s.user_email];
        if(ix){
          for(const[k,v]of Object.entries(ix.byThread||{})){if(removedAppIds.has(v))delete ix.byThread[k];}
          for(const[k,v]of Object.entries(ix.byMsgId||{})){if(removedAppIds.has(v))delete ix.byMsgId[k];}
          for(const[k,arr]of Object.entries(ix.byTo||{})){ix.byTo[k]=(arr||[]).filter(id=>!removedAppIds.has(id));if(!ix.byTo[k].length)delete ix.byTo[k];}
          persist(APPIDX_FILE,DB_APP_INDEX);
        }
      }
      invalidateUserStatsCache(s.user_email);
      console.log(`[history/delete] ${s.user_email} removeu key="${key}" (${before-hist.length} entradas, ${toRemove.length} emails limpos do sent)`);
      return json(res,200,{ok:true,removed:before-hist.length});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // Limpa TODO o histórico + DB_SENT do usuário (Reset geral — vagas voltam para a lista)
  if(pathname==="/api/history/clear"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const total=(DB_HIST[s.user_email]||[]).length;
      // Apaga histórico
      delete DB_HIST[s.user_email];
      persist(HIST_FILE,DB_HIST);
      // Apaga sent (anti-duplicata) — para que as vagas voltem à lista
      delete DB_SENT[s.user_email];
      persistSent();
      // Limpa índice de candidaturas
      if(DB_APP_INDEX[s.user_email]){
        delete DB_APP_INDEX[s.user_email];
        persist(APPIDX_FILE,DB_APP_INDEX);
      }
      invalidateUserStatsCache(s.user_email);
      console.log(`[history/clear] ${s.user_email} resetou histórico completo (${total} entradas)`);
      return json(res,200,{ok:true,removed:total});
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

  if(pathname==="/api/history"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const hist = getHist(s.user_email);
    // Garante que cada entrada tem tipo legível
    const enriched = hist.map(h => ({
      ...h,
      typeLabel: h.type==="auto" ? "🤖 Automático" : h.type==="reply" ? "↩️ Resposta" : "✋ Manual",
      // Garante que caseNum está presente para o anti-duplicata da planilha
      caseNum: h.caseNum || h.jobId || ""
    }));
    // Também retorna o que está NA FILA (ainda não enviado mas reservado)
    const autoJob = getAutoJob(s.user_email);
    const queueSize = autoJob?.active ? (autoJob.queue||[]).length : 0;
    const totalSent = hist.filter(h=>h.type!=="reply").length;
    const totalAuto = hist.filter(h=>h.type==="auto").length;
    const totalManual = hist.filter(h=>h.type==="manual").length;
    return json(res,200,{
      history: enriched,
      totalSent, totalAuto, totalManual,
      autoQueueSize: queueSize,
      notice: queueSize > 0
        ? `⚡ Você tem ${queueSize} vaga${queueSize>1?"s":""} aguardando na fila automática. Elas já foram reservadas e não aparecem na planilha.`
        : null
    });
  }

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
  if(pathname==="/api/disconnect"){const id=getSessId(req);if(id&&sessions[id]){delete sessions[id];persistSessionsDebounced(500);}res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":clearCookieStr()});return res.end('{"ok":true}');}

  // ── POST /api/account/delete — usuário deleta a própria conta ──────────
  // Soft-delete: NADA é apagado (histórico, financeiro, pedidos — tudo fica).
  // Só marca accountDeleted:true. Efeito imediato: some do ranking e de
  // qualquer lista pública, o automático para, a sessão é destruída (logout).
  // Relogar com o MESMO e-mail restaura tudo automaticamente (ver OAuth callback).
  if(pathname==="/api/account/delete"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    try{
      const d=JSON.parse(await readBody(req)||"{}");
      if(d.confirm!==true)return json(res,400,{error:"Confirmação obrigatória."});
      const email=s.user_email;
      setUser(email,{accountDeleted:true,deletedAt:Date.now()});
      // Para o automático imediatamente, se estiver rodando.
      const job=getAutoJob(email);
      if(job){
        setAutoJob(email,{...job,active:false,status:"paused_account_deleted",finishedAt:Date.now()});
      }
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      addLog(email,{status:"sistema",jobTitle:"🗑️ Conta deletada pelo usuário",company:"Some do ranking e de listas públicas. Dados ficam guardados. Relogar restaura tudo."});
      try{ trackJourney(email,'account_deleted',{detail:'Usuário deletou a própria conta'}); }catch{}
      console.log("[account] 🗑️ Conta deletada pelo usuário:",email);
      // Destrói a sessão (mesmo padrão do /api/disconnect) — logout imediato.
      const sid=getSessId(req);if(sid&&sessions[sid]){delete sessions[sid];persistSessionsDebounced(500);}
      res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":clearCookieStr()});
      return res.end('{"ok":true}');
    }catch(e){return json(res,500,{error:e.message});}
  }

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
    // Normalize sheets — KNOWN_SHEETS era uma lista estática (só jan2026/
    // jul2025/dol), então QUALQUER planilha nova (h2a, jan2025, jul2026...)
    // era descartada em silêncio aqui se o usuário tentasse selecioná-la
    // num perfil de envio automático. Agora é dinâmico: sempre inclui as
    // fixas + todas as chaves publicadas em SHEET_EXTRAS no momento do save.
    const KNOWN_SHEETS=["jan2026","jul2025","h2a-jun2026","dol",...Object.keys(SHEET_EXTRAS)];
    const sheets=Array.isArray(d.sheets)?d.sheets.filter(s=>KNOWN_SHEETS.includes(s)):[];
    const prf={id:d.id||crypto.randomUUID(),name:String(d.name).slice(0,80),desc:String(d.desc||"").slice(0,200),active:d.active!==false,isGeneral:!!d.isGeneral,subjects,emailBodies,subject:subjects[0]||String(d.subject||"").slice(0,200),body:emailBodies[0]||String(d.body||"").slice(0,5000),categories,sheets,resumeIdx:d.resumeIdx??null,pdfName:d.pdfName?String(d.pdfName).slice(0,200):undefined,pdfSize:d.pdfSize||0,coverIdx:d.coverIdx??null,state:String(d.state||"").slice(0,40),updatedAt:new Date().toISOString(),createdAt:d.createdAt||new Date().toISOString()};if(idx>=0)prfs[idx]=prf;else{if(prfs.length>=20)return json(res,429,{error:"Limite de 20 perfis atingido"});prfs.unshift(prf);}setUser(s.user_email,{profiles:prfs});return json(res,200,{ok:true,profile:prf});}catch(e){return json(res,500,{error:e.message});}}
  if(pathname==="/api/profiles/delete"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});try{const d=JSON.parse(await readBody(req));if(!d.id)return json(res,400,{error:"id obrigatório"});const p=getUser(s.user_email)||{};setUser(s.user_email,{profiles:(p.profiles||[]).filter(pr=>pr.id!==d.id)});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

  if(pathname==="/api/debug/export"){const s=getSess(req);if(!s?.user_email||(getUser(s.user_email)||{}).isAdmin!==true)return json(res,403,{error:"Acesso negado."});return json(res,200,{ts:new Date().toISOString(),users:DB_USERS,totalUsers:Object.keys(DB_USERS).length,dataDir:DATA_DIR,disk:fs.existsSync("/data")});}

  // ── ENVIO AUTOMÁTICO ──────────────────────────────────
  if(pathname==="/api/auto/start"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    // Proteção contra múltiplos cliques: bloqueia se já existe job ativo
    if(DATA_DIR==="/tmp"){
      return json(res,503,{error:"⚠️ Servidor sem volume persistente (/tmp). Configure DATA_DIR=/data com volume Docker/Railway antes de usar o automático.",diskVolatile:true});
    }
    const existingJob=getAutoJob(s.user_email);
    if(existingJob&&existingJob.active){
      return json(res,409,{error:"Envio automático já está em andamento. Pause ou pare antes de iniciar novamente.",alreadyRunning:true,queueSize:existingJob.queue?.length||0});
    }
    const p=getUser(s.user_email)||{};const h=getHist(s.user_email);const todayAuto=countAutoToday(h);const autoLimit=getAutoLimit(p);
    if(!isAdminVip(p)&&todayAuto>=autoLimit)return json(res,429,{error:`Limite de ${autoLimit} automáticos/dia atingido.`,limitReached:true});
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
      // ENRAIZAMENTO (2026-07-09): vagas já enviadas agora são cortadas AQUI,
      // na montagem da fila — não mais uma a uma na hora do envio. Antes a fila
      // nascia com TODAS as vagas (inclusive 2.000+ já enviadas), o tamanho da
      // fila mentia, o % de progresso mentia, e o motor perdia ciclos pulando
      // duplicata por duplicata. O skip do motor continua existindo como 2ª
      // camada de segurança (corrida entre manual e auto), mas o grosso sai já.
      const _sentSetStart = buildUserSentSet(s.user_email);
      let skippedAlreadySent = 0;
      // MODO 1: Frontend já enviou fila com emails (fluxo antigo, agora preserva todos os campos extras)
      if(d.queue&&d.queue.length){
        // v15-SEC: normaliza emails, valida com regex robusta, remove self-sends
        queue=d.queue.map(item=>{ const _p=parseEmail(item.to||''); return _p.ok ? {...item, to: _p.email} : null; })
          .filter(item => item && isValidEmail(item.to) && item.to !== s.user_email.toLowerCase())
          .filter(item => { if(_sentSetStart.has(_normEmail(item.to))){ skippedAlreadySent++; return false; } return true; })
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
      // MODO 2: Frontend enviou case numbers + caseMeta (contém email da planilha local)
      // Usa email diretamente do caseMeta (que vem do sheet-meta com campo email já preenchido)
      // Fallback: busca na planilha local pelo case number
      if(d.cases&&d.cases.length&&!queue.length){
        console.log(`[auto] Construindo fila de ${d.cases.length} vagas via caseMeta+planilha local...`);
        // Combina TODOS os sheets: jan2026 + jul2025 + planilhas extras carregadas
        const allSheetRows2 = getAllSheets();
        const sheetByCase = new Map(allSheetRows2.map(r=>[String(r.c||"").toUpperCase(), r]));
        let noEmailCount = 0;
        for(const cn of d.cases){
          const meta = d.caseMeta?.[cn] || {};
          // Prioridade: 1) caseMeta.email (vem do sheet-meta já populado), 2) planilha local, 3) meta.to
          let emailRaw = (meta.email||"").trim() || (meta.to||"").trim();
          if(!emailRaw){
            const row = sheetByCase.get(String(cn).toUpperCase());
            if(row?.e) emailRaw = (row.e||"").trim();
          }
          if(!emailRaw){ noEmailCount++; continue; }
          const _p = parseEmail(emailRaw);
          if(!_p.ok || _p.email === s.user_email.toLowerCase()) continue;
          if(_sentSetStart.has(_normEmail(_p.email))){ skippedAlreadySent++; continue; } // já enviou pra esse empregador
          const row = sheetByCase.get(String(cn).toUpperCase());
          // Título real: usa o título da planilha (campo t) em vez de occupation genérico
          const realTitle = meta.title || row?.t || meta.company || cn;
          queue.push({
            id: cn, to: _p.email,
            title: realTitle,
            company: meta.company || row?.n || "",
            category: meta.category || row?.k || "other",
            state: meta.state || row?.s || "",
            city: meta.city || row?.ci || row?.d || "",   // ci = cidade, d = legado
            wage: meta.wage || (row?.w ? `$${row.w}/${row.wunit||'h'}` : ""),
            visa: meta.visa || row?.visa || "",
            start: meta.start || row?.d || "",
            end: meta.end || row?.de || "",
            workers: meta.workers || row?.wk || null,
            desc: (meta.desc||"").slice(0,500),
            caseNum: cn,
            url: cn.startsWith("H-") ? `https://seasonaljobs.dol.gov/jobs/${cn}` : "",
            sheetOrigin: row?._sheet || "local",  // rastrear de qual planilha veio
          });
        }
        console.log(`[auto] ✅ ${queue.length} vagas com email de ${d.cases.length} cases (${noEmailCount} sem email, ${skippedAlreadySent} já enviadas — cortadas da fila)`);
      }
      if(!queue.length){
        if(skippedAlreadySent>0) return json(res,400,{error:`Todas as ${skippedAlreadySent} vagas dessa seleção já foram enviadas por você antes. Escolha outra fonte, categoria ou filtro para encontrar vagas novas.`,allAlreadySent:true,skippedAlreadySent});
        return json(res,400,{error:"Nenhuma vaga com e-mail encontrada. As planilhas JAN2026 e JUL2025 já têm e-mails embutidos. Verifique se os arquivos foram carregados corretamente.",noEmail:true});
      }
      // BUG-015 CORRIGIDO: proteção contra fila duplicada só bloqueia se o job anterior terminou
      // nos últimos 60s (era 5min) E não foi parado/cancelado manualmente pelo usuário.
      const queueFingerprint=crypto.createHash("md5").update(queue.map(i=>i.to).sort().join(",")).digest("hex");
      const lastJob=getAutoJob(s.user_email);
      if(lastJob&&lastJob.queueFingerprint===queueFingerprint&&lastJob.finishedAt&&Date.now()-lastJob.finishedAt<60_000&&lastJob.status==="finished"){
        return json(res,409,{error:"Esta fila idêntica já foi processada há menos de 1 minuto. Aguarde um momento.",duplicateQueue:true});
      }
      // startH/endH removidos — automático roda 24/7 sem janela de horário

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
      // ── Seleção de e-mails de envio (rodízio 1 a 1 SÓ entre os escolhidos) ──
      // Valida contra principal + extras ativos; se nada válido vier, usa todos (comportamento padrão).
      let jobSenders = null;
      if (Array.isArray(d.senders) && d.senders.length) {
        const validSet = new Set([s.user_email.toLowerCase(), ...((p.senderEmails||[]).filter(x=>x.active!==false).map(x=>String(x.email).toLowerCase()))]);
        jobSenders = d.senders.map(e=>String(e).toLowerCase().trim()).filter(e=>validSet.has(e));
        if (!jobSenders.length) jobSenders = null;
      }
      // mode removido — sempre 24/7
const job={active:true,startedAt:Date.now(),queue,originalCount:queue.length,filteredCount:queue.length,resumeIdx:jobResumeIdx,coverIdx:jobCoverIdx,bodyTemplate:d.bodyTemplate||p.settings?.body||"",subjects:Array.isArray(d.subjects)&&d.subjects.length?d.subjects:null,emailBodies:Array.isArray(d.emailBodies)&&d.emailBodies.length?d.emailBodies:null,status:"starting",lastSentAt:null,finishedAt:null,source:d.source||"manual",category:d.category||"all",filters:d.filters||{},queueFingerprint,rotState:{lastSubjIdx:-1,lastBodyIdx:-1},senders:jobSenders,lockedAutoLimit:isAdminVip(p)?9999:getAutoLimit(p)};
      setAutoJob(s.user_email,job);
      autoStats.set(s.user_email,{sent:0,failed:0,skipped:0,startedAt:Date.now()});
      addLog(s.user_email,{status:"sistema",jobTitle:`Envio automático iniciado: ${queue.length} vagas${skippedAlreadySent>0?` (${skippedAlreadySent} já enviadas foram puladas)`:""}`,company:`Fonte: ${d.source||"manual"} | Categoria: ${d.category||"all"}`,source:d.source||"manual",category:d.category||"all"});
      trackJourney(s.user_email,'auto_start',{detail:`Auto: ${queue.length} vagas | ${d.source||"manual"}`,meta:{queueSize:queue.length,skippedAlreadySent}});
      // Inicia imediatamente
      setTimeout(()=>scheduleAuto(s.user_email),100);
      return json(res,200,{ok:true,queueSize:queue.length,skippedAlreadySent});
    }catch(e){return json(res,500,{error:e.message});}
  }
  if(pathname==="/api/auto/pause"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}setAutoJob(s.user_email,{...j,active:false,status:"paused"});addLog(s.user_email,{status:"pausado",jobTitle:"Envio pausado pelo usuário",company:""});return json(res,200,{ok:true});}
  if(pathname==="/api/auto/resume"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);if(!j)return json(res,404,{error:"Nenhum job."});setAutoJob(s.user_email,{...j,active:true,status:"resuming"});addLog(s.user_email,{status:"sistema",jobTitle:"Envio retomado",company:""});scheduleAuto(s.user_email);return json(res,200,{ok:true});}
  if(pathname==="/api/auto/stop"&&req.method==="POST"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});if(autoTimers.has(s.user_email)){clearTimeout(autoTimers.get(s.user_email));autoTimers.delete(s.user_email);}addLog(s.user_email,{status:"cancelado",jobTitle:"Envio cancelado pelo usuário",company:""});delAutoJob(s.user_email);return json(res,200,{ok:true});}

  // ══════════════════════════════════════════════════════════
  //  BASE DE CONHECIMENTO PERMANENTE — rotas admin
  //  GET  /api/admin/kb          → lista todas as entradas
  //  POST /api/admin/kb          → adiciona nova entrada
  //  DELETE /api/admin/kb/:id    → remove entrada por ID
  // ══════════════════════════════════════════════════════════
  if(pathname==="/api/admin/kb"&&req.method==="GET"){
    const s=getSess(req);
    if(!s?.user_email||!isAdminEmail(s.user_email))return json(res,403,{error:"Acesso negado."});
    return json(res,200,{ok:true,total:DB_KB.entries.length,entries:DB_KB.entries});
  }
  if(pathname==="/api/admin/kb"&&req.method==="POST"){
    const s=getSess(req);
    if(!s?.user_email||!isAdminEmail(s.user_email))return json(res,403,{error:"Acesso negado."});
    let body=""; req.on("data",c=>body+=c); await new Promise(r=>req.on("end",r));
    let d; try{ d=JSON.parse(body); }catch{ return json(res,400,{error:"JSON inválido."}); }
    if(!d.problema||!d.solucao)return json(res,400,{error:"Campos obrigatórios: problema, solucao."});
    const nextNum = (DB_KB.entries.length>0
      ? Math.max(...DB_KB.entries.map(e=>parseInt((e.id||"KB-000").replace("KB-",""))||0))+1
      : 1);
    const entry = {
      id: `KB-${String(nextNum).padStart(3,"0")}`,
      versao: d.versao||"manual",
      data: new Date().toISOString().slice(0,10),
      autor: d.autor||s.user_email,
      problema: d.problema,
      solucao: d.solucao,
      motivo: d.motivo||"",
      impacto: d.impacto||"",
      modulos: Array.isArray(d.modulos)?d.modulos:[],
      tags: Array.isArray(d.tags)?d.tags:[]
    };
    DB_KB.entries.unshift(entry);
    persist(KB_FILE, DB_KB);
    console.log(`[kb] Nova entrada adicionada: ${entry.id} — ${entry.problema.slice(0,60)}`);
    return json(res,200,{ok:true,entry});
  }
  if(pathname.startsWith("/api/admin/kb/")&&req.method==="DELETE"){
    const s=getSess(req);
    if(!s?.user_email||!isAdminEmail(s.user_email))return json(res,403,{error:"Acesso negado."});
    const kbId=pathname.replace("/api/admin/kb/","");
    const before=DB_KB.entries.length;
    DB_KB.entries=DB_KB.entries.filter(e=>e.id!==kbId);
    if(DB_KB.entries.length===before)return json(res,404,{error:"Entrada não encontrada."});
    persist(KB_FILE,DB_KB);
    console.log(`[kb] Entrada removida: ${kbId}`);
    return json(res,200,{ok:true,removed:kbId});
  }

  // ── ADMIN: Reinicia todos os workers travados de uma vez ───────────────────────
  if(pathname==="/api/admin/restart-all-stalled"&&req.method==="POST"){
    const s=getSess(req);
    if(!s?.user_email||!isAdminEmail(s.user_email))return json(res,403,{error:"Acesso negado."});
    let restarted=0, tokensFailed=0, skipped=0;
    const SAFE_WAIT_STATUSES = new Set(["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"]);
    for(const[email,job] of Object.entries(DB_AUTO)){
      if(!job.active||!job.queue?.length) continue;
      // BUG3-FIX: não reiniciar quem está em espera legítima (limite diário, rate limit, etc.)
      const hasActiveTimer = autoTimers.has(email);
      const hasNextSendFuture = job.nextSendAt && job.nextSendAt > Date.now();
      const isLegitWait = SAFE_WAIT_STATUSES.has(job.status) && (hasActiveTimer || hasNextSendFuture);
      if(isLegitWait){ skipped++; continue; }
      // Renova token antes de reiniciar
      const u=getUser(email);
      if(u?.refresh_token){
        try{ await refreshTokenForUser(email); }
        catch(e){ tokensFailed++; console.warn(`[restart-all] token falhou ${email}:`,e.message); }
      }
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      setAutoJob(email,{...job,status:"recovering",nextSendAt:null});
      addLog(email,{status:"sistema",jobTitle:"🔄 Worker reiniciado pelo admin",company:"Restart manual via painel"});
      scheduleAuto(email);
      restarted++;
    }
    console.log(`[admin/restart-all] ${restarted} workers reiniciados, ${skipped} em espera legítima ignorados, ${tokensFailed} tokens falharam`);
    return json(res,200,{ok:true,restarted,skipped,tokensFailed});
  }

  // ── HEALTH CHECK — para Render/Railway não reiniciar o container ──────────────
  if(pathname==="/health"||pathname==="/ping"){
    const activeJobs=Object.values(DB_AUTO).filter(j=>j.active&&j.queue?.length>0).length;
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,uptime:Math.round(process.uptime()),memMB:Math.round(process.memoryUsage().rss/1024/1024),users:Object.keys(DB_USERS).length,activeJobs,ts:Date.now()}));
  }
  if(pathname==="/api/auto/status"&&req.method==="GET"){const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});const j=getAutoJob(s.user_email);const h=getHist(s.user_email);const p=getUser(s.user_email)||{};const stats=getAutoStats(s.user_email);const allLogs=DB_LOGS[s.user_email]||[];
    const logs=allLogs.slice(0,15);// últimos 15 logs para dashboard
    const logStats={sent:allLogs.filter(l=>l.status==="enviado").length,failed:allLogs.filter(l=>l.status==="falhou").length,dup:allLogs.filter(l=>l.status==="duplicado").length,skip:allLogs.filter(l=>l.status==="pulado").length};
    const todayLogs=allLogs.filter(l=>{const d=new Date(l.ts||0);return d.toDateString()===new Date().toDateString();});
    const todayStats={sent:todayLogs.filter(l=>l.status==="enviado").length,failed:todayLogs.filter(l=>l.status==="falhou").length};
    // jSH/jEH removidos — sem janela de horário
    const autoQueueIds=j&&j.active?(j.queue||[]).map(q=>q.id||q.caseNum).filter(Boolean):[];return json(res,200,{job:j?{active:j.active,status:j.status,queueSize:j.queue?.length||0,originalCount:j.originalCount,filteredCount:j.filteredCount,startedAt:j.startedAt,lastSentAt:j.lastSentAt,nextSendAt:j.nextSendAt,currentJob:j.currentJob,source:j.source,category:j.category,}:null,todayAuto:countAutoToday(h),autoLimit:getAutoLimit(p),stats,recentLogs:logs,logStats,todayStats,autoQueueIds:autoQueueIds});}

  // ── INBOX: Respostas recebidas no Gmail ───────────────────
  if(pathname==="/api/inbox"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const sid=getSessId(req);
    // Server-side inbox cache — 30s TTL (reduzido para melhor responsividade)
    if(!global._inboxCache) global._inboxCache={};
    // FIX-CRASH: limpa entradas antigas do cache (>5min) para evitar memory leak
    const _now2 = Date.now();
    for (const k of Object.keys(global._inboxCache)) {
      if (_now2 - global._inboxCache[k].ts > 5 * 60_000) delete global._inboxCache[k];
    }
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
      const isTokenErr=e.message==="TOKEN_EXPIRED"||e.message.includes("TOKEN_EXPIRED")||e.message.includes("Sessão expirada");
      if(isTokenErr)return json(res,401,{error:"TOKEN_EXPIRED",tokenExpired:true,message:"Sua conexão com o Gmail expirou. Reconecte para ver as respostas."});
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
    if(pathname==="/api/admin/users"&&req.method==="GET"){const list=Object.values(DB_USERS).map(u=>{const vok=isVipActive(u);const h=getHist(u.email);const autoJob=getAutoJob(u.email);return{email:u.email,name:u.name,picture:u.picture,country:u.country,phone:u.phone,created_at:u.created_at,cvCount:(u.cvs||[]).length,histCount:h.length,todaySent:countManualToday(h)+countAutoToday(h),plan:getPlan(u),isAdmin:!!u.isAdmin,vip:u.vip?{active:vok,expiresAt:u.vip.expiresAt,activatedAt:u.vip.activatedAt,days:u.vip.days||30,plan:u.vip.plan||"vip",manualExpires:u.vip.manualExpires||0,autoExpires:u.vip.autoExpires||0,source:u.vip.source||"admin",usedCode:u.vip.usedCode||null,codeNote:u.vip.codeNote||null,activatedBy:u.vip.activatedBy||null,note:u.vip.note||null}:null,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0}:null};}).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));return json(res,200,{users:list,total:list.length});}
    if(pathname==="/api/admin/vip/activate"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(!d.email)return json(res,400,{error:"email obrigatório."});
      const target=getUser(d.email);
      if(!target)return json(res,404,{error:"Usuário não encontrado."});
      const days=Math.max(0,Math.min(365,parseInt(d.days||30,10)));
      const autoDays=Math.max(0,Math.min(365,parseInt(d.autoDays||0,10)));
      const planName=d.plan||"vip";
      const now=Date.now();

      // Lógica CORRETA de acumulação:
      // - days = dias de acesso MANUAL
      // - autoDays = dias de acesso AUTOMÁTICO
      // - Para cada tipo, soma sobre o que já existe (se ainda ativo) ou começa de hoje
      // - NUNCA soma days em auto E autoDays em auto ao mesmo tempo

      const curManual=(target.vip?.manualExpires&&target.vip.manualExpires>now)?target.vip.manualExpires:now;
      const curAuto  =(target.vip?.autoExpires&&target.vip.autoExpires>now)?target.vip.autoExpires:now;

      // manualExpires: soma days (se o plano tem manual)
      const manualExpires = days>0 ? curManual + days*86400_000 : (target.vip?.manualExpires||0);

      // autoExpires: soma APENAS autoDays (não days) — evita o bug do 60 dias
      const autoExpires   = autoDays>0 ? curAuto + autoDays*86400_000 : (target.vip?.autoExpires||0);

      const vip={...(target.vip||{}),active:true,manualExpires,autoExpires,
        activatedAt:now,activatedBy:s.user_email,
        note:d.note||"",days,autoDays,plan:planName,source:'admin'};
      setUser(d.email,{plan:planName,vip});
      if(days>0) addCredito(d.email,{dias:days,tipo:"gratis",origem:"admin",motivo:`Ativação admin — ${planName}`+(d.note?` (${d.note})`:""),dadoPor:isAdminEmail(s.user_email)&&s.user_email===ADMIN_EMAIL?"Andrio":(ADMIN_EMAIL_2&&s.user_email===ADMIN_EMAIL_2?"Diego":s.user_email)});
      console.log(`[admin] ✅ Ativou ${planName} → ${d.email} (manual:${days}d→${new Date(manualExpires).toLocaleDateString('pt-BR')} auto:${autoDays}d→${autoExpires>now?new Date(autoExpires).toLocaleDateString('pt-BR'):'–'})`);

      // (Bônus de indicação por compra removido — 2026-07-03, KB-059)

      return json(res,200,{ok:true,vip,days,autoDays,
        manualExpiresDate:manualExpires>now?new Date(manualExpires).toLocaleDateString("pt-BR"):null,
        autoExpiresDate:autoExpires>now?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}}

    if(pathname==="/api/admin/vip/revoke"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email)return json(res,400,{error:"email obrigatório."});if(autoTimers.has(d.email)){clearTimeout(autoTimers.get(d.email));autoTimers.delete(d.email);}delAutoJob(d.email);setUser(d.email,{plan:"free",vip:{active:false,revokedAt:Date.now(),manualExpires:0,autoExpires:0}});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

    if(pathname==="/api/admin/vip/set-expiry"&&req.method==="POST"){try{
      const d=JSON.parse(await readBody(req));
      if(!d.email)return json(res,400,{error:"email obrigatório."});
      const target=getUser(d.email);
      if(!target)return json(res,404,{error:"Usuário não encontrado."});
      const now=Date.now();
      const manualDays=parseInt(d.manualDays||0,10);
      const autoDays=parseInt(d.autoDays||0,10);
      const manualExpires=manualDays>0?now+manualDays*86400000:0;
      const autoExpires=autoDays>0?now+autoDays*86400000:0;
      let planName=target.vip?.plan||"vip";
      if(d.plan)planName=d.plan;
      else if(manualDays>0&&autoDays>0)planName="vipro";
      else if(manualDays>0)planName="vip";
      else if(autoDays>0)planName="pro";
      const vip={...(target.vip||{}),active:true,manualExpires,autoExpires,
        adjustedAt:now,adjustedBy:s.user_email,
        note:d.note||(target.vip?.note||""),
        plan:planName,source:target.vip?.source||"admin",
        usedCode:target.vip?.usedCode||null};
      setUser(d.email,{plan:planName,vip});
      console.log("[admin] set-expiry "+d.email+" manual:"+manualDays+"d auto:"+autoDays+"d plano:"+planName);
      return json(res,200,{ok:true,vip,planName,
        manualExpiresDate:manualExpires>0?new Date(manualExpires).toLocaleDateString("pt-BR"):null,
        autoExpiresDate:autoExpires>0?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}}
    // ── Admin: PAGANTES — visão única "quem pagou + dias de VIP" (calculada no servidor = fonte única) ──
if(pathname==="/api/admin/pagantes"&&req.method==="GET"){try{
  const now=Date.now();
  const parseVal=v=>{if(typeof v==="number")return v||0;if(!v)return 0;const n=parseFloat(String(v).replace(/[^0-9,.-]/g,"").replace(",","."));return isNaN(n)?0:n;};
  const toTs=x=>{if(!x)return null;if(typeof x==="number")return x;const t=Date.parse(x);return isNaN(t)?null:t;};
  // Livro-caixa (fonte primária de pagamentos) por email
  const finByEmail={};
  for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){
    if(!pg||!pg.email)continue;
    const e=String(pg.email).toLowerCase();
    (finByEmail[e]=finByEmail[e]||[]).push({valor:parseVal(pg.valor),date:toTs(pg.dataPagamento)||toTs(pg.data)||pg.criadoEm||null,id:pg.id||null,source:"financeiro"});
  }
  // Pedidos pagos/ativos (fallback) por email
  const pedByEmail={};
  for(const ped of Object.values(DB_PEDIDOS||{})){
    if(!ped||!ped.userEmail)continue;
    const st=String(ped.status||"").toLowerCase();
    if(st!=="pago"&&st!=="ativo")continue;
    const e=String(ped.userEmail).toLowerCase();
    (pedByEmail[e]=pedByEmail[e]||[]).push({valor:parseVal(ped.valorTotal),date:ped.ativadoEm||ped.pagoEm||ped.createdAt||null,id:ped.id||null,source:"pedido"});
  }
  const PLAN_LABELS={free:"Free",vip:"⭐ VIP Manual",pro:"🤖 Pro",vipro:"⭐🤖 VIPro",doublepro:"🚀 DoublePro"};
  const rows=[];
  for(const u of Object.values(DB_USERS||{})){
    if(!u||!u.email)continue;
    const email=u.email;const elc=email.toLowerCase();const vip=u.vip||{};
    const src=String(vip.source||"").toLowerCase();
    // Pagamentos: Financeiro (primário) -> Pedidos (fallback) -> paymentAmount do usuário (último recurso)
    let pagamentos=finByEmail[elc]||[];
    if(!pagamentos.length) pagamentos=pedByEmail[elc]||[];
    if(!pagamentos.length && u.paymentAmount) pagamentos=[{valor:parseVal(u.paymentAmount),date:vip.activatedAt||null}];
    pagamentos=pagamentos.filter(p=>p.valor>0).sort((a,b)=>(b.date||0)-(a.date||0));
    const everPaidVip = (src===""||src==="admin"||src==="pago"||src==="payment") && ((vip.manualExpires||0)>0||(vip.autoExpires||0)>0||vip.activatedAt);
    const isPayer = pagamentos.length>0 || everPaidVip;
    if(!isPayer)continue;
    const plan=vip.plan||getPlan(u);
    const nextExp=Math.max(vip.manualExpires||0,vip.autoExpires||0);
    const daysLeft = nextExp>0 ? Math.ceil((nextExp-now)/86400000) : null;
    const manualActive=isManualVipActive(u);const autoActive=isAutoVipActive(u);
    const status = daysLeft===null?"sem_data":(daysLeft<=0?"vencido":(daysLeft<=3?"vencendo":"ativo"));
    const totalPago=pagamentos.reduce((acc,p)=>acc+p.valor,0);
    const last=pagamentos[0]||null;
    rows.push({
      email,name:u.name||email,plan,planLabel:PLAN_LABELS[plan]||plan,source:src||"admin",
      whatsapp:u.whatsapp||u.phone||"",
      manualExpires:vip.manualExpires||0,autoExpires:vip.autoExpires||0,nextExpiry:nextExp,
      daysLeft,manualActive,autoActive,active:(manualActive||autoActive),status,
      lastPaymentValor:last?last.valor:0,lastPaymentDate:last?last.date:null,
      lastPaymentId:last?last.id:null,lastPaymentSource:last?last.source:null,
      totalPago,pedidosCount:pagamentos.length,note:vip.note||""
    });
  }
  rows.sort((a,b)=>{if(a.daysLeft===null&&b.daysLeft===null)return 0;if(a.daysLeft===null)return 1;if(b.daysLeft===null)return -1;return a.daysLeft-b.daysLeft;});
  // Receita: livro-caixa (canônico); se vazio, soma pedidos
  const ms=new Date();ms.setDate(1);ms.setHours(0,0,0,0);const monthStart=ms.getTime();
  let recMes=0,recTotal=0;
  const finAll=((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[]);
  if(finAll.length){
    for(const pg of finAll){const v=parseVal(pg.valor);recTotal+=v;const dt=toTs(pg.dataPagamento)||toTs(pg.data)||pg.criadoEm||0;if(dt>=monthStart)recMes+=v;}
  } else {
    for(const e in pedByEmail)for(const p of pedByEmail[e]){recTotal+=p.valor;if((p.date||0)>=monthStart)recMes+=p.valor;}
  }
  const summary={
    totalPagantes:rows.length,
    ativos:rows.filter(r=>r.status==="ativo"||r.status==="vencendo").length,
    vencendo:rows.filter(r=>r.status==="vencendo").length,
    vencidos:rows.filter(r=>r.status==="vencido").length,
    semData:rows.filter(r=>r.status==="sem_data").length,
    receitaMes:recMes,receitaTotal:recTotal
  };
  return json(res,200,{ok:true,rows,summary,generatedAt:now});
}catch(e){return json(res,500,{error:e.message});}}
if(pathname.startsWith("/api/admin/user/")&&req.method==="DELETE"){const te=decodeURIComponent(pathname.split("/").pop());if(te===s.user_email)return json(res,400,{error:"Não pode deletar a si mesmo."});const t=getUser(te);if(t)(t.cvs||[]).forEach(c=>deleteCv(te,c.idx));if(autoTimers.has(te)){clearTimeout(autoTimers.get(te));autoTimers.delete(te);}delUser(te);delHist(te);if(DB_AUTO[te]){delete DB_AUTO[te];persist(AUTO_FILE,DB_AUTO);}if(DB_SENT[te]){delete DB_SENT[te];persistSent();}// BUG-011 CORRIGIDO: limpa dados órfãos ao deletar usuário
if(DB_LOGS[te]){delete DB_LOGS[te];persistLogs();}if(DB_APP_INDEX[te]){delete DB_APP_INDEX[te];persist(APPIDX_FILE,DB_APP_INDEX);}if(DB_PUSH[te]){delete DB_PUSH[te];persistPush();}if(DB_NOTES[te]){delete DB_NOTES[te];persist(NOTES_FILE,DB_NOTES);}if(DB_ALERTS[te]){delete DB_ALERTS[te];persist(ALERTS_FILE,DB_ALERTS);}return json(res,200,{ok:true});}
    if(pathname==="/api/admin/message"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));if(!d.email||!d.text)return json(res,400,{error:"email e text obrigatórios."});const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});setUser(d.email,{adminMessage:{text:d.text,date:new Date().toISOString(),from:s.user_email}});return json(res,200,{ok:true});}catch(e){return json(res,500,{error:e.message});}}

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
        // waiting_hour removido — sem janela de horário
        else if(job.active&&stalMs>1200000){phase="stalled";phDet=`Travado ${Math.round(stalMs/60000)}min. Timer:${hasTmr?'ativo':'MORTO'}`;phIco="🚨";canFix=true;}
        else if(job.active&&!hasTmr&&qLen>0){phase="dead_timer";phDet="Timer morto";phIco="💀";canFix=true;}
        else if(job.active&&qLen>0){const nx=job.nextSendAt;phase="running";phDet=`${qLen} restantes (${pct}%). ${nx&&nx>bsNow?`Próximo ${Math.round((nx-bsNow)/1000)}s`:"Enviando"}`;phIco="🟢";}
        else{phase=job.status||"unknown";phDet=`Status:${job.status||"?"} Fila:${qLen}`;phIco="❓";}
        const bsLogs=(DB_LOGS[em]||[]).slice(0,20).map(l=>({ts:l.ts,date:l.date||"",status:l.status,jobTitle:l.jobTitle||"",company:l.company||"",to:l.to||"",error:l.error||""}));
        bsResult.push({email:em,name:usr.name||em.split("@")[0],picture:usr.picture||"",plan:getPlan(usr),phase,phaseDetail:phDet,phaseIcon:phIco,canFix,needsUser,job:{active:job.active,status:job.status,queueLen:qLen,originalCount:origC,sentCount:sentC,pctDone:pct,startedAt:job.startedAt,lastSentAt:job.lastSentAt,nextSendAt:job.nextSendAt},todayAuto:tAuto,autoLimit:aLim,stalledMs:stalMs,restarts:bsH.restarts||0,errors:bsH.errors||0,lastError:bsH.lastError||"",checklist:{hasToken:hTok,hasPdf:hPdf,hasTimer:hasTmr,limitOk:tAuto<aLim,queueOk:qLen>0},logs:bsLogs});
      }
      const bsOrd={stalled:0,dead_timer:1,paused_token:2,waiting_limit:3,running:4,paused_manual:5,finished:6,unknown:7};
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
        // Erros recentes (últimas 24h) — exclui falhas de rate limit (são esperas normais)
        const recentErrors=logs.filter(l=>
          (l.status==="falhou"||l.status==="erro_anexo")&&
          l.ts>(now-86400000)&&
          !((l.error||"").toLowerCase().includes("rate limit")||
            (l.error||"").toLowerCase().includes("ratelimit")||
            (l.error||"").toLowerCase().includes("user-rate"))
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
            // waiting_hour removido
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
        const logs=(DB_LOGS[u.email]||[]).slice(0,8); // mais logs para diagnóstico
        const todaySent=countManualToday(hist)+countAutoToday(hist);
        // CORREÇÃO: duplicados NÃO são falhas — são comportamento normal e esperado do sistema
        // "falhou" = erro real (SMTP, quota, token, etc.)
        // "duplicado" / "pulado" = sistema funcionando corretamente (anti-spam, anti-repetição)
        const todayFailed=(DB_LOGS[u.email]||[]).filter(l=>l.status==="falhou"&&l.ts>now-86400000).length;
        const todaySkipped=(DB_LOGS[u.email]||[]).filter(l=>l.status==="pulado"&&l.ts>now-86400000).length;
        const todayDuplicates=(DB_LOGS[u.email]||[]).filter(l=>l.status==="duplicado"&&l.ts>now-86400000).length;
        const isOnline=onlineEmails.has(u.email);
        const lastSession=onlineSessions.find(s=>s.user_email===u.email);
        const sessionAge=lastSession?Math.round((now-(lastSession.created_at||0))/60000):null;
        const jobStalled=job?.active&&job?.queue?.length>0&&(now-(job.lastSentAt||job.startedAt||0))>STALL_THRESHOLD;
        const uPlan=getPlan(u);
        const autoLimitU=getAutoLimit(u);
        const manualLimitU=getManualLimit(u);
        const todayManualU=countManualToday(hist);
        const todayAutoU=countAutoToday(hist);

        // ── DIAGNÓSTICO: por que não está enviando? ──────────────
        let diagStatus = "ok";
        let diagReason = "";
        let diagAction = "";
        if (job?.active) {
          const lastSentMs = job.lastSentAt ? now - job.lastSentAt : null;
          const minsSinceLastSend = lastSentMs ? Math.round(lastSentMs/60000) : null;
          const expectedMaxInterval = 6; // 5min max + 1min margem

          if (job.status === "waiting_limit") {
            diagStatus = "waiting_limit";
            diagReason = `Limite diário atingido (${todayAutoU}/${autoLimitU}). Retoma amanhã.`;
            diagAction = "Normal — aguarda meia-noite BRT";
          // waiting_hour removido — sem janela de horário
            diagAction = "Normal — aguarda horário configurado";
          } else if (job.status === "waiting_rate_limit") {
            diagStatus = "rate_limit";
            diagReason = `Gmail bloqueou temporariamente (rate limit). Retoma às ${job.nextSendAt?new Date(job.nextSendAt).toLocaleTimeString("pt-BR",{timeZone:"America/Sao_Paulo"}):"?"}`;
            diagAction = "Normal — aguarda Google liberar";
          } else if (job.status === "waiting_token_retry") {
            diagStatus = "token_retry";
            diagReason = "Erro temporário de token. Tentando renovar em 5min.";
            diagAction = "Aguardar ou reiniciar manualmente";
          } else if (jobStalled) {
            diagStatus = "stalled";
            const stallMins = Math.round((now-(job.lastSentAt||job.startedAt||0))/60000);
            diagReason = `Travado há ${stallMins}min sem enviar. Timer: ${autoTimers.has(u.email)?"✅ ativo":"❌ morto"}. Token: ${h.oauthOk===false?"❌ inválido":"?"}`;
            diagAction = "Reinicie o worker — watchdog vai tentar automaticamente";
          } else if (minsSinceLastSend !== null && minsSinceLastSend > expectedMaxInterval && job.status === "sending") {
            diagStatus = "stuck_sending";
            diagReason = `Status 'sending' há ${minsSinceLastSend}min — possível travamento interno`;
            diagAction = "Reinicie o worker";
          } else if (!h.oauthOk && h.oauthOk !== null) {
            diagStatus = "no_token";
            diagReason = "Token OAuth inválido ou revogado. Usuário precisa fazer login novamente.";
            diagAction = "Usuário deve fazer login";
          } else if (!h.hasPdf && h.hasPdf !== null) {
            diagStatus = "no_pdf";
            diagReason = "PDF do currículo não encontrado no servidor.";
            diagAction = "Usuário deve fazer upload do PDF novamente";
          } else if (minsSinceLastSend !== null && minsSinceLastSend > 10 && !["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"].includes(job.status)) {
            diagStatus = "slow";
            diagReason = `Último envio há ${minsSinceLastSend}min. Status: ${job.status}. Timer: ${autoTimers.has(u.email)?"✅":"❌"}`;
            diagAction = autoTimers.has(u.email) ? "Aguardar próximo ciclo" : "Reiniciar worker — timer morto";
          } else if (!job.lastSentAt && job.startedAt) {
            const startedMins = Math.round((now-job.startedAt)/60000);
            diagStatus = startedMins > 8 ? "never_sent" : "starting";
            diagReason = startedMins > 8
              ? `Iniciou há ${startedMins}min mas nunca enviou nenhum email. Possível problema de configuração.`
              : `Iniciando (${startedMins}min) — primeiro envio em breve`;
            diagAction = startedMins > 8 ? "Verifique logs — pode ser PDF ausente ou assunto vazio" : "Aguardar";
          } else {
            diagStatus = "ok";
            const lastSendStr = job.lastSentAt ? `${Math.round((now-job.lastSentAt)/60000)}min atrás` : "nunca";
            const nextSendStr = job.nextSendAt && job.nextSendAt > now ? `em ${Math.round((job.nextSendAt-now)/60000)}min` : "em breve";
            diagReason = `Funcionando normalmente. Último envio: ${lastSendStr}. Próximo: ${nextSendStr}.`;
            diagAction = "";
          }
        }

        return{
          email:u.email, name:u.name, picture:u.picture, plan:uPlan,
          isOnline, sessionAge,
          hasAuto:!!job?.active,
          autoStatus:job?.status||null,
          // autoMode/startH/endH removidos — sem janela de horário
          queueSize:job?.queue?.length||0,
          originalCount:job?.originalCount||0,
          queueDaysLeft:autoLimitU>0?Math.ceil((job?.queue?.length||0)/autoLimitU):null,
          lastSentAt:job?.lastSentAt||null,
          startedAt:job?.startedAt||null,
          nextSendAt:job?.nextSendAt||null,
          currentJob:job?.currentJob||null,
          jobStalled,
          timers:autoTimers.has(u.email),
          manualLimit:manualLimitU,
          autoLimit:autoLimitU,
          todaySentManual:todayManualU,
          todaySentAuto:todayAutoU,
          todaySent:todayManualU+todayAutoU,
          todayFailed, todaySkipped, todayDuplicates,
          profileCount:(u.profiles||[]).length,
          hasPdf:h.hasPdf,
          oauthOk:h.oauthOk,
          gmailOk:h.gmailOk,
          restarts:h.restarts||0,
          errors:h.errors||0,
          lastError:h.lastError||"",
          stalledSince:h.stalledAt,
          totalSent:hist.filter(x=>x.type!=="reply").length,
          totalAutoSent:hist.filter(x=>x.type==="auto").length,
          totalManualSent:hist.filter(x=>x.type==="manual").length,
          cvCount:(u.cvs||[]).length,
          createdAt:u.created_at||u.createdAt||"",
          recentLogs:logs,
          lastHeartbeat:h.lastSent||0,
          source:job?.source||null,
          category:job?.category||null,
          totalQueueRemaining:job?.queue?.length||0,
          autoLimitLocked:job?.lockedAutoLimit||null,
          // DIAGNÓSTICO COMPLETO
          diag:{ status:diagStatus, reason:diagReason, action:diagAction },
          vip:u.vip?{active:isVipActive(u),manualExpires:u.vip.manualExpires||0,autoExpires:u.vip.autoExpires||0,plan:u.vip.plan||'vip',source:u.vip.source||'admin',usedCode:u.vip.usedCode||null,codeNote:u.vip.codeNote||null,activatedBy:u.vip.activatedBy||null,activatedAt:u.vip.activatedAt||null,note:u.vip.note||null}:null,
          // CCC fields para filtros
          lastValidatedAt:u.lastValidatedAt||null,
          lastValidatedBy:u.lastValidatedBy||null,
          lastValidationResult:u.lastValidationResult||null,
          financialStatus:u.financialStatus||null,
          hasReceipt:!!(u.paymentAmount||u.financialStatus==='pago'),
          accountDeleted:!!u.accountDeleted, deletedAt:u.deletedAt||null,
        };
      }).sort((a,b)=>{
        // Ordena: problemas primeiro, depois ativos, depois online, depois por envios hoje
        const prob = (u) => ["stalled","stuck_sending","no_token","no_pdf","never_sent","token_retry"].includes(u.diag?.status) ? 0 : 1;
        if(prob(a)<prob(b)) return -1; if(prob(a)>prob(b)) return 1;
        if(a.hasAuto&&!b.hasAuto)return-1; if(!a.hasAuto&&b.hasAuto)return 1;
        if(a.isOnline&&!b.isOnline)return-1; if(!a.isOnline&&b.isOnline)return 1;
        return(b.todaySent||0)-(a.todaySent||0);
      });
      const totalSentToday=Object.values(DB_HIST).reduce((n,h)=>n+h.filter(x=>x.dateStr===todayStr()).length,0);
      const totalSentAll=Object.values(DB_HIST).reduce((n,h)=>n+h.length,0);
      // FIX-ADM: estatísticas completas de fila
      const totalQueueAll=Object.values(DB_AUTO).reduce((n,j)=>n+(j.queue?.length||0),0);
      const totalOriginalAll=Object.values(DB_AUTO).reduce((n,j)=>n+(j.originalCount||0),0);
      const activeWithQueue=Object.values(DB_AUTO).filter(j=>j.active&&j.queue?.length>0).length;
      const waitingLimit=Object.values(DB_AUTO).filter(j=>j.active&&j.status==="waiting_limit").length;
      const diskOk=DATA_DIR!=="/tmp";
      return json(res,200,{
        ts:now,
        adminEmail:s.user_email,
        onlineCount:onlineEmails.size,
        activeAutoCount:activeJobs.length,
        activeWithQueue,
        waitingLimit,
        stalledCount:stalledJobs.length,
        totalUsers:Object.keys(DB_USERS).length,
        totalSentToday,totalSentAll,
        totalQueueAll,totalOriginalAll,
        activeSessions:Object.keys(sessions).filter(k=>!k.startsWith("__")).length,
        globalEvents:GLOBAL_EVENTS.slice(0,100),
        users,
        serverUptime:Math.round(process.uptime()),
        memMB:Math.round(process.memoryUsage().rss/1048576),
        sheetJan:SHEET_JAN.length,sheetJul:SHEET_JUL.length,
        jobsCache:jobsCache.length,
        diskOk,dataDir:DATA_DIR,
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

    // ── ADMIN: Edição completa do cliente (Client Control Center) ────────────
    if(pathname==="/api/admin/user/full-update"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});
        // Validar senha do editor
        const editorKey=matchEditorPassword(d.editorPassword);
        if(!editorKey)return json(res,403,{error:"Senha de edição inválida."});
        const editorName=editorKey==="andrew"?"Andrew":"Diego";
        const now=Date.now();
        const upd={};
        // Dados de perfil
        if(d.name!==undefined)upd.name=String(d.name).slice(0,200);
        if(d.phone!==undefined)upd.phone=String(d.phone).slice(0,50);
        if(d.whatsapp!==undefined)upd.whatsapp=String(d.whatsapp).slice(0,50);
        if(d.country!==undefined)upd.country=String(d.country).slice(0,100);
        if(d.city!==undefined)upd.city=String(d.city).slice(0,100);
        if(d.state!==undefined)upd.state=String(d.state).slice(0,100);
        if(d.address!==undefined)upd.address=String(d.address).slice(0,300);
        if(d.age!==undefined)upd.age=Math.max(0,Math.min(120,parseInt(d.age)||0));
        if(d.adminNotes!==undefined)upd.adminNotes=String(d.adminNotes).slice(0,2000);
        // Plano VIP
        if(d.manualDays!==undefined||d.autoDays!==undefined){
          const manualDays=Math.max(0,Math.min(3650,parseInt(d.manualDays||0,10)));
          const autoDays=Math.max(0,Math.min(3650,parseInt(d.autoDays||0,10)));
          const bonusDays=Math.max(0,Math.min(365,parseInt(d.bonusDays||0,10)));
          const manualExpires=manualDays>0?now+manualDays*86400000:0;
          const autoExpires=autoDays>0?now+autoDays*86400000:0;
          let planName="free";
          if(manualDays>0&&autoDays>0)planName="vipro";
          else if(manualDays>0)planName="vip";
          else if(autoDays>0)planName="pro";
          const vip={...(target.vip||{}),active:planName!=="free",manualExpires,autoExpires,
            adjustedAt:now,adjustedBy:editorName,adjustedByEmail:s.user_email,
            note:d.vipNote||(target.vip?.note||""),
            plan:planName,source:target.vip?.source||"admin",
            bonusDays:bonusDays||(target.vip?.bonusDays||0),
            usedCode:target.vip?.usedCode||null};
          upd.plan=planName;
          upd.vip=vip;
        }
        // Situação financeira
        if(d.financialStatus!==undefined)upd.financialStatus=String(d.financialStatus).slice(0,50);
        if(d.paymentNote!==undefined)upd.paymentNote=String(d.paymentNote).slice(0,500);
        if(d.paymentDate!==undefined)upd.paymentDate=String(d.paymentDate).slice(0,50);
        if(d.paymentAmount!==undefined)upd.paymentAmount=String(d.paymentAmount).slice(0,50);
        if(d.paymentMethod!==undefined)upd.paymentMethod=String(d.paymentMethod).slice(0,50);
        if(d.paymentReceiver!==undefined)upd.paymentReceiver=String(d.paymentReceiver).slice(0,50);
        // Histórico de edições
        const editEntry={at:now,by:editorName,byEmail:s.user_email,changes:Object.keys(upd).join(","),note:d.editNote||""};
        const prevHistory=target.adminEditHistory||[];
        upd.adminEditHistory=[...prevHistory.slice(-49),editEntry]; // mantém últimas 50
        upd.lastValidatedAt=target.lastValidatedAt||null;
        setUser(d.email,upd);
        console.log(`[admin] ✅ Full-update de ${d.email} por ${editorName} (${s.user_email}): ${Object.keys(upd).join(",")}`);
        trackJourney(d.email,'admin_edit',{detail:`Editado por ${editorName}`,meta:{fields:Object.keys(upd)}});
        return json(res,200,{ok:true,editorName,editedFields:Object.keys(upd)});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN: Validar cliente com Gemini ─────────────────────────────────────
    if(pathname==="/api/admin/user/validate"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        if(!d.email)return json(res,400,{error:"email obrigatório."});
        const target=getUser(d.email);if(!target)return json(res,404,{error:"Usuário não encontrado."});
        const now=Date.now();
        const vip=target.vip||{};
        const manualDaysLeft=vip.manualExpires&&vip.manualExpires>now?Math.ceil((vip.manualExpires-now)/86400000):0;
        const autoDaysLeft=vip.autoExpires&&vip.autoExpires>now?Math.ceil((vip.autoExpires-now)/86400000):0;
        const hist=getHist(d.email)||[];
        const comprovantes=[];// comprovantes ficam no localStorage do admin - usar dados financeiros do perfil
        const totalPago=parseFloat((target.paymentAmount||'0').replace(/[^0-9.,]/g,'').replace(',','.').trim())||0;
        const dossiePagamento={
          plano:vip.plan||"free",
          fonte:vip.source||"–",
          manualDiasRestantes:manualDaysLeft,
          autoDiasRestantes:autoDaysLeft,
          manualExpira:vip.manualExpires?new Date(vip.manualExpires).toLocaleDateString("pt-BR"):"–",
          autoExpira:vip.autoExpires?new Date(vip.autoExpires).toLocaleDateString("pt-BR"):"–",
          diasBonus:vip.bonusDays||0,
          totalComprovantes:target.paymentAmount?1:0,
          totalPagoDetectado:`R$${totalPago.toFixed(2)}`,
          situacaoFinanceira:target.financialStatus||"–",
          notaPagamento:target.paymentNote||"–",
          valorPago:target.paymentAmount||"–",
          dataPagamento:target.paymentDate||"–",
          quemRecebeu:target.paymentReceiver||"–",
          historicoEdits:(target.adminEditHistory||[]).length,
          ultimaEdicao:target.adminEditHistory?.slice(-1)[0]?.by||"–",
          totalEnviados:hist.length,
          notasAdmin:target.adminNotes||"–"
        };
        const GEMINI_API_KEY=getGeminiKey();
        if(!GEMINI_API_KEY)return json(res,503,{error:"Gemini não configurado."});
        const geminiPrompt=`Você é o auditor financeiro do H2BApply. Analise a situação deste cliente e determine se está TUDO CORRETO ou se há DIVERGÊNCIA.

DADOS DO CLIENTE: ${target.name||d.email} (${d.email})
${JSON.stringify(dossiePagamento,null,2)}

REGRAS DE VALIDAÇÃO:
- Plano "vip" = só envio manual, sem automático. Dias auto devem ser 0.
- Plano "vipro" = manual + automático. Os dois devem ter dias.
- Plano "doublepro" = igual vipro mas com 2 contas Gmail.
- Plano "free" = sem VIP ativo. Dias manual e auto devem ser 0.
- "trial" como fonte = usuário está no trial gratuito de 1 dia. Normal.
- "admin" como fonte = foi ativado manualmente pelo admin. Verificar se tem comprovante ou nota de pagamento.
- Dias bônus são legítimos — não geram divergência.
- Se totalPagoDetectado for 0 mas o plano for pago (vip/vipro/doublepro) e fonte for "admin", verificar nota de pagamento. Se houver nota, considerar OK.
- Se houver comprovante de pagamento e plano ativo, é OK.
- Se não houver comprovante E não houver nota de pagamento E fonte for "admin", é PENDÊNCIA.

Responda APENAS em JSON (sem markdown):
{
  "status": "CLIENTE_VALIDADO" ou "PENDENCIAS_DETECTADAS",
  "statusEmoji": "✅" ou "⚠️",
  "resumo": "Resumo em 1-2 frases para o admin",
  "detalhes": ["item1","item2"],
  "pendencias": ["pendencia1"] ou [],
  "recomendacao": "Ação recomendada ao admin"
}`;
        const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const gemPayload={contents:[{parts:[{text:geminiPrompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:1000}};
        const gemResVal=await new Promise((resolve,reject)=>{
          const bodyG=JSON.stringify(gemPayload);
          const uG=new URL(geminiUrl);
          const optsG={hostname:uG.hostname,path:uG.pathname+uG.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(bodyG)}};
          const reqG=https.request(optsG,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida"));}});});
          reqG.on("error",reject);reqG.setTimeout(20000,()=>{reqG.destroy();reject(new Error("Timeout Gemini"));});
          reqG.write(bodyG);reqG.end();
        });
        let rawText=(gemResVal.body?.candidates?.[0]?.content?.parts?.[0]?.text||"").replace(/```json|```/g,"").trim();
        let result;try{result=JSON.parse(rawText);}catch{result={status:"PENDENCIAS_DETECTADAS",statusEmoji:"⚠️",resumo:"Erro ao processar auditoria Gemini.",detalhes:[rawText.slice(0,200)],pendencias:["Erro interno Gemini"],recomendacao:"Verificar manualmente."}}
        // Salvar resultado da validação no usuário
        const {editorPassword}=d;
        const editorKey=matchEditorPassword(editorPassword);
        if(editorKey){
          setUser(d.email,{lastValidatedAt:now,lastValidatedBy:editorKey==="andrew"?"Andrew":"Diego",lastValidationResult:result.status});
        }
        return json(res,200,{ok:true,result,dossiePagamento});
      }catch(e){return json(res,500,{error:e.message});}
    }

    // ── ADMIN: Live endpoint retorna adminEmail ────────────────
    if(pathname==="/api/admin/settings"&&req.method==="GET"){const _s={...DB_ADMIN_SETTINGS};delete _s.editorPasswords;return json(res,200,{settings:_s,adminEmail:s.user_email,editorPwdSet:{andrew:!!getEditorPasswords().andrew,diego:!!getEditorPasswords().diego}});}
    if(pathname==="/api/admin/settings"&&req.method==="POST"){try{const d=JSON.parse(await readBody(req));delete d.editorPasswords;Object.assign(DB_ADMIN_SETTINGS,d);persist(ADMIN_SETTINGS_FILE,DB_ADMIN_SETTINGS);const _s={...DB_ADMIN_SETTINGS};delete _s.editorPasswords;return json(res,200,{ok:true,settings:_s});}catch(e){return json(res,500,{error:e.message});}}
    // ── Admin troca a PRÓPRIA senha de editor (Andrew/Diego) ──
    // Cada sócio troca a sua senha sem o outro saber. Exige a senha atual.
    if(pathname==="/api/admin/editor-password"&&req.method==="POST"){
      try{
        const d=JSON.parse(await readBody(req));
        const who=(d.who||"").trim().toLowerCase();
        if(!["andrew","diego"].includes(who))return json(res,400,{error:"Editor inválido. Use 'andrew' ou 'diego'."});
        const cur=(d.currentPassword||"").toString();
        const nw=(d.newPassword||"").toString();
        if(matchEditorPassword(cur)!==who)return json(res,403,{error:"Senha atual incorreta."});
        if(nw.length<4)return json(res,400,{error:"A nova senha precisa ter pelo menos 4 caracteres."});
        if(nw===cur)return json(res,400,{error:"A nova senha precisa ser diferente da atual."});
        DB_ADMIN_SETTINGS.editorPasswords={...pwds,[who]:nw};
        persist(ADMIN_SETTINGS_FILE,DB_ADMIN_SETTINGS);
        console.log(`[editor-password] senha de ${who} alterada por ${s.user_email}`);
        return json(res,200,{ok:true,message:`Senha de ${who==="andrew"?"Andrew":"Diego"} atualizada com sucesso.`});
      }catch(e){return json(res,500,{error:e.message});}
    }
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
      const category=["sends","vip","active"].includes(u.searchParams.get("category"))?u.searchParams.get("category"):"sends";
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
        ["sends","vip","active"].forEach(cat=>{delete rankPosCache[`${period}_${cat}`];});
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
    // 🔒 FIX (varredura total 03/07): anti-brute-force — sem isso, um usuário logado
    // podia testar códigos VIP ilimitadamente até acertar um válido.
    if(rateLimit(s.user_email+"_redeem",10,3600_000))return json(res,429,{error:"Muitas tentativas de código. Aguarde 1 hora."});
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
      const planName=c.autoDays>0&&c.manualDays>0?'vipro':c.manualDays>0?'vip':c.autoDays>0?'pro':'vip';
      const vip={...(u.vip||{}),active:true,manualExpires,autoExpires,
        source:'code',usedCode:code,codeNote:c.note||'',
        activatedAt:now,plan:planName,days:c.manualDays||c.autoDays,autoDays:c.autoDays||0};
      setUser(s.user_email,{vip,plan:planName});
      DB_CODES[code]={...c,usedBy:[...c.usedBy,s.user_email]};
      persistCodes();
      console.log(`[codes] ${code} usado por ${s.user_email} manual:${c.manualDays}d auto:${c.autoDays}d`);
      return json(res,200,{ok:true,manualDays:c.manualDays,autoDays:c.autoDays,manualExpiresDate:c.manualDays>0?new Date(manualExpires).toLocaleDateString("pt-BR"):null,autoExpiresDate:c.autoDays>0?new Date(autoExpires).toLocaleDateString("pt-BR"):null});
    }catch(e){return json(res,500,{error:e.message});}
  }

  // ══ MULTI-SERVIDOR ═══════════════════════════════════════
  // GET /api/servers/self — dados públicos mínimos deste servidor (para peers)
  if(pathname==="/api/servers/self"&&req.method==="GET"){
    return json(res,200,{ok:true,id:_resolveServerId(req),users:_countLocalUsers(),at:Date.now()});
  }
  // GET /api/servers/has-account?h=<sha256 do e-mail> — checagem de conta única
  // entre servidores. Só recebe HASH (privacidade); rate limit por IP.
  if(pathname==="/api/servers/has-account"&&req.method==="GET"){
    const _hip=(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"").split(",")[0].trim();
    if(rateLimit("hasacct_"+_hip,120,60_000))return json(res,429,{error:"Muitas consultas. Aguarde."});
    const h=(u.searchParams.get("h")||"").toLowerCase().trim();
    if(!/^[a-f0-9]{64}$/.test(h))return json(res,400,{error:"hash inválido"});
    return json(res,200,{ok:true,serverId:_resolveServerId(req),exists:_emailHashExists(h)});
  }
  // GET /api/auth/where?email=<e-mail> — localiza em QUAL servidor o e-mail já
  // tem conta (fluxo de login do card de entrada: e-mail sem senha → servidor
  // certo → só lá acontece o login do Google). Checa local primeiro (grátis),
  // depois os irmãos via hash SHA-256 (o e-mail nunca viaja em texto entre
  // servidores). Não expõe NADA além de "existe / em qual servidor".
  if(pathname==="/api/auth/where"&&req.method==="GET"){
    const _wip=(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"").split(",")[0].trim();
    if(rateLimit("authwhere_"+_wip,30,60_000))return json(res,429,{error:"Muitas tentativas. Aguarde um minuto."});
    const email=String(u.searchParams.get("email")||"").toLowerCase().trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)||email.length>120)return json(res,400,{error:"E-mail inválido"});
    const _selfId=_resolveServerId(req);
    const list=_getServersConfig();
    const _svInfo=sv=>({id:sv.id,nome:sv.nome,url:sv.url||"",status:sv.status,self:sv.id===_selfId});
    // 🛡️ Atalho ADMIN (pedido do dono, 07/07/2026): admin não fica preso à regra
    // "conta pertence a 1 servidor só" — ele PRECISA conseguir entrar em
    // QUALQUER servidor pra administrar/testar. Quando o e-mail é admin, manda
    // junto a lista COMPLETA de servidores (com self) pro front oferecer
    // "entrar direto" em cada um, além do resultado normal de onde a conta existe.
    const _isAdmin=isAdminEmail(email);
    const _allServers=_isAdmin?list.map(_svInfo):undefined;
    // 1) Conta existe NESTE servidor?
    const h=crypto.createHash("sha256").update(email).digest("hex");
    if(_emailHashExists(h)){
      const me=list.find(s=>s.id===_selfId)||{id:_selfId,nome:"Servidor "+_selfId,status:"aberto"};
      return json(res,200,{ok:true,found:true,server:_svInfo(me),isAdmin:_isAdmin,servers:_allServers});
    }
    // 2) Existe em algum irmão? (fail-open: peer fora do ar = não encontrado lá)
    const peer=await checkAccountOnPeers(email,_selfId);
    if(peer)return json(res,200,{ok:true,found:true,server:_svInfo(peer),isAdmin:_isAdmin,servers:_allServers});
    // 3) Não existe em lugar nenhum → devolve servidores abertos p/ criar conta
    const abertos=list.filter(s=>s.status!=="lotado").map(_svInfo);
    return json(res,200,{ok:true,found:false,openServers:abertos,isAdmin:_isAdmin,servers:_allServers});
  }
  // GET /api/servers — lista completa para o seletor da landing.
  // Para o próprio servidor conta usuários locais; para peers busca (cache 10 min)
  // via httpsReq; se o peer estiver fora, users=null e o front mostra "—".
  if(pathname==="/api/servers"&&req.method==="GET"){
    const _selfId=_resolveServerId(req);
    const list=_getServersConfig();
    const out=[];
    for(const sv of list){
      let users=null;
      if(sv.id===_selfId){ users=_countLocalUsers(); }
      else if(sv.url){ const pi=await _fetchPeerJson(sv.url,"/api/servers/self"); if(pi&&typeof pi.users==="number") users=pi.users; }
      out.push({id:sv.id,nome:sv.nome,url:sv.url,maxExibido:sv.maxExibido,status:sv.status,users,self:sv.id===_selfId});
    }
    return json(res,200,{ok:true,selfId:_selfId,servers:out});
  }
  // GET /api/servers/ranking-export — top 50 público deste servidor (mesmos
  // dados já públicos no ranking: nome/avatar/plano/envios; NUNCA e-mail).
  if(pathname==="/api/servers/ranking-export"&&req.method==="GET"){
    return json(res,200,{ok:true,serverId:_resolveServerId(req),list:_calcGlobalExport()});
  }
  // GET /api/ranking/global — ranking geral de TODOS os servidores (local + peers).
  if(pathname==="/api/ranking/global"&&req.method==="GET"){
    const _selfId=_resolveServerId(req);
    const rows=_calcGlobalExport().map(r=>({...r,serverId:_selfId}));
    for(const sv of _getServersConfig()){
      if(sv.id===_selfId||!sv.url) continue;
      const pr=await _fetchPeerJson(sv.url,"/api/servers/ranking-export");
      if(pr&&Array.isArray(pr.list)) rows.push(...pr.list.slice(0,50).map(r=>({
        name:String(r.name||"Usuário").slice(0,40),picture:String(r.picture||"").slice(0,500),
        appAvatarId:String(r.appAvatarId||"").slice(0,10),plan:String(r.plan||"free").slice(0,12),
        score:parseInt(r.score)||0,uid:String(r.uid||"").slice(0,16),serverId:sv.id
      })));
    }
    rows.sort((a,b)=>b.score-a.score);
    return json(res,200,{ok:true,selfId:_selfId,list:rows.slice(0,50).map((r,i)=>({pos:i+1,...r})),updatedAt:new Date().toISOString()});
  }

  if(pathname==="/api/public-stats"&&req.method==="GET"){
    const ds=todayStr();
    const totalUsers=Object.keys(DB_USERS).length;
    const vipUsers=Object.values(DB_USERS).filter(u=>isVipActive(u)).length;
    const allHist=Object.values(DB_HIST);
    const _todayManual=allHist.reduce((n,a)=>n+a.filter(h=>h.dateStr===ds&&h.type==="manual").length,0);
    const todayAuto=allHist.reduce((n,a)=>n+a.filter(h=>h.dateStr===ds&&h.type==="auto").length,0);
    const todaySent=_todayManual+todayAuto;
    const totalSent=allHist.reduce((n,a)=>n+a.filter(h=>h.type!=="reply").length,0);
    const totalAuto=allHist.reduce((n,a)=>n+a.filter(h=>h.type==="auto").length,0);
    // Preview do ranking diário para landing page (top 5 sem dados sensíveis)
    const { list: rankPreview } = calcRanking("day", "sends", null);
    return json(res,200,{totalUsers,vipUsers,todaySent,todayAuto,totalSent,totalAuto,trialEnabled:!!DB_ADMIN_SETTINGS.newUserTrialEnabled,trialDays:1,rankPreview:rankPreview.slice(0,5)}); // FIX Fase-0: era hardcode 5; trial real = 1 dia (KB-686: números de plano nunca hardcodados... este estava)
  }

  // ── RANKING API ───────────────────────────────────────────
  // GET /api/gamification — XP, nível e conquistas do usuário logado (V954).
  // Tudo derivado do histórico: recomputável, sem estado novo, sem migração.
  if(pathname==="/api/gamification"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const h=getHist(s.user_email);
    const man=h.filter(e=>e.type==="manual").length;
    const auto=h.filter(e=>e.type==="auto").length;
    const rep=h.filter(e=>e.type==="reply").length;
    const xp=xpFromCounts(man,auto,rep);
    const streak=calcStreak(h);
    const nivel=levelForXP(xp);
    const conquistas=calcConquistas(h,streak);
    return json(res,200,{ok:true,xp,nivel,streak,conquistas,
      desbloqueadas:conquistas.filter(c=>c.unlocked).length,total:conquistas.length});
  }
  if(pathname==="/api/ranking"&&req.method==="GET"){
    const period   = ["day","week","month","all"].includes(u.searchParams.get("period"))   ? u.searchParams.get("period")   : "day";
    const category = ["sends","vip","active"].includes(u.searchParams.get("category")) ? u.searchParams.get("category") : "sends";
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
    // Perfil público OPCIONAL escrito pelo próprio usuário (Editar Perfil).
    // Só dados que a pessoa escolheu compartilhar — nada de e-mail/telefone/cidade.
    const pubP=found.publicProfile||{};
    const _showPic=pubP.mostrarFotoGoogle!==false;
    return json(res,200,{
      name:found.rankName||found.name||"Usuário",
      picture:_showPic?(found.picture||""):"",
      appAvatarId:found.appAvatarId||"",
      plan:getPlan(found),
      isOnline:isOnlineUser(foundEmail),totalSends:totS,totalResponses:totR,responseRate:respRate,
      streak,memberSince,last7:l7,topStates,adminBadge:DB_RANK_BADGES[foundEmail]||null,
      vipCompras:(calcVipCompras()[foundEmail]||0),
      serverId:_resolveServerId(req),
      sobre:String(pubP.sobre||"").slice(0,600),
      experiencias:String(pubP.experiencias||"").slice(0,400),
      foiContratado:["sim","nao"].includes(pubP.foiContratado)?pubP.foiContratado:"",
      opiniao:String(pubP.opiniao||"").slice(0,300)});
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
// isAdmin helper — movido para próximo ao getSess/json (linha ~2007) para clareza

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
    if(!getGeminiKey()) return json(res,503,{error:"Gemini API não configurada. Configure GEMINI_API_KEY no servidor."});
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
- VIPro: R$150/mês → 200 manuais/dia + 200 automáticos/dia
- Novos usuários ganham 1 dia de VIP Manual grátis ao se cadastrar (trial de boas-vindas)

=== COMO PAGAR ===
Pagamento via PIX para Andrio Kickhofel (telefone: 53981453496). Após pagar, enviar comprovante + Gmail pelo WhatsApp: +55 53 98145-3496. Plano ativado em até 24h.

=== ENVIO AUTOMÁTICO (DETALHE TÉCNICO) ===
- Roda no servidor Railway, NÃO precisa do celular ligado
- Intervalo de 5 a 6 minutos entre e-mails (anti-spam)
- Sistema anti-duplicata: nunca envia duas vezes para a mesma empresa
- Limite Gmail: não ultrapassar 400-500 e-mails/dia pelo mesmo Gmail (risco de bloqueio)
- O automático usa o perfil certo por categoria automaticamente
- Pode pausar, retomar ou parar a qualquer momento

=== PERFIS DE E-MAIL ===
- Perfil Geral (🌐): usado como fallback para qualquer vaga sem perfil específico
- Perfil por Categoria (📂): landscape, construction, housekeeper, seafood, farm, golf, amusement, forest, lifeguard, etc.
- Cada perfil precisa: nome, currículo PDF (obrigatório), mínimo 3 assuntos, mínimo 3 corpos de e-mail
- Variáveis automáticas nos templates: {nome}, {vaga}, {empresa}, {pais}, {telefone}, {email}, {cidade}, {estado}, {wage}, {salario}, {inicio}, {fim}, {case_number}, {url_vaga}

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
          const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiKey()}`;
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


  // ── ANÁLISE DE COMPROVANTE — Gemini Vision ─────────────────────────────
  // Recebe imagem base64 de comprovante PIX e extrai: valor, data, remetente, destinatário
  // ── ROBÔ DE AUDITORIA — Gemini analisa todo o sistema ────
  if(pathname==="/api/admin/auditoria-gemini" && req.method==="POST"){
    const s=getSess(req); if(!s?.user_email) return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email); if(!isAdminVip(p)) return json(res,403,{error:"Acesso negado"});
    if(!getGeminiKey()) return json(res,503,{error:"Gemini API não configurada. Configure GEMINI_API_KEY no Render."});
    try{
      const now=Date.now();
      const allUsers=Object.values(DB_USERS||{});
      // ── Montar dossiê completo do sistema ──
      const usersSnapshot = allUsers.map(u=>{
        if(!u||!u.email) return null;
        const job=getAutoJob(u.email);
        const _hist=getHist(u.email);
        const sentToday=countAutoToday(_hist)||0;
        const sentManual=countManualToday(_hist)||0;
        const tokenOk=u.cached_token_expiry&&u.cached_token_expiry>now;
        const vipOk=isManualVipActive(u)||isAutoVipActive(u);
        const vipExp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);
        return {
          email:u.email,name:u.name||u.email,plan:u.plan||'free',
          vipAtivo:vipOk,vipExpira:vipExp?new Date(vipExp).toISOString().slice(0,10):null,
          tokenValido:tokenOk,
          tokenExpiraEm:u.cached_token_expiry?new Date(u.cached_token_expiry).toISOString().slice(0,16):null,
          autoRodando:job?.active||false,
          autoStatus:job?.status||'inativo',
          autoFilaSize:job?.queue?.length||0,
          enviosAuto:sentToday,
          enviosManuais:sentManual,
          totalHistorico:(Object.keys(DB_HIST[u.email]||{})).length,
          cvs:u.cvs?.length||0,
          emailsExtra:u.senderEmails?.length||0,
          ultimoEnvioAuto:job?.lastSentAt?new Date(job.lastSentAt).toISOString().slice(0,16):null,
          travado:job?.active&&job?.lastSentAt&&(now-job.lastSentAt)>7200000&&!["waiting_limit","waiting_rate_limit","waiting_interval","waiting_token_retry"].includes(job?.status),
          statusAuto:job?.status||"inativo",
          aguardandoLimite:job?.status==="waiting_limit",
          aguardandoRateLimit:job?.status==="waiting_rate_limit",
          proximoEnvio:job?.nextSendAt?new Date(job.nextSendAt).toISOString().slice(0,16):null,
          membro:u.created_at?u.created_at.slice(0,10):null,
          diasInativo:Math.round((now-(u.lastSeenAt||new Date(u.created_at||0).getTime()))/86400000),
          ultimoAcesso:u.lastSeenAt?new Date(u.lastSeenAt).toISOString().slice(0,10):null,
          tokenProblemaReal:!!(u.cached_token_expiry&&u.cached_token_expiry<now&&(now-(u.lastSeenAt||0))<=(10*86400000))
        };
      }).filter(Boolean);

      const pedidosPendentes=(DB_PEDIDOS||[]).filter(pd=>pd.status==='pendente').length;
      const pedidosAtivos=(DB_PEDIDOS||[]).filter(pd=>pd.status==='ativo').length;
      const totalReceita=(()=>{let r=0;for(const u of Object.values(DB_USERS||{})){if(isVipActive(u)&&u.paymentAmount){const v=parseFloat((u.paymentAmount||'0').replace(/[^0-9.,]/g,'').replace(',','.'));if(!isNaN(v))r+=v;}}return r;})();
      const usersComToken=usersSnapshot.filter(u=>u.tokenValido).length;
      const usersAutoRodando=usersSnapshot.filter(u=>u.autoRodando).length;
      const usersTravados=usersSnapshot.filter(u=>u.travado).length;
      const usersTokenProblemaReal=usersSnapshot.filter(u=>u.tokenProblemaReal).length; // token expirado + ativo ≤10 dias
      const usersTokenInativoIgnorado=usersSnapshot.filter(u=>u.cached_token_expiry&&u.cached_token_expiry<Date.now()&&u.diasInativo>10).length;
      const usersAguardandoLimite=usersSnapshot.filter(u=>u.aguardandoLimite).length;
      const usersAguardandoRateLimit=usersSnapshot.filter(u=>u.aguardandoRateLimit).length;
      const usersSemCV=usersSnapshot.filter(u=>u.cvs===0&&u.autoRodando).length;

      // ══════════════════════════════════════════════════════════════
      // DOSSIÊ GEMINI v9.0 — CONTEXTO COMPLETO + DADOS REAIS
      // ══════════════════════════════════════════════════════════════

      // ── Dados extras para o dossiê ──────────────────────────────
      const _pedidosDetalhados=(DB_PEDIDOS||[]).slice(0,30).map(pd=>({
        id:pd.id?.slice(-8),user:pd.userEmail,nome:pd.userName||'?',
        plano:pd.plano,dias:pd.dias,diasBonus:pd.diasBonus||0,diasTotal:pd.diasTotal||pd.dias||30,
        status:pd.status,valor:pd.valorTotal,desconto:pd.desconto||0,
        temComprovante:!!(pd.comprovante),criadoEm:pd.createdAt?new Date(pd.createdAt).toISOString().slice(0,10):null,
        ativadoPor:pd._ativadoEditor||pd.ativadoPor||null,
        geminiAuditoria:pd.geminiAuditoria?.status||null,
        horasPendente:pd.status==='pendente'?Math.round((Date.now()-(pd.createdAt||0))/3600000):null,
      }));

      const _clientesValidados=Object.values(DB_USERS||{}).filter(u=>u.lastValidatedAt).map(u=>({
        email:u.email,status:u.lastValidationResult,validadoPor:u.lastValidatedBy,
        em:u.lastValidatedAt?new Date(u.lastValidatedAt).toISOString().slice(0,10):null
      }));

      const _pedidosCriticos=(DB_PEDIDOS||[]).filter(pd=>pd.status==='pendente'&&(Date.now()-(pd.createdAt||0))>24*3600000);
      const _authErrors=usersSnapshot.filter(u=>u.statusAuto==='paused_auth_error');
      const _semCV=usersSnapshot.filter(u=>u.cvs===0&&u.autoRodando);
      const _planosAtivos=Object.values(DB_USERS||{}).filter(u=>isVipActive(u)&&u.plan!=='free'&&!isAdminVip(u));

      // Métricas de envio dos últimos 7 dias por plano
      const _enviosPorPlano={vip:0,vipro:0,doublepro:0,free:0};
      const _since7=Date.now()-7*86400000;
      for(const [email,logs] of Object.entries(DB_LOGS||{})){
        const u=getUser(email);if(!u)continue;
        const plan=getPlan(u)||'free';
        const envios7=(logs||[]).filter(l=>l.ts&&l.ts>_since7&&l.status==='enviado').length;
        if(envios7)_enviosPorPlano[plan]=(_enviosPorPlano[plan]||0)+envios7;
      }

      // Aprendizados recentes (últimas 10 entradas de auditoria)
      const _aprendizadosRecentes=DB_KB.entries.filter(e=>e.tipo==='auditoria_aprendizado').slice(-10);

      const dossie=`
╔══════════════════════════════════════════════════════════════════╗
║          H2BAPPLY — DOSSIÊ COMPLETO v9.0 PARA GEMINI            ║
║     Data: ${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} (BRT)     ║
╚══════════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. IDENTIDADE DO SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
H2BApply é um SaaS brasileiro (Node.js monolito) que automatiza envio de
candidaturas para vistos H-2B e H-2A (trabalho sazonal nos EUA).
Fundadores: Andrio (técnico) e Diego (comercial/pagamentos).
Deploy: Render.com, disco persistente /data 1GB.

PLANOS ATUAIS (CORRETOS jun/2026):
┌─────────────┬──────────────┬─────────────────────────────────────┐
│ Plano       │ Preço        │ Limites diários                     │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ FREE        │ Grátis       │ 20 manual + 10 auto                 │
│ VIP Manual  │ R$100/mês    │ 200 manual + 10 auto                │
│ VIPro       │ R$150/mês    │ 200 manual + 200 auto               │
│ DoublePro   │ R$250/mês    │ 400 manual + 400 auto (2 Gmails)    │
└─────────────┴──────────────┴─────────────────────────────────────┘
TRIAL: 1 dia VIP Manual apenas (sem automático) no primeiro login.
Anti-abuse: IP + telefone + Google ID (3 camadas).

TABELA DE PREÇOS POR PERÍODO:
VIP: 30d=R$100 | 60d=R$190 | 90d=R$270 | 1ano=R$960
VIPro: 30d=R$150 | 60d=R$285 | 90d=R$405 | 1ano=R$1440
DoublePro: 30d=R$250 | 60d=R$475 | 90d=R$675 | 1ano=R$2400

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. GUIA DE FUNCIONAMENTO (LEIA ANTES DE ANALISAR)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STATUS NORMAIS DO AUTOMÁTICO (NÃO são problemas):
✅ waiting_limit       → Atingiu limite diário. Aguarda meia-noite BRT.
✅ waiting_rate_limit  → Gmail pediu pausa. Retoma em minutos.
✅ waiting_interval    → Aguardando intervalo entre envios (3-5min).
✅ waiting_token_retry → Erro temporário de token. Retry em 5min.
✅ finished            → Fila concluída. SUCESSO.
✅ paused_no_vip       → VIP expirou. Normal — usuário precisa renovar.

STATUS QUE INDICAM PROBLEMA REAL:
🔴 paused_auth_error       → Auth falhou repetidamente. Usuário precisa relogar.
🔴 paused_token_revoked    → Usuário revogou acesso no Google.
🔴 stalled                 → Travado genuinamente >2h sem razão válida.

SOBRE TOKENS:
- token expirado + ativo ≤3 dias = URGENTE
- token expirado + inativo >10 dias = IGNORAR (usuário parou de usar)

SOBRE CLIENTES NOVOS (FLUXO ATUAL):
1. Usuário se cadastra → ganha 1 dia VIP Manual (trial)
2. Usuário solicita plano → envia comprovante
3. Admin abre Modal de Aprovação → vê comprovante → escolhe dias bônus → confirma senha
4. Sistema ativa VIP, preenche CCC do cliente, Gemini audita automaticamente
5. Dados financeiros salvos no perfil do cliente (CCC)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. RESUMO GERAL DO SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total usuários: ${usersSnapshot.length}
Com token Gmail válido: ${usersComToken}
Automático rodando: ${usersAutoRodando}
Robôs travados (genuíno): ${usersTravados}
Aguardando limite diário (NORMAL): ${usersAguardandoLimite}
Aguardando rate limit (NORMAL): ${usersAguardandoRateLimit}
Token expirado + ativo ≤10d (PROBLEMA REAL): ${usersTokenProblemaReal}
Token expirado + inativo >10d (IGNORAR): ${usersTokenInativoIgnorado}
Sem CV com auto ativo: ${usersSemCV}
Paused auth_error: ${_authErrors.length}
Pedidos pendentes: ${pedidosPendentes}
Planos VIP ativos (isVipActive): ${_planosAtivos.length}
Receita ativa: R$${totalReceita.toFixed(2)}
Gemini API: ${getGeminiKey()?'✅ OK':'❌ AUSENTE'}
Clientes validados pelo Gemini: ${_clientesValidados.length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. USUÁRIOS — SNAPSHOT COMPLETO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(usersSnapshot, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. PEDIDOS DE PLANO — DETALHADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PEDIDOS CRÍTICOS (pendentes >24h): ${_pedidosCriticos.length}
${_pedidosCriticos.map(pd=>`  ⚡ ${pd.userEmail} — ${pd.plano} R$${pd.valorTotal} — ${Math.round((Date.now()-(pd.createdAt||0))/3600000)}h pendente${pd.comprovante?'  📸 com comprovante':' ⚠️ SEM comprovante'}`).join('\n')}

TODOS OS PEDIDOS (últimos 30):
${JSON.stringify(_pedidosDetalhados, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. FINANCEIRO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Receita ativa (planos isVipActive): R$${(()=>{let r=0;for(const u of Object.values(DB_USERS||{})){if(isVipActive(u)&&u.paymentAmount){const v=parseFloat((u.paymentAmount||'0').replace(/[^0-9.,]/g,'').replace(',','.'));if(!isNaN(v))r+=v;}}return r;})().toFixed(2)}
Pedidos pendentes >3 dias: ${(DB_PEDIDOS||[]).filter(pd=>pd.status==='pendente'&&(Date.now()-(pd.createdAt||0))>3*86400000).length}
Clientes pagantes (isVipActive, não free): ${_planosAtivos.length}
Conversão free→pago: ${((_planosAtivos.length/Math.max(1,Object.keys(DB_USERS||{}).length))*100).toFixed(1)}%
Trial ativo agora: ${Object.values(DB_USERS||{}).filter(u=>u.vip?.source==='trial'&&isVipActive(u)).length} usuários

Envios 7 dias por plano:
- VIP: ${_enviosPorPlano.vip} emails
- VIPro: ${_enviosPorPlano.vipro} emails
- DoublePro: ${_enviosPorPlano.doublepro} emails
- Free: ${_enviosPorPlano.free} emails

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. CLIENTES VALIDADOS PELO GEMINI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(_clientesValidados, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. BOUNCES E QUALIDADE DE DADOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bounces permanentes: ${Object.values(DB_INVALID_EMAILS||{}).filter(e=>e.tipo==='permanente'||e.tipo==='bloqueado').length}
Falhas temporárias: ${Object.values(DB_TEMP_FAILURES||{}).length}
Top domínios com bounce: ${(()=>{const d={};Object.values(DB_INVALID_EMAILS||{}).forEach(e=>{const dom=(e.email||'').split('@')[1]||'?';d[dom]=(d[dom]||0)+1;});return Object.entries(d).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+'('+v+')').join(', ')||'nenhum';})()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. LOGS DE SISTEMA (últimas 24h — erros)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(()=>{const since=Date.now()-86400000;const errs=[];for(const [email,logs] of Object.entries(DB_LOGS||{})){(logs||[]).filter(l=>l.ts>since&&(l.status==='erro'||l.status==='cancelado'||l.error)).slice(0,2).forEach(l=>{errs.push({user:email,status:l.status,job:(l.jobTitle||'').slice(0,50),error:(l.error||'').slice(0,80),ts:new Date(l.ts).toISOString().slice(11,16)});});}return JSON.stringify(errs.slice(0,25),null,2)||'[]';})()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. PLANILHAS E ENRIQUECIMENTO DOL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
jan2026: ${(typeof SHEET_JAN!=='undefined'?SHEET_JAN.length:0)} vagas
jul2025: ${(typeof SHEET_JUL!=='undefined'?SHEET_JUL.length:0)} vagas
Extras: ${Object.keys(SHEET_EXTRAS||{}).map(k=>k+'('+((SHEET_EXTRAS[k]||[]).length)+'vagas)').join(', ')||'nenhuma'}
Enriquecimento bot: ${typeof _enrichBot!=='undefined'&&_enrichBot?.running?'SIM — '+(_enrichBot.done||0)+'/'+(_enrichBot.total||0):'inativo'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. ENGAJAMENTO (últimos 7 dias)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(()=>{const since7=Date.now()-7*86400000;const ativos7=Object.values(DB_USERS||{}).filter(u=>u.lastSeenAt&&u.lastSeenAt>since7).length;const enviadores7=Object.values(DB_LOGS||{}).filter(logs=>(logs||[]).some(l=>l.ts>since7&&l.status==='enviado')).length;const totalEnvios7=Object.values(DB_LOGS||{}).reduce((a,logs)=>a+(logs||[]).filter(l=>l.ts>since7&&l.status==='enviado').length,0);return `Ativos: ${ativos7} | Enviaram: ${enviadores7} | Total emails: ${totalEnvios7}`;})()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. ARQUITETURA TÉCNICA & REGRAS DE DESENVOLVIMENTO (CONHECIMENTO PERMANENTE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STACK: Node.js monólito puro (http nativo, sem framework). Frontend SPA vanilla: index.html (app do usuário), admin.html (painel), guia.html (tutorial). Login Google OAuth + envio pela Gmail API do próprio usuário. Persistência em flat-file JSON no disco /data (Render.com).

MODELO DE DADOS (persistido em /data):
- DB_USERS: usuários. NUNCA acessar direto — usar getUser(email)/setUser(email,updates).
- DB_PEDIDOS: pedidos (valorTotal, status pendente|pago|ativo|cancelado|expirado, plano, dias).
- DB_FINANCEIRO: {pagamentos:[],gastos:[]} — livro-caixa (fonte canônica de receita).
- DB_INCIDENTS: Central de Incidentes. DB_LOGS: histórico de envios por usuário.
- DB_KB: esta base (memória IA-IA; só soma, nunca apaga).

FUNÇÕES-CHAVE (sempre usar; nunca ler propriedade direto):
getUser/setUser · getHist/addLog · countManualToday/countAutoToday · todayStrBRT() · isManualVipActive(u)/isAutoVipActive(u)/isVipActive(u)/getPlan(u) · getManualLimit/getAutoLimit · httpsReq() (HTTP nativo) · pushGlobalEvent() · trackJourney() · persistFinanceiro/persistPedidos.

REGRAS CRÍTICAS (o fundador NUNCA deve quebrar; código que violar isto É PROBLEMA a reportar):
1. NUNCA fetch() no server.js — usar httpsReq() nativo (não há node-fetch).
2. NUNCA acessar DB_USERS direto — sempre getUser/setUser.
3. NUNCA DB_COMPROVANTES no servidor — comprovantes vivem no localStorage do navegador do admin.
4. Toda rota /api/admin checa isAdminVip()/isAdmin antes de acessar dados.
5. Manter ??20 (não ||20) em manualRemaining (0 é valor válido).
6. Checar prefixo H-300 ANTES de H-3 (colisão H-400/H-300).
7. H-2A e H-2B são sistemas SEPARADOS (anti-duplicado independente).
8. Plano ativo = isVipActive(), nunca DB_PEDIDOS.filter(status==='ativo').
9. Números de plano/limite/trial vêm do backend (PLAN_LIMITS) — divergência na UI É PROBLEMA.
10. Validar cada bloco <script> com checagem de sintaxe antes de publicar (1 aspa quebra o bloco inteiro — ver KB-021).

MAPA DE TELAS:
- Usuário (index.html): home, vagas, pesquisa, salvas, enviadas, respostas, perfil/currículos, automático, planos, ranking, notificações, resgatar, tutorial, IA chat, sugestões.
- Admin (admin.html): dashboard, usuários, VIP & Planos, Vencimentos VIP, Pagantes (quem pagou + dias), Pedidos, Lixeira, Códigos, Financeiro, Central de Incidentes, Robô de Auditoria (VOCÊ), Emails Inválidos, Planilhas, IA Admin.

COMO VOCÊ (GEMINI) DEVE AGIR:
- Validar o sistema contra estas regras e contra a KB. O que está conforme NÃO é bug.
- Sugerir melhorias de retenção/conversão/UX/anti-abuse SEM remover funcionalidades.
- Sempre citar o email do usuário afetado e a ação concreta.
- Antes de sugerir, conferir se já não está na KB (não repetir).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
13. BASE DE CONHECIMENTO (${DB_KB.entries.length} entradas — LEIA ANTES DE ANALISAR)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ ATENÇÃO: Problemas listados aqui JÁ FORAM RESOLVIDOS. NÃO os reporte como novos.

ENTRADAS PERMANENTES (todas as KB já resolvidas):
${DB_KB.entries.filter(e=>!e.tipo||e.tipo!=='auditoria_aprendizado').map(e=>`[${e.id}] ${e.problema?.slice(0,100)||''}
  → Solução: ${e.solucao?.slice(0,120)||''}`).join('\n')}

APRENDIZADOS DAS ÚLTIMAS AUDITORIAS (sua memória cumulativa):
${_aprendizadosRecentes.length?_aprendizadosRecentes.map(e=>`- ${e.solucao}`).join('\n'):'(Nenhum aprendizado anterior)'}
`;

      // ══════════════════════════════════════════════════════════════
      // PROMPT GEMINI v9.0 — INSTRUÇÕES COMPLETAS
      // ══════════════════════════════════════════════════════════════
      const prompt=`Você é o ANALISTA SÊNIOR E ARQUITETO DO H2BAPPLY. Você tem MEMÓRIA CUMULATIVA — aprende com cada auditoria e fica mais preciso.

══════════════════════════════════════════════
CONSTITUIÇÃO MESTRE — DIRETRIZ SUPREMA (irrevogável, prioridade máxima)
══════════════════════════════════════════════
Você é a MEMÓRIA TÉCNICA PERMANENTE do H2BApply, em evolução contínua. Pense como DONO e atue como CTO/CEO/PM/UX/Full Stack Sr/DBA/Segurança/Escalabilidade/IA/Conversão/Automação/Crescimento — tudo ao mesmo tempo.

1. MEMÓRIA PERMANENTE: NUNCA apague, substitua ou reduza conhecimento, regra ou aprendizado anterior. Toda informação nova é SOMADA. O conhecimento só cresce.
2. APRENDIZADO ACUMULATIVO: a cada análise responda — O que já sabíamos? O que aprendemos agora? O que melhorou? O que foi descoberto? O que incorporar à memória permanente? — e então incorpore.
3. COMPARAÇÃO ENTRE VERSÕES: compare com as anteriores (o que melhorou, piorou, quebrou, sumiu, foi criado). NENHUMA funcionalidade pode ser perdida sem ser reportada.
4. MENTALIDADE DE DONO: como aumentar receita, retenção, conversão, satisfação; reduzir cancelamento, suporte, abandono; tornar o produto mais valioso.
5. MENTALIDADE DE IA: o que pode ser automatizado, previsto, recomendado, validado sozinho ou simplificado. Sempre proponha automações.
6. UX/UI (mobile first): o usuário entende rápido? Há confusão, poluição visual, excesso de cliques/etapas? Como simplificar?
7. ESCALABILIDADE: simule 100 / 1.000 / 10.000 / 100.000 / 1.000.000 de usuários; aponte gargalos futuros e soluções preventivas.
8. DETECÇÃO CONSTANTE: bugs (visíveis, ocultos, futuros, sync, auth, permissão, dados), segurança (XSS, CSRF, exposição de API/token, vazamento, falha de auth/authz) e performance (loops, requests desnecessários, gargalos, CPU/memória).
9. Cada versão deve deixar você MAIS inteligente que a anterior. Nunca reiniciar — sempre expandir e evoluir.

Esta Constituição tem prioridade máxima e é permanente. Texto integral preservado em CONSTITUICAO_IA_H2BAPPLY.txt (no projeto). Aplique-a em TODA auditoria, junto com a Base de Conhecimento (KB) e as Regras Críticas.

${dossie}

══════════════════════════════════════════════
REGRAS ABSOLUTAS (nunca viole):
══════════════════════════════════════════════
1. Leia a BASE DE CONHECIMENTO — TODOS os problemas listados (KB-001 a KB-028+) JÁ foram resolvidos, não os reporte
2. waiting_limit/rate_limit/interval/token_retry = NORMAIS, nunca são problemas
3. token expirado + inativo >10 dias = IGNORAR completamente
4. Planos ativos = use isVipActive() (${_planosAtivos.length} usuários), não DB_PEDIDOS.filter(ativo)
5. Trial atual = 1 dia VIP Manual (sem automático) — não reporte como VIPro
6. Analise TODOS os dados: usuários, financeiro, pedidos, bounces, logs, planilhas

══════════════════════════════════════════════
TREINAMENTO v2 (03/07/2026) — APRENDIZADOS DA ÚLTIMA AUDITORIA (some, nunca substitui):
══════════════════════════════════════════════
7. O sistema agora tem o 🩺 HEALTH SENTINEL: automação que roda a cada 6h e JÁ notifica sozinho — VIP com robô parado (vip_desync), VIP expirando ≤3d (vip_expiring), VIP sem perfil (no_profile), fila concluída (refill), auth_error >12h; alerta o admin de pedido pendente >6h por e-mail; e sanitiza filas com e-mails inválidos a cada 2h. REGRA: quando encontrar um caso dessas categorias, NÃO liste como "Ação: notificar usuário" (isso já é automático). Em vez disso, VERIFIQUE: "o Sentinel já notificou? há quanto tempo?" e só escale como crítico se a automação estiver falhando (ex.: pedido pendente >24h = o alerta de 6h não surtiu efeito → aí sim é crítico PARA O ADMIN AGIR).
8. AGRUPE POR CAUSA RAIZ, nunca liste sintomas repetidos: N usuários com token expirado no mesmo dia = 1 achado ("N tokens expirados — causa raiz: app em modo Testing no Google, verificação pendente"), não N críticos separados. Deduplique sempre.
9. Bot de enriquecimento: "running:false" NÃO significa inativo/quebrado — ele roda no boot + watchdog 30min e fica ocioso quando termina. Só reporte se os DADOS estiverem velhos: % de vagas com e-mail <90% OU enriquecimento >30 dias. Use os campos do dossiê, não o flag momentâneo.
10. DECISÕES PENDENTES CONHECIDAS (não re-reportar como bug, apenas lembrar na seção própria): (a) card VIP Manual anuncia 400/dia mas backend entrega 200 — decisão do dono pendente (KB-686); (b) verificação do app no Google Cloud — 5 ações do dono pendentes (é a causa raiz da maioria dos tokens expirados).
11. CLASSES DE BUG PARA CAÇAR ATIVAMENTE (padrões reais já encontrados neste sistema — procure por sintomas semelhantes nos dados): dessincronização de cache entre duas fontes da mesma informação (caso U.profiles vs UPROFILES); comparações falsy com índice 0 (idx||undefined); fluxos que só sabem CRIAR e não RENOVAR (caso re-login do e-mail secundário); dependência de recurso externo sem fallback (caso CDN de ícones). Se os logs/dados sugerirem qualquer um desses padrões, aponte com prioridade.
12. FORMATO: (a) termine SEMPRE com "## 🎯 TOP 3 AÇÕES DA SEMANA" — as 3 ações de maior impacto, ordenadas, cada uma com dono (Andrio/Diego/automático) e esforço (minutos/horas); (b) inclua "## 📊 DELTA vs AUDITORIA ANTERIOR" — nota anterior vs atual e o que mudou; (c) em cada crítico, diga O QUE o admin faz (botão/tela exata), não só "notificar usuário"; (d) você NÃO enxerga o visual do site — quando relevante, recomende o checklist visual manual (fotos carregam? ícones renderizam? nas 3 páginas) em vez de fingir que auditou o front.

══════════════════════════════════════════════
SUA MISSÃO — RELATÓRIO COMPLETO:
══════════════════════════════════════════════

## 🏥 SAÚDE GERAL: [nota]/100
[Justificativa baseada nos dados reais. Seja preciso e honesto.]

## 🚨 PROBLEMAS CRÍTICOS
[Apenas o que precisa de ação HOJE. Com email do usuário afetado.]
[Se não há críticos, escreva: "✅ Nenhum problema crítico identificado"]

## ⚠️ AVISOS
[Situações para atenção nos próximos dias]

## 📊 MÉTRICAS DO SISTEMA
[Quadro completo com os dados reais do dossiê]

## 👥 ANÁLISE DE USUÁRIOS ATIVOS (≤10 dias)
[Examine CADA usuário ativo. Agrupe: saudáveis / problemas / VIP expirando]
[TOP 3 urgentes: nome, email, problema específico, ação recomendada]

## 💰 SAÚDE FINANCEIRA
[Receita, conversão, pedidos parados, discrepâncias de valor, trial abuse]
[Valide: valorTotal dos pedidos bate com a tabela de preços?]

## 🔍 QUALIDADE DOS DADOS
[Bounces, planilhas, CVs faltando, comprovantes sem pedido]

## 💡 SUGESTÕES ARQUITETURAIS
[Novas ideias — verifique se NÃO estão na KB antes de sugerir]
[Foque em: retenção, conversão, UX, automação, anti-abuse]

## ✅ O QUE ESTÁ FUNCIONANDO BEM
[Implementações corretas que o fundador não deve quebrar]

## 📋 RESUMO EXECUTIVO
[3-5 frases diretas para o fundador tomar decisões imediatas]

## 🔄 COMPARAÇÃO COM A VERSÃO ANTERIOR
[O que melhorou, piorou, quebrou, sumiu ou foi criado. Nenhuma funcionalidade perdida pode passar sem ser reportada.]

## 🧩 GARGALOS FUTUROS (ESCALABILIDADE)
[Simule 100 / 1k / 10k / 100k / 1M usuários. Aponte gargalos e soluções preventivas.]

## 🧠 NOVOS APRENDIZADOS PARA MEMÓRIA CUMULATIVA
[Escreva EXATAMENTE 5 aprendizados NOVOS desta análise, no formato:]
[NÃO repita aprendizados já existentes na KB]
APRENDIZADO: [padrão detectado, conciso, acionável, max 200 chars]
APRENDIZADO: [padrão detectado, conciso, acionável, max 200 chars]
APRENDIZADO: [padrão detectado, conciso, acionável, max 200 chars]
APRENDIZADO: [padrão detectado, conciso, acionável, max 200 chars]
APRENDIZADO: [padrão detectado, conciso, acionável, max 200 chars]`;

      const GEMINI_MODELS=["gemini-2.0-flash","gemini-2.5-flash-lite","gemini-2.5-flash"];
      let texto=null; let lastErr="";

      for(const modelName of GEMINI_MODELS){
        try{
          const geminiUrl=`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiKey()}`;
          const payload={
            contents:[{role:"user",parts:[{text:prompt}]}],
            generationConfig:{temperature:0.25,maxOutputTokens:10000,topP:0.9}
          };
          const body=JSON.stringify(payload);
          const url=new URL(geminiUrl);
          const opts={hostname:url.hostname,path:url.pathname+url.search,method:"POST",
            headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};

          const raw=await new Promise((resolve,reject)=>{
            const req2=https.request(opts,resp=>{
              const ch=[];
              resp.on("data",c=>ch.push(c));
              resp.on("end",()=>{try{resolve({status:resp.statusCode,body:JSON.parse(Buffer.concat(ch).toString())});}catch{reject(new Error("Resposta inválida"));}});
            });
            req2.on("error",reject);
            req2.setTimeout(90000,()=>{req2.destroy();reject(new Error("Timeout 90s"));});
            req2.write(body);req2.end();
          });

          if(raw.status===200){
            texto=(raw.body?.candidates?.[0]?.content?.parts?.[0]?.text||"").trim();
            if(texto){console.log(`[auditoria] ✅ modelo=${modelName} chars=${texto.length}`);break;}
          } else {
            lastErr=raw.body?.error?.message||`HTTP ${raw.status}`;
            if(raw.status===403||raw.status===401)break;
          }
        }catch(e){lastErr=e.message;}
      }

      if(!texto) return json(res,502,{error:`Gemini falhou: ${lastErr}`});
      _geminiCount.count++;

      // ══════════════════════════════════════════════════════════════
      // TREINAMENTO INCREMENTAL v9.1 — KB só cresce, nunca encolhe
      // ══════════════════════════════════════════════════════════════
      try{
        const _auditDate=new Date().toISOString().slice(0,10);
        const _auditTime=new Date().toISOString().slice(0,16);
        const _aprendizados=[...texto.matchAll(/APRENDIZADO:\s*(.+)/g)].map(m=>m[1].trim()).filter(Boolean);
        let _novosCount=0;
        let _ignoradosCount=0;

        for(const ap of _aprendizados.slice(0,5)){
          if(ap.length<15||ap.length>500)continue;

          // Verificação de duplicata inteligente:
          // - Texto exatamente igual → ignorar
          // - Primeiros 100 chars muito similares → ignorar
          // - Conteúdo diferente mesmo que tema parecido → SALVAR
          const _jaExisteExato=DB_KB.entries.some(e=>e.solucao===ap);
          const _jaExisteSimilar=DB_KB.entries.some(e=>e.solucao&&e.solucao.slice(0,100)===ap.slice(0,100));

          if(_jaExisteExato||_jaExisteSimilar){
            _ignoradosCount++;
            continue; // Não duplicar, mas não apagar nada
          }

          // Detectar categoria do aprendizado para melhor indexação
          let _categoria='geral';
          if(/token|oauth|gmail|auth/i.test(ap)) _categoria='autenticacao';
          else if(/auto|robô|envio|fila|limit/i.test(ap)) _categoria='automático';
          else if(/plano|vip|trial|pago|financ/i.test(ap)) _categoria='financeiro';
          else if(/usuário|cliente|perfil/i.test(ap)) _categoria='usuários';
          else if(/bounce|email inv|invalido/i.test(ap)) _categoria='bounces';
          else if(/ux|interface|tela|modal/i.test(ap)) _categoria='ux';

          DB_KB.entries.push({
            id:'audit_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
            versao:'auto-v9.1',
            data:_auditDate,
            geradoEm:_auditTime,
            tipo:'auditoria_aprendizado',
            categoria:_categoria,
            problema:`Padrão detectado em auditoria de ${_auditDate}`,
            solucao:ap,
            impacto:'a avaliar',
            modulos:['gemini-audit-v9'],
            geradoPor:'gemini-2.0-flash',
            // Contexto do sistema no momento da auditoria
            contexto:{
              totalUsuarios:usersSnapshot.length,
              planosAtivos:_planosAtivos.length,
              usuariosAutoRodando:usersAutoRodando,
            }
          });
          _novosCount++;
          console.log(`[auditoria] 🧠 [${_categoria}] ${ap.slice(0,90)}`);
        }

        // ── KB nunca perde entradas de auditoria — apenas limita a 50 por tipo ──
        // As mais antigas ficam como histórico mas as 50 mais recentes têm prioridade
        const _auditEntries=DB_KB.entries.filter(e=>e.tipo==='auditoria_aprendizado');
        if(_auditEntries.length>50){
          // Marcar as antigas como "histórico" ao invés de deletar
          const _antigas=_auditEntries.slice(0,_auditEntries.length-50);
          for(const e of _antigas){
            const idx=DB_KB.entries.findIndex(x=>x.id===e.id);
            if(idx>=0) DB_KB.entries[idx]={...e,tipo:'auditoria_historico',arquivadoEm:_auditDate};
          }
        }

        // Salvar — sempre sobrevive
        fs.writeFileSync(KB_FILE,JSON.stringify(DB_KB,null,2));
        console.log(`[auditoria] ✅ KB: +${_novosCount} novos | ${_ignoradosCount} ignorados (similares) | total: ${DB_KB.entries.length} entradas`);
      }catch(kbErr){console.warn('[auditoria] erro KB:',kbErr.message);}


      return json(res,200,{ok:true,relatorio:texto,geradoEm:new Date().toISOString(),totalUsuarios:usersSnapshot.length,usersAutoRodando,usersTravados,pedidosPendentes});
    }catch(e){
      console.error("[auditoria-gemini]",e.message);
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

  // ── SISTEMA DE INDICAÇÃO REMOVIDO DEFINITIVAMENTE (2026-07-03, KB-059) ──
  // Motivo: uso de má fé (abuso do programa de bônus). Removidos: genRefCode,
  // getOrCreateRefCode, GET /api/referral/info, GET /api/admin/referral/list,
  // bônus de cadastro (OAuth callback) e bônus de compra (/api/pedido + set-plan).
  // Rotas antigas respondem 410 Gone para clientes/PWAs com cache antigo:
  if(pathname.startsWith("/api/referral") || pathname.startsWith("/api/admin/referral")){
    return json(res,410,{error:"O programa de indicação foi encerrado."});
  }

  res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"404"}));
});

// ── Cleanup ───────────────────────────────────────────────
setInterval(()=>{const n=Date.now();let c=0;Object.keys(sessions).forEach(k=>{const s=sessions[k],a=n-(s.ts||s.created_at||0);if((s.pending&&a>600_000)||(!s.pending&&a>SESS_TTL)){delete sessions[k];c++;}});if(c)console.log(`[cleanup] ${c} sessão(ões)`);persistSessionsDebounced(1000); // V955: snapshot periódico (captura refresh de tokens)Object.keys(rateMap).forEach(k=>{if(rateMap[k].r<Date.now())delete rateMap[k];});// Limpa locks de send órfãos (>30s)
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

// FIX-CRASH: Monitor de memória — loga a cada 10min e alerta se estiver alto
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB  = Math.round(mem.rss / 1024 / 1024);
  if (heapMB > 400) {
    console.warn(`[mem] ⚠️ Heap alto: ${heapMB}MB RSS: ${rssMB}MB — users:${Object.keys(DB_USERS).length} logs:${Object.values(DB_LOGS).reduce((n,a)=>n+a.length,0)} hist:${Object.values(DB_HIST).reduce((n,a)=>n+a.length,0)}`);
    // Limpa cache de inbox expirado
    if (global._inboxCache) {
      const now = Date.now();
      for (const k of Object.keys(global._inboxCache)) {
        if (now - global._inboxCache[k].ts > 2 * 60_000) delete global._inboxCache[k];
      }
    }
  } else {
    console.log(`[mem] Heap: ${heapMB}MB RSS: ${rssMB}MB`);
  }
}, 10 * 60 * 1000);

// ══════════════════════════════════════════════════════════
//  NOTIFICAÇÕES AUTOMÁTICAS POR EMAIL — H2BApply
//  Avisa o usuário quando fila trava ou finaliza
//  Usa Gmail do admin (andrio.kick18@gmail.com)
//  25+ variações de mensagem para nunca repetir
// ══════════════════════════════════════════════════════════

// V951: carrega cooldowns persistidos (se existirem) ANTES de criar os
// objetos em memória — assim eles nascem já com o histórico de quando a
// última notificação de cada tipo foi enviada, mesmo após um deploy.
let _DB_NOTIF_COOLDOWN = { notifSentAt:{}, authErrNotifiedAt:{}, pedAlertSent:{}, refillNotifiedAt:{} };
try{
  if(fs.existsSync(NOTIF_COOLDOWN_FILE)){
    const _loaded = JSON.parse(fs.readFileSync(NOTIF_COOLDOWN_FILE,"utf8"));
    _DB_NOTIF_COOLDOWN = { ..._DB_NOTIF_COOLDOWN, ..._loaded };
  }
}catch(e){ console.warn("[notif-cooldown] falha ao carregar cooldowns persistidos:", e.message); }
function _persistNotifCooldowns(){
  try{
    _DB_NOTIF_COOLDOWN.notifSentAt = _notifSentAt;
    _DB_NOTIF_COOLDOWN.authErrNotifiedAt = (typeof getAuthErrNotifiedAt==="function") ? getAuthErrNotifiedAt() : (_DB_NOTIF_COOLDOWN.authErrNotifiedAt||{});
    _DB_NOTIF_COOLDOWN.pedAlertSent = (typeof getPedAlertSent==="function") ? getPedAlertSent() : (_DB_NOTIF_COOLDOWN.pedAlertSent||{});
    _DB_NOTIF_COOLDOWN.refillNotifiedAt = global._refillNotifiedAt||{};
    fs.writeFileSync(NOTIF_COOLDOWN_FILE, JSON.stringify(_DB_NOTIF_COOLDOWN));
  }catch(e){ console.warn("[notif-cooldown] falha ao salvar cooldowns:", e.message); }
}
setInterval(_persistNotifCooldowns, 5*60*1000); // salva a cada 5min (não só no shutdown — Render pode matar sem SIGTERM)
global._refillNotifiedAt = _DB_NOTIF_COOLDOWN.refillNotifiedAt; // usado por mod-sentinel.js (re-engajamento)

const _notifSentAt = _DB_NOTIF_COOLDOWN.notifSentAt; // email → {stalled: ts, finished: ts} — evita spam
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

// Mensagens para token revogado — usuário precisa fazer login novamente
const MSGS_AUTH_ERROR = [
  { sub:"🚨 {nome}, seu robô parou — reconecte o Gmail agora!", body:`{nome}!

Seu robô do H2BApply tentou enviar suas candidaturas mas encontrou um erro de autenticação no Gmail e pausou automaticamente.

📋 Você tem uma fila de candidaturas esperando para ser enviada!

✅ Para reativar em 1 minuto:
1. Acesse h2bapply.com
2. Faça login com o Google novamente
3. O robô retoma de onde parou automaticamente!

Não perca tempo — as vagas H-2B têm prazo! 🇺🇸💪

Equipe H2BApply 🤖` },

  { sub:"⚠️ {nome}, ação necessária — erro de autenticação no Gmail", body:`Oi {nome}!

O sistema detectou um erro de autenticação no seu Gmail e pausou o envio automático para proteger sua conta.

Sua fila de candidaturas está salva e aguardando! 📋

🔄 Solução rápida:
→ Acesse h2bapply.com
→ Clique em "Entrar com Google"
→ Pronto! O robô volta a trabalhar!

Qualquer dúvida, responda este email.

Equipe H2BApply` },

  { sub:"🔑 {nome}! Autenticação do Gmail falhou — reative o robô", body:`{nome}!!

Detectamos que o acesso ao seu Gmail foi interrompido por um erro de autenticação. Isso pode acontecer quando as configurações de segurança do Google mudam.

A solução é simples e rápida:
🔐 Entre em h2bapply.com → faça login com Google → robô volta a correr!

Suas candidaturas anteriores estão salvas e a fila continua te esperando! 💪

Bora lá! 🇺🇸🚀

Equipe H2BApply 🤖` },
];

const MSGS_TOKEN_REVOKED = [
  { sub:"🔐 {nome}, seu automático pausou — precisa de 1 minutinho!", body:`{nome}!

Seu robô do H2BApply estava trabalhando forte, mas o acesso ao seu Gmail foi interrompido — provavelmente porque sua senha do Google mudou ou o acesso foi revogado.

✅ Para reativar em 1 minuto:
1. Acesse h2bapply.com
2. Faça login com o Google novamente
3. O automático volta a funcionar do ponto onde parou!

Suas candidaturas que já foram enviadas estão todas salvas — você não perdeu nada! 🎯

Bora reativar e continuar enviando! 🇺🇸💪

Equipe H2BApply 🤖` },

  { sub:"⚠️ {nome}, ação necessária — automático pausado por segurança", body:`Oi {nome}!

Detectamos que o acesso ao seu Gmail foi interrompido. Isso é normal quando a senha do Google é alterada ou quando o acesso é revogado nas configurações da conta.

Seu automático está pausado mas a fila está salva! 📋

🔄 Para continuar em segundos:
→ Acesse h2bapply.com
→ Clique em "Entrar com Google"
→ Pronto! O robô retoma de onde parou!

Não deixa a fila esfriar — tem empresa americana esperando! 🇺🇸

Equipe H2BApply` },

  { sub:"🔑 {nome}! Seu robô precisa de você — acesso Google expirou", body:`{nome}!!

Seu robô estava na missão, mas encontrou um obstáculo: o acesso ao Gmail foi interrompido e ele pausou para te avisar.

A solução é rápida:
🔐 Entre em h2bapply.com → faça login com Google → robô volta a correr!

Suas candidaturas anteriores estão todas salvas e a fila continua te esperando! 💪

Vamos lá que a América não espera! 🇺🇸🚀

Equipe H2BApply 🤖` },
];

async function sendNotifEmail(userEmail, tipo) {
  // 🔕 KILL SWITCH (pedido do dono, 06/07/2026): desativa TODAS as notificações
  // automáticas por e-mail enviadas pela conta admin (andrio.kick18@gmail.com)
  // até um novo sistema de notificações ser configurado. Reversível em
  // DB_ADMIN_SETTINGS.emailNotificationsEnabled (toggle em Configurações ou
  // POST /api/admin/notif/toggle-email).
  if (DB_ADMIN_SETTINGS.emailNotificationsEnabled !== true) return;
  // Trava: não envia o mesmo tipo 2x em 24h
  const lockKey = `${userEmail}_${tipo}`;
  if (_notifLock.has(lockKey)) return;
  const last = _notifSentAt[lockKey] || 0;
  if (Date.now() - last < 22 * 3600_000) return; // 22h de cooldown

  try {
    const p = getUser(userEmail);
    const nome = (p?.name || userEmail.split("@")[0] || "amigo").split(" ")[0];
    const msgs = (tipo === "stalled"       ? MSGS_STALLED
               : tipo === "token_revoked" ? MSGS_TOKEN_REVOKED
               : tipo === "auth_error"    ? MSGS_AUTH_ERROR
               : tipo === "vip_expiring"  ? MSGS_VIP_EXPIRING
               : tipo === "vip_desync"    ? MSGS_VIP_DESYNC
               : tipo === "no_profile"    ? MSGS_NO_PROFILE
               : tipo === "refill"        ? MSGS_REFILL
               : MSGS_FINISHED);
    // Escolhe variação aleatória
    const idx = Math.floor(Math.random() * msgs.length);
    const msg = msgs[idx];
    const subject = msg.sub.replace(/{nome}/g, nome);
    const body = msg.body.replace(/{nome}/g, nome);

    // Pega sessão do admin — com fallback automático via refresh_token
    let adminToken = null;
    const adminSessEntry = Object.entries(sessions).find(([,s]) => s.user_email === ADMIN_EMAIL && s.access_token);
    if (adminSessEntry) {
      adminToken = adminSessEntry[1].access_token;
    } else {
      // Sem sessão ativa — tenta renovar via refresh_token do banco
      const adminUser = getUser(ADMIN_EMAIL);
      if (adminUser?.refresh_token) {
        try {
          adminToken = await refreshTokenForUser(ADMIN_EMAIL);
        } catch(re) {
          console.warn(`[notif] Não foi possível renovar token do admin: ${re.message}`);
          return;
        }
      } else {
        console.warn(`[notif] Admin sem sessão e sem refresh_token — notificação para ${userEmail} não enviada`);
        return;
      }
    }

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
        "Authorization": "Bearer " + adminToken,
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
  // 🔕 Mesmo kill switch de sendNotifEmail — pedido do dono (06/07/2026).
  if (DB_ADMIN_SETTINGS.emailNotificationsEnabled !== true) { console.log("[reengagement] 🔕 Notificações por e-mail desativadas — pulando rodada."); return; }
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

  // 2. Checa OAuth/token — só age se usuário ativo nos últimos 10 dias
  const hasToken = !!(user?.refresh_token || user?.cached_access_token);
  if (!hasToken && h.oauthOk !== false) {
    const lastSeen = user?.lastSeenAt || new Date(user?.created_at||0).getTime();
    const inactiveDays = (Date.now() - lastSeen) / 86400000;
    if (inactiveDays > 10) {
      // Usuário inativo >10 dias: pausa silenciosa sem log ruidoso, sem notif
      h.oauthOk = false;
      setAutoJob(email, { ...job, active:false, status:"paused_oauth_expired" });
      autoTimers.delete(email);
      console.log(`[watchdog] ${email} token inválido mas inativo ${Math.round(inactiveDays)}d — pausa silenciosa`);
      return;
    }
    // Usuário ativo: alerta real
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
  const WAITING_STATUSES = new Set(["waiting_limit","waiting_rate_limit","waiting_interval"]);
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

  // 5. Checa timer fantasma: nextSendAt já passou há mais de 10min mas timer ainda existe
  // Isso ocorre quando o Node.js event loop ficou travado — o setTimeout existe mas não disparou
  const nextOverdue = job.nextSendAt && job.nextSendAt < now - 10*60*1000;
  const hasTimer = autoTimers.has(email);
  const notWaitingNormal = !["waiting_limit","waiting_rate_limit"].includes(job.status);
  if (nextOverdue && hasTimer && notWaitingNormal && !isStalled) {
    clearTimeout(autoTimers.get(email));
    autoTimers.delete(email);
    h.restarts++;
    pushGlobalEvent("ghost_timer", email, `Timer fantasma detectado (nextSendAt passou há ${Math.round((now-job.nextSendAt)/60000)}min) — reiniciando (restart #${h.restarts})`, "warn");
    addLog(email, { status:"sistema", jobTitle:`🔄 Timer atrasado — reagendando worker`, company:"Watchdog" });
    scheduleAuto(email);
  }

  // 6. Checa parada absoluta: ativo há mais de 4h sem nenhum envio
  // Cobre casos onde nextSendAt está no futuro mas o timer nunca vai disparar
  // EXCEÇÃO: waiting_limit e waiting_rate_limit são esperas longas normais
  const ABSOLUTE_STALL_MS = 4 * 60 * 60 * 1000; // 4 horas
  const lastAct = job.lastSentAt || job.startedAt || 0;
  const absoluteStalled = lastAct > 0 && (now - lastAct) > ABSOLUTE_STALL_MS;
  const isLongWait = ["waiting_limit","waiting_rate_limit"].includes(job.status);
  if (absoluteStalled && !isLongWait) {
    // Força reinício total: cancela timer existente e reagenda
    if (autoTimers.has(email)) {
      clearTimeout(autoTimers.get(email));
      autoTimers.delete(email);
    }
    h.restarts++;
    const hrsStalled = Math.round((now - lastAct) / 3600000);
    pushGlobalEvent("absolute_stall", email, `Sem envios há ${hrsStalled}h (status: ${job.status}) — forçando reinício (restart #${h.restarts})`, "error");
    addLog(email, { status:"sistema", jobTitle:`🔄 Sem atividade há ${hrsStalled}h — reiniciando worker`, company:"Watchdog forçou reinício" });
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

// Detecta status "sending" preso por >30min (lock liberado mas status não atualizado)
setInterval(()=>{
  const now=Date.now();
  for(const[email,job] of Object.entries(DB_AUTO)){
    if(!job.active||job.status!=="sending") continue;
    const lastAct=job.lastSentAt||job.startedAt||0;
    if(lastAct>0&&(now-lastAct)>30*60*1000&&!autoSendLock.has(email)){
      console.warn(`[stuck-guard] ${email}: sending preso ${Math.round((now-lastAct)/60000)}min — reiniciando`);
      addLog(email,{status:"sistema",jobTitle:"🔄 Status 'sending' travado — reiniciando",company:"Stuck guardian"});
      if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
      scheduleAuto(email);
    }
  }
},5*60*1000);

// ══════════════════════════════════════════════════════════
//  DAILY RESET GUARDIAN — Garante que jobs em waiting_limit
//  sejam retomados no próximo dia, mesmo após crashes/deploys
//  Roda a cada 5 minutos e verifica se nextSendAt já passou
// ══════════════════════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  let resumed = 0;
  for (const [email, job] of Object.entries(DB_AUTO)) {
    if (!job.active || !job.queue?.length) continue;
    if (job.status !== "waiting_limit") continue;
    // Se nextSendAt já passou e não há timer ativo, retoma imediatamente
    const nextPassed = !job.nextSendAt || job.nextSendAt <= now;
    const noTimer = !autoTimers.has(email);
    if (nextPassed && noTimer) {
      const h = getHealth(email);
      h.restarts++;
      console.log(`[daily-reset] ${email} — limite expirou, retomando envios (restart #${h.restarts})`);
      addLog(email, { status:"sistema", jobTitle:"🔄 Novo dia — retomando envios automáticos", company:`Fila: ${job.queue.length} vagas restantes` });
      scheduleAuto(email);
      resumed++;
    }
  }
  if (resumed > 0) console.log(`[daily-reset] ${resumed} job(s) retomados após reset diário`);
}, 5 * 60 * 1000); // checa a cada 5min

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


// ══════════════════════════════════════════════════════════
//  🐕 WATCHDOGS — extraídos para src/watchdogs.js (Fase 1 · Módulo 4)
//  tokenGuardian (renova tokens 10/10min) · vipExpiryWatchdog (no-op
//  intencional, KB-860) · authErrorWatchdog (notifica parados >12h, 3/3h)
// ══════════════════════════════════════════════════════════
const { initWatchdogs } = require("./mod-watchdogs.js");
const { tokenGuardianRun, vipExpiryWatchdog, authErrorWatchdog, getAuthErrNotifiedAt } = initWatchdogs({
  DB_AUTO: ()=>DB_AUTO, autoTimers: ()=>autoTimers,
  getUser, getAutoJob, setAutoJob, addLog, sendNotifEmail, refreshTokenForUser,
  authErrNotifiedAtInit: _DB_NOTIF_COOLDOWN.authErrNotifiedAt, // V951: sobrevive a deploy
  botLog, // 📜 log unificado — pedido do dono (07/07/2026)
});

// ══════════════════════════════════════════════════════════
//  FUNÇÕES UTILITÁRIAS GLOBAIS (stats, ranking)
//  Movidas para escopo global para reutilização entre rotas
// ══════════════════════════════════════════════════════════

// Calcula streak de dias consecutivos com envios
function calcStreak(h){ return _calcStreakMod(h); } // corpo em src/engine/core.js

// Retorna contagem de envios dos últimos 7 dias
function last7Days(h){ return _last7DaysMod(h); } // corpo em src/engine/core.js

// Verifica se uma entrada pertence ao período de ranking
// Fallback: se sentAt ausente/inválido, usa dateStr para reconstruir timestamp
function inRankPeriod(e, period) {
  if (period === "all") return true;
  if (period === "day") return e.dateStr === todayStr();

  // Tenta obter timestamp confiável: sentAt → dateStr → exclui
  let ts = 0;
  if (e.sentAt) {
    const parsed = new Date(e.sentAt).getTime();
    if (!isNaN(parsed)) ts = parsed;
  }
  // Fallback: reconstrói timestamp a partir do dateStr "DD/MM/YYYY"
  if (ts === 0 && e.dateStr) {
    const parts = e.dateStr.split("/");
    if (parts.length === 3) {
      const reconstructed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00Z`).getTime();
      if (!isNaN(reconstructed)) ts = reconstructed;
    }
  }
  if (ts === 0) return false; // sem data confiável — exclui do ranking de período

  if (period === "week")  return ts >= Date.now() - 7  * 86400_000;
  if (period === "month") return ts >= Date.now() - 30 * 86400_000;
  return false;
}

// ══ MULTI-SERVIDOR: helpers ═══════════════════════════════════════════════
// Config dos servidores (default embutido + override em admin_settings.servers)
function _getServersConfig(){
  const def=[
    {id:1,nome:"Servidor 1",url:"https://h2bapply.com",maxExibido:50,status:"lotado"},
    {id:2,nome:"Servidor 2",url:"https://h2b-teste.onrender.com",maxExibido:100,status:"aberto"}
  ];
  const raw=Array.isArray(DB_ADMIN_SETTINGS.servers)&&DB_ADMIN_SETTINGS.servers.length?DB_ADMIN_SETTINGS.servers:def;
  return raw.map(sv=>({
    id:parseInt(sv.id)||0,
    nome:String(sv.nome||("Servidor "+sv.id)).slice(0,40),
    url:String(sv.url||"").replace(/\/+$/,""),
    maxExibido:Math.max(1,parseInt(sv.maxExibido)||100),
    status:(String(sv.status||"aberto").toLowerCase()==="lotado")?"lotado":"aberto"
  })).filter(sv=>sv.id>0);
}
// ── V951: IDENTIDADE ÚNICA POR HOST, usada em TODA rota que precisa saber
// "quem sou eu" (não só no callback OAuth como antes). A env SERVER_ID é só
// o fallback de última instância — a fonte de verdade é o host da requisição
// batido contra a URL de cada servidor na config. Isso corrige de raiz o
// looping do Servidor 2: antes, só o callback OAuth se autocorrigia pelo host;
// /api/auth/where, /api/servers, /api/servers/self, /api/status etc. ainda
// confiavam cegamente na env SERVER_ID — se ela estivesse ausente/errada no
// Render, essas rotas relatavam a identidade ERRADA (ex.: o próprio servidor
// aberto aparecia como "não-self"), fazendo o front redirecionar a pessoa
// pra URL onde ela JÁ está → recarrega a landing → parece que "voltou a
// pedir e-mail" → loop infinito. Resultado é cacheado por 60s (host não muda
// em runtime) só para não recalcular em toda requisição.
let _selfIdCache=null,_selfIdCacheAt=0,_selfIdWarned=false;
function _resolveServerId(req){
  const now=Date.now();
  if(_selfIdCache && (now-_selfIdCacheAt)<60_000) return _selfIdCache;
  const _norm=x=>String(x||"").replace(/^https?:\/\//,"").replace(/\/.*$/,"").toLowerCase();
  const _reqHost=_norm(req&&req.headers&&req.headers.host);
  const _cfgList=_getServersConfig();
  const _hostMatch=_reqHost?_cfgList.find(sv=>_norm(sv.url)===_reqHost):null;
  let id=SERVER_ID;
  if(_hostMatch){
    if(_hostMatch.id!==SERVER_ID && !_selfIdWarned){
      _selfIdWarned=true;
      console.error(`[servers] 🚨 CONFIG CONTRADITÓRIA: este deploy responde por "${_reqHost}" (Servidor ${_hostMatch.id} na config), mas a env SERVER_ID=${SERVER_ID||"(ausente)"} aponta para outro id. Usando a identidade pelo HOST (mais confiável) em TODAS as rotas — corrija a env SERVER_ID no Render para ${_hostMatch.id} assim que possível.`);
    }
    id=_hostMatch.id;
  }
  _selfIdCache=id;_selfIdCacheAt=now;
  return id;
}
function _countLocalUsers(){
  // Conta usuários visíveis (exclui contas soft-deletadas)
  let n=0; for(const u of Object.values(DB_USERS)){ if(!u||u.accountDeleted) continue; n++; } return n;
}
// ── CONTA ÚNICA ENTRE SERVIDORES ──────────────────────────────────────────
// Cada pessoa tem conta em UM servidor só. A checagem cruzada usa SHA-256 do
// e-mail (o e-mail nunca viaja em texto entre servidores). Cache do set de
// hashes locais reconstruído a cada 5 min ou quando a base muda de tamanho.
let _acctHashCache={at:0,size:-1,set:new Set()};
function _emailHashExists(h){
  const emails=Object.keys(DB_USERS); // inclui contas soft-deletadas (relogin restaura — a conta EXISTE)
  if(Date.now()-_acctHashCache.at>300_000||_acctHashCache.size!==emails.length){
    const s=new Set();
    for(const e of emails)s.add(crypto.createHash("sha256").update(String(e).toLowerCase().trim()).digest("hex"));
    _acctHashCache={at:Date.now(),size:emails.length,set:s};
  }
  return _acctHashCache.set.has(h);
}
// Pergunta aos servidores irmãos se o e-mail já tem conta lá.
// Timeout de 6s por peer e FAIL-OPEN: peer fora do ar nunca trava um cadastro
// legítimo (disponibilidade > rigidez; o evento fica logado para auditoria).
async function checkAccountOnPeers(email,selfId){
  const _self=selfId||SERVER_ID;
  const h=crypto.createHash("sha256").update(String(email||"").toLowerCase().trim()).digest("hex");
  for(const sv of _getServersConfig()){
    if(sv.id===_self||!sv.url)continue;
    try{
      const hurl=new URL(sv.url);
      if(hurl.protocol!=="https:")continue;
      const call=httpsReq({hostname:hurl.hostname,port:hurl.port||443,path:"/api/servers/has-account?h="+h,method:"GET",headers:{"Accept":"application/json","User-Agent":"H2BApply-Server/"+_self}});
      const r=await Promise.race([call,new Promise(res2=>setTimeout(()=>res2(null),6000))]);
      if(r&&r.status===200&&r.body&&r.body.exists===true)return sv;
    }catch(e){console.warn("[servers] has-account em",sv.url,"falhou (fail-open):",e.message);}
  }
  return null;
}

// Cache de chamadas a peers (10 min) — nunca derruba a resposta se o peer cair
const _peerCache={};
async function _fetchPeerJson(baseUrl,apiPath){
  const key=baseUrl+apiPath;
  const c=_peerCache[key];
  if(c&&Date.now()-c.at<600_000) return c.data;
  try{
    const h=new URL(baseUrl);
    if(h.protocol!=="https:") throw new Error("peer não-https");
    const {status,body}=await httpsReq({hostname:h.hostname,port:h.port||443,path:apiPath,method:"GET",headers:{"Accept":"application/json","User-Agent":"H2BApply-Server/"+SERVER_ID}});
    if(status===200&&body&&typeof body==="object"){ _peerCache[key]={at:Date.now(),data:body}; return body; }
  }catch(e){ console.warn("[servers] peer",baseUrl,apiPath,"falhou:",e.message); }
  _peerCache[key]={at:Date.now(),data:null}; // cacheia a falha p/ não martelar o peer
  return null;
}
// Export do top 50 local (envios totais) para o ranking global — só dados já públicos
function _calcGlobalExport(){
  const {list}=calcRanking("all","sends",null);
  return list.slice(0,50).map(r=>({name:r.name,picture:r.picture||"",appAvatarId:r.appAvatarId||"",plan:r.plan,score:r.totalSends||r.score||0,uid:r.uid}));
}

// ══ RANKING VIP: compras por pagante (fonte canônica única) ═══════════════
// Mesma prioridade da receitaReal (KB: uma fonte por pagante, sem dupla contagem):
// livro-caixa (DB_FINANCEIRO) → pedidos pagos/ativos (DB_PEDIDOS) → paymentAmount.
// Retorna { email: nºCompras }. Trial/código nunca contam (não geram pagamento).
function calcVipCompras(){
  const finBy={},pedBy={};
  for(const pg of ((DB_FINANCEIRO&&DB_FINANCEIRO.pagamentos)||[])){ if(!pg||!pg.email) continue; const e=String(pg.email).toLowerCase(); finBy[e]=(finBy[e]||0)+1; }
  for(const ped of Object.values(DB_PEDIDOS||{})){ if(!ped||!ped.userEmail) continue; const st=String(ped.status||"").toLowerCase(); if(st!=="pago"&&st!=="ativo") continue; const e=String(ped.userEmail).toLowerCase(); pedBy[e]=(pedBy[e]||0)+1; }
  const map={};
  for(const [email,u] of Object.entries(DB_USERS)){
    const e=email.toLowerCase();
    map[email]=finBy[e]||pedBy[e]||((parseFloat(u&&u.paymentAmount)||0)>0?1:0);
  }
  return map;
}

// Calcula ranking de usuários por período e categoria
// Score = auto + manual (respostas NÃO contam — são recebidas, não enviadas)
// Categorias: sends (envios) | vip (compras VIP, ignora período) | active (dias com envio)
// ═══ V954 (Parte 4): GAMIFICAÇÃO — XP, níveis e conquistas ═══════════════
// Tudo DERIVADO do histórico existente (zero migração, sempre recomputável):
// manual=10 XP (esforço ativo), auto=4 XP, resposta recebida=25 XP (resultado).
const XP_NIVEIS=[
  {n:1,xp:0,nome:"Iniciante",emoji:"🌱"},
  {n:2,xp:100,nome:"Explorador",emoji:"🧭"},
  {n:3,xp:300,nome:"Candidato",emoji:"📨"},
  {n:4,xp:800,nome:"Persistente",emoji:"💪"},
  {n:5,xp:1500,nome:"Profissional",emoji:"🎯"},
  {n:6,xp:3000,nome:"Veterano",emoji:"🛡️"},
  {n:7,xp:6000,nome:"Especialista",emoji:"⚡"},
  {n:8,xp:12000,nome:"Mestre",emoji:"🏆"},
  {n:9,xp:25000,nome:"Elite",emoji:"💎"},
  {n:10,xp:50000,nome:"Lenda",emoji:"👑"}
];
function xpFromCounts(man,auto,rep){return (man|0)*10+(auto|0)*4+(rep|0)*25;}
function levelForXP(xp){
  let lv=XP_NIVEIS[0];
  for(const l of XP_NIVEIS){if(xp>=l.xp)lv=l;else break;}
  const next=XP_NIVEIS.find(l=>l.n===lv.n+1)||null;
  const pct=next?Math.min(100,Math.round((xp-lv.xp)/(next.xp-lv.xp)*100)):100;
  return {n:lv.n,nome:lv.nome,emoji:lv.emoji,xp,xpNivel:lv.xp,xpProximo:next?next.xp:null,proximoNome:next?next.nome:null,pct};
}
function calcConquistas(hist,streak){
  const sends=hist.filter(e=>e.type!=="reply");
  const man=hist.filter(e=>e.type==="manual").length;
  const auto=hist.filter(e=>e.type==="auto").length;
  const rep=hist.filter(e=>e.type==="reply").length;
  const tot=man+auto;
  const estados=new Set(sends.filter(e=>e.state).map(e=>String(e.state).toUpperCase())).size;
  let madruga=false;
  // BUG CORRIGIDO: e.date é string pt-BR "DD/MM/YYYY HH:MM:SS" — new Date() interpretava
  // como MM/DD (inválido em dias >12) e usava fuso do servidor (UTC), não BRT.
  // Agora: usa e.sentAt (ISO confiável) convertido para BRT (UTC-3), padrão do projeto.
  for(const e of sends){
    const ts=e.sentAt?new Date(e.sentAt).getTime():NaN;
    if(!isNaN(ts)){const h=new Date(ts-3*60*60*1000).getUTCHours();if(h>=4&&h<7){madruga=true;break;}}
  }
  const C=[
    {id:"primeiro",  emoji:"🚀",nome:"Primeiro Passo",       desc:"Envie sua 1ª candidatura",          ok:tot>=1},
    {id:"cinquenta", emoji:"📬",nome:"Engrenado",            desc:"50 candidaturas enviadas",          ok:tot>=50},
    {id:"cem",       emoji:"💯",nome:"Centurião",            desc:"100 candidaturas enviadas",         ok:tot>=100},
    {id:"quinhentos",emoji:"🔥",nome:"Imparável",            desc:"500 candidaturas enviadas",         ok:tot>=500},
    {id:"mil",       emoji:"🚀",nome:"Elite dos Mil",        desc:"1.000 candidaturas enviadas",       ok:tot>=1000},
    {id:"cincomil",  emoji:"👑",nome:"Lendário",             desc:"5.000 candidaturas enviadas",       ok:tot>=5000},
    {id:"resp1",     emoji:"💌",nome:"Primeira Resposta",    desc:"Receba 1 resposta de empregador",   ok:rep>=1},
    {id:"resp10",    emoji:"🌟",nome:"Popular",              desc:"10 respostas recebidas",            ok:rep>=10},
    {id:"streak7",   emoji:"🔥",nome:"Semana de Fogo",       desc:"7 dias seguidos enviando",          ok:streak>=7},
    {id:"streak30",  emoji:"🌋",nome:"Mês Implacável",       desc:"30 dias seguidos enviando",         ok:streak>=30},
    {id:"estados5",  emoji:"🗺️",nome:"Explorador de Estados",desc:"Envie para 5 estados diferentes",   ok:estados>=5},
    {id:"estados15", emoji:"🇺🇸",nome:"Coast to Coast",       desc:"Envie para 15 estados diferentes",  ok:estados>=15},
    {id:"autopilot", emoji:"🤖",nome:"Piloto Automático",    desc:"100 envios pelo automático",        ok:auto>=100},
    {id:"sniper",    emoji:"🎯",nome:"Atirador Manual",      desc:"100 envios manuais",                ok:man>=100},
    {id:"madrugador",emoji:"🌅",nome:"Madrugador",           desc:"Envie entre 4h e 7h da manhã",      ok:madruga}
  ];
  return C.map(c=>({id:c.id,emoji:c.emoji,nome:c.nome,desc:c.desc,unlocked:!!c.ok}));
}

// PERF (V954-fix): cache de 30s das linhas do ranking. Endpoint é público e a
// computação é O(usuários × histórico) — sem cache, cada F5 refaz a varredura completa.
// isMe/myPos continuam por-requisição (nada específico do usuário entra no cache).
const _rankRowsCache = Object.create(null);
const RANK_ROWS_TTL = 30_000;

function calcRanking(period, category, myEmail) {
  const _ck = period + "_" + category;
  const _hit = _rankRowsCache[_ck];
  if (_hit && (Date.now() - _hit.at) < RANK_ROWS_TTL) {
    return _buildRankResponse(_hit.rows, _ck, myEmail);
  }
  const rows = [];
  const vipCompras = category === "vip" ? calcVipCompras() : null;
  for (const [email, user] of Object.entries(DB_USERS)) {
    if (DB_RANK_HIDDEN[email]) continue;
    if (user.accountDeleted) continue; // conta deletada pelo próprio usuário: invisível em qualquer lista pública
    if (user.isAdmin || isAdminEmail(email)) continue; // excluir todos os admins do ranking público
    const hist = getHist(email);
    const ph = hist.filter(e => inRankPeriod(e, period));

    // Enviados = auto + manual (nunca replies)
    const autoSends   = ph.filter(e => e.type === "auto").length;
    const manualSends = ph.filter(e => e.type === "manual").length;
    const sends       = autoSends + manualSends; // total enviados no período
    const replies     = ph.filter(e => e.type === "reply").length;

    const totAutoSends   = hist.filter(e => e.type === "auto").length;
    const totManualSends = hist.filter(e => e.type === "manual").length;
    const totS = totAutoSends + totManualSends;
    const totR = hist.filter(e => e.type === "reply").length;
    const respRate = totS > 0 ? Math.round((totR / totS) * 100) : 0;

    // Categoria "active" = engajamento real: dias distintos COM envio no período
    const activeDays = category === "active" ? new Set(ph.filter(e => e.type !== "reply" && e.dateStr).map(e => e.dateStr)).size : 0;
    const compras    = vipCompras ? (vipCompras[email] || 0) : 0;

    const score = category === "vip"    ? compras     // compras VIP (todo o histórico — período não se aplica)
                : category === "active" ? activeDays  // dias ativos no período (desempate por envios no sort)
                : sends;                              // default: total enviados (auto+manual)

    if (category === "vip") { if (score === 0) continue; }
    else {
      if (score === 0 && period !== "all") continue;
      if (totS + totR === 0 && period === "all") continue;
    }
    // Privacidade: usuário pode desligar a foto do Google no perfil público
    const _showPic = (user.publicProfile?.mostrarFotoGoogle) !== false;
    rows.push({
      email,
      name: user.rankName || user.name || "Usuário",
      picture: _showPic ? (user.picture || "") : "",
      appAvatarId: user.appAvatarId || "",
      plan: getPlan(user),
      sends,       // auto + manual no período
      autoSends,   // só auto no período
      manualSends, // só manual no período
      responses: replies,
      totalSends: totS, totalAutoSends: totAutoSends, totalManualSends: totManualSends,
      totalResponses: totR, responseRate: respRate, score, compras,
      isOnline: isOnlineUser(email), adminBadge: DB_RANK_BADGES[email] || null,
      createdAt: user.created_at || "2024-01-01",
      // V954: nível derivado do total histórico (barato: contadores já calculados)
      xp: xpFromCounts(totManualSends, totAutoSends, totR),
      nivel: null // preenchido abaixo (levelForXP 1x por linha do top-50 apenas)
    });
  }
  // Desempate: mesmo score → mais envios no período → conta mais antiga
  rows.sort((a, b) => b.score !== a.score ? b.score - a.score
                    : b.sends !== a.sends ? b.sends - a.sends
                    : new Date(a.createdAt) - new Date(b.createdAt));
  _rankRowsCache[`${period}_${category}`] = { rows, at: Date.now() };
  return _buildRankResponse(rows, `${period}_${category}`, myEmail);
}

// Monta a resposta pública a partir das linhas (cacheadas ou recém-computadas).
function _buildRankResponse(rows, cacheKey, myEmail) {
  const prev = rankPosCache[cacheKey] || {};
  const newPos = {};
  rows.forEach((r, i) => newPos[r.email] = i + 1);
  rankPosCache[cacheKey] = newPos;
  const list = rows.slice(0, 50).map((r, i) => {
    const pos = i + 1, pp = prev[r.email];
    const change = pp !== undefined ? pp - pos : null;
    return {
      pos, name: r.name, picture: r.picture, appAvatarId: r.appAvatarId||"", plan: r.plan,
      sends: r.sends, autoSends: r.autoSends, manualSends: r.manualSends,
      responses: r.responses, totalSends: r.totalSends,
      totalAutoSends: r.totalAutoSends, totalManualSends: r.totalManualSends,
      responseRate: r.responseRate, score: r.score, compras: r.compras || 0, isOnline: r.isOnline,
      change, adminBadge: r.adminBadge,
      uid: crypto.createHash("sha256").update(r.email).digest("hex").slice(0, 16),
      isMe: myEmail ? r.email === myEmail : false,
      xp: r.xp||0, nivel: (()=>{const l=levelForXP(r.xp||0);return {n:l.n,nome:l.nome,emoji:l.emoji};})()
    };
  });
  let myPos = null;
  if (myEmail) {
    const mi = rows.findIndex(r => r.email === myEmail);
    if (mi >= 0) {
      const me = rows[mi];
      myPos = { pos: mi + 1, sends: me.sends, autoSends: me.autoSends, manualSends: me.manualSends, responses: me.responses, score: me.score, total: rows.length };
    }
  }
  return { list, myPos, total: rows.length };
}

// Ranking exclusivo de admins (só visível para admins na aba Admin)
function calcAdminRanking(period) {
  const rows = [];
  for (const [email, user] of Object.entries(DB_USERS)) {
    if (!user.isAdmin && !isAdminEmail(email)) continue; // só admins
    const hist = getHist(email);
    const ph = hist.filter(e => inRankPeriod(e, period));
    const autoSends   = ph.filter(e => e.type === "auto").length;
    const manualSends = ph.filter(e => e.type === "manual").length;
    const sends = autoSends + manualSends;
    const replies = ph.filter(e => e.type === "reply").length;
    const totS = hist.filter(e => e.type !== "reply").length;
    const totR = hist.filter(e => e.type === "reply").length;
    const respRate = totS > 0 ? Math.round((totR / totS) * 100) : 0;
    rows.push({
      email, name: user.name || "Admin", picture: user.picture || "",
      plan: "admin",
      sends, autoSends, manualSends,
      responses: replies,
      totalSends: totS, totalResponses: totR,
      responseRate: respRate,
      score: sends,
      isOnline: isOnlineUser(email),
    });
  }
  rows.sort((a, b) => b.score !== a.score ? b.score - a.score : b.totalSends - a.totalSends);
  return rows.map((r, i) => ({ pos: i + 1, ...r }));
}

// ════════════════════════════════════════════════════════════
//  SISTEMA DE PEDIDOS DE PLANO
//  Usuário solicita → admin revisa e ativa
// ════════════════════════════════════════════════════════════
// FIX (2026-07-08, a pedido do Andrio — "você garante que toda edição fica
// salva?"): antes essas duas funções tinham escrita própria, simples, SEM
// retry e SEM SQLite — mais fraca que o resto do sistema (users.json já
// usava o motor persist()/storagePersist() com SQLite+WAL e 3 tentativas).
// Exatamente os arquivos de DINHEIRO (pedidos e financeiro) estavam na
// via mais fraca. Agora passam pelo mesmo persist() robusto de tudo mais,
// e retornam true/false pra quem chama poder checar de verdade.
function persistPedidos(){
  try{ return !!persist(PEDIDOS_FILE, DB_PEDIDOS); }
  catch(e){ console.warn("[pedidos]",e.message); return false; }
}
// Grava o resultado do pré-check do comprovante no pedido (por id), sem corrida.
function setPedidoPreCheck(pedidoId, pc){
  try{
    const i=DB_PEDIDOS.findIndex(p=>p.id===pedidoId);
    if(i<0) return;
    DB_PEDIDOS[i].preCheck = { ...pc, at: Date.now() };
    persistPedidos();
  }catch(e){ console.warn("[precheck] setPedidoPreCheck:",e.message); }
}
function persistFinanceiro(){
  // Salva sem imagens base64 inline para não explodir o arquivo — as
  // imagens ficam como referência de pedido (já persistidas nos pedidos).
  try{ return !!persist(FINANCEIRO_FILE, DB_FINANCEIRO); }
  catch(e){ console.warn("[financeiro]",e.message); return false; }
}

// ── BOOT ─────────────────────────────────────────────────
boot();loadSheets();
loadGruposJ26();
setTimeout(j26AutoTick, 45_000);              // 1ª checagem ~45s depois do boot
setInterval(j26AutoTick, 5*60_000);            // depois, a cada 5 minutos — pedido do dono
console.log(`[grupos-j26] 🎯 Sistema de Grupos — Julho 2026 pronto | ${Object.keys(DB_GRUPOS_J26.mapa).length} case(s) no mapa`);
loadDolNewsWatch();
setTimeout(dolNewsAutoTick, 60_000);           // 1ª checagem ~60s depois do boot
setInterval(dolNewsAutoTick, 10*60_000);       // depois, a cada 10 minutos
console.log(`[dol-news-watch] 📰 Vigia de Anúncios DOL pronto | último conhecido: ${DB_DOL_NEWS_WATCH.ultimaConhecida.date} — admins: ${getAllAdminEmails().join(", ")}`);

// ── Correção pontual pedida pelo Andrio (05/07/26): o gasto "RENDER 41 DOLARES"
// foi lançado como R$ 2.010,00 por engano — o valor real é US$ 41 (câmbio 5,17
// = R$ 211,97). Idempotente: só corrige 1x, e a correção fica na trilha.
try{
  const _gErr=(DB_FINANCEIRO.gastos||[]).find(g=>g&&!g._fixRender41&&/render/i.test(g.descricao||g.nota||"")&&/41/.test(g.descricao||g.nota||"")&&g.valor>=2000&&g.valor<=2020);
  if(_gErr){
    const _antes={...(_gErr)};delete _antes.comprovante;
    _gErr.moeda="USD";_gErr.valorUSD=41;_gErr.cambio=5.17;
    _gErr.valor=Math.round(41*5.17*100)/100; // 211,97
    _gErr.editadoEm=Date.now();_gErr.editadoPor="Sistema";_gErr._fixRender41=true;
    if(!Array.isArray(DB_FINANCEIRO.alteracoes))DB_FINANCEIRO.alteracoes=[];
    const _dep={...(_gErr)};delete _dep.comprovante;
    DB_FINANCEIRO.alteracoes.push({id:'alt_'+Date.now().toString(36),tipo:'edit_gasto',por:'Sistema (correção Andrio)',porEmail:'sistema',em:Date.now(),
      motivo:'Correção automática: gasto RENDER lançado como R$2.010,00 por engano — valor real US$41 (câmbio 5,17 = R$211,97).',antes:_antes,depois:_dep});
    persistFinanceiro();
    console.log('[fin] ✅ Gasto RENDER corrigido: R$2.010,00 → US$41 (R$211,97)');
  }
}catch(e){console.warn('[fin] fix render41:',e.message);}

// ── Migração automática: copiar planilhas enriquecidas para /data/ ──────────
// Se o bot já enriqueceu (enrichedAt no meta) mas o arquivo em /data/ não existe,
// significa que o enriquecimento foi feito antes desta correção.
// Copia o arquivo de __dirname para /data/ para que deploys futuros carreguem corretamente.
(function migrateEnrichedSheets(){
  for(const[key,file]of[["jan2026","jan2026_compact.json"],["jul2025","jul2025_compact.json"]]){
    const dataPath=path.join(DATA_DIR,file);
    const srcPath=path.join(__dirname,file);
    if(!fs.existsSync(dataPath)&&fs.existsSync(srcPath)){
      try{
        const data=JSON.parse(fs.readFileSync(srcPath,"utf8"));
        // Só migra se o arquivo tem dados enriquecidos (campo ci preenchido em pelo menos 10%)
        const withCity=data.filter(r=>r.ci).length;
        const pct=data.length>0?Math.round(withCity/data.length*100):0;
        if(pct>=10){
          fs.writeFileSync(dataPath,JSON.stringify(data));
          console.log(`[migrate] ✅ ${file} copiado para /data/ (${pct}% enriquecido, ${data.length} vagas)`);
        } else {
          console.log(`[migrate] ⚠️ ${file} sem enriquecimento significativo (${pct}%) — não migrado`);
        }
      }catch(e){console.warn(`[migrate] Erro ao migrar ${file}:`,e.message);}
    } else if(fs.existsSync(dataPath)){
      console.log(`[migrate] ✅ ${file} já existe em /data/ — ok`);
    }
  }
})();

// ── Recategorização corretiva (bug reportado: Housekeeper puxando vaga de
// Cook/cozinha) — causa-raiz: detectCategory() vinha sendo chamado só com o
// NOME DA EMPRESA (r.n), nunca com o CARGO (r.t). Uma empresa chamada
// "Breezeway Family Resorts" contratando "Cook" caía em housekeeper só por
// ter "resort" no nome. Os 5 pontos que faziam essa chamada errada já foram
// corrigidos no código (agora usam empresa+cargo). Esta função roda 1x no
// boot e força o recálculo de TODA vaga já classificada antes da correção
// (ignora o cache de r.k existente), e persiste o resultado corrigido.
function recategorizeAllSheets(){
  let totalFixed=0;
  function fixArray(arr,label){
    let fixed=0;
    for(const r of arr){
      if(String(r.visa||"").toUpperCase().includes("H-2A")) continue; // H-2A tem taxonomia própria — nunca tocar aqui
      const novo=detectCategory(`${r.n||""} ${r.t||""}`);
      if(r.k!==novo){ r.k=novo; fixed++; }
    }
    if(fixed>0) console.log(`[recat] 🔧 ${label}: ${fixed}/${arr.length} vagas recategorizadas (título passou a valer, não só empresa)`);
    return fixed;
  }
  totalFixed+=fixArray(SHEET_JAN,"jan2026");
  totalFixed+=fixArray(SHEET_JUL,"jul2025");
  // H-2A NÃO entra aqui: usa uma taxonomia agrícola própria de 20 categorias
  // (crop, livestock, equipment_op, sheepherder...) que não existe em
  // CATEGORY_KEYWORDS. Rodar detectCategory() nele destruiria essa
  // classificação especializada — só H-2B (jan2026/jul2025/extras) usa
  // CATEGORY_KEYWORDS.
  for(const[key,arr] of Object.entries(SHEET_EXTRAS)){
    const n=fixArray(arr,`extra:${key}`);
    if(n>0){
      try{
        if(!fs.existsSync(SHEETS_DIR)) fs.mkdirSync(SHEETS_DIR,{recursive:true});
        fs.writeFileSync(path.join(SHEETS_DIR,key+".json"), JSON.stringify(arr));
      }catch(e){console.warn(`[recat] Erro ao persistir extra ${key}:`,e.message);}
    }
  }
  // Persiste jan2026/jul2025 corrigidos em /data/ (mesmo padrão do bot de enriquecimento)
  if(totalFixed>0){
    try{ fs.writeFileSync(path.join(DATA_DIR,"jan2026_compact.json"), JSON.stringify(SHEET_JAN)); }catch(e){console.warn("[recat] persist jan2026:",e.message);}
    try{ fs.writeFileSync(path.join(DATA_DIR,"jul2025_compact.json"), JSON.stringify(SHEET_JUL)); }catch(e){console.warn("[recat] persist jul2025:",e.message);}
    console.log(`[recat] ✅ Recategorização concluída: ${totalFixed} vaga(s) corrigida(s) no total e salvas em /data/.`);
  } else {
    console.log("[recat] ✅ Nenhuma vaga precisou de correção de categoria.");
  }
}
recategorizeAllSheets();

// ── Graceful shutdown: persiste TODOS os bancos ──────────
function flushAll() {
  console.log("[shutdown] Persistindo dados...");

  // 1. Cancela todos os timers de debounce pendentes
  _persistDebounceTimers.forEach((tid, _file) => clearTimeout(tid));
  _persistDebounceTimers.clear();

  // 2. Persiste todos os bancos de dados principais
  try { persist(USERS_FILE,  DB_USERS); } catch(e) { console.warn("[shutdown] users:", e.message); }
  try { persistSessions();              } catch(e) { console.warn("[shutdown] sessions:", e.message); }
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
  try { persist(SUGGESTIONS_FILE, DB_SUGGESTIONS); } catch(e) { console.warn("[shutdown] suggestions:", e.message); }
  try { _persistNotifCooldowns(); } catch(e) { console.warn("[shutdown] notif-cooldowns:", e.message); }

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
process.on("uncaughtException",(err)=>{
  console.error("[FATAL] uncaughtException:",err?.message||err);
  try{pushGlobalEvent("uncaught_exception",null,String(err?.message||err).slice(0,200),"error");persist(AUTO_FILE,DB_AUTO);persist(USERS_FILE,DB_USERS);}catch(_){}
  // NÃO termina — timers do automático continuam
});
process.on("unhandledRejection",(reason)=>{
  console.error("[WARN] unhandledRejection:",reason?.message||reason);
  try{pushGlobalEvent("unhandled_rejection",null,String(reason?.message||reason).slice(0,200),"warn");}catch(_){}
});


// ── Motor de Enriquecimento Autônomo ─────────────────────────────────────
// Verifica e processa TODAS as planilhas pendentes (1x por planilha).
// Roda invisível no servidor — não depende de sessão, página aberta ou login.
// Builtins (jan2026, jul2025) + extras (uploadadas via admin).
// Critério: enrichedAt ausente no DB_SHEETS_META = pendente.
async function _autoEnrichCycle(){
  if(_enrichBot.running){ return; } // já rodando, aguarda

  const allSheetKeys = ["jan2026","jul2025",...Object.keys(SHEET_EXTRAS)];

  for(const sheetKey of allSheetKeys){
    if(_enrichBot.running) break;

    const sheet = getSheet(sheetKey);
    if(!sheet||!sheet.length) continue;

    // REGRA: verificar progresso REAL pelo disco (contagem de vagas com email)
    // Ignora enrichedAt — ele pode estar errado se houve deploy no meio
    const withEmail = sheet.filter(r=>r.e&&r.e.includes("@")).length;
    const withoutEmail = sheet.length - withEmail;
    const pct = Math.round((withEmail/sheet.length)*100);

    if(withoutEmail === 0){
      // 100% real — marca como concluído e pula
      if(!DB_SHEETS_META[sheetKey]) DB_SHEETS_META[sheetKey]={name:sheetKey};
      DB_SHEETS_META[sheetKey].enrichedAt=Date.now();
      DB_SHEETS_META[sheetKey].enriched=withEmail;
      DB_SHEETS_META[sheetKey].enrichedTotal=sheet.length;
      try{fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));}catch{}
      console.log(`[auto-enrich] ${sheetKey}: ✅ 100% completo (${withEmail}/${sheet.length}) — nada a fazer`);
      continue;
    }

    // Tem vagas sem email — inicia bot de enriquecimento
    const resume = withEmail > 0;
    const startIdx = resume ? Math.max(0, withEmail - 5) : 0;
    console.log(`[auto-enrich] 🚀 ${sheetKey}: ${withoutEmail} pendentes (${pct}% completo) — idx ${startIdx}`);
    await _runEnrichBot(sheetKey, resume).catch(e=>console.error(`[auto-enrich] ${sheetKey}:`,e.message));
    console.log(`[auto-enrich] ✅ ${sheetKey}: concluído`);

    // Pausa 60s entre planilhas para não saturar DOL API
    if(allSheetKeys.indexOf(sheetKey) < allSheetKeys.length-1){
      await new Promise(r=>setTimeout(r,60000));
    }
  }
}

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`\n✅  H2BApply v13.1 — ${APP_URL} (porta ${PORT})`);
  console.log(`    👤 Usuários: ${Object.keys(DB_USERS).length}`);
  console.log(`    📋 Jan/2026: ${SHEET_JAN.length} | Jul/2025: ${SHEET_JUL.length}`);
  console.log(`    🔗 Índice candidaturas: ${Object.keys(DB_APP_INDEX).length} usuário(s)`);
  console.log(`    🍪 Cookie: SameSite=Lax | IS_PROD: ${IS_PROD}`);
  if(!CONFIGURED)console.log("\n⚠️  Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET!\n");
  setTimeout(refreshCache,3000);
  setTimeout(()=>reactivateAutoJobs().catch(e=>console.error("[boot] reactivate error:",e.message)),6000);

  // ══════════════════════════════════════════════════════════════════════
  // ── GEMINI AUTO-REGULARIZAÇÃO — roda 30s após boot ────────────────────
  // Verifica clientes com plano ativo mas sem dados financeiros preenchidos
  // e preenche automaticamente. Nunca sobrescreve dados já existentes.
  // Também salva contexto financeiro na KB para auditorias futuras.
  // ══════════════════════════════════════════════════════════════════════
  // ── Regularização imediata dos clientes confirmados (10s após boot) ────────
  // Dados confirmados pelo Andrio em 27/06/2026. Executado 1 vez por cliente.
  // Nunca sobrescreve dados já preenchidos pelo admin/Diego.
  setTimeout(()=>{
    const _CLIENTES_CONFIRMADOS=[
      {email:"italoleal812@gmail.com",        nome:"Ítalo Almeida Leal",            valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"esdras.silva.h2b@gmail.com",    nome:"Esdras Alberto da Silva",       valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"sw26wagnersilva@gmail.com",     nome:"Wagner Silva da Silva",         valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"maykoncanalgg@gmail.com",       nome:"Maykon de Souza Nobrega",       valor:"R$100.00",plano:"vip",  nota:"VIP Manual 30d — confirmado Diego 27/06/2026"},
      {email:"jonatafontela07@gmail.com",     nome:"Jonata Fontela Dutra",          valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"itallofeitoza1993@gmail.com",   nome:"Itallo Jailson Feitoza",        valor:"R$150.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"regianegoncalves.rgs@gmail.com",nome:"Regiane Gonçalves dos Santos",  valor:"R$100.00",plano:"vip",  nota:"VIP Manual 30d — confirmado Diego 27/06/2026"},
      {email:"bruno.j.lange@gmail.com",       nome:"Bruno Luis Jara Lange",         valor:"R$120.00",plano:"vipro",nota:"VIPro 30d R$120 desconto — confirmado Diego 27/06/2026"},
      {email:"enggustavomachado93@gmail.com", nome:"Gustavo Amaral Machado",        valor:"R$100.00",plano:"vipro",nota:"VIPro 30d — confirmado Diego 27/06/2026"},
      {email:"jose.camilo.jobs@gmail.com",    nome:"José Camilo Rodrigues",         valor:"R$149.90",plano:"vipro",nota:"VIPro 30d R$149,90 — confirmado Diego 27/06/2026"},
    ];
    const now=Date.now();
    let _reg=0;
    for(const c of _CLIENTES_CONFIRMADOS){
      const u=getUser(c.email);
      if(!u)continue;
      // Nunca sobrescrever dados já preenchidos
      if(u.financialStatus==='pago'&&u.paymentAmount&&u.lastValidationResult==='CLIENTE_VALIDADO')continue;
      const patch={};
      if(!u.financialStatus)patch.financialStatus='pago';
      if(!u.paymentAmount)patch.paymentAmount=c.valor;
      if(!u.paymentMethod)patch.paymentMethod='pix';
      if(!u.paymentReceiver)patch.paymentReceiver='Diego';
      if(!u.paymentDate)patch.paymentDate='27/06/2026';
      if(!u.paymentNote)patch.paymentNote=c.nota;
      if(u.lastValidationResult!=='CLIENTE_VALIDADO'){
        patch.lastValidatedAt=now;
        patch.lastValidatedBy='Sistema (boot) — confirmado por Diego';
        patch.lastValidationResult='CLIENTE_VALIDADO';
      }
      if(!u.adminNotes)patch.adminNotes=`Receita jun/2026: R$1.319,90 | Gastos: R$466,01 | Lucro: R$853,89 (Andrio: R$426,95 / Diego: R$426,95)`;
      patch.adminEditHistory=[...(u.adminEditHistory||[]).slice(-49),{
        at:now,by:'Sistema Auto',byEmail:'boot',
        changes:Object.keys(patch).join(','),
        note:`Regularização boot 27/06/2026 — ${c.nota}`
      }];
      setUser(c.email,patch);
      _reg++;
      console.log(`[boot-reg] ✅ ${c.nome} (${c.email}): ${c.valor} preenchido`);
    }
    if(_reg>0)console.log(`[boot-reg] ✅ ${_reg} cliente(s) regularizado(s) automaticamente`);
    else console.log('[boot-reg] ✅ Todos os clientes confirmados já estão regularizados');
  }, 10000); // 10s após boot

  setTimeout(async()=>{
    try{
      const gKey=getGeminiKey();
      if(!gKey){ console.log("[gemini-boot] sem chave Gemini, pulando regularização"); return; }
      console.log("[gemini-boot] 🤖 Iniciando regularização automática de perfis...");

      // ── PASSO 1: Regularizar clientes com plano ativo sem dados financeiros ──
      const _clientesSemFinanceiro=Object.values(DB_USERS||{}).filter(u=>{
        if(!u||!u.email||!u.plan||u.plan==='free')return false;
        if(!isVipActive(u))return false;  // só quem tem VIP ativo
        if(isAdminVip(u))return false;    // nunca o admin
        // Está faltando dados financeiros?
        return !u.financialStatus||!u.paymentAmount||u.lastValidationResult!=='CLIENTE_VALIDADO';
      });

      if(_clientesSemFinanceiro.length===0){
        console.log("[gemini-boot] ✅ Todos os clientes já estão com dados financeiros preenchidos.");
      } else {
        console.log(`[gemini-boot] 📋 ${_clientesSemFinanceiro.length} cliente(s) com dados financeiros incompletos.`);

        // Montar lista para o Gemini analisar
        const _listaPendentes=_clientesSemFinanceiro.map(u=>({
          email:u.email,
          nome:u.name||u.email,
          plano:u.plan||'?',
          vipExpira:u.vip?.manualExpires?new Date(u.vip.manualExpires).toLocaleDateString('pt-BR'):'?',
          financialStatus:u.financialStatus||'não preenchido',
          paymentAmount:u.paymentAmount||'não preenchido',
          lastValidationResult:u.lastValidationResult||'não validado',
          pedidos:(DB_PEDIDOS||[]).filter(pd=>pd.userEmail===u.email).map(pd=>({
            status:pd.status,plano:pd.plano,valor:pd.valorTotal,
            ativadoPor:pd._ativadoEditor||pd.ativadoPor,
            geminiAuditoria:pd.geminiAuditoria?.status
          }))
        }));

        // Montar contexto de KB de preços
        const _tabelaPrecos=`VIP 30d=R$100 60d=R$190 90d=R$270 1a=R$960 | VIPro 30d=R$150 60d=R$285 90d=R$405 1a=R$1440 | DoublePro 30d=R$250 60d=R$475 90d=R$675 1a=R$2400`;

        const _promptReg=`Você é o sistema de regularização do H2BApply. Analise os clientes abaixo e para cada um infira os dados financeiros corretos baseado no plano e nos pedidos existentes.

TABELA DE PREÇOS: ${_tabelaPrecos}

CLIENTES PENDENTES:
${JSON.stringify(_listaPendentes, null, 2)}

Para cada cliente, retorne APENAS um array JSON (sem markdown) com os dados a preencher.
Regras:
- Se há pedido com valor, use esse valor como paymentAmount
- Se não há pedido, infira o valor padrão pelo plano (30 dias)
- paymentReceiver = "Diego" (é quem recebe os pagamentos)
- paymentMethod = "pix"
- financialStatus = "pago" se o cliente tem VIP ativo
- paymentDate = data de hoje se não há data no pedido
- paymentNote = descrição curta clara
- Se não há informação suficiente, preencha com o mínimo possível

RESPONDA APENAS com array JSON:
[{"email":"...","financialStatus":"pago","paymentAmount":"R$150.00","paymentMethod":"pix","paymentReceiver":"Diego","paymentDate":"${new Date().toLocaleDateString('pt-BR')}","paymentNote":"..."}]`;

        const gUrl=new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gKey}`);
        const gBody=JSON.stringify({
          contents:[{parts:[{text:_promptReg}]}],
          generationConfig:{temperature:0.1,maxOutputTokens:2000}
        });
        const gRes=await new Promise((rs,rj)=>{
          const r2=https.request({hostname:gUrl.hostname,path:gUrl.pathname+gUrl.search,method:"POST",
            headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(gBody)}},
            resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{try{rs(JSON.parse(Buffer.concat(ch).toString()));}catch{rj(new Error("parse"));}});});
          r2.on("error",rj);r2.setTimeout(25000,()=>{r2.destroy();rj(new Error("timeout"));});
          r2.write(gBody);r2.end();
        });

        const rawReg=(gRes?.candidates?.[0]?.content?.parts?.[0]?.text||"").replace(/```json|```/g,"").trim();
        let atualizacoes=[];
        try{ atualizacoes=JSON.parse(rawReg); }
        catch(e){ console.warn("[gemini-boot] erro parse regularização:",rawReg.slice(0,200)); }

        let _regCount=0;
        const now=Date.now();
        for(const upd of (Array.isArray(atualizacoes)?atualizacoes:[])){
          if(!upd.email)continue;
          const u=getUser(upd.email);if(!u)continue;
          // Nunca sobrescrever dados já preenchidos pelo admin
          const patch={};
          if(!u.financialStatus&&upd.financialStatus)patch.financialStatus=upd.financialStatus;
          if(!u.paymentAmount&&upd.paymentAmount)patch.paymentAmount=upd.paymentAmount;
          if(!u.paymentMethod&&upd.paymentMethod)patch.paymentMethod=upd.paymentMethod;
          if(!u.paymentReceiver&&upd.paymentReceiver)patch.paymentReceiver=upd.paymentReceiver;
          if(!u.paymentDate&&upd.paymentDate)patch.paymentDate=upd.paymentDate;
          if(!u.paymentNote&&upd.paymentNote)patch.paymentNote=upd.paymentNote;
          // Sempre marcar como validado pelo Gemini
          patch.lastValidatedAt=now;
          patch.lastValidatedBy="Gemini Auto (boot)";
          patch.lastValidationResult="CLIENTE_VALIDADO";
          patch.adminEditHistory=[...(u.adminEditHistory||[]).slice(-49),{
            at:now,by:"Gemini Auto",byEmail:"sistema",
            changes:Object.keys(patch).join(","),
            note:"Regularização automática Gemini no boot — dados inferidos do plano e pedidos"
          }];
          if(Object.keys(patch).length>3){ // tem dados reais além dos campos de validação
            setUser(upd.email,patch);
            _regCount++;
            console.log(`[gemini-boot] ✅ ${upd.email}: ${upd.paymentAmount||'?'} preenchido`);
          }
        }
        console.log(`[gemini-boot] ✅ Regularização concluída: ${_regCount} perfil(is) atualizados`);
      }

      // ── PASSO 2: Salvar contexto financeiro na KB (sem apagar antigas) ────
      // Extrai dados reais do sistema e salva como entrada KB permanente
      const _planosAtivosCount=Object.values(DB_USERS||{}).filter(u=>isVipActive(u)&&u.plan!=='free'&&!isAdminVip(u)).length;
      const _receita=Object.values(DB_USERS||{}).reduce((acc,u)=>{
        if(!isVipActive(u)||u.plan==='free'||isAdminVip(u))return acc;
        const v=parseFloat((u.paymentAmount||'0').replace(/[^0-9.,]/g,'').replace(',','.'))||0;
        return acc+v;
      },0);

      // Salvar contexto financeiro na KB — sempre novo (não substitui)
      const _kbFinanceiro={
        id:`KB-FIN-${new Date().toISOString().slice(0,7)}`, // KB-FIN-2026-06
        versao:"auto-financeiro",
        data:new Date().toISOString().slice(0,10),
        tipo:"contexto_financeiro",
        problema:`Contexto financeiro de ${new Date().toISOString().slice(0,7)}`,
        solucao:`Receita inferida: R$${_receita.toFixed(2)} | Planos ativos: ${_planosAtivosCount} | Clientes validados: ${Object.values(DB_USERS||{}).filter(u=>u.lastValidationResult==='CLIENTE_VALIDADO').length}`,
        impacto:"contexto",
        modulos:["gemini-boot"],
        geradoPor:"gemini-boot-auto",
        geradoEm:new Date().toISOString()
      };
      // Atualizar ou adicionar (não duplicar mesmo mês)
      const _kbFinIdx=DB_KB.entries.findIndex(e=>e.id===_kbFinanceiro.id);
      if(_kbFinIdx>=0){ DB_KB.entries[_kbFinIdx]={...DB_KB.entries[_kbFinIdx],..._kbFinanceiro}; }
      else { DB_KB.entries.push(_kbFinanceiro); }
      try{ fs.writeFileSync(KB_FILE,JSON.stringify(DB_KB,null,2)); }catch{}
      console.log(`[gemini-boot] 📚 KB financeira atualizada: R$${_receita.toFixed(2)} | ${_planosAtivosCount} planos ativos`);

    }catch(e){ console.warn("[gemini-boot] erro:",e.message); }
  }, 30000); // 30s após boot — depois do reactivate e cache

  // ── Startup Bounce Scan — verifica inbox de todos os usuários com token ──
  // Roda 20s após boot para dar tempo do reactivate e cache carregarem.
  // Para cada usuário com refresh_token, renova token e escaneia inbox por bounces.
  // Bounces encontrados → registrados em DB_INVALID_EMAILS → removidos das planilhas.
  setTimeout(async()=>{
    const usersWithToken = Object.values(DB_USERS).filter(u=>u&&u.email&&u.refresh_token);
    if(!usersWithToken.length){ console.log("[bounce-scan] nenhum usuário com token, pulando"); return; }
    console.log(`[bounce-scan] 🔍 Iniciando scan de bounces para ${usersWithToken.length} usuário(s)...`);
    let totalBounces=0, totalUsers=0;
    for(const u of usersWithToken){
      try{
        // Renova token diretamente via refresh_token (sem precisar de sessão ativa)
        const freshToken = await refreshTokenForUser(u.email).catch(()=>null);
        if(!freshToken){ console.log(`[bounce-scan] ${u.email}: token inválido, pulando`); continue; }
        // Cria sessão temporária para gmailFetchInbox
        const _tmpSid = "__bounce_scan__"+u.email;
        sessions[_tmpSid] = {access_token:freshToken, user_email:u.email, expires_at:Date.now()+3500_000};
        try{
          // Busca apenas as últimas 50 mensagens para não sobrecarregar
          const emails = await gmailFetchInbox(_tmpSid, 50);
          // gmailFetchInbox já processa bounces internamente e chama processBounce()
          totalBounces += (emails._bouncesProcessed||0);
          totalUsers++;
          console.log(`[bounce-scan] ✅ ${u.email}: ${emails.length} mensagens verificadas`);
        }finally{
          delete sessions[_tmpSid]; // limpa sessão temporária
        }
        // Pausa 2s entre usuários para não sobrecarregar Gmail API
        await new Promise(r=>setTimeout(r,2000));
      }catch(e){
        console.warn(`[bounce-scan] ${u.email}: ${e.message}`);
      }
    }
    console.log(`[bounce-scan] ✅ Concluído: ${totalUsers} usuários verificados | ${Object.keys(DB_INVALID_EMAILS).length} emails inválidos na base`);
  }, 20000); // 20s após boot

  // ── Auto-Enriquecimento DOL — Motor Autônomo ─────────────────────────
  // REGRAS:
  //   • Roda 1x por planilha (controle via DB_SHEETS_META[key].enrichedAt)
  //   • Cobre TODAS as planilhas: builtins + extras uploadadas
  //   • Invisível ao usuário — roda 100% server-side sem necessitar sessão
  //   • Persiste no disco — sobrevive a restart/deploy
  //   • Watchdog a cada 30min verifica novas planilhas pendentes
  //   • Admin pode pausar via botão Parar; watchdog retoma automaticamente

  // Dispara o ciclo 15s após boot
  setTimeout(()=>_autoEnrichCycle().catch(e=>console.error("[auto-enrich] boot cycle erro:",e.message)), 15000);

  // Watchdog a cada 30 minutos — captura planilhas novas ou que travaram
  setInterval(()=>{
    _autoEnrichCycle().catch(e=>console.error("[auto-enrich] watchdog erro:",e.message));
  }, 30 * 60 * 1000);
});

// ══════════════════════════════════════════════════════════════════════════
//  🩺 HEALTH SENTINEL — extraído para src/sentinel.js (Fase 1 · Módulo 3)
//  Injeção de dependências via getters: estado vivo do servidor sempre atual.
// ══════════════════════════════════════════════════════════════════════════
const { MSGS_VIP_EXPIRING, MSGS_NO_PROFILE, MSGS_VIP_DESYNC, MSGS_REFILL } = require("./mod-notif-templates.js");
const { initSentinel } = require("./mod-sentinel.js");
const { healthSentinelRun, pendingOrderAlert, queueSanitizerRun, getPedAlertSent } = initSentinel({
  DB_USERS: ()=>DB_USERS, DB_AUTO: ()=>DB_AUTO, DB_PEDIDOS: ()=>DB_PEDIDOS,
  DB_INVALID_EMAILS: ()=>DB_INVALID_EMAILS, DB_SHEETS_META: ()=>DB_SHEETS_META,
  SHEET_EXTRAS: ()=>SHEET_EXTRAS, sessions: ()=>sessions,
  ADMIN_EMAIL,
  getUser, getAutoJob, setAutoJob, isVipActive, sendNotifEmail,
  refreshTokenForUser, buildMime, httpsReq, getSheet,
  cooldownMaps: { notifSentAt: ()=>_notifSentAt, authErrNotifiedAt: getAuthErrNotifiedAt },
  pedAlertSentInit: _DB_NOTIF_COOLDOWN.pedAlertSent, // V951: sobrevive a deploy
  botLog, // 📜 log unificado — pedido do dono (07/07/2026)
});

// ── Router do grupo saúde/operação (Fase 1 · Módulo 5) ──
const { createAdminHealthRouter } = require("./mod-admin-health.js");
const handleAdminHealthRoutes = createAdminHealthRouter({
  getSess, getUser, isAdminVip, isAdminEmail, json, readBody,
  DB_USERS: ()=>DB_USERS, DB_AUTO: ()=>DB_AUTO, DB_PEDIDOS: ()=>DB_PEDIDOS,
  getAutoJob, setAutoJob, sendNotifEmail, storageInfo,
  queueSanitizerRun, healthSentinelRun, pendingOrderAlert,
});
console.log("[health-sentinel] 🩺 Módulo carregado: desync VIP↔robô, lembrete de renovação, alerta de pedidos, sanitização de fila.");

// ── 🚀 PAINEL ADMIN V2 (novo) — rotas /api/admin/v2/* ──
const { createAdminV2Router } = require("./mod-admin-v2.js");
const handleAdminV2Routes = createAdminV2Router({
  getSess, getUser, setUser, isAdminVip, isAdminEmail, json, readBody,
  DB_USERS: ()=>DB_USERS, DB_HIST: ()=>DB_HIST, DB_AUTO: ()=>DB_AUTO,
  DB_PEDIDOS: ()=>DB_PEDIDOS, DB_FINANCEIRO: ()=>DB_FINANCEIRO,
  DB_LOGS: ()=>DB_LOGS, DB_KB: ()=>DB_KB, DB_NOTES: ()=>DB_NOTES,
  DB_ALERTS: ()=>DB_ALERTS, DB_SHEETS_META: ()=>DB_SHEETS_META,
  getPlan, getAutoJob, setAutoJob, getHist,
  persistUsers: ()=>persist(USERS_FILE, DB_USERS),
  persistAuto:  ()=>persist(AUTO_FILE, DB_AUTO),
  persistPedidos, persistFinanceiro,
  DATA_DIR, getGeminiKey, scheduleAuto, httpsReq,
  ADMIN_SETTINGS: ()=>DB_ADMIN_SETTINGS,
  persistAdminSettings: ()=>persist(ADMIN_SETTINGS_FILE, DB_ADMIN_SETTINGS),
});
console.log("[admin-v2] 🚀 Painel V2 carregado: auditoria permanente, dashboard, edição universal, bots, IA, logs, financeiro, relatórios, backup, config.");

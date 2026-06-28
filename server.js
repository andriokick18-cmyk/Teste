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

// ── Config ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const APP_URL       = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const REDIRECT_URI        = APP_URL + "/oauth/callback";
const REDIRECT_URI_SENDER = APP_URL + "/oauth/add-sender/callback";
const MAX_SENDER_EMAILS_FREE   = 1; // free: apenas o email principal (0 extras)
const MAX_SENDER_EMAILS_VIP    = 2; // pagantes: email principal + 1 extra = 2 total
const MAX_SENDER_EMAILS_ADMIN  = 6; // admins: email principal + 5 extras = 6 total
// getMaxSenders retorna o TOTAL de emails (principal + extras)
const getMaxSenders = (u) => {
  if(u?.isAdmin || isAdminEmail(u?.email||"")) return MAX_SENDER_EMAILS_ADMIN;
  const plan = (u?.plan||"free").toLowerCase();
  if(["vip","vipro","doublepro","vip_pro","double_pro"].includes(plan)) return MAX_SENDER_EMAILS_VIP;
  return MAX_SENDER_EMAILS_FREE; // free: só o email principal
};
const MAX_RESUMES         = 3;
const MAX_COVERS          = 3;
const PORT          = parseInt(process.env.PORT || "3000", 10);
const IS_PROD       = APP_URL.startsWith("https://");
const CONFIGURED    = !!(CLIENT_ID && CLIENT_SECRET);
const ADMIN_EMAIL   = (process.env.ADMIN_EMAIL || "andrio.kick18@gmail.com").trim().toLowerCase();
const ADMIN_EMAIL_2 = (process.env.ADMIN_EMAIL_2 || "").trim().toLowerCase();
// Admins adicionais hardcoded (além do env)
// Admins adicionais hardcoded — adicione mais emails aqui se necessário
const ADMIN_EMAILS_EXTRA = ["ndrkick.2@gmail.com","jesuscristh22@gmail.com"].map(e=>e.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS  = new Set([ADMIN_EMAIL, ADMIN_EMAIL_2, ...ADMIN_EMAILS_EXTRA].filter(Boolean));
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
//   free      → 20 manual  + 10 auto   /dia (Grátis)
//   vip       → 200 manual + 10 auto   /dia (só manual pago)
//   vipro     → 200 manual + 200 auto  /dia (manual + automático)
//   doublepro → 400 manual + 400 auto  /dia (2 contas Gmail)
//   pro       → 0 manual   + 200 auto  /dia (só auto — legado)
//
//   Os limites de manual e auto são INDEPENDENTES — não se misturam.
const PLAN_LIMITS = {
  free:      { manual: 20,  auto: 10  },
  vip:       { manual: 200, auto: 10  }, // VIP = só manual 200/dia
  pro:       { manual: 0,   auto: 200 }, // só auto — legado
  vipro:     { manual: 200, auto: 200 }, // manual + auto 200 cada
  doublepro: { manual: 400, auto: 400 }, // DoublePro — 2 contas, 400 cada
};
// Intervalos base (substituídos pelo cálculo inteligente)
const AUTO_INTERVAL_MIN = 180_000; // 3 min fallback
const AUTO_INTERVAL_MAX = 300_000; // 5 min fallback
// Horário padrão se usuário não configurar
// Horário de envio REMOVIDO: automático roda 24/7 sem janela de horário

// Intervalo de envio: padrão 3-5 min. Admins podem configurar intervalo menor.
// adminIntervalSecs: número de segundos entre envios (mín 30s para admins)
function calcSmartInterval(email) {
  // Verificar configuração personalizada do admin
  if (email) {
    const u = getUser(email);
    if (u && isAdminVip(u) && u.adminSettings?.intervalSecs) {
      const secs = Math.max(30, parseInt(u.adminSettings.intervalSecs) || 180);
      const jitter = secs * 0.15; // ±15% de variação
      return (secs + (Math.random() * 2 - 1) * jitter) * 1000;
    }
  }
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
const PEDIDOS_FILE     = path.join(DATA_DIR, "pedidos.json");         // Pedidos de plano dos usuários
const FINANCEIRO_FILE  = path.join(DATA_DIR, "financeiro.json");      // Dados financeiros (entradas + gastos)
const BLOCKED_FILE     = path.join(DATA_DIR, "blocked_emails.json");  // Emails banidos permanentemente
const TRIAL_USED_FILE  = path.join(DATA_DIR, "trial_used.json");       // Histórico anti-abuse: phones/IPs que já receberam trial
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
let DB_ADMIN_SETTINGS = { newUserTrialEnabled: true, newUserTrialDays: 1, newUserTrialAutoDays: 0, newUserTrialPlan: "vip" }; // v9: trial = 1d VIP Manual apenas (sem auto)
// Notifications: { notifications: [{id, title, body, createdAt, createdBy, readBy:[email,...]}] }
let DB_NOTIF = { notifications: [] };
// Referrals: { byCode: { code → {ownerEmail, createdAt} }, byEmail: { email → {code, referredBy, joinedAt, paidAt, bonusPaid} } }
let DB_REFERRAL = { byCode: {}, byEmail: {} };
let DB_SUGGESTIONS = []; // Array de sugestões dos usuários
let DB_PEDIDOS     = []; // Array de pedidos de plano
let DB_FINANCEIRO  = {pagamentos:[],gastos:[]};  // Dados financeiros persistentes
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

function load(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } }

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
  DB_FINANCEIRO = load(FINANCEIRO_FILE, {pagamentos:[],gastos:[]});
  if(!DB_FINANCEIRO.pagamentos) DB_FINANCEIRO = {pagamentos:[],gastos:[]};
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
  for(let attempt=0;attempt<3;attempt++){
    try{const t=file+".tmp";fs.writeFileSync(t,JSON.stringify(data,null,2),"utf8");fs.renameSync(t,file);return;}
    catch(e){console.warn(`[db] persist attempt ${attempt+1}/3 ${path.basename(file)}:`,e.message);
    if(attempt===2){try{fs.writeFileSync(file,JSON.stringify(data,null,2));}catch(e2){console.error("[db] FALHA persist:",e2.message);}}}
  }
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
  // Se o usuário tem plano explicitamente salvo, usa ele (para doublepro funcionar)
  if (u.plan && u.plan !== 'free' && isVipActive(u)) return u.plan;
  const manual = isManualVipActive(u);
  const auto   = isAutoVipActive(u);
  if (manual && auto) return 'vipro';
  if (manual) return 'vip';
  if (auto)   return 'vipro';
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
let SHEET_JAN = [], SHEET_JUL = [];
let SHEET_EXTRAS = {}; // { "jul2026": [...vagas] } — planilhas extras carregadas via admin
const SHEETS_DIR = path.join(DATA_DIR, "sheets");
const SHEETS_META_FILE = path.join(DATA_DIR, "sheets_meta.json");
let DB_SHEETS_META = {}; // { "jul2026": { name, file, uploaded, count, enriched, enrichedAt } }

// ── Bot de Enriquecimento de Planilhas ──────────────────
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
  other:        { label:"📋 Outros",                  en:"Other" },
};

function loadSheets() {
  // ── Carrega DB_SHEETS_META do disco ──
  if(fs.existsSync(SHEETS_META_FILE)){
    try{ DB_SHEETS_META = JSON.parse(fs.readFileSync(SHEETS_META_FILE,"utf8")); }catch{}
  }

  let anyLoaded = false;
  for(const[key,file]of[["jan","jan2026_compact.json"],["jul","jul2025_compact.json"]]){
    // PRIORIDADE: /data/ (disco persistente, sobrevive deploys)
    // FALLBACK: __dirname (arquivo original do código, sem enriquecimento)
    const pData = path.join(DATA_DIR, file);   // /data/jan2026_compact.json
    const pSrc  = path.join(__dirname, file);   // /opt/render/.../jan2026_compact.json
    const p = fs.existsSync(pData) ? pData : pSrc; // preferir /data/
    if(p===pData) console.log(`[sheet] 📂 Carregando ${file} de /data/ (enriquecido)`);
    else console.log(`[sheet] 📂 Carregando ${file} de código (original)`);
    if(fs.existsSync(p)){
      try {
        const d=JSON.parse(fs.readFileSync(p,"utf8"));
        if(!Array.isArray(d) || d.length === 0) {
          console.warn(`[sheet] ⚠️ ${file} existe mas está vazio ou inválido`);
          continue;
        }
        if(key==="jan") SHEET_JAN=d; else SHEET_JUL=d;
        (key==="jan"?SHEET_JAN:SHEET_JUL).forEach(r=>{if(!r.k)r.k=detectCategory(r.n||"");});
        console.log(`[sheet] ✅ ${key}: ${d.length} vagas`);
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
        const d = JSON.parse(fs.readFileSync(fp,"utf8"));
        if(!Array.isArray(d)||d.length===0) continue;
        d.forEach(r=>{if(!r.k)r.k=detectCategory(r.n||"");r._sheet=metaKey;});
        SHEET_EXTRAS[metaKey] = d;
        extrasLoaded++;
        console.log(`[sheet] ✅ extra ${metaKey}: ${d.length} vagas`);
      }catch(e){ console.warn(`[sheet] ❌ Erro ao ler extra ${metaKey}:`, e.message); }
    }
    if(extrasLoaded>0) console.log(`[sheet] ✅ ${extrasLoaded} planilha(s) extra(s) carregada(s) do disco`);
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

function getSheet(n) { return n==="jan2026"?SHEET_JAN:n==="jul2025"?SHEET_JUL:SHEET_EXTRAS[n]||[]; }
function getAllSheets() {
  // Retorna TODAS as planilhas combinadas (jan + jul + extras)
  return [...SHEET_JAN,...SHEET_JUL,...Object.values(SHEET_EXTRAS).flat()];
}

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

  // ── FIX CRÍTICO: parar automático se VIP/plano auto expirou ─────────────
  // lockedAutoLimit era salvo no início do job quando VIP estava ativo.
  // Mas se o VIP expirar enquanto o job roda, precisamos parar imediatamente.
  if(!isAdminVip(p) && !isAutoVipActive(p)){
    setAutoJob(email,{...job,active:false,status:"paused_no_vip",finishedAt:Date.now()});
    autoTimers.delete(email);
    addLog(email,{status:"pausado",jobTitle:"⛔ Automático pausado — plano expirado",company:"Renove seu plano VIPro para continuar o envio automático.",error:"Plano auto expirado"});
    console.log(`[auto] ⛔ ${email} VIP auto expirou — automático PARADO`);
    sendNotifEmail(email,"vip_expired").catch(()=>{});
    return;
  }

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
    const {token:sndTok0, senderEmail:sndEmail0} = await getSenderToken(email, null);
    _autoSenderEmail = sndEmail0; // já define o sender (principal ou extra)
    if (sndTok0) {
      accessToken = sndTok0; // extra: tem token direto
      console.log(`[auto] 🔄 Round-robin → extra: ${sndEmail0}`);
    } else {
      console.log(`[auto] 🔄 Round-robin → principal: ${sndEmail0}`);
      // token=null → fluxo normal de sessão/refresh abaixo para o principal
    }
  } catch(e) { console.warn("[auto] round-robin erro:", e.message); }

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
const sessions=Object.create(null);
const rateMap  =Object.create(null);
const SESS_TTL =7*24*60*60*1000;

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

function httpsReq(opts,body){return new Promise((res,rej)=>{const p=body?(typeof body==="string"?body:JSON.stringify(body)):null;const r=https.request(opts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{const raw=Buffer.concat(ch).toString();try{res({status:resp.statusCode,body:JSON.parse(raw)});}catch{res({status:resp.statusCode,body:raw});}});});r.on("error",rej);r.setTimeout(15000,()=>{r.destroy();rej(new Error("Timeout"));});if(p)r.write(p);r.end();});}
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB — suficiente para PDFs base64
function readBody(req){return new Promise((res,rej)=>{const p=[];let sz=0;req.on("data",c=>{sz+=c.length;if(sz>MAX_BODY_SIZE){rej(new Error("Payload too large"));return;}p.push(c);});req.on("end",()=>res(Buffer.concat(p).toString()));req.on("error",rej);});}
function json(res,status,data){const b=JSON.stringify(data);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(b)});res.end(b);}

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
async function getSenderToken(ownerEmail, requestedSender) {
  const p = getUser(ownerEmail);
  const extras = (p?.senderEmails || []).filter(s => s.active !== false);

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
    const pool = [
      { email: ownerEmail, isPrincipal: true },  // email principal sempre no pool
      ...extrasOk.map(s => ({ ...s, isPrincipal: false }))
    ];

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

  // ── Fallback final: email principal ──
  return { token: null, senderEmail: ownerEmail };
}


function buildMime({to,subject,text,fromName,fromEmail,attachments=[]}){ // v15-SEC: normaliza to
  to = normalizeEmail(to) || to;
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");const b64=s=>Buffer.from(s).toString("base64");const L=[`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,`To: ${to}`];L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`,"MIME-Version: 1.0");if(!attachments.length){L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);}else{L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");for(const a of attachments){const aMime=a.mime||"application/octet-stream";L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${a.name}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${a.name}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}L.push(`--${bnd}--`);}return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}

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
const server=http.createServer(async(req,res)=>{
  let u,pathname;try{u=new URL(req.url,"http://x");pathname=u.pathname;}catch{res.writeHead(400);return res.end();}
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Content-Security-Policy",[
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
    "img-src 'self' data: https:",
    "connect-src 'self' https://oauth2.googleapis.com https://gmail.googleapis.com https://api.seasonaljobs.dol.gov https://fcm.googleapis.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  const org=req.headers.origin||"";const ao=(org===APP_URL||/^https?:\/\/localhost/.test(org))?org:APP_URL;
  res.setHeader("Access-Control-Allow-Origin",ao);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,PATCH,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}

  const serveHtml=f=>{try{const h=fs.readFileSync(path.join(__dirname,f),"utf8");res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});return res.end(h);}catch{res.writeHead(404);return res.end(f+" não encontrado");}};
  if(pathname==="/"||pathname==="/index.html")return serveHtml("index.html");
  if(pathname==="/admin"||pathname==="/admin.html")return serveHtml("admin.html");
  if(pathname==="/guia"||pathname==="/guia.html")return serveHtml("guia.html");

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
    persistPedidos();
    // Atualizar também no financeiro se existir
    try{
      const finP=DB_FINANCEIRO.pagamentos.find(x=>x.pedidoId===pedidoId);
      if(finP){finP.valor=pd.valorTotal;finP.notaCorrecao=`Valor corrigido de R$${vAntes} para R$${pd.valorTotal} por ${s.user_email}`;persistFinanceiro();}
    }catch{}
    console.log(`[pedido] valor corrigido: ${pedidoId} R$${vAntes}→R$${pd.valorTotal} por ${s.user_email}`);
    return json(res,200,{ok:true,valorAntes:vAntes,valorNovo:pd.valorTotal});
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

  // POST /api/admin/sheet/upload — recebe nova planilha (JSON compacto ou CSV)
  if(pathname==="/api/admin/sheet/upload"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado"});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Não autorizado"});
    const{name,key,data}=body;
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
    const valid = vagas.filter(v=>v.c&&v.e&&v.e.includes("@"));
    if(valid.length<1)return json(res,400,{error:`Nenhuma vaga válida (com case_number e email). Encontradas: ${vagas.length}`});
    // Enriquecer categorias
    valid.forEach(r=>{if(!r.k)r.k=detectCategory(r.n||"");r._sheet=safeKey;});
    // Salvar arquivo
    const fname=`${safeKey}.json`;
    const fpath=path.join(SHEETS_DIR,fname);
    fs.writeFileSync(fpath,JSON.stringify(valid));
    SHEET_EXTRAS[safeKey]=valid;
    DB_SHEETS_META[safeKey]={name,file:fname,uploaded:Date.now(),count:valid.length,enriched:0};
    fs.writeFileSync(SHEETS_META_FILE,JSON.stringify(DB_SHEETS_META,null,2));
    console.log(`[sheet] ✅ Nova planilha carregada: ${safeKey} (${valid.length} vagas válidas de ${vagas.length})`);
    addLog(s.user_email,{status:"sistema",jobTitle:`📋 Nova planilha adicionada: ${name}`,company:`${valid.length} vagas válidas — Chave: ${safeKey}`});
    // Dispara enriquecimento automático imediato (não espera o watchdog de 30min)
    if(typeof _autoEnrichCycle === "function"){
      setTimeout(()=>_autoEnrichCycle().catch(e=>console.error("[auto-enrich] trigger upload erro:",e.message)), 3000);
      console.log(`[auto-enrich] 🔔 Enriquecimento de "${safeKey}" agendado em 3s`);
    }
    return json(res,200,{ok:true,key:safeKey,count:valid.length,total:vagas.length});
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
  // ── REFERRAL FIX: salva o ?ref= na sessão pendente para recuperar no callback ──
  const refCodeParam=(u.searchParams.get("ref")||"").trim().toUpperCase().slice(0,16);
  sessions["__p__"+st]={pending:true,ts:Date.now(),...(refCodeParam?{refCode:refCodeParam}:{})};
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
        if(existing2.find(s=>s.email===newEmail2))return fail2("Este Gmail já está adicionado à sua conta.");
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
      if(!ex){
        const now=Date.now();
        // ── Anti-abuse: verificar se este IP ou Google ID já recebeu trial ────
        const _clientIp = (req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"").split(",")[0].trim();
        const _googleId = String(ui.id||"").trim(); // ID único da conta Google
        const _ipPrevEmails = DB_TRIAL_USED.ips[_clientIp]||[];
        const _ipAbuse = _ipPrevEmails.length >= 2; // mesmo IP, 2+ contas
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
        console.log("[oauth] ✅ Novo:",ui.email,"| trial:",trialDays,"d VIP Manual (sem auto)");
        trackJourney(ui.email,'first_login',{detail:`Novo. Trial:${trialDays}d Manual`,meta:{name:ui.name}});
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
        setUser(ui.email,{...tokenData,picture:ui.picture||ex.picture,isAdmin:isAdminEmail(ui.email),...vipDowngrade,scopeVersion:2,lastLoginAt:Date.now()});
        console.log("[oauth] Login:",ui.email,"| refresh_token salvo:",!!tokenData.refresh_token,"| vip:",vipStillActive?"ativo":"inativo","| Total:",Object.keys(DB_USERS).length);
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
    if(totalSenders>=maxSnd){res.writeHead(302,{Location:"/?err="+encodeURIComponent(`Limite de ${maxSnd} emails atingido.`)});return res.end();}
    const st=crypto.randomBytes(20).toString("hex");
    // Salva o state com o email do dono para vincular no callback
    sessions["__sender__"+st]={ownerEmail:s.user_email,created:Date.now()};
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
      const TOKEN_INACTIVE_IGNORE_MS = 10*24*60*60*1000;
      const TOKEN_ACTIVE_ALERT_MS    =  3*24*60*60*1000;

      for(const u of allUsers){
        if(!u||!u.email)continue;
        const email=u.email;
        const job=getAutoJob(email);
        const lastSeen=u.lastSeenAt||new Date(u.created_at||0).getTime();
        const inactiveMs=now-lastSeen;

        // ── Token/OAuth expirado ──────────────────────────────────
        if(u.cached_token_expiry&&u.cached_token_expiry<now&&inactiveMs<=TOKEN_INACTIVE_IGNORE_MS){
          const sev=inactiveMs<=TOKEN_ACTIVE_ALERT_MS?'error':'warn';
          const diasAtivo=Math.round(inactiveMs/86400000);
          incidents.push({
            id:'tok_'+email, type:'token_expired', severity:sev, status:'open',
            robot:'OAuth / Gmail', module:'Autenticação',
            userEmail:email, name:u.name||email,
            title:'Token Gmail expirado',
            description:`Token expirou em ${new Date(u.cached_token_expiry).toLocaleString('pt-BR')}. Último acesso há ${diasAtivo}d. Automático parado.`,
            suggestedAction:'Solicite que o usuário acesse h2bapply.com e faça login novamente para renovar o token.',
            humanExplanation:'O acesso ao Gmail do usuário expirou. O sistema não consegue mais enviar e-mails em nome dele até que ele faça login novamente.',
            options:[
              {label:'Notificar usuário por email',action:'notify_auth_error'},
              {label:'Ignorar (usuário inativo)',action:'ignore'}
            ],
            createdAt:now
          });
          missions.push({
            id:'mis_tok_'+email, incidentId:'tok_'+email, type:'token', status:'pending',
            severity:sev, robot:'OAuth', userEmail:email,
            title:`Reativar token: ${u.name||email}`,
            action:'Peça ao usuário fazer login novamente em h2bapply.com'
          });
        }

        // ── paused_auth_error ────────────────────────────────────
        if((job?.status==='paused_auth_error'||u.autoStatus==='paused_auth_error')&&inactiveMs<=TOKEN_INACTIVE_IGNORE_MS){
          incidents.push({
            id:'auth_err_'+email, type:'oauth_expired', severity:'error', status:'open',
            robot:'Automático Gmail', module:'Autenticação',
            userEmail:email, name:u.name||email,
            title:'Automático pausado — erro de autenticação',
            description:`O robô automático de ${u.name||email} parou por erro de autenticação. Nenhum e-mail está sendo enviado.`,
            suggestedAction:'Envie notificação de reconexão. O usuário precisa fazer login novamente.',
            humanExplanation:'O Google recusou o acesso. Isso acontece quando o token expira ou o usuário revoga o acesso. Nenhuma ação automática pode ser tomada sem intervenção do usuário.',
            options:[
              {label:'Notificar usuário',action:'notify_auth_error'},
              {label:'Ignorar',action:'ignore'}
            ],
            createdAt:now
          });
        }

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

        // ── VIP vencido mas marcado ativo ────────────────────────
        if(u.vip&&u.vip.active){
          const exp=Math.max(u.vip.manualExpires||0,u.vip.autoExpires||0);
          if(exp>0&&exp<now){
            const diasVencido=Math.round((now-exp)/86400000);
            incidents.push({
              id:'vip_exp_'+email, type:'vip_expired', severity:'warn', status:'open',
              robot:'Robô Contábil', module:'Planos VIP',
              userEmail:email, name:u.name||email,
              title:'VIP vencido sem atualização',
              description:`Plano ${u.plan||'VIP'} de ${u.name||email} venceu há ${diasVencido} dia(s) em ${new Date(exp).toLocaleString('pt-BR')} mas a conta ainda aparece como ativa.`,
              suggestedAction:'Acesse VIP & Planos → ajuste o plano manualmente ou aguarde o robô contábil sincronizar.',
              humanExplanation:'O plano expirou mas o sistema ainda mostra o usuário como VIP ativo. Isso pode causar acesso indevido a funcionalidades pagas.',
              options:[
                {label:'Corrigir plano manualmente',action:'fix_vip'},
                {label:'Ignorar',action:'ignore'}
              ],
              createdAt:now
            });
            missions.push({
              id:'mis_vip_'+email, incidentId:'vip_exp_'+email, type:'vip', status:'pending',
              severity:'warn', robot:'Robô Contábil', userEmail:email,
              title:`Corrigir plano: ${u.name||email}`,
              action:'Vá em VIP & Planos → ajuste o plano manualmente'
            });
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

  // ── M01: Health summary rápido ───────────────────────────
  if(pathname==="/api/admin/health-summary"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    const now=Date.now();
    const users=Object.values(DB_USERS||{});
    const authErrUsers=Object.entries(DB_AUTO||{}).filter(([,j])=>j?.status==="paused_auth_error").map(([e])=>e);
    const pendCriticos=(DB_PEDIDOS||[]).filter(pd=>pd.status==="pendente"&&(now-(pd.createdAt||0))>24*3600_000);
    const vipExpiring=users.filter(u=>{const exp=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);return exp>0&&exp>now&&exp<now+3*86400_000;});
    return json(res,200,{ok:true,score:authErrUsers.length===0&&pendCriticos.length===0?100:Math.max(60,100-authErrUsers.length*5-pendCriticos.length*10),authErrCount:authErrUsers.length,pedidosCriticos:pendCriticos.length,vipExpiring:vipExpiring.length,totalUsers:users.length,activeAuto:Object.values(DB_AUTO||{}).filter(j=>j?.active).length,timestamp:now});
  }

  // ── M02: Notificar TODOS com auth_error de uma vez ───────
  if(pathname==="/api/admin/notify-all-auth-error"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    const authErrEmails=Object.entries(DB_AUTO||{}).filter(([,j])=>j?.status==="paused_auth_error").map(([e])=>e);
    let sent=0;const failed=[];
    for(const email of authErrEmails){
      try{await sendNotifEmail(email,"auth_error");sent++;await new Promise(r=>setTimeout(r,2000));}
      catch(e){failed.push(email);}
    }
    console.log(`[admin] notify-all-auth-error: ${sent} enviados, ${failed.length} falhas por ${s.user_email}`);
    return json(res,200,{ok:true,sent,failed,total:authErrEmails.length});
  }

  // ── M03: Log de ações admin ───────────────────────────────
  if(!global._adminActionLog)global._adminActionLog=[];
  if(pathname==="/api/admin/action-log"&&req.method==="GET"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    if(!isAdminEmail(s.user_email))return json(res,403,{error:"Apenas admins."});
    return json(res,200,{ok:true,log:global._adminActionLog.slice(0,100)});
  }

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
    const inboxEmails=new Set((INBOX_EMAILS||[]).map(e=>(e.from||"").toLowerCase()));
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
      gastos:     DB_FINANCEIRO.gastos||[],
    };
    return json(res,200,{ok:true,financeiro:slim,pagamentos:slim.pagamentos,gastos:slim.gastos});
  }
  if(pathname==="/api/admin/financeiro"&&req.method==="POST"){
    const s=getSess(req);if(!s?.user_email)return json(res,401,{error:"Não autenticado."});
    const p=getUser(s.user_email);if(!isAdminVip(p))return json(res,403,{error:"Acesso negado."});
    try{
      const d=JSON.parse(await readBody(req));
      // SEGURANÇA: nunca substitui arrays completos — só adiciona/atualiza itens
      if(d.action==='add_pagamento' && d.pagamento){
        // Adicionar um pagamento individual
        const pg=d.pagamento;
        if(!pg.id) pg.id='fin_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!pg.criadoEm) pg.criadoEm=Date.now();
        DB_FINANCEIRO.pagamentos=DB_FINANCEIRO.pagamentos||[];
        DB_FINANCEIRO.pagamentos.unshift(pg);
        persistFinanceiro();
        return json(res,200,{ok:true,id:pg.id});
      }
      if(d.action==='add_gasto' && d.gasto){
        // Adicionar um gasto individual
        const gs=d.gasto;
        if(!gs.id) gs.id='gst_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
        if(!gs.criadoEm) gs.criadoEm=Date.now();
        DB_FINANCEIRO.gastos=DB_FINANCEIRO.gastos||[];
        DB_FINANCEIRO.gastos.unshift(gs);
        persistFinanceiro();
        return json(res,200,{ok:true,id:gs.id});
      }
      if(d.action==='delete_pagamento' && d.id){
        DB_FINANCEIRO.pagamentos=(DB_FINANCEIRO.pagamentos||[]).filter(x=>x.id!==d.id);
        persistFinanceiro();
        return json(res,200,{ok:true});
      }
      if(d.action==='delete_gasto' && d.id){
        DB_FINANCEIRO.gastos=(DB_FINANCEIRO.gastos||[]).filter(x=>x.id!==d.id);
        persistFinanceiro();
        return json(res,200,{ok:true});
      }
      // Legado: substituição completa (mantido para compatibilidade interna)
      if(d._replace===true){
        if(d.pagamentos!==undefined)DB_FINANCEIRO.pagamentos=d.pagamentos||[];
        if(d.gastos!==undefined)DB_FINANCEIRO.gastos=d.gastos||[];
      }
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
          let adminToken=null;
          // Tentar token de sessão ativa do admin
          const adminSessEntry=Object.values(sessions).find(ss=>ss.user_email===ADMIN_EMAIL&&ss.access_token);
          adminToken=adminSessEntry?.access_token;
          // Se não tem token de sessão, tentar refresh
          if(!adminToken){try{adminToken=await refreshTokenForUser(ADMIN_EMAIL);}catch{}}
          if(adminToken){
            const emailSubject=`💳 Novo pedido de plano — ${pedido.userName||pedido.userEmail} quer ${pedido.plano} por ${pedido.dias}d`;
            const emailText=`💳 NOVO PEDIDO DE PLANO RECEBIDO!

👤 Usuário: ${pedido.userName||"?"}
📧 Email: ${pedido.userEmail||"?"}
📱 WhatsApp: ${pedido.userWhatsapp||"?"}
🏙️ Cidade: ${pedido.userCity||"?"}

📦 Plano: ${pedido.plano.toUpperCase()} — ${pedido.dias} dias — R$${pedido.valorTotal}${pedido.desconto>0?" ("+pedido.desconto+"% desconto)":""}
📝 Nota: ${pedido.nota||"Sem observação"}
🆔 Pedido: #${pedido.id.slice(-8).toUpperCase()}
⏰ Recebido: ${new Date().toLocaleString("pt-BR")}
${pedido.comprovante?"📸 Comprovante: ANEXADO a este email":"⚠️ Comprovante: NÃO enviado ainda"}

✅ Para ativar: h2bapply.com/ad → Pedidos de Plano → Ativar
${pedido.criadoPor&&pedido.criadoPor!==pedido.userEmail?`\n🛠️ Registrado retroativamente por admin: ${pedido.criadoPor}`:""}

— Sistema H2BApply`;

            // Preparar anexo do comprovante se existir
            let attachments = [];
            if(pedido.comprovante && typeof pedido.comprovante === "string" && pedido.comprovante.startsWith("data:")){
              try{
                // Extrair base64 puro do data URL
                const matches = pedido.comprovante.match(/^data:([^;]+);base64,(.+)$/);
                if(matches){
                  const mimeType = matches[1]; // ex: image/jpeg
                  const base64Data = matches[2];
                  const ext = mimeType.includes("pdf")?"pdf":mimeType.includes("png")?"png":"jpg";
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
                  fromEmail:ADMIN_EMAIL,
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
    return json(res,200,{ok:true,pedido:pd});
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
        const EDITOR_PASS={andrew:"84800-54",diego:"Diego2026"};
        const editorKey=Object.keys(EDITOR_PASS).find(k=>EDITOR_PASS[k]===d.editorPassword);
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

        // Calcular expiração acumulando sobre o existente
        const now=Date.now();
        const tgt=getUser(pd.userEmail)||{};
        const curManual=(tgt.vip?.manualExpires&&tgt.vip.manualExpires>now)?tgt.vip.manualExpires:now;
        const curAuto=(tgt.vip?.autoExpires&&tgt.vip.autoExpires>now)?tgt.vip.autoExpires:now;
        const manualExpires=curManual+diasTotal*86400_000;
        const autoExpires=["vipro","doublepro"].includes(planoKey)?curAuto+diasTotal*86400_000:(tgt.vip?.autoExpires||0);

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

        // Bônus de indicação
        try{
          const refKey=`ref:${pd.userEmail}`;
          const refData=DB_USERS[refKey];
          if(refData?.ownerEmail&&diasBase>=30){
            const owner=getUser(refData.ownerEmail);
            if(owner){const nowR=Date.now();const curExp=Math.max(nowR,owner.vip?.manualExpires||0);
              setUser(refData.ownerEmail,{vip:{...(owner.vip||{}),active:true,manualExpires:curExp+5*86400_000,activatedAt:nowR,note:"Bônus indicação compra +5d"}});
              console.log(`[ref] +5d para ${refData.ownerEmail} por compra de ${pd.userEmail}`);
            }
          }
        }catch(eR){console.warn("[ref]",eR.message);}

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
    return json(res,200,{connected:true,email:s.user_email,name:p.name||s.user_name,picture:p.picture||s.picture||"",country:p.country||"Brazil",phone:p.phone||"",whatsapp:p.whatsapp||"",cc:p.cc||"",city:p.city||"",language:p.language||"pt-BR",rankName:p.rankName||"",appAvatarId:p.appAvatarId||"",h2bProfile:p.h2bProfile||{},age:p.age||0,isAdmin:!!p.isAdmin,plan:planKey,totalSent,totalManual,totalAutoHist,totalReplies,vip:p.vip?{active:vipOk,expiresAt:p.vip.expiresAt||Math.max(p.vip.manualExpires||0,p.vip.autoExpires||0),activatedAt:p.vip.activatedAt,days:p.vip.days||30,plan:p.vip.plan||"vip",manualExpires:p.vip.manualExpires||0,autoExpires:p.vip.autoExpires||0,manualActive:isManualVipActive(p),autoActive:isAutoVipActive(p)}:null,todaySentManual:sentManual,manualLimit,manualRemaining:Math.max(0,manualLimit-sentManual),todaySentAuto:sentAuto,autoLimit,autoRemaining:Math.max(0,autoLimit-sentAuto),autoEnabled:true,autoJob:autoJob?{active:autoJob.active,status:autoJob.status,queueSize:autoJob.queue?.length||0,source:autoJob.source,startedAt:autoJob.startedAt,lastSentAt:autoJob.lastSentAt,nextSendAt:autoJob.nextSendAt,currentJob:autoJob.currentJob,originalCount:autoJob.originalCount}:null,autoStats:stats,cvs:(p.cvs||[]).map(c=>({idx:c.idx,name:c.name,size:c.size,date:c.date,cvType:c.cvType||"resume"})),settings:p.settings||{},onboarded:!!p.onboarded,adminMessage:p.adminMessage||null,readEmailIds:p.readEmailIds||[],profiles:p.profiles||[],senderEmails:(p.senderEmails||[]).map(s=>({email:s.email,label:s.label||"",active:s.active!==false,tokenExpired:!!s.tokenExpired,blocked:!!s.blocked,addedAt:s.addedAt})),senderMax:getMaxSenders(p),adminSettings:isAdminVip(p)?{intervalSecs:(p.adminSettings?.intervalSecs||180),senderLimits:(p.adminSettings?.senderLimits||{}),maxSenders:getMaxSenders(p)}:null});
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

      const attachments=[];const getAtt=async idx=>{if(!idx)return null;const m=p.cvs?.find(c=>c.idx===parseInt(idx,10));return m&&loadCv(s.user_email,m.idx)?{data:loadCv(s.user_email,m.idx),name:m.name}:null;};
      if(!isReply){// Anexos só em candidaturas originais
        if(d.resumeIdx){const a=await getAtt(d.resumeIdx);if(a)attachments.push(a);}else if(d.pdfBase64){attachments.push({data:d.pdfBase64,name:d.pdfName||"resume.pdf"});}
        if(d.coverIdx){const a=await getAtt(d.coverIdx);if(a)attachments.push(a);}
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

    hist.forEach(h=>{
      const cn  = h.caseNum||"";
      const src = h.sheetSource||"";
      const id  = h.jobId||h.id||"";

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
      const src = autoJob.source || "";
      if(src==="jan2026"||cn.startsWith("H-4")||cn.startsWith("H-5")) sentJan.add(id);
      else if(src==="jul2025"||cn.startsWith("H-3")) sentJul.add(id);
      else sentSeasonal.add(id);
    });

    return json(res,200,{
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
        console.log(`[auto] ✅ ${queue.length} vagas com email de ${d.cases.length} cases (${noEmailCount} sem email ignoradas)`);
      }
      if(!queue.length)return json(res,400,{error:"Nenhuma vaga com e-mail encontrada. As planilhas JAN2026 e JUL2025 já têm e-mails embutidos. Verifique se os arquivos foram carregados corretamente.",noEmail:true});
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
      // mode removido — sempre 24/7
const job={active:true,startedAt:Date.now(),queue,originalCount:queue.length,filteredCount:queue.length,resumeIdx:jobResumeIdx,coverIdx:jobCoverIdx,bodyTemplate:d.bodyTemplate||p.settings?.body||"",subjects:Array.isArray(d.subjects)&&d.subjects.length?d.subjects:null,emailBodies:Array.isArray(d.emailBodies)&&d.emailBodies.length?d.emailBodies:null,status:"starting",lastSentAt:null,finishedAt:null,source:d.source||"manual",category:d.category||"all",filters:d.filters||{},queueFingerprint,rotState:{lastSubjIdx:-1,lastBodyIdx:-1},lockedAutoLimit:isAdminVip(p)?9999:getAutoLimit(p)};
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
      console.log(`[admin] ✅ Ativou ${planName} → ${d.email} (manual:${days}d→${new Date(manualExpires).toLocaleDateString('pt-BR')} auto:${autoDays}d→${autoExpires>now?new Date(autoExpires).toLocaleDateString('pt-BR'):'–'})`);

      // Bônus de indicação
      try{
        const refKey=`ref:${d.email}`;
        const refData=DB_USERS[refKey];
        if(refData?.ownerEmail&&days>=30){
          const ownerEmail=refData.ownerEmail;
          const owner=getUser(ownerEmail);
          if(owner){
            const nowR=Date.now();
            const curExp=Math.max(nowR,owner.vip?.manualExpires||0);
            setUser(ownerEmail,{vip:{...(owner.vip||{}),active:true,manualExpires:curExp+5*86400_000,activatedAt:nowR,note:"Bônus indicação compra +5d"}});
            console.log(`[ref] Bônus +5d para ${ownerEmail} por compra de ${d.email}`);
          }
        }
      }catch(e2){console.warn("[ref] erro bônus:",e2.message);}

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
    (finByEmail[e]=finByEmail[e]||[]).push({valor:parseVal(pg.valor),date:toTs(pg.dataPagamento)||toTs(pg.data)||pg.criadoEm||null});
  }
  // Pedidos pagos/ativos (fallback) por email
  const pedByEmail={};
  for(const ped of Object.values(DB_PEDIDOS||{})){
    if(!ped||!ped.userEmail)continue;
    const st=String(ped.status||"").toLowerCase();
    if(st!=="pago"&&st!=="ativo")continue;
    const e=String(ped.userEmail).toLowerCase();
    (pedByEmail[e]=pedByEmail[e]||[]).push({valor:parseVal(ped.valorTotal),date:ped.ativadoEm||ped.pagoEm||ped.createdAt||null});
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
        const EDITOR_PASSWORDS={andrew:"84800-54",diego:"Diego2026"};
        const editorKey=Object.keys(EDITOR_PASSWORDS).find(k=>EDITOR_PASSWORDS[k]===d.editorPassword);
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
        const EDITOR_PASSWORDS={andrew:"84800-54",diego:"Diego2026"};
        const editorKey=Object.keys(EDITOR_PASSWORDS).find(k=>EDITOR_PASSWORDS[k]===editorPassword);
        if(editorKey){
          setUser(d.email,{lastValidatedAt:now,lastValidatedBy:editorKey==="andrew"?"Andrew":"Diego",lastValidationResult:result.status});
        }
        return json(res,200,{ok:true,result,dossiePagamento});
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
    return json(res,200,{totalUsers,vipUsers,todaySent,todayAuto,totalSent,totalAuto,trialEnabled:true,trialDays:5,rankPreview:rankPreview.slice(0,5)});
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
    return json(res,200,{
      name:found.rankName||found.name||"Usuário",
      picture:found.appAvatarId?"":found.picture||"",
      appAvatarId:found.appAvatarId||"",
      plan:getPlan(found),
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
- DB_REFERRAL: indicações (indicador +5 dias; +5 se o amigo assinar).
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
- Usuário (index.html): home, vagas, pesquisa, salvas, enviadas, respostas, perfil/currículos, automático, planos, ranking, indicar, notificações, resgatar, tutorial, IA chat, sugestões.
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
//  TOKEN GUARDIAN — garante que o refresh_token NUNCA deixe
//  o automático parar. Roda a cada 15min.
//
//  O refresh_token do Google NÃO expira (é permanente enquanto
//  o usuário não revogar o acesso no painel Google).
//  O access_token expira em 1h — por isso renovamos de 15 em 15min.
//
//  Renova para: jobs ativos + jobs aguardando limite/horário
//  (eles vão precisar do token logo quando o timer disparar)
// ══════════════════════════════════════════════════════════
async function tokenGuardianRun() {
  const NEEDS_TOKEN = new Set(["sending","starting","waiting_interval","waiting_limit","waiting_rate_limit","recovered","resuming","recovering"]);
  const emails = Object.entries(DB_AUTO)
    .filter(([,j]) => j.active || NEEDS_TOKEN.has(j.status))
    .map(([e]) => e);

  for (const email of emails) {
    const u = getUser(email);
    if (!u?.refresh_token) {
      // Sem refresh_token — pausa definitivamente (nunca vai conseguir enviar)
      const job = getAutoJob(email);
      if (job?.active) {
        console.warn(`[token-guardian] ❌ ${email}: sem refresh_token — pausando job`);
        setAutoJob(email, {...job, active:false, status:"paused_no_refresh_token"});
        if (autoTimers.has(email)) { clearTimeout(autoTimers.get(email)); autoTimers.delete(email); }
        addLog(email, {status:"pausado", jobTitle:"🔐 Sem token de autenticação", company:"Faça login novamente no H2BApply para reativar o envio automático.", error:"Nenhum refresh_token disponível"});
      }
      continue;
    }
    const expiry = Number.isFinite(u.cached_token_expiry) ? u.cached_token_expiry : 0;
    // Renova se não tem token OU falta menos de 45min para expirar OU expiry inválido
    if (!u.cached_access_token || !expiry || Date.now() > expiry - 45*60*1000) {
      try {
        await refreshTokenForUser(email);
        console.log(`[token-guardian] ✅ Token renovado: ${email}`);
      } catch(e) {
        const msg = e.message || "";
        // invalid_grant = usuário revogou acesso no Google → único caso onde para definitivamente
        if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked")) {
          const job = getAutoJob(email);
          if (job?.active) {
            setAutoJob(email, {...job, active:false, status:"paused_token_revoked"});
            if (autoTimers.has(email)) { clearTimeout(autoTimers.get(email)); autoTimers.delete(email); }
            addLog(email, {status:"pausado", jobTitle:"🔐 Acesso Google revogado pelo usuário", company:"O usuário removeu o acesso do H2BApply no painel Google. Faça login novamente para reativar.", error: msg});
            // Notifica usuário por email para que saiba que precisa fazer login novamente
            sendNotifEmail(email, "token_revoked").catch(e => console.warn("[notif/token_revoked/guardian]", e.message));
          }
        }
        // Outros erros (rede, timeout) → tenta de novo no próximo ciclo
        console.warn(`[token-guardian] ⚠️ ${email}:`, msg);
      }
    }
  }
}
setInterval(tokenGuardianRun, 10 * 60 * 1000); // a cada 10 minutos (era 15)

// ── Watchdog de VIP expirado — para automático de quem não pagou ────────────
// Roda a cada hora. Para qualquer job ativo de usuário sem plano auto válido.
// Essa é a rede de segurança contra trial que continua rodando após expirar.
async function vipExpiryWatchdog(){
  const now = Date.now();
  let stopped = 0;
  for(const [email, job] of Object.entries(DB_AUTO)){
    if(!job?.active) continue;
    const u = getUser(email);
    if(!u) continue;
    if(isAdminVip(u)) continue; // admin nunca para
    if(isAutoVipActive(u)) continue; // VIP ativo = ok
    // VIP expirou e job ainda ativo → parar agora
    if(autoTimers.has(email)){clearTimeout(autoTimers.get(email));autoTimers.delete(email);}
    setAutoJob(email,{...job,active:false,status:"paused_no_vip",finishedAt:now});
    addLog(email,{status:"pausado",jobTitle:"⛔ Automático pausado — plano expirado",company:"Renove seu plano VIPro para continuar o envio automático.",error:"Plano auto expirado"});
    console.log(`[vip-watchdog] ⛔ ${email} sem plano auto — job parado`);
    stopped++;
  }
  if(stopped>0) console.log(`[vip-watchdog] Parou ${stopped} job(s) de usuários sem plano`);
}
setInterval(()=>vipExpiryWatchdog().catch(e=>console.error("[vip-watchdog]",e.message)), 15*60*1000); // a cada 15min (v9: reduzido de 1h)

// ── Watchdog de paused_auth_error — notifica usuário após 12h parado ─────────
// Roda a cada 3h. Se job parado por auth_error há >12h e usuário ativo ≤30 dias,
// envia email de notificação automática pedindo para reconectar o Gmail.
const _authErrNotifiedAt = {}; // {email: timestamp} — cooldown de 24h por usuário
async function authErrorWatchdog(){
  const now = Date.now();
  let notified = 0;
  for(const [email, job] of Object.entries(DB_AUTO)){
    if(!job?.active && job?.status==="paused_auth_error"){
      const pausedAt = job.finishedAt || job.lastSentAt || 0;
      const pausedMs = now - pausedAt;
      if(pausedMs < 12*3600_000) continue; // menos de 12h — ainda cedo
      const lastNotif = _authErrNotifiedAt[email] || 0;
      if(now - lastNotif < 22*3600_000) continue; // já notificou nas últimas 22h
      const u = getUser(email);
      if(!u) continue;
      const diasInativo = Math.round((now-(u.lastSeenAt||0))/86400000);
      if(diasInativo > 30) continue; // usuário inativo >30 dias — não notifica
      try{
        await sendNotifEmail(email, "auth_error");
        _authErrNotifiedAt[email] = now;
        notified++;
        console.log(`[auth-watchdog] 📧 Notificado ${email} sobre paused_auth_error (${Math.round(pausedMs/3600000)}h parado)`);
      }catch(e){ console.warn(`[auth-watchdog] erro notif ${email}:`, e.message); }
      await new Promise(r=>setTimeout(r,2000)); // pausa entre emails
    }
  }
  if(notified>0) console.log(`[auth-watchdog] ✅ ${notified} usuários notificados sobre auth_error`);
}
setInterval(()=>authErrorWatchdog().catch(e=>console.error("[auth-watchdog]",e.message)), 3*60*60*1000); // a cada 3h

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

// Calcula ranking de usuários por período e categoria
// Score = auto + manual (respostas NÃO contam — são recebidas, não enviadas)
function calcRanking(period, category, myEmail) {
  const rows = [];
  for (const [email, user] of Object.entries(DB_USERS)) {
    if (DB_RANK_HIDDEN[email]) continue;
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

    const score = category === "responses" ? replies
                : category === "active"    ? sends + replies * 2
                : sends; // default: total enviados (auto+manual)

    if (score === 0 && period !== "all") continue;
    if (totS + totR === 0 && period === "all") continue;
    rows.push({
      email,
      name: user.rankName || user.name || "Usuário",
      picture: user.appAvatarId ? "" : (user.picture || ""),
      appAvatarId: user.appAvatarId || "",
      plan: getPlan(user),
      sends,       // auto + manual no período
      autoSends,   // só auto no período
      manualSends, // só manual no período
      responses: replies,
      totalSends: totS, totalAutoSends: totAutoSends, totalManualSends: totManualSends,
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
      pos, name: r.name, picture: r.picture, appAvatarId: r.appAvatarId||"", plan: r.plan,
      sends: r.sends, autoSends: r.autoSends, manualSends: r.manualSends,
      responses: r.responses, totalSends: r.totalSends,
      totalAutoSends: r.totalAutoSends, totalManualSends: r.totalManualSends,
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
function persistPedidos() { try{const tmp=PEDIDOS_FILE+".tmp";require("fs").writeFileSync(tmp,JSON.stringify(DB_PEDIDOS,null,2));require("fs").renameSync(tmp,PEDIDOS_FILE);}catch(e){console.warn("[pedidos]",e.message);} }
function persistFinanceiro() {
  try{
    // Salva sem imagens base64 inline para não explodir o arquivo
    // As imagens ficam como referência de pedido (já persistidas nos pedidos)
    const tmp=FINANCEIRO_FILE+".tmp";
    require("fs").writeFileSync(tmp,JSON.stringify(DB_FINANCEIRO,null,2));
    require("fs").renameSync(tmp,FINANCEIRO_FILE);
  }catch(e){console.warn("[financeiro]",e.message);}
}

// ── BOOT ─────────────────────────────────────────────────
boot();loadSheets();

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

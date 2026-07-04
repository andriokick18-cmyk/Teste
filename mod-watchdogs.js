/* ═══════════════════════════════════════════════════════════════════════
   🐕 src/watchdogs.js — Fase 1 · Módulo 4 (extraído do server.js)
   tokenGuardianRun + vipExpiryWatchdog (no-op intencional, KB-860) +
   authErrorWatchdog. Injeção de dependências no molde do sentinel.js:
   getters para estado reatribuível (DB_AUTO, autoTimers).
   startIntervals=false permite testar sem timers pendurados.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

function initWatchdogs(ctx, { startIntervals = true } = {}){
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
  const emails = Object.entries(ctx.DB_AUTO())
    .filter(([,j]) => j.active || NEEDS_TOKEN.has(j.status))
    .map(([e]) => e);

  for (const email of emails) {
    const u = ctx.getUser(email);
    if (!u?.refresh_token) {
      // Sem refresh_token — pausa definitivamente (nunca vai conseguir enviar)
      const job = ctx.getAutoJob(email);
      if (job?.active) {
        console.warn(`[token-guardian] ❌ ${email}: sem refresh_token — pausando job`);
        ctx.setAutoJob(email, {...job, active:false, status:"paused_no_refresh_token"});
        if (ctx.autoTimers().has(email)) { clearTimeout(ctx.autoTimers().get(email)); ctx.autoTimers().delete(email); }
        ctx.addLog(email, {status:"pausado", jobTitle:"🔐 Sem token de autenticação", company:"Faça login novamente no H2BApply para reativar o envio automático.", error:"Nenhum refresh_token disponível"});
      }
      continue;
    }
    const expiry = Number.isFinite(u.cached_token_expiry) ? u.cached_token_expiry : 0;
    // Renova se não tem token OU falta menos de 45min para expirar OU expiry inválido
    if (!u.cached_access_token || !expiry || Date.now() > expiry - 45*60*1000) {
      try {
        await ctx.refreshTokenForUser(email);
        console.log(`[token-guardian] ✅ Token renovado: ${email}`);
      } catch(e) {
        const msg = e.message || "";
        // invalid_grant = usuário revogou acesso no Google → único caso onde para definitivamente
        if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked")) {
          const job = ctx.getAutoJob(email);
          if (job?.active) {
            ctx.setAutoJob(email, {...job, active:false, status:"paused_token_revoked"});
            if (ctx.autoTimers().has(email)) { clearTimeout(ctx.autoTimers().get(email)); ctx.autoTimers().delete(email); }
            ctx.addLog(email, {status:"pausado", jobTitle:"🔐 Acesso Google revogado pelo usuário", company:"O usuário removeu o acesso do H2BApply no painel Google. Faça login novamente para reativar.", error: msg});
            // Notifica usuário por email para que saiba que precisa fazer login novamente
            ctx.sendNotifEmail(email, "token_revoked").catch(e => console.warn("[notif/token_revoked/guardian]", e.message));
          }
        }
        // Outros erros (rede, timeout) → tenta de novo no próximo ciclo
        console.warn(`[token-guardian] ⚠️ ${email}:`, msg);
      }
    }
  }
}


// ── Watchdog de VIP expirado — para automático de quem não pagou ────────────
// Roda a cada hora. Para qualquer job ativo de usuário sem plano auto válido.
// Essa é a rede de segurança contra trial que continua rodando após expirar.
// Rede de segurança: NÃO para mais por falta de plano (regra: 10 auto/dia
// grátis para todos). O limite diário (getAutoLimit=10 p/ free) já regula no
// agendador via "waiting_limit". Mantido só como no-op/observação para não
// re-pausar jobs de quem não tem VIP a cada 15 min (o que desfazia o fix).
async function vipExpiryWatchdog(){
  // Intencionalmente vazio quanto a parar por VIP: todos têm 10 automáticos/dia.
  // (Se um dia precisar de outra rede de segurança, adicionar aqui SEM parar
  // por ausência de plano.)
  return;
}


// ── Watchdog de paused_auth_error — notifica usuário após 12h parado ─────────
// Roda a cada 3h. Se job parado por auth_error há >12h e usuário ativo ≤30 dias,
// envia email de notificação automática pedindo para reconectar o Gmail.
const _authErrNotifiedAt = {}; // {email: timestamp} — cooldown de 24h por usuário
async function authErrorWatchdog(){
  const now = Date.now();
  let notified = 0;
  for(const [email, job] of Object.entries(ctx.DB_AUTO())){
    if(!job?.active && job?.status==="paused_auth_error"){
      const pausedAt = job.finishedAt || job.lastSentAt || 0;
      const pausedMs = now - pausedAt;
      if(pausedMs < 12*3600_000) continue; // menos de 12h — ainda cedo
      const lastNotif = _authErrNotifiedAt[email] || 0;
      if(now - lastNotif < 22*3600_000) continue; // já notificou nas últimas 22h
      const u = ctx.getUser(email);
      if(!u) continue;
      const diasInativo = Math.round((now-(u.lastSeenAt||0))/86400000);
      if(diasInativo > 30) continue; // usuário inativo >30 dias — não notifica
      try{
        await ctx.sendNotifEmail(email, "auth_error");
        _authErrNotifiedAt[email] = now;
        notified++;
        console.log(`[auth-watchdog] 📧 Notificado ${email} sobre paused_auth_error (${Math.round(pausedMs/3600000)}h parado)`);
      }catch(e){ console.warn(`[auth-watchdog] erro notif ${email}:`, e.message); }
      await new Promise(r=>setTimeout(r,2000)); // pausa entre emails
    }
  }
  if(notified>0) console.log(`[auth-watchdog] ✅ ${notified} usuários notificados sobre auth_error`);
}


  if (startIntervals) {
    setInterval(tokenGuardianRun, 10 * 60 * 1000); // a cada 10 minutos (era 15)
    setInterval(()=>vipExpiryWatchdog().catch(e=>console.error("[vip-watchdog]",e.message)), 15*60*1000);
    setInterval(()=>authErrorWatchdog().catch(e=>console.error("[auth-watchdog]",e.message)), 3*60*60*1000); // a cada 3h
  }
  return { tokenGuardianRun, vipExpiryWatchdog, authErrorWatchdog, getAuthErrNotifiedAt: ()=>_authErrNotifiedAt };
}
module.exports = { initWatchdogs };

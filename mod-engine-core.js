/* ═══════════════════════════════════════════════════════════════════════
   ⏱️ src/engine/core.js — Fase 1 · Módulo 6 (extraído do server.js)
   O núcleo TESTÁVEL do motor de envio:
   - calcSmartInterval: o intervalo "humanizado" (5-6min c/ jitter) que
     protege as contas Gmail dos usuários — a função mais crítica do produto
   - Timezone BRT (UTC-3 fixo): nowBRT, todayStrBRT, toLocaleBRT
   - calcStreak / last7Days: métricas de constância do ranking
   scheduleAuto (a máquina de estados completa, 100% acoplada) permanece
   no server.js — extração dela exige reescrita guiada, não mecânica.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

// ── Intervalo humanizado entre envios ─────────────────────────────────────
// createCalcSmartInterval(deps) → calcSmartInterval(email)
// deps: { getUser, isAdminVip } — admins podem ter intervalo custom (min 30s)
function createCalcSmartInterval({ getUser, isAdminVip }){
  return function calcSmartInterval(email) {
    // Verificar configuração personalizada do admin
    if (email) {
      const u = getUser(email);
      if (u && isAdminVip(u) && u.adminSettings?.intervalSecs) {
        const secs = Math.max(30, parseInt(u.adminSettings.intervalSecs) || 180);
        const jitter = secs * 0.15; // ±15% de variação
        return (secs + (Math.random() * 2 - 1) * jitter) * 1000;
      }
    }
    const MIN_MS = 5 * 60 * 1000; // 5 minutos
    const MAX_MS = 6 * 60 * 1000; // 6 minutos
    return MIN_MS + Math.random() * (MAX_MS - MIN_MS);
  };
}

// ── Timezone BRT — UTC-3 fixo (sem horário de verão no Brasil) ───────────
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

// ── Métricas de constância (ranking) ──────────────────────────────────────
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
    r.push(h.filter(x => x.dateStr === ds).length);
  }
  return r;
}

module.exports = { createCalcSmartInterval, nowBRT, todayStrBRT, toLocaleBRT, calcStreak, last7Days };

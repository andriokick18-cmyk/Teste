#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  H2BApply — Regularizar clientes PAGANTES (financeiro + PLANO)
//
//  ⚠️ v2 (28/06/2026) — CORREÇÃO CRÍTICA DE 2 BUGS:
//   1) ARQUIVO ERRADO: a v1 lia/gravava "h2b_users.json" (alias morto).
//      O server.js lê "users.json". Resultado: nada do que a v1 escrevia
//      chegava ao servidor. CORRIGIDO → grava em users.json (e mantém o
//      alias h2b_users.json sincronizado por segurança).
//   2) PLANO NÃO ERA CONCEDIDO: a v1 só gravava metadados financeiros
//      (financialStatus, paymentAmount...) mas NUNCA o direito VIP
//      (vip.manualExpires / vip.autoExpires / plan). Por isso, após o
//      reset, os pagantes ficavam presos no trial de 1 dia (VIP Manual,
//      auto 0/10, "plano expirou"). CORRIGIDO → concede o plano real.
//
//  USO: node update_clientes_pagantes.js
//  Executar no Render Shell e depois reiniciar o servidor.
//  Idempotente: rodar 2x não duplica dias nem créditos.
// ═══════════════════════════════════════════════════════════
"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
const USERS_FILE  = path.join(DATA_DIR, "users.json");        // ✅ FILE que o server.js realmente lê
const USERS_ALIAS = path.join(DATA_DIR, "h2b_users.json");    // alias legado — mantido em sincronia
const AUTO_FILE   = path.join(DATA_DIR, "auto_jobs.json");    // jobs de envio automático

const DAY = 86400_000;
const PLAN_DAYS = 30; // todos os pagantes desta leva: 30 dias

console.log(`\n[update] DATA_DIR:   ${DATA_DIR}`);
console.log(`[update] Users file: ${USERS_FILE}`);

if (!fs.existsSync(USERS_FILE)) {
  console.error("[update] ❌ users.json não encontrado! O servidor já rodou pelo menos uma vez?");
  process.exit(1);
}

// Ler usuários
let DB_USERS = {};
try {
  DB_USERS = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
} catch(e) {
  console.error("[update] ❌ Erro ao ler users.json:", e.message);
  process.exit(1);
}

// Ler jobs automáticos (para limpar "plano expirou" dos VIPro)
let DB_AUTO = {};
let autoLoaded = false;
try {
  if (fs.existsSync(AUTO_FILE)) { DB_AUTO = JSON.parse(fs.readFileSync(AUTO_FILE, "utf8")); autoLoaded = true; }
} catch(e) {
  console.warn("[update] ⚠️ Não consegui ler auto_jobs.json (segue sem limpar jobs):", e.message);
}

// ═══════════════════════════════════════════════════════════
// CLIENTES PAGANTES — dados confirmados pelo Andrio em 27/06/2026
// Recebimentos totais: R$1.319,90 | Gastos: R$466,01 | Lucro: R$853,89
//   plano "vipro" → manual 200/dia + auto 200/dia (30d)
//   plano "vip"   → manual 200/dia (30d), sem automático
// ═══════════════════════════════════════════════════════════
const CLIENTES = [
  { email:"italoleal812@gmail.com",         nome:"Ítalo Almeida Leal",             valor:150.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"esdras.silva.h2b@gmail.com",     nome:"Esdras Alberto da Silva",        valor:150.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"sw26wagnersilva@gmail.com",      nome:"Wagner Silva da Silva",          valor:150.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"maykoncanalgg@gmail.com",        nome:"Maykon de Souza Nobrega",        valor:100.00,  plano:"vip",   nota:"VIP Manual 30d — confirmado Diego 27/06/2026" },
  { email:"jonatafontela07@gmail.com",      nome:"Jonata Fontela Dutra",           valor:150.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"itallofeitoza1993@gmail.com",    nome:"Itallo Jailson Feitoza",         valor:150.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"regianegoncalves.rgs@gmail.com", nome:"Regiane Gonçalves dos Santos",   valor:100.00,  plano:"vip",   nota:"VIP Manual 30d — confirmado Diego 27/06/2026" },
  { email:"bruno.j.lange@gmail.com",        nome:"Bruno Luis Jara Lange",          valor:120.00,  plano:"vipro", nota:"VIPro 30d R$120 (desconto) — confirmado Diego 27/06/2026" },
  { email:"enggustavomachado93@gmail.com",  nome:"Gustavo Amaral Machado",         valor:100.00,  plano:"vipro", nota:"VIPro 30d — confirmado Diego 27/06/2026" },
  { email:"jose.camilo.jobs@gmail.com",     nome:"José Camilo Rodrigues",          valor:149.90,  plano:"vipro", nota:"VIPro 30d R$149,90 — confirmado Diego 27/06/2026" },
];

// Contexto financeiro geral
const RESUMO_FINANCEIRO = {
  totalRecebido: 1319.90, totalGastos: 466.01, lucroLiquido: 853.89,
  parteAndrio: 426.95, parteDiego: 426.95, periodo: "jun/2026",
  gastos: "Claude + ChatGPT + Hostinger + Render = R$466,01",
};

const now = Date.now();
let atualizados = 0;
let planosConcedidos = 0;
let jobsLimpos = 0;
let naoEncontrados = [];

// status de job que devem ser "destravados" quando o plano volta a valer
const PAUSE_STATES_TO_CLEAR = ["paused_no_vip","paused_auth_error","paused_oauth_expired","paused_no_session","paused"];

console.log(`\n[update] Regularizando ${CLIENTES.length} clientes (financeiro + PLANO)...\n`);

for (const c of CLIENTES) {
  const u = DB_USERS[c.email];
  if (!u) {
    console.log(`  ❌ NÃO ENCONTRADO: ${c.email} (cliente ainda não fez login após o reset?)`);
    naoEncontrados.push(c.email);
    continue;
  }

  const isAuto = (c.plano === "vipro" || c.plano === "doublepro");

  // ── 1) CONCEDER O DIREITO (PLANO) — a parte que faltava na v1 ──────────
  // Idempotência: a concessão de dias é AMARRADA ao crédito. Se este mesmo
  // pagamento (origem+valor+nota) já está no ledger, NÃO soma dias de novo
  // (rodar 2x não vira 60 dias). Se ainda não está, concede +PLAN_DAYS a
  // partir do maior entre "agora" e a expiração paga atual.
  const prevVip = u.vip || {};
  const creditosPrev = Array.isArray(prevVip.creditos) ? prevVip.creditos.slice(-299) : [];
  const jaCreditado = creditosPrev.some(cr =>
    cr && cr.origem === "pagamento" && cr.tipo === "pago" &&
    Number(cr.valor) === Number(c.valor) && cr.motivo === c.nota);

  let manualExpires = prevVip.manualExpires || 0;
  let autoExpires   = prevVip.autoExpires   || 0;

  if (!jaCreditado) {
    // 1ª aplicação deste pagamento → concede os dias
    const prevPaid   = prevVip.source === "pago";
    const baseManual = (prevPaid && manualExpires > now) ? manualExpires : now;
    const baseAuto   = (prevPaid && autoExpires   > now) ? autoExpires   : now;
    manualExpires = baseManual + PLAN_DAYS * DAY;
    autoExpires   = isAuto ? (baseAuto + PLAN_DAYS * DAY) : 0;
    creditosPrev.push({
      id: "cred_" + now.toString(36) + "_" + Math.random().toString(16).slice(2, 8),
      quando: now, dias: PLAN_DAYS, tipo: "pago", origem: "pagamento",
      motivo: c.nota, dadoPor: "Diego", pedidoId: null, valor: c.valor,
    });
  } else {
    // Já aplicado antes → não soma. Só garante cobertura mínima se expirou.
    if (manualExpires < now) manualExpires = now + PLAN_DAYS * DAY;
    if (isAuto && autoExpires < now) autoExpires = now + PLAN_DAYS * DAY;
  }
  if (!isAuto) autoExpires = 0; // VIP manual nunca tem auto

  const vip = {
    ...prevVip,
    active: true,
    plan: c.plano,
    manualExpires,
    autoExpires,
    activatedAt: prevVip.activatedAt || now,
    lastActivatedAt: now,
    source: "pago",
    days: PLAN_DAYS,
    autoDays: isAuto ? PLAN_DAYS : 0,
    note: c.nota,
    activatedBy: "Diego (regularização jun/2026)",
    creditos: creditosPrev,
  };

  // Histórico de edição
  const editEntry = {
    at: now, by: "Diego", byEmail: "sistema",
    changes: "plan,vip.manualExpires,vip.autoExpires,financialStatus,paymentAmount,paymentDate,paymentMethod,paymentReceiver,paymentNote,adminNotes,lastValidatedAt",
    note: `Regularização v2 (financeiro + PLANO) — ${c.nota}`
  };

  // ── 2) Gravar usuário: PLANO + financeiro ─────────────────────────────
  DB_USERS[c.email] = {
    ...u,
    plan: c.plano,             // top-level plan (necessário p/ doublepro e getPlan)
    vip,                       // ✅ DIREITO concedido (era isto que faltava)
    // Dados financeiros (CCC)
    financialStatus: "pago",
    paymentAmount: `R$${c.valor.toFixed(2)}`,
    paymentDate: "27/06/2026",
    paymentMethod: "pix",
    paymentReceiver: "Diego",
    paymentNote: c.nota,
    adminNotes: [
      u.adminNotes || "",
      `[27/06/2026] Pagamento confirmado: R$${c.valor.toFixed(2)} — ${c.plano.toUpperCase()} ${PLAN_DAYS}d.`,
      `Recebido por Diego via PIX. Comprovante validado manualmente.`,
      `Lucro líquido jun/2026: R$${RESUMO_FINANCEIRO.lucroLiquido.toFixed(2)} (Andrio: R$${RESUMO_FINANCEIRO.parteAndrio.toFixed(2)} / Diego: R$${RESUMO_FINANCEIRO.parteDiego.toFixed(2)})`,
    ].filter(Boolean).join(" | "),
    lastValidatedAt: now,
    lastValidatedBy: "Diego (manual)",
    lastValidationResult: "CLIENTE_VALIDADO",
    adminEditHistory: [ ...(u.adminEditHistory || []).slice(-49), editEntry ],
  };
  atualizados++;
  planosConcedidos++;

  // ── 3) Destravar o job automático (limpa "plano expirou") ─────────────
  // Para VIPro com job parado por falta de plano/auth, devolve a um estado
  // "paused" limpo (resumível): o usuário clica Retomar (ou o re-login do
  // server.js já retoma sozinho) e volta a enviar — sem o banner vermelho.
  if (autoLoaded && DB_AUTO[c.email]) {
    const j = DB_AUTO[c.email];
    if (isAuto && j && PAUSE_STATES_TO_CLEAR.includes(j.status)) {
      DB_AUTO[c.email] = { ...j, active: false, status: "paused", unlockedAt: now };
      jobsLimpos++;
    }
  }

  const manualDataStr = new Date(manualExpires).toLocaleDateString("pt-BR");
  const autoDataStr   = isAuto ? new Date(autoExpires).toLocaleDateString("pt-BR") : "—";
  console.log(`  ✅ ${c.nome}`);
  console.log(`     ${c.email} | ${c.plano.toUpperCase()} | manual até ${manualDataStr} | auto até ${autoDataStr} | R$${c.valor.toFixed(2)}`);
}

// ── Salvar (com backup) ─────────────────────────────────────
function persistJSON(file, data, label) {
  const backupFile = file + ".bak_" + Date.now();
  try { fs.copyFileSync(file, backupFile); } catch {}
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[update] 💾 ${label} salvo (backup: ${path.basename(backupFile)})`);
}

try {
  persistJSON(USERS_FILE, DB_USERS, "users.json");
  // Mantém o alias legado em sincronia para evitar regressões em scripts antigos
  try { fs.writeFileSync(USERS_ALIAS, JSON.stringify(DB_USERS, null, 2)); } catch {}
  if (autoLoaded && jobsLimpos > 0) persistJSON(AUTO_FILE, DB_AUTO, "auto_jobs.json");
  console.log(`\n[update] ✅ ${atualizados}/${CLIENTES.length} clientes regularizados | ${planosConcedidos} planos concedidos | ${jobsLimpos} jobs destravados.`);
} catch(e) {
  console.error("[update] ❌ Erro ao salvar:", e.message);
  process.exit(1);
}

if (naoEncontrados.length > 0) {
  console.log(`\n[update] ⚠️  NÃO encontrados (${naoEncontrados.length}) — peça para fazerem login e rode de novo:`);
  naoEncontrados.forEach(e => console.log(`         • ${e}`));
}

console.log(`
╔════════════════════════════════════════════╗
║   RESUMO FINANCEIRO jun/2026 REGISTRADO    ║
╠════════════════════════════════════════════╣
║  Total recebido:  R$ 1.319,90              ║
║  Total gastos:    R$ 466,01                ║
║  Lucro líquido:   R$ 853,89                ║
║  Parte Andrio:    R$ 426,95                ║
║  Parte Diego:     R$ 426,95                ║
║  Pagantes OK:     ${atualizados.toString().padEnd(3)}                      ║
╚════════════════════════════════════════════╝
`);

console.log("[update] ✅ Concluído. REINICIE o servidor para aplicar os planos.");

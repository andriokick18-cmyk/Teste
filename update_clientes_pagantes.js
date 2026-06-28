#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  H2BApply — Atualizar dados financeiros dos clientes pagantes
//  Marca comprovante como OK, adiciona dados de pagamento no CCC
//  
//  USO: node update_clientes_pagantes.js
//  Executar no Render Shell ou via deploy
// ═══════════════════════════════════════════════════════════
"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "/tmp");
const USERS_FILE = path.join(DATA_DIR, "h2b_users.json");

console.log(`\n[update] DATA_DIR: ${DATA_DIR}`);
console.log(`[update] Users file: ${USERS_FILE}`);

if (!fs.existsSync(USERS_FILE)) {
  console.error("[update] ❌ h2b_users.json não encontrado!");
  process.exit(1);
}

// Ler usuários
let DB_USERS = {};
try {
  DB_USERS = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
} catch(e) {
  console.error("[update] ❌ Erro ao ler:", e.message);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// CLIENTES PAGANTES — dados confirmados pelo Andrio em 27/06/2026
// Recebimentos totais: R$1.319,90 | Gastos: R$466,01 | Lucro: R$853,89
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
  totalRecebido: 1319.90,
  totalGastos: 466.01,
  lucroLiquido: 853.89,
  parteAndrio: 426.95,
  parteDiego: 426.95,
  periodo: "jun/2026",
  gastos: "Claude + ChatGPT + Hostinger + Render = R$466,01",
};

const now = Date.now();
let atualizados = 0;
let naoEncontrados = [];

console.log(`\n[update] Atualizando ${CLIENTES.length} clientes...\n`);

for (const c of CLIENTES) {
  const u = DB_USERS[c.email];
  if (!u) {
    console.log(`  ❌ NÃO ENCONTRADO: ${c.email}`);
    naoEncontrados.push(c.email);
    continue;
  }

  // Histórico de edição
  const editEntry = {
    at: now,
    by: "Diego",
    byEmail: "sistema",
    changes: "financialStatus,paymentAmount,paymentDate,paymentMethod,paymentReceiver,paymentNote,adminNotes,comprovante,lastValidatedAt",
    note: `Regularização financeira jun/2026 — ${c.nota}`
  };

  // Atualizar dados financeiros no perfil (CCC)
  DB_USERS[c.email] = {
    ...u,
    // Dados financeiros completos
    financialStatus: "pago",
    paymentAmount: `R$${c.valor.toFixed(2)}`,
    paymentDate: "27/06/2026",
    paymentMethod: "pix",
    paymentReceiver: "Diego",
    paymentNote: c.nota,
    // Nota admin com contexto completo
    adminNotes: [
      u.adminNotes || "",
      `[27/06/2026] Pagamento confirmado: R$${c.valor.toFixed(2)} — ${c.plano.toUpperCase()} 30d.`,
      `Recebido por Diego via PIX. Comprovante validado manualmente.`,
      `Lucro líquido jun/2026: R$${RESUMO_FINANCEIRO.lucroLiquido.toFixed(2)} (Andrio: R$${RESUMO_FINANCEIRO.parteAndrio.toFixed(2)} / Diego: R$${RESUMO_FINANCEIRO.parteDiego.toFixed(2)})`,
    ].filter(Boolean).join(" | "),
    // Validação automática como OK — comprovante confirmado por Diego
    lastValidatedAt: now,
    lastValidatedBy: "Diego (manual)",
    lastValidationResult: "CLIENTE_VALIDADO",
    // Histórico de edições
    adminEditHistory: [
      ...(u.adminEditHistory || []).slice(-49),
      editEntry
    ],
  };

  // Log
  const planoAtual = u.plan || "free";
  console.log(`  ✅ ${c.nome}`);
  console.log(`     ${c.email} | plano: ${planoAtual} | R$${c.valor.toFixed(2)} | ${c.nota}`);
  atualizados++;
}

// Salvar
try {
  // Backup antes de salvar
  const backupFile = USERS_FILE + ".bak_clientes_" + Date.now();
  fs.copyFileSync(USERS_FILE, backupFile);
  console.log(`\n[update] Backup salvo: ${path.basename(backupFile)}`);
  
  fs.writeFileSync(USERS_FILE, JSON.stringify(DB_USERS, null, 2));
  console.log(`[update] ✅ ${atualizados}/${CLIENTES.length} clientes atualizados com sucesso!`);
} catch(e) {
  console.error("[update] ❌ Erro ao salvar:", e.message);
  process.exit(1);
}

if (naoEncontrados.length > 0) {
  console.log(`\n[update] ⚠️  Não encontrados (${naoEncontrados.length}): ${naoEncontrados.join(", ")}`);
}

// Resumo financeiro
console.log(`
╔════════════════════════════════════════════╗
║   RESUMO FINANCEIRO jun/2026 REGISTRADO   ║
╠════════════════════════════════════════════╣
║  Total recebido:  R$ 1.319,90             ║
║  Total gastos:    R$ 466,01               ║
║  Lucro líquido:   R$ 853,89               ║
║  Parte Andrio:    R$ 426,95               ║
║  Parte Diego:     R$ 426,95               ║
║  Clientes:        ${atualizados.toString().padEnd(3)} pagantes atualizados   ║
╚════════════════════════════════════════════╝
`);

console.log("[update] ✅ Concluído. Reinicie o servidor para aplicar.");

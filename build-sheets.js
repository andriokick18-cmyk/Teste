#!/usr/bin/env node
/**
 * build-sheets.js — H2BApply v36
 *
 * H-2B: baixa do DOL, filtra, salva jan2026_compact.json (igual antes)
 * H-2A: baixa do DOL e faz MERGE INCREMENTAL no h2a_jobs.json
 *        → nunca apaga vagas existentes
 *        → adiciona apenas vagas novas (por case number)
 *        → mantém todos os campos extras (exp, hrs, loc) das vagas manuais
 *
 * Rode manualmente: node build-sheets.js
 * Cron diário:      0 2 * * * node /app/build-sheets.js >> /var/log/build-sheets.log 2>&1
 */

"use strict";
const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const zlib   = require("zlib");
const os     = require("os");

// ─── Paths ────────────────────────────────────────────────────────────────────
const OUT_DIR  = path.join(__dirname);
const OUT_JAN  = path.join(OUT_DIR, "jan2026_compact.json");   // H-2B (substitui todo dia)
const OUT_H2A  = path.join(OUT_DIR, "h2a_jobs.json");          // H-2A FONTE ÚNICA (merge incremental)

// DOL Seasonal Jobs Data Hub — feeds ZIP com JSON interno
const DOL_BASE = "https://api.seasonaljobs.dol.gov/datahub-search/sjCaseData/zip";

function getFeedUrl(type, dateStr) {
  return `${DOL_BASE}/${type}/${dateStr}`;
}

// ─── Categorias H-2A ──────────────────────────────────────────────────────────
// Mapa de título/employer → categoria no formato do h2a_jobs.json
const H2A_TITLE_TO_CAT = {
  // Crop / Field
  "farmworker":           "crop_laborer",
  "farm worker":          "crop_laborer",
  "field worker":         "crop_laborer",
  "field laborer":        "crop_laborer",
  "crop laborer":         "crop_laborer",
  "harvest worker":       "crop_laborer",
  "harvester":            "crop_laborer",
  "farm laborer":         "crop_laborer",
  "general farmworker":   "crop_laborer",
  "farmworkers":          "crop_laborer",
  // Equipment
  "equipment operator":   "equipment_operator",
  "operating engineer":   "equipment_operator",
  "tractor operator":     "equipment_operator",
  "machine operator":     "equipment_operator",
  "agricultural equipment operator": "equipment_operator",
  // Greenhouse / Nursery
  "greenhouse worker":    "greenhouse",
  "nursery worker":       "greenhouse",
  "greenhouse":           "greenhouse",
  "flower harvester":     "greenhouse",
  // Tree Fruit / Orchard
  "tree fruit laborer":   "tree_fruit",
  "orchard worker":       "tree_fruit",
  "fruit picker":         "tree_fruit",
  "apple picker":         "tree_fruit",
  "cherry picker":        "tree_fruit",
  // Livestock / Dairy
  "dairy worker":         "livestock",
  "livestock worker":     "livestock",
  "beekeeper":            "livestock",
  "poultry worker":       "livestock",
  "ranch hand":           "livestock",
  // Driver
  "truck driver":         "driver",
  "shuttle driver":       "driver",
  "transport driver":     "driver",
  // Ag Construction
  "construction laborer": "ag_construction",
  "construction worker":  "ag_construction",
  "farm construction":    "ag_construction",
  "ag construction":      "ag_construction",
};

const H2A_EMPLOYER_KEYWORDS = {
  crop_laborer:      ["farm","ranch","harvest","crop","orchard","berry","lettuce","potato","tomato","vegetable","fruit","citrus","vineyard","winery","agri"],
  equipment_operator:["equipment","tractor","machinery","irrigat","operator"],
  greenhouse:        ["greenhouse","nursery","floral","flower","plant nursery"],
  tree_fruit:        ["orchard","cherry","apple","peach","pear","plum","blueberry","strawberry"],
  livestock:         ["dairy","cattle","livestock","poultry","hog","swine","bee","apiary","ranch"],
  driver:            ["transport","shuttle","logistics","trucking","driver"],
  ag_construction:   ["construction","builder","concrete","paving","ag builder","installers"],
  general_farm:      ["general farm","family farm","llc farm","farm inc","farms"],
  forestry:          ["timber","logging","lumber","reforestation","forest"],
};

function detectH2ACategory(title, employer) {
  const t = (title   || "").toLowerCase().trim();
  const n = (employer|| "").toLowerCase().trim();

  // 1. Match exato no título
  if (H2A_TITLE_TO_CAT[t]) return H2A_TITLE_TO_CAT[t];

  // 2. Match parcial no título
  for (const [kw, cat] of Object.entries(H2A_TITLE_TO_CAT)) {
    if (t.includes(kw) || kw.includes(t)) return cat;
  }

  // 3. Employer keywords
  for (const [cat, kws] of Object.entries(H2A_EMPLOYER_KEYWORDS)) {
    if (kws.some(k => n.includes(k))) return cat;
  }

  return "general_farm";
}

// ─── Filtros H-2B (igual ao v35) ─────────────────────────────────────────────
const DISCARD_STATUSES = ["denied", "withdrawn", "invalidated"];

function shouldDiscardH2B(rec) {
  if (rec.apply_url && rec.apply_url.trim() && rec.apply_url !== "N/A") return true;
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email : "";
  if (!email || !email.includes("@")) return true;
  const st = (rec.case_status || "").toLowerCase();
  if (DISCARD_STATUSES.some(d => st.includes(d))) return true;
  return false;
}

// ─── Filtros H-2A ─────────────────────────────────────────────────────────────
// Para H-2A aceitamos mesmo sem apply_url pois empregador agrícola geralmente não tem site
function shouldDiscardH2A(rec) {
  // Precisa ter email
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email : "";
  if (!email || !email.includes("@")) return true;
  // Status descartável
  const st = (rec.case_status || "").toLowerCase();
  if (DISCARD_STATUSES.some(d => st.includes(d))) return true;
  return false;
}

// ─── Converter registro bruto DOL → formato H-2B compacto ────────────────────
const JOB_TITLE_TO_H2B_CAT = {
  bartender:"food",barman:"food",barmaid:"food","bar back":"food",barback:"food",
  cook:"food","line cook":"food","prep cook":"food","head cook":"food",chef:"food",
  "sous chef":"food","executive chef":"food",dishwasher:"food","dish washer":"food",
  waiter:"food",waitress:"food",server:"food","food server":"food",busser:"food",
  busperson:"food",barista:"food",baker:"food","food service":"food","food prep":"food",
  "food preparation":"food","kitchen helper":"food","kitchen worker":"food",
  host:"food",hostess:"food",
  driver:"driver","truck driver":"driver","cdl driver":"driver","delivery driver":"driver",
  "bus driver":"driver",chauffeur:"driver",courier:"driver","forklift operator":"driver",
  "forklift driver":"driver","equipment operator":"driver",
  landscaper:"landscape","landscape worker":"landscape","landscape laborer":"landscape",
  "lawn care":"landscape",groundskeeper:"landscape","grounds keeper":"landscape",
  gardener:"landscape","irrigation technician":"landscape","tree trimmer":"landscape",
  arborist:"landscape","sod installer":"landscape",mulcher:"landscape",
  carpenter:"construction",electrician:"construction",plumber:"construction",
  welder:"construction",roofer:"construction",mason:"construction",laborer:"construction",
  "general laborer":"construction",painter:"construction",drywaller:"construction",
  "concrete worker":"construction","paving worker":"construction","hvac technician":"construction",
  housekeeper:"housekeeper",maid:"housekeeper","room attendant":"housekeeper",
  "hotel cleaner":"housekeeper","front desk":"housekeeper",bellman:"housekeeper",
  "night auditor":"housekeeper","laundry attendant":"housekeeper",
  janitor:"cleaning",custodian:"cleaning","office cleaner":"cleaning",
  "building cleaner":"cleaning","sanitation worker":"cleaning","janitorial":"cleaning",
  "warehouse worker":"warehouse",picker:"warehouse",packer:"warehouse",
  "picker packer":"warehouse","shipping clerk":"warehouse","receiving clerk":"warehouse",
  "order picker":"warehouse","stock clerk":"warehouse",
  "seafood processor":"seafood","fish processor":"seafood","crab picker":"seafood",
  "oyster shucker":"seafood","shrimp peeler":"seafood","fish cutter":"seafood",
  "farm worker":"farm",farmhand:"farm","field worker":"farm",harvester:"farm",
  "harvest worker":"farm","greenhouse worker":"farm","dairy worker":"farm",
  "poultry worker":"farm","crop worker":"farm",
  greenskeeper:"golf","golf course worker":"golf",caddie:"golf","golf attendant":"golf",
  lifeguard:"lifeguard","pool attendant":"lifeguard","aquatic staff":"lifeguard",
  "swim instructor":"lifeguard",
  "ride operator":"amusement","camp counselor":"amusement","carnival worker":"amusement",
  "recreation worker":"amusement",
  "timber worker":"forest","tree planter":"forest","reforestation worker":"forest",
  "logging worker":"forest",
  "ski instructor":"ski","lift operator":"ski","snow groomer":"ski","ski patrol":"ski",
  "snowboard instructor":"ski",
};

const H2B_EMPLOYER_KEYWORDS = {
  landscape:    ["landscape","lawn","turf","grass","grounds","mowing","garden","tree","arborist","nursery","sod","irrigation","mulch","shrub"],
  construction: ["construction","concrete","masonry","roofing","gutter","excavat","paving","asphalt","electrical","plumb","hvac","demolit","contractor","builder"],
  housekeeper:  ["hotel","resort","hospitality","inn","lodge","motel","housekeeper","laundry","maid"],
  seafood:      ["seafood","fish","crab","lobster","oyster","shrimp","vessel","marine","aqua","shellfish"],
  farm:         ["farm","agri","crop","harvest","orchard","ranch","dairy","livestock","poultry"],
  golf:         ["golf","country club"],
  amusement:    ["amusement","carnival","fair","theme park","waterpark","camp"],
  forest:       ["forest","timber","logging","reforestation"],
  lifeguard:    ["lifeguard","pool","aquatic","swim"],
  food:         ["restaurant","grill","tavern","cantina","bistro","brewpub","cafeteria","diner","foodservice","food service","bartend","catering"],
  driver:       ["trucking","transport","delivery","logistics","courier","freight","shipping","cdl"],
  cleaning:     ["cleaning service","janitorial","custodial","sanitation","housecleaning"],
  warehouse:    ["warehouse","distribution","fulfillment","logistics center","storage"],
  ski:          ["ski ","snowboard","winter resort","mountain resort"],
};

function detectH2BCategory(title, employer) {
  const t = (title   || "").toLowerCase().trim();
  const n = (employer|| "").toLowerCase().trim();
  if (JOB_TITLE_TO_H2B_CAT[t]) return JOB_TITLE_TO_H2B_CAT[t];
  for (const [kw, cat] of Object.entries(JOB_TITLE_TO_H2B_CAT)) {
    if (t.includes(kw) || kw.includes(t)) return cat;
  }
  for (const [cat, kws] of Object.entries(H2B_EMPLOYER_KEYWORDS)) {
    if (kws.some(k => n.includes(k))) return cat;
  }
  return "other";
}

function toH2BCompact(rec) {
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email.trim()
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email.trim() : "";
  const title    = (rec.job_title || "").trim();
  const employer = (rec.employer_business_name || rec.employer_trade_name || "").trim();
  const state    = (rec.worksite_state || rec.employer_state || "").toUpperCase().trim();
  const wage     = rec.basic_rate_from ? String(parseFloat(rec.basic_rate_from).toFixed(2)) : "";
  const wunit    = rec.pay_range_desc === "Month" ? "mês" : "h";
  const workers  = parseInt(rec.total_positions || 0) || 0;
  const caseNum  = (rec.case_number || rec.case_id || "").trim();
  const visa     = caseNum.startsWith("H-300") ? "H-2A"
                 : caseNum.startsWith("H-400") ? "H-2B"
                 : (rec.visa_class || "H-2B");

  return {
    c:    caseNum,
    t:    title,
    n:    employer,
    s:    state,
    d:    (rec.begin_date || "").slice(0, 10),
    e:    email,
    w:    wage,
    wunit,
    wk:   workers,
    k:    detectH2BCategory(title, employer),
    visa,
    st:   (rec.case_status || "").trim(),
  };
}

// ─── Converter registro bruto DOL → formato h2a_jobs.json ────────────────────
// Mantém compatibilidade total com os campos extras do arquivo existente
function toH2ARecord(rec) {
  const email = (rec.apply_email && rec.apply_email !== "N/A") ? rec.apply_email.trim()
              : (rec.employer_email && rec.employer_email !== "N/A") ? rec.employer_email.trim() : "";
  const title    = (rec.job_title || "").trim();
  const employer = (rec.employer_business_name || rec.employer_trade_name || "").trim();
  const state    = (rec.worksite_state || rec.employer_state || "").toUpperCase().trim();
  const city     = (rec.worksite_city || rec.employer_city || "").trim();
  const caseNum  = (rec.case_number || rec.case_id || "").trim();

  // Salário
  const wageRaw  = rec.basic_rate_from ? String(parseFloat(rec.basic_rate_from).toFixed(2)) : "";
  const wunit    = rec.pay_range_desc === "Month" ? "mês" : "h";

  // Horas semanais garantidas (campo H-2A específico)
  const hrs = parseInt(rec.hours_per_week || rec.guaranteed_hours || 0) || 40;

  // Localização legível: "City, STATE"
  const loc = city ? `${city}, ${state}` : state;

  // Data de início → para verificar se "expirou" (begin_date no passado)
  const beginDate = (rec.begin_date || "").slice(0, 10);
  const beginMs   = beginDate ? new Date(beginDate).getTime() : 0;
  const exp       = beginMs > 0 ? (beginMs < Date.now()) : false; // expirou se data já passou

  return {
    c:     caseNum,
    t:     title,
    n:     employer,
    s:     state,
    e:     email,
    w:     wageRaw,
    wunit,
    wk:    parseInt(rec.total_positions || 0) || 0,
    k:     detectH2ACategory(title, employer),
    visa:  "H-2A",
    exp,                         // true = data de início já passou
    hrs,                         // horas semanais garantidas
    loc,                         // "City, STATE"
  };
}

// ─── Download helpers ─────────────────────────────────────────────────────────
function download(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "H2BApply-BuildSheets/1.0" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

async function downloadAndParse(url) {
  console.log(`  ↓ GET ${url}`);
  const buf = await download(url);

  let data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // gzip
    data = zlib.gunzipSync(buf);
  } else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP
    const tmpZip = path.join(os.tmpdir(), `dol_feed_${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, buf);
    const { execSync } = require("child_process");
    try {
      const list     = execSync(`unzip -Z1 "${tmpZip}"`).toString().trim().split("\n");
      const jsonFile = list.find(f => f.endsWith(".json") || f.endsWith(".JSON"));
      if (!jsonFile) throw new Error("No JSON inside ZIP");
      data = execSync(`unzip -p "${tmpZip}" "${jsonFile.trim()}"`);
    } finally {
      try { fs.unlinkSync(tmpZip); } catch (_) {}
    }
  } else {
    data = buf;
  }

  return JSON.parse(data.toString("utf8"));
}

// ─── H-2B: substitui jan2026_compact.json todo dia (igual ao v35) ─────────────
async function buildH2B(today) {
  console.log(`\n[H-2B] Baixando feed h2b para ${today}...`);
  const url = getFeedUrl("h2b", today);
  let raw;
  try {
    raw = await downloadAndParse(url);
  } catch (e) {
    console.error(`  ❌ Falha no download H-2B: ${e.message}`);
    console.log(`  ↩ Mantendo ${OUT_JAN} intacto`);
    return false;
  }

  const records = Array.isArray(raw) ? raw
    : (raw.data || raw.results || raw.items || raw.cases || []);
  console.log(`  📥 ${records.length} registros brutos`);

  let discarded = 0;
  const compact = [];
  for (const rec of records) {
    if (shouldDiscardH2B(rec)) { discarded++; continue; }
    compact.push(toH2BCompact(rec));
  }

  console.log(`  ✅ ${compact.length} vagas válidas H-2B (${discarded} descartadas)`);

  if (compact.length < 10) {
    console.error(`  ❌ ABORTANDO: apenas ${compact.length} vagas — suspeito de resposta inválida`);
    return false;
  }

  const catCount = {};
  compact.forEach(r => { catCount[r.k] = (catCount[r.k] || 0) + 1; });
  Object.entries(catCount).sort((a,b)=>b[1]-a[1])
    .forEach(([k,v]) => console.log(`     ${k.padEnd(14)} ${v}`));

  fs.writeFileSync(OUT_JAN, JSON.stringify(compact));
  console.log(`  💾 Salvo: ${OUT_JAN} (${(fs.statSync(OUT_JAN).size/1024).toFixed(1)} KB)`);
  return true;
}

// ─── H-2A: MERGE INCREMENTAL no h2a_jobs.json ────────────────────────────────
// Regras:
//   1. Lê o arquivo existente (se houver) — essas vagas são a base
//   2. Baixa vagas novas do DOL
//   3. Adiciona apenas as que NÃO existem ainda (por case number)
//   4. Nunca remove vagas existentes
//   5. Atualiza campo `exp` das vagas existentes (begin_date pode ter virado passado)
async function buildH2AMerge(today) {
  console.log(`\n[H-2A] Baixando feed h2a para ${today} e fazendo merge incremental...`);

  // ── 1. Carrega base existente ──────────────────────────────────────────────
  let existing = [];
  if (fs.existsSync(OUT_H2A)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT_H2A, "utf8"));
      if (!Array.isArray(existing)) existing = [];
      console.log(`  📂 Base existente: ${existing.length} vagas em ${OUT_H2A}`);
    } catch (e) {
      console.warn(`  ⚠️  Erro ao ler base existente: ${e.message}. Iniciando do zero.`);
      existing = [];
    }
  } else {
    console.log(`  📂 ${OUT_H2A} não encontrado — será criado do zero`);
  }

  // Índice por case number para lookup rápido O(1)
  const existingByCaseNum = new Map(existing.map(r => [r.c, r]));

  // ── 2. Baixa feed do DOL ───────────────────────────────────────────────────
  const url = getFeedUrl("h2a", today);
  let raw;
  try {
    raw = await downloadAndParse(url);
  } catch (e) {
    console.error(`  ❌ Falha no download H-2A: ${e.message}`);
    console.log(`  ↩ Mantendo ${OUT_H2A} intacto (sem merge)`);
    return false;
  }

  const records = Array.isArray(raw) ? raw
    : (raw.data || raw.results || raw.items || raw.cases || []);
  console.log(`  📥 ${records.length} registros brutos do DOL`);

  // ── 3. Processa cada registro do DOL ──────────────────────────────────────
  let added   = 0;
  let updated = 0;
  let skipped = 0;
  let noEmail = 0;

  for (const rec of records) {
    if (shouldDiscardH2A(rec)) { skipped++; continue; }

    const converted = toH2ARecord(rec);
    const cn = converted.c;
    if (!cn) { skipped++; continue; }

    if (existingByCaseNum.has(cn)) {
      // Vaga já existe → só atualiza campo `exp` (datas mudam com o tempo)
      const existing_rec = existingByCaseNum.get(cn);
      if (existing_rec.exp !== converted.exp) {
        existing_rec.exp = converted.exp;
        updated++;
      }
      // NÃO sobrescreve outros campos — preserva edições manuais (hrs, loc, etc.)
    } else {
      // Vaga nova → adiciona
      existingByCaseNum.set(cn, converted);
      added++;
    }
  }

  console.log(`  ✅ Merge concluído:`);
  console.log(`     +${added} novas vagas adicionadas`);
  console.log(`     ~${updated} vagas com exp atualizado`);
  console.log(`     ${skipped} descartadas (sem email / status inválido)`);

  // ── 4. Reconstrói array final a partir do Map ──────────────────────────────
  const merged = [...existingByCaseNum.values()];
  console.log(`  📊 Total no arquivo: ${merged.length} vagas`);

  // Distribuição de categorias
  const catCount = {};
  merged.forEach(r => { catCount[r.k] = (catCount[r.k] || 0) + 1; });
  Object.entries(catCount).sort((a,b)=>b[1]-a[1])
    .forEach(([k,v]) => console.log(`     ${k.padEnd(20)} ${v}`));

  // Validação mínima
  if (merged.length === 0) {
    console.error(`  ❌ ABORTANDO: resultado do merge está vazio — algo deu errado`);
    return false;
  }

  // ── 5. Salva com backup atômico (tmp → rename) ─────────────────────────────
  const tmpFile = OUT_H2A + ".tmp";
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(merged));
    fs.renameSync(tmpFile, OUT_H2A);
    console.log(`  💾 Salvo: ${OUT_H2A} (${(fs.statSync(OUT_H2A).size/1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error(`  ❌ Erro ao salvar: ${e.message}`);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return false;
  }

  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log(" H2BApply — build-sheets.js v36");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════");

  const today = new Date().toISOString().slice(0, 10);

  const okH2B = await buildH2B(today);
  const okH2A = await buildH2AMerge(today);

  console.log("\n═══════════════════════════════════════════");
  if (okH2B && okH2A) {
    console.log(" ✅ Build concluído com sucesso!");
  } else {
    console.log(" ⚠️  Build concluído com avisos");
    if (!okH2B) console.log("    • H-2B: falhou (jan2026_compact.json mantido)");
    if (!okH2A) console.log("    • H-2A: falhou (h2a_jobs.json mantido)");
  }
  console.log("═══════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("ERRO FATAL:", e);
  process.exit(1);
});

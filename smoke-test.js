#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   🧪 SMOKE TEST do H2BApply — `npm test`
   Sobe o servidor DE VERDADE com um usuário-fixture no estado bugado que
   já aconteceu em produção (PDF triplicado, base64 dentro do users.json,
   perfil apontando pra PDF que não existe, arquivo órfão no disco) e
   verifica que o boot cura tudo e que as rotas vitais respondem.

   Zero dependências. Sai com código 0 (verde) ou 1 (falhou).
   Roda em ~15s. Use antes de TODO deploy.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = 3900 + Math.floor(Math.random() * 90); // evita colisão em CI
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-smoke-"));

// ── 🎭 Feed DOL falso — testa o bot de coleta de PONTA A PONTA sem internet.
// O server recebe DOL_FEED_BASE apontando pra cá; qualquer GET devolve um
// feed com 14 vagas H-2B válidas + 1 duplicada (pro dedupe provar serviço)
// + 1 sem e-mail (pro filtro de qualidade provar serviço).
const FEED_PORT = PORT + 1;
const _mkVaga = (i) => ({
  case_number: `H-400-2600${String(i).padStart(2, "0")}-111111`,
  job_title: "Landscape Laborer", employer_business_name: `Empresa Teste ${i} LLC`,
  worksite_state: "TX", worksite_city: "Austin",
  begin_date: "2026-10-01", end_date: "2027-03-31",
  apply_email: `rh${i}@empresa${i}.com`, basic_rate_from: "16.50",
  total_positions: 10, case_status: "certified",
});
const feedSrv = http.createServer((rq, rs) => {
  const vagas = [];
  for (let i = 1; i <= 14; i++) vagas.push(_mkVaga(i));
  vagas.push(_mkVaga(1)); // duplicada de propósito
  vagas.push({ ..._mkVaga(15), apply_email: "" }); // sem e-mail — deve cair fora
  rs.writeHead(200, { "Content-Type": "application/json" });
  rs.end(JSON.stringify(vagas));
});
feedSrv.listen(FEED_PORT);

// ── Fixture: o "caso Kley" real ─────────────────────────────────────────
const b64 = Buffer.from(
  "%PDF-1.4 conteudo falso de teste ".repeat(8)
).toString("base64");
const users = {
  "cliente@test.com": {
    name: "Kley",
    cvs: [
      { idx: 1001, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1002, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1003, name: "Cover_H2A.pdf", size: 5000, cvType: "cover", b64 },
      { idx: 1004, name: "Curriculo.pdf", size: 8000, cvType: "resume", b64 },
    ],
    profiles: [
      { id: "pa", name: "Perfil H-2A", visaType: "h2a", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: 1004, coverIdx: 1002 },
      { id: "pb", name: "Perfil H-2B", visaType: "h2b", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: 9999, pdfName: "Curriculo.pdf", coverIdx: null },
    ],
  },
  // Usuário legado: perfil com NOMES-fantasma (pdfName/coverName sem idx) —
  // o currículo existe na conta (religa pelo nome); a carta sumiu (limpa nome)
  "legado@test.com": {
    name: "Legado",
    // Texto ENLATADO de fábrica intocado (v22 deve limpar) + um campo editado
    // pelo usuário (v22 NUNCA pode tocar)
    settings: {
      subject: "Application for {vaga} – {nome}",
      body: "Texto que o usuário escreveu com as próprias mãos",
    },
    cvs: [{ idx: 2001, name: "MeuCV.pdf", size: 4000, cvType: "resume", b64 }],
    profiles: [
      { id: "pl", name: "Perfil H-2B", visaType: "h2b", active: true,
        subjects: ["a", "b", "c"], emailBodies: ["x", "y", "z"],
        resumeIdx: null, pdfName: "MeuCV.pdf",
        coverIdx: null, coverName: "CartaQueSumiu.pdf" },
    ],
  },
};
// v43-PERF: 1.500 usuários sintéticos, cada um com refresh_token/access_token
// (o mesmo formato de quem conectou Google de verdade) — estressa o MESMO
// laço de criptografia (AES-256-GCM sobre todos os usuários) que travava o
// servidor inteiro a cada salvamento de perfil, ANTES do fix de 23/07/2026
// (setUser() tratava array — sempre truthy — como campo "crítico" e gravava
// o banco INTEIRO de forma síncrona e bloqueante a cada save). Sem essa
// população, o bug de performance passaria despercebido pra sempre — a
// suíte SEM isso testa correção, não velocidade sob carga real.
for (let i = 0; i < 5000; i++) {
  users["perfuser" + i + "@test.com"] = {
    name: "Perf User " + i,
    // Tamanho realista de token OAuth de verdade (não "fake-0" — isso não
    // estressa nada; o custo real é AES-256-GCM + JSON.stringify sobre o
    // payload inteiro, que só aparece com tokens do tamanho de produção).
    refresh_token: "1//" + crypto.randomBytes(24).toString("hex"),
    cached_access_token: "ya29." + crypto.randomBytes(40).toString("hex"),
    cached_token_expiry: Date.now() + 3600_000,
    plan: "vip", cvs: [], profiles: [],
  };
}
fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify(users, null, 2));
// PDF órfão no disco (lixo do antigo delete sem unlink) — o sweep deve apagar
fs.mkdirSync(path.join(DATA, "cvs"), { recursive: true });
fs.writeFileSync(path.join(DATA, "cvs", "fantasma@test.com_777.pdf"), "%PDF-1.4 orfao");

// v46: notícias com data futura/absurda (bug real, print do dono 23/07:
// "ABRIL 2103", "JUNHO 2027") — a migração do boot deve REMOVER as inválidas
// e PRESERVAR a válida. Datas futuras construídas dinamicamente pra o teste
// não apodrecer com o calendário.
const _futuroISO = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
fs.writeFileSync(path.join(DATA, "dol_noticias.json"), JSON.stringify({ items: [
  { id: "n_valida001", date: "2026-06-29", titleEN: "OFLC Issues Technical Release Notes VALID", url: "", titlePT: "Notícia válida", resumoPT: "ok", translatedAt: 1, addedAt: 1 },
  { id: "n_futura001", date: _futuroISO, titleEN: "Future effective-date wrongly parsed", url: "", titlePT: "", resumoPT: "", translatedAt: null, addedAt: 1 },
  { id: "n_absurda01", date: "2103-04-04", titleEN: "Year 2103 typo announcement", url: "", titlePT: "", resumoPT: "", translatedAt: null, addedAt: 1 },
] }));
// Baseline do Vigia corrompido com data futura — deve voltar pro baseline
// oficial no boot (senão anúncio real novo nunca mais dispararia detecção).
fs.writeFileSync(path.join(DATA, "dol_news_watch.json"), JSON.stringify({
  ultimaConhecida: { date: _futuroISO, title: "corrompida", detectadaEm: 1, origem: "teste" },
}));

// ── Helpers ─────────────────────────────────────────────────────────────
const TEST_TOKEN = "smoke-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
let COOKIE = ""; // jar de 1 cookie (sessão de teste)

const req2 = (method, p, payload) => new Promise((resolve, reject) => {
  const body = payload ? JSON.stringify(payload) : null;
  const r = http.request(BASE + p, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      ...(COOKIE ? { Cookie: COOKIE } : {}),
    },
  }, (res) => {
    const sc = res.headers["set-cookie"];
    if (sc && sc.length) COOKIE = sc[0].split(";")[0];
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      let json = null; try { json = JSON.parse(b); } catch {}
      resolve({ status: res.statusCode, body: b, json, headers: res.headers });
    });
  });
  r.on("error", reject);
  if (body) r.write(body);
  r.end();
});
const get = (p) => req2("GET", p);

const waitUp = async (ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await get("/api/status"); if (r.status) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let failed = 0;
const check = (nome, ok, detalhe) => {
  console.log(`  ${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : " — " + detalhe}`);
  if (!ok) failed++;
};

// ── Unit: watchdog de auth_error avisa por PUSH (e-mails estão desligados
// por decisão do dono — sem push, cliente pagante com robô morto não sabia).
async function testAuthWatchdogPush() {
  const { initWatchdogs } = require("./mod-watchdogs.js");
  let pushed = null;
  const wd = initWatchdogs({
    DB_AUTO: () => ({ "vip@test.com": { active: false, status: "paused_auth_error", finishedAt: Date.now() - 13 * 3600_000 } }),
    autoTimers: () => new Map(),
    getUser: (e) => ({ email: e, lastSeenAt: Date.now() - 3600_000 }),
    getAutoJob: () => null, setAutoJob: () => {}, addLog: () => {},
    sendNotifEmail: async () => {}, refreshTokenForUser: async () => {},
    authErrNotifiedAtInit: {}, botLog: () => {},
    pushToUser: async (email, payload) => { pushed = { email, payload }; },
  }, { startIntervals: false });
  await wd.authErrorWatchdog();
  check("📲 robô parado >12h por erro de Gmail dispara PUSH pro cliente",
    pushed && pushed.email === "vip@test.com" && /reconecte/i.test(pushed.payload?.title || ""), JSON.stringify(pushed)?.slice(0, 120));
}

// ── Execução ────────────────────────────────────────────────────────────
(async () => {
  console.log(`🧪 Smoke test — porta ${PORT}, dados em ${DATA}`);
  await testAuthWatchdogPush(); // unit puro, não precisa do servidor
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  srv.stdout.on("data", (c) => (log += c));
  srv.stderr.on("data", (c) => (log += c));

  try {
    check("servidor subiu e respondeu HTTP", await waitUp(40_000));

    // Rotas vitais
    const home = await get("/");
    check("GET / responde 200 com a página", home.status === 200 && home.body.length > 10_000,
      `status=${home.status} bytes=${home.body.length}`);

    // v42: GUARDA ESTRUTURAL — nenhuma <div class="view" id="v-X"> pode ficar
    // aninhada dentro de outra. Bug real de produção (23/07/2026): faltou um
    // </div> no fechamento de #v-home, e TODAS as views seguintes (jobs,
    // plans, notificacoes, noticias, hist, ranking, respostas...) nasceram
    // como FILHAS de #v-home no DOM — escondidas junto toda vez que a Home
    // levava .gone (ou seja, sempre que qualquer outra aba estava ativa).
    // "Nenhuma aba funcionando" — reproduzido com Playwright, raiz corrigida.
    // Entre a tag de abertura de uma view (que conta como +1 nela mesma) e a
    // abertura da PRÓXIMA, o saldo de <div> abertas menos fechadas deve
    // voltar a ZERO — a própria view (e qualquer wrapper interno dela) tem
    // que fechar por completo antes da próxima começar. Saldo > 0 = sobrou
    // div aberta = a próxima view nasce aninhada (filha) da anterior.
    const viewTags = [...home.body.matchAll(/<div\b[^>]*\bid="v-([a-zA-Z]+)"/g)];
    let nestingBug = null;
    for (let i = 0; i < viewTags.length - 1; i++) {
      const seg = home.body.slice(viewTags[i].index, viewTags[i + 1].index);
      const bal = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
      if (bal !== 0) { nestingBug = `#v-${viewTags[i][1]} não fechou direito (saldo ${bal}, esperado 0) — #v-${viewTags[i + 1][1]} nasceu aninhada dentro dela`; break; }
    }
    check("🏗️ nenhuma aba (view) nasce aninhada dentro de outra no HTML", nestingBug === null, nestingBug || "");
    const st = await get("/api/status");
    let stJson = null; try { stJson = JSON.parse(st.body); } catch {}
    check("GET /api/status sem sessão → JSON connected:false",
      st.status === 200 && stJson && stJson.connected === false, st.body.slice(0, 120));
    const hl = await get("/health");
    let hlJson = null; try { hlJson = JSON.parse(hl.body); } catch {}
    check("GET /health → ok (Render não recicla o container)",
      hl.status === 200 && hlJson && hlJson.ok === true, hl.body.slice(0, 120));
    const ps = await get("/api/public-stats");
    check("GET /api/public-stats responde 200 (landing pública)", ps.status === 200, `status=${ps.status}`);
    const nt = await get("/api/noticias");
    let ntJson = null; try { ntJson = JSON.parse(nt.body); } catch {}
    check("GET /api/noticias → ok com lista (aba Notícias DOL)",
      nt.status === 200 && ntJson && ntJson.ok === true && Array.isArray(ntJson.items), nt.body.slice(0, 120));
    // v46: notícia com data FUTURA/absurda ("ABRIL 2103" — print real do dono)
    // é extração errada de data de vigência do corpo do texto. A migração do
    // boot remove as inválidas do fixture e preserva a válida.
    const _ntIds = (ntJson?.items || []).map((i) => i.id);
    check("📰 migração do boot removeu notícias com data futura/absurda (2103 etc.)",
      _ntIds.includes("n_valida001") && !_ntIds.includes("n_futura001") && !_ntIds.includes("n_absurda01"),
      `ids presentes: ${_ntIds.join(", ").slice(0, 120)}`);
    // Baseline do Vigia corrompido com data futura (anúncio real novo nunca
    // mais dispararia) — o boot deve restaurar o baseline oficial no arquivo.
    let _watchDisk = null; try { _watchDisk = JSON.parse(fs.readFileSync(path.join(DATA, "dol_news_watch.json"), "utf8")); } catch {}
    check("📰 baseline futuro do Vigia foi restaurado pro oficial no boot",
      _watchDisk?.ultimaConhecida?.date === "2026-06-29",
      `date no disco: ${_watchDisk?.ultimaConhecida?.date}`);
    // v33-SEO: /noticias é página PÚBLICA renderizada no servidor
    const ntPub = await get("/noticias");
    check("GET /noticias → página pública SEO das notícias traduzidas",
      ntPub.status === 200 && ntPub.body.includes("Notícias H-2B e H-2A em português"), `status=${ntPub.status}`);
    const smap = await get("/sitemap.xml");
    check("sitemap.xml lista /noticias (changefreq daily)",
      smap.status === 200 && smap.body.includes("h2bapply.com/noticias"), `status=${smap.status}`);
    // v40: fonte de ícones é BUILT-IN — nunca mais some por CDN bloqueada
    const tcss = await get("/vendor/tabler-icons.min.css");
    check("🎨 fonte de ícones servida pelo próprio site (CSS)",
      tcss.status === 200 && tcss.body.includes("tabler-icons"), `status=${tcss.status}`);
    const tfont = await get("/vendor/fonts/tabler-icons.woff2");
    check("🎨 arquivo woff2 dos ícones servido localmente",
      tfont.status === 200 && tfont.body.length > 100_000, `status=${tfont.status} bytes=${tfont.body.length}`);
    check("🎨 index.html aponta pra fonte local (não mais CDN)",
      home.body.includes("/vendor/tabler-icons.min.css"));

    // v34: páginas privadas proibidas de indexar + CSP deixa o Analytics carregar
    const admPage = await get("/admin");
    check("GET /admin manda X-Robots-Tag noindex (página privada fora do Google)",
      admPage.status === 200 && String(admPage.headers["x-robots-tag"] || "").includes("noindex"), JSON.stringify(admPage.headers["x-robots-tag"]));
    check("CSP libera googletagmanager (funil gaEvent deixa de ser bloqueado)",
      String(home.headers["content-security-policy"] || "").includes("googletagmanager.com"));

    // v44: GUARDA ESTRUTURAL do admin.html — mesma classe de bug do #v-home
    // (div não fechada = view nasce aninhada e some), mas aqui o admin tem
    // um mecanismo OFICIAL diferente: fixOrphanViews() no runtime confere
    // `v.parentElement !== content` e, se for verdade, arranca a view de
    // onde ela estiver no DOM e a arruma dentro de #content. Ou seja: uma
    // view pode legitimamente morar FISICAMENTE fora de #content no HTML
    // cru, contanto que o id dela esteja na lista fixOrphanViews — senão
    // ela fica escondida pra sempre (bug real de produção: Conferência
    // nasceu com tela preta por não estar nessa lista). A guarda replica
    // a MESMA regra do runtime, contando abertura/fechamento de <div> a
    // partir de "id=\"content\"" pra achar onde #content realmente fecha:
    // toda view cujo <div id="view-X"> cai DEPOIS desse fechamento (fora
    // de #content) tem que estar em fixOrphanViews — senão é uma órfã
    // nova, não registrada, prestes a repetir o mesmo bug.
    const admNoScript = admPage.body.replace(/<script[\s\S]*?<\/script>/g, "");
    const admViewTags = [...admNoScript.matchAll(/<div\b[^>]*\bid="(view-[a-zA-Z0-9-]+)"/g)]
      .filter((m) => m[1] !== "view-title");
    const orphanArrMatch = admPage.body.match(/fixOrphanViews[\s\S]{0,300}?\[([\s\S]{0,600}?)\]/);
    const orphanIds = orphanArrMatch ? [...orphanArrMatch[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]) : [];
    check("🧬 admin.html: lista de views órfãs (fixOrphanViews) encontrada no JS",
      orphanIds.length > 0, `encontrados: ${orphanIds.join(", ") || "NENHUM"}`);
    const contentIdIdx = admNoScript.indexOf('id="content"');
    const contentDivStart = contentIdIdx === -1 ? -1 : admNoScript.lastIndexOf("<div", contentIdIdx);
    let contentDivEnd = -1;
    if (contentDivStart !== -1) {
      let depth = 0;
      const divRe = /<div\b|<\/div>/g;
      divRe.lastIndex = contentDivStart;
      let dm;
      while ((dm = divRe.exec(admNoScript))) {
        depth += dm[0] === "<div" ? 1 : -1;
        if (depth === 0) { contentDivEnd = divRe.lastIndex; break; }
      }
    }
    check("🧱 admin.html: fechamento de #content localizado (guarda de órfãs depende disso)",
      contentDivEnd !== -1, `contentDivStart=${contentDivStart} contentDivEnd=${contentDivEnd}`);
    const unregisteredOutside = admViewTags.filter((m) => m.index >= contentDivEnd && !orphanIds.includes(m[1]));
    check("🏗️ admin.html: nenhuma view fora de #content sem registro em fixOrphanViews (não fica preta)",
      contentDivEnd !== -1 && unregisteredOutside.length === 0,
      unregisteredOutside.map((m) => m[1]).join(", "));
    let admNestingBug = null;
    const insideTags = admViewTags.filter((m) => m.index < contentDivEnd);
    for (let i = 0; i < insideTags.length - 1; i++) {
      const idA = insideTags[i][1], idB = insideTags[i + 1][1];
      const seg = admNoScript.slice(insideTags[i].index, insideTags[i + 1].index);
      const bal = (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
      if (bal !== 0) { admNestingBug = `#${idA} não fechou direito (saldo ${bal}, esperado 0) — #${idB} nasceu aninhada dentro dela`; break; }
    }
    check("🏗️ admin.html: nenhuma aba dentro de #content nasce aninhada dentro de outra", admNestingBug === null, admNestingBug || "");

    // Rota admin SEM sessão tem que negar — o portão global é vital
    const adm = await get("/api/admin/users");
    check("GET /api/admin/users sem sessão → bloqueado (401/403)",
      adm.status === 401 || adm.status === 403, `status=${adm.status}`);

    // Migrações de cura (v20/v21)
    const raw = fs.readFileSync(path.join(DATA, "users.json"), "utf8");
    const u = JSON.parse(raw)["cliente@test.com"];
    check("PDFs duplicados → 1 por nome (4 viraram 2)", u.cvs.length === 2,
      `cvs=${u.cvs.map((c) => c.idx).join(",")}`);
    check("nenhum base64 sobrou dentro do users.json", !raw.includes('"b64"'));
    const pa = u.profiles.find((p) => p.visaType === "h2a");
    const pb = u.profiles.find((p) => p.visaType === "h2b");
    check("perfil H-2A manteve currículo e cover", pa.resumeIdx === 1004 && pa.coverIdx === 1002);
    check("perfil H-2B: currículo órfão curado pelo nome", pb.resumeIdx === 1004);
    check('perfil H-2B: cover "Nenhuma" preservada', pb.coverIdx === null);
    const legU = JSON.parse(raw)["legado@test.com"];
    check("texto enlatado de fábrica foi limpo (ordem do dono)", legU.settings.subject === undefined,
      JSON.stringify(legU.settings.subject));
    check("texto escrito pelo usuário foi PRESERVADO",
      legU.settings.body === "Texto que o usuário escreveu com as próprias mãos");
    const leg = legU.profiles[0];
    check("legado: currículo-fantasma religado pelo nome", leg.resumeIdx === 2001);
    check("legado: nome de carta sumida foi limpo", !leg.coverName && leg.coverIdx === null,
      JSON.stringify({ coverName: leg.coverName, coverIdx: leg.coverIdx }));

    // Disco
    // ═══ FLUXOS AUTENTICADOS (sessão de teste — só existe com TEST_LOGIN_TOKEN) ═══
    const lg = await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    check("login de teste cria sessão", lg.status === 200 && lg.json?.ok === true, lg.body.slice(0, 100));
    const st2 = await get("/api/status");
    check("sessão vale: /api/status connected:true", st2.json?.connected === true);

    // Upload de PDF + dedup por nome (re-upload SUBSTITUI, não duplica)
    const pdfB64 = Buffer.from("%PDF-1.4 " + "smoke ".repeat(300)).toString("base64");
    const up1 = await req2("POST", "/api/cv/upload", { base64: pdfB64, name: "Curriculo_Smoke.pdf", cvType: "resume" });
    check("upload de currículo funciona", up1.json?.ok === true, up1.body.slice(0, 120));
    const up2 = await req2("POST", "/api/cv/upload", { base64: pdfB64, name: "Curriculo_Smoke.pdf", cvType: "resume" });
    check("re-upload do MESMO nome substitui (não duplica)", up2.json?.ok === true && up2.json?.replaced === true, up2.body.slice(0, 120));

    // Perfil: salvar com cover "Nenhuma" e depois salvar SEM o campo (herança)
    const resumeIdx = up1.json?.cv?.idx;
    const pf1 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"], resumeIdx, coverIdx: null });
    check('perfil salvo com cover "Nenhuma" (null explícito)', pf1.json?.ok === true && pf1.json?.profile?.coverIdx === null, pf1.body.slice(0, 140));
    const pf2 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke 2", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"] });
    check("salvar sem campo resumeIdx HERDA o currículo do perfil existente", pf2.json?.ok === true && pf2.json?.profile?.resumeIdx === resumeIdx, JSON.stringify(pf2.json?.profile?.resumeIdx));

    // v43-PERF (dono, 23/07: "site lento, até salvar perfil demora muito"):
    // GUARDA DETERMINÍSTICA — não depende de cronômetro (que varia de
    // máquina pra máquina e flaca em CI). Testa o MECANISMO em si: salvar
    // perfil tem que cair no caminho DEBOUNCED (grava em memória, agenda
    // disco pra depois) — nunca no síncrono (reescreve o banco INTEIRO,
    // bloqueando o servidor pra TODOS os usuários, a cada clique). Prova:
    // lê o arquivo em disco ANTES do save, chama a API, lê o arquivo nesse
    // MESMO INSTANTE de novo (sem esperar) — se já contém o nome novo, a
    // escrita foi síncrona (bug); se ainda não contém, foi debounced (certo).
    const _usersFilePath = path.join(DATA, "users.json");
    const _beforeSave = fs.readFileSync(_usersFilePath, "utf8");
    const pf3 = await req2("POST", "/api/profiles/save", { name: "Perfil Smoke 3 ÚNICO-MARCADOR", visaType: "h2b", subjects: ["a1", "a2", "a3"], emailBodies: ["b1", "b2", "b3"] });
    const _afterSaveImmediate = fs.readFileSync(_usersFilePath, "utf8");
    const _gravouNaHora = _afterSaveImmediate.includes("Perfil Smoke 3 ÚNICO-MARCADOR");
    check("⚡ salvar perfil usa caminho DEBOUNCED (não trava o servidor gravando o banco inteiro na hora)",
      pf3.json?.ok === true && _beforeSave === _afterSaveImmediate && !_gravouNaHora,
      _gravouNaHora ? "BUG: gravou o arquivo INTEIRO em disco de forma síncrona dentro do próprio request" : "ok, debounced");
    const tg = await req2("POST", "/api/profiles/toggle", { id: pf2.json?.profile?.id, active: false });
    check("toggle desativa perfil de verdade", tg.json?.ok === true && tg.json?.profile?.active === false);

    // v45-PERF: GUARDA DETERMINÍSTICA análoga à do perfil (linha acima), mas
    // pro MOTOR DO AUTOMÁTICO — setAutoJob() é chamado várias vezes por CADA
    // e-mail que CADA robô de CADA usuário manda (24/7, em produção), então é
    // uma via bem mais quente que salvar perfil. Mesmo teste: lê o arquivo,
    // chama a API que dispara setAutoJob, lê de novo NO MESMO INSTANTE — se
    // já mudou, foi síncrono (bug, trava o servidor a cada envio de qualquer
    // robô); se não mudou, foi debounced (certo).
    const _autoFilePath = path.join(DATA, "auto_jobs.json");
    const _readAutoFile = () => { try { return fs.readFileSync(_autoFilePath, "utf8"); } catch { return ""; } };
    const _beforeAuto = _readAutoFile();
    const as1 = await req2("POST", "/api/auto/start", {
      queue: [{ to: "empregador-smoke-unico@teste-h2b.com", title: "Vaga Smoke", company: "Empresa Smoke" }],
      resumeIdx, subjects: ["a1"], emailBodies: ["b1"],
    });
    const _afterAutoImmediate = _readAutoFile();
    const _gravouAutoNaHora = _afterAutoImmediate !== _beforeAuto && _afterAutoImmediate.includes("empregador-smoke-unico@teste-h2b.com");
    check("⚡ robô automático usa caminho DEBOUNCED pro estado do job (não trava o servidor a cada envio)",
      as1.json?.ok === true && !_gravouAutoNaHora,
      _gravouAutoNaHora ? "BUG: gravou auto_jobs.json INTEIRO em disco de forma síncrona dentro do próprio request" : "ok, debounced");
    await req2("POST", "/api/auto/stop", {});

    // ═══ v46: CÓDIGOS PROMO — personalizado honrado + Membro YouTube R$147 ═══
    // Bug real: o campo "Código personalizado" do admin era IGNORADO pelo
    // servidor (sempre gerava aleatório). E o dono pediu botão dedicado de
    // código Membro YouTube: uso único, 30d, valendo R$147 na Conferência.
    const cc1 = await req2("POST", "/api/admin/codes/create", { manualDays: 5, autoDays: 0, maxUses: 1, code: "PROMOSMOKE1" });
    check("🎟️ código personalizado é honrado (não vira aleatório)",
      cc1.json?.ok === true && cc1.json?.code === "PROMOSMOKE1", cc1.body.slice(0, 120));
    const cc1b = await req2("POST", "/api/admin/codes/create", { manualDays: 5, autoDays: 0, maxUses: 1, code: "PROMOSMOKE1" });
    check("🎟️ código personalizado repetido é barrado (409)", cc1b.status === 409, `status=${cc1b.status}`);
    const cc2 = await req2("POST", "/api/admin/codes/create", { manualDays: 30, autoDays: 30, maxUses: 1, yt: true });
    check("🎬 código Membro YouTube criado com flag yt", cc2.json?.ok === true && cc2.json?.yt === true, cc2.body.slice(0, 120));
    const ytCode = cc2.json?.code;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ytmember@test.com", name: "YT Member" });
    const rd = await req2("POST", "/api/redeem-code", { code: ytCode });
    check("🎬 membro YouTube resgata o código (30d manual + 30d auto)",
      rd.json?.ok === true && rd.json?.manualDays === 30 && rd.json?.autoDays === 30, rd.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const cfYt = await get("/api/admin/conferencia");
    const ytRow = (cfYt.json?.rows || []).find((r) => r.tipo === "codigo" && r.code === ytCode && r.email === "ytmember@test.com");
    check("🎬 Conferência lista o resgate do código YouTube valendo R$147",
      !!ytRow && ytRow.valor === 147, JSON.stringify(ytRow || {}).slice(0, 140));

    // ═══ CAMINHO DO DINHEIRO: comprador (não-admin) compra, admin aprova ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com", name: "Comprador" });
    const pd1 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Comprador" });
    const pdId = pd1.json?.pedidoId;
    check("pedido criado pelo comprador", pd1.json?.ok === true && !!pdId, pd1.body.slice(0, 120));
    const pd2 = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150 });
    check("2º pedido igual é barrado (dedup devolve o existente)", pd2.json?.duplicado === true && pd2.json?.pedido?.id === pdId, pd2.body.slice(0, 120));

    // troca pro ADMIN pra aprovar
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const bad = await req2("PATCH", "/api/pedido/" + pdId, { status: "Banana" });
    check("status fora da máquina de estados → 400", bad.status === 400, bad.body.slice(0, 100));
    const wrongPwd = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo", editorPassword: "senha-errada" });
    check("ativar com senha de editor ERRADA → 403", wrongPwd.status === 403, wrongPwd.body.slice(0, 100));
    const act = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo", editorPassword: "84800-54" });
    check("ativação com senha de editor → plano ativado", act.json?.ok === true && act.json?.planoKey === "vipro", act.body.slice(0, 160));
    const dupAct = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo", editorPassword: "84800-54" });
    check("dupla ativação do MESMO pedido é barrada (409)", dupAct.status === 409, dupAct.body.slice(0, 100));
    const fin1 = await get("/api/admin/financeiro");
    const temCaixa = (fin1.json?.pagamentos || []).some((x) => x.pedidoId === pdId);
    check("ativação lançou a entrada no livro-caixa", temCaixa);

    // v28: Visão do Dono — resumo de dinheiro calculado no servidor
    const dr = await get("/api/admin/dono-resumo");
    check("💰 Visão do Dono: a ativação de R$150 aparece nas entradas de hoje",
      dr.json?.ok === true && dr.json?.entradas?.total >= 150 && dr.json?.entradas?.hoje >= 150, dr.body.slice(0, 140));

    // v31: 🧾 Conferência de pagamentos — todos os pagamentos numa lista só,
    // valor ao lado do nome, e correção de valor com trilha (caixa junto)
    const cf = await get("/api/admin/conferencia");
    const cfRow = (cf.json?.rows || []).find((r) => r.tipo === "pedido" && r.id === pdId);
    check("🧾 Conferência lista o pedido com o valor ao lado do nome", cf.json?.ok === true && cfRow?.valor === 150, cf.body.slice(0, 140));
    // O pedido recém-ativado TEM entrada no caixa — não pode aparecer como divergência
    const dvComprador = (cf.json?.divergencias || []).filter((x) => x.email === "comprador@test.com");
    check("🔍 varredura de divergências roda e não acusa o fluxo saudável", Array.isArray(cf.json?.divergencias) && dvComprador.length === 0, JSON.stringify(dvComprador).slice(0, 140));
    const corr = await req2("PATCH", "/api/pedido/" + pdId, { corrigirValor: 147 });
    check("✏️ corrigirValor altera o pedido preservando o original na trilha", corr.json?.ok === true && corr.json?.pedido?.valorTotal === 147 && corr.json?.pedido?.valorOriginal === 150, corr.body.slice(0, 140));
    const fin1b = await get("/api/admin/financeiro");
    const pgCorr = (fin1b.json?.pagamentos || []).find((x) => x.pedidoId === pdId);
    check("✏️ correção de valor corrige o caixa JUNTO (uma verdade só)", corr.json?.caixaCorrigido === true && pgCorr?.valor === 147);

    // v32: ⏳ Robô de Renovação — a varredura roda inteira sem erro sob demanda
    const rnv = await req2("POST", "/api/admin/renova-run", {});
    check("⏳ Robô de Renovação roda sob demanda (varredura completa sem erro)", rnv.json?.ok === true && typeof rnv.json?.avisados === "number", rnv.body.slice(0, 100));

    // v37: 📊 Resumo Diário do Dono — números de ontem calculados sem erro
    const rsd = await req2("POST", "/api/admin/resumo-diario-run", {});
    check("📊 Resumo Diário do Dono calcula os números de ontem sob demanda",
      rsd.json?.ok === true && typeof rsd.json?.vendas === "number" && typeof rsd.json?.pendentes === "number" && typeof rsd.json?.envios === "number", rsd.body.slice(0, 140));

    // v35: 🤖 Bot de coleta "Nova Planilha do DOL" — ponta a ponta com o feed falso
    const cs = await req2("POST", "/api/admin/sheet/coleta-start", { visa: "H-2B", sheetKey: "teste2099", sheetName: "Teste 2099" });
    check("🤖 coleta-start aceita e dispara o bot em background", cs.json?.ok === true, cs.body.slice(0, 120));
    let stC = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300));
      stC = (await get("/api/admin/sheet/coleta-status")).json;
      if (stC && stC.running === false && stC.finishedAt) break;
    }
    check("🤖 coleta terminou: 14 vagas (dedupe tirou a duplicada, qualidade tirou a sem e-mail)",
      stC?.running === false && !stC?.error && stC?.count === 14, JSON.stringify({ count: stC?.count, error: stC?.error }));
    const sl1 = await get("/api/sheets-list");
    check("🔒 rascunho da coleta NÃO aparece pros usuários antes de publicar",
      sl1.status === 200 && !(sl1.json?.sheets || []).some((x) => x.key === "teste2099"), sl1.body.slice(0, 160));
    const pub = await req2("POST", "/api/admin/sheet/coleta-publish", { key: "teste2099" });
    const sl2 = await get("/api/sheets-list");
    check("📢 publicar libera a planilha coletada na lista dos usuários",
      pub.json?.ok === true && (sl2.json?.sheets || []).some((x) => x.key === "teste2099" && x.count === 14), sl2.body.slice(0, 200));
    const sm2 = await get("/api/sheet-meta?sheet=teste2099&skip=0&top=5");
    check("🗂️ vagas da planilha coletada abrem no Manual (/api/sheet-meta)",
      Array.isArray(sm2.json?.jobs) && sm2.json.jobs.length > 0, sm2.body.slice(0, 140));

    // v27: conjunto de empregadores bloqueados responde pro usuário logado
    const se = await get("/api/sent-emails");
    check("GET /api/sent-emails → listas de enviados e fila", se.json?.ok === true && Array.isArray(se.json?.sent) && Array.isArray(se.json?.queued), se.body.slice(0, 100));

    // comprador tem que estar VIPRO com VIP ativo ANTES do cancelamento
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const st3 = await get("/api/status");
    check("comprador virou VIPRO com VIP ativo de verdade", st3.json?.plan === "vipro" && st3.json?.vip?.active === true, JSON.stringify({ plan: st3.json?.plan, vip: !!st3.json?.vip?.active }));

    // admin cancela: caixa estornado E os dias de VIP revertidos
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com" });
    const canc = await req2("PATCH", "/api/pedido/" + pdId, { status: "cancelado" });
    const fin2 = await get("/api/admin/financeiro");
    const caixaSumiu = !(fin2.json?.pagamentos || []).some((x) => x.pedidoId === pdId);
    check("cancelamento ESTORNA a entrada automática do caixa", canc.json?.ok === true && caixaSumiu);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const st4 = await get("/api/status");
    check("cancelamento também estorna os dias de VIP do comprador", st4.json?.vip?.active !== true, JSON.stringify({ plan: st4.json?.plan, vip: !!st4.json?.vip?.active }));

    const disk = fs.readdirSync(path.join(DATA, "cvs"));
    check("PDFs válidos gravados no disco", disk.includes("cliente@test.com_1002.pdf") && disk.includes("cliente@test.com_1004.pdf"),
      disk.join(", "));
    check("PDF órfão varrido do disco", !disk.includes("fantasma@test.com_777.pdf"));
    const pdf = fs.readFileSync(path.join(DATA, "cvs", "cliente@test.com_1004.pdf"), "utf8");
    check("conteúdo do PDF íntegro (%PDF)", pdf.startsWith("%PDF"));
  } catch (e) {
    check("execução sem exceção", false, e.message);
  } finally {
    srv.kill("SIGKILL");
    try { feedSrv.close(); } catch {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  }

  if (failed) {
    console.log(`\n❌ ${failed} verificação(ões) FALHARAM. Últimas linhas do servidor:`);
    console.log(log.split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  console.log("\n✅ Smoke test 100% verde — seguro pra deploy.");
  process.exit(0);
})();

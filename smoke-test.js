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
// v49: pedido /h2a/ devolve vagas H-2A (case H-300-…) pro robô "Vagas Novas
// H-2A"; qualquer outro caminho segue devolvendo o feed H-2B de sempre.
const _mkVagaH2A = (i) => ({
  ..._mkVaga(i),
  case_number: `H-300-2600${String(i).padStart(2, "0")}-222222`,
  job_title: "Farm Worker", employer_business_name: `Fazenda Teste ${i} LLC`,
  apply_email: `rh${i}@fazenda${i}.com`,
});
const feedSrv = http.createServer((rq, rs) => {
  const h2a = (rq.url || "").includes("/h2a/");
  const vagas = [];
  for (let i = 1; i <= 14; i++) vagas.push(h2a ? _mkVagaH2A(i) : _mkVaga(i));
  vagas.push(h2a ? _mkVagaH2A(1) : _mkVaga(1)); // duplicada de propósito
  vagas.push({ ...(h2a ? _mkVagaH2A(15) : _mkVaga(15)), apply_email: "" }); // sem e-mail — deve cair fora
  // v50: com o arquivo-bandeira presente, a vaga 14 vem RETIRADA (withdrawn)
  // — o robô tem que atualizar o status e REMOVER ela da planilha.
  if (h2a && fs.existsSync(path.join(DATA, "h2a_feed_withdraw.flag"))) vagas[13].case_status = "withdrawn";
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

// v58 (dono, 25/07: "1 e 2 bloqueados, cadastro só no Servidor 3"): simula o
// disco de um servidor ANTIGO (lista salva com 2 servidores, o 2 ainda
// aberto) — a migração one-shot do boot tem que fechar 1/2 e acrescentar o
// Servidor 3 (applyh2b.com) aberto, gravando de volta com a flag _migSrv3.
fs.writeFileSync(path.join(DATA, "admin_settings.json"), JSON.stringify({
  servers: [
    { id: 1, nome: "Servidor 1", url: "https://h2bapply.com", maxExibido: 50, status: "lotado" },
    { id: 2, nome: "Servidor 2", url: "https://h2b-teste.onrender.com", maxExibido: 100, status: "aberto" },
  ],
}));

// v48: INCIDENTE REAL (25/07, print do dono: "as vagas das planilhas de
// inverno e h2a sumiram") — cópia de /data truncada (gravação não-atômica
// interrompida) e cópia vazia. Como /data tem prioridade, o load antigo
// fazia `continue` e a planilha ficava vazia PRA SEMPRE, mesmo com a cópia
// bundled boa no código. O boot novo tem que recuperar pelas bundled.
fs.writeFileSync(path.join(DATA, "jul2025_compact.json"), '[{"c":"ETA-123","n":"Truncada Corp","e":"x@y.co');
fs.writeFileSync(path.join(DATA, "h2a_jun2026_compact.json"), "[]");

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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, STORAGE: "json", TEST_LOGIN_TOKEN: TEST_TOKEN, DATA_ENC_KEY: "smoke-enc-key-1234567890", DOL_FEED_BASE: `http://127.0.0.1:${FEED_PORT}/feed` },
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
    // v58: migração dos servidores — o fixture semeou a lista ANTIGA (2
    // servidores, o 2 aberto); o boot tem que ter fechado 1/2 e acrescentado
    // o Servidor 3 (applyh2b.com) como o ÚNICO aberto pra cadastro novo.
    const svs = await get("/api/servers");
    const _sv = (id) => (svs.json?.servers || []).find((x) => x.id === id);
    // v66b: a URL do Servidor 3 é o endereço VIVO do Render enquanto o DNS de
    // applyh2b.com não aponta pro Render (seletor e ranking global dependem dela).
    check("🌐 v58+v66b: Servidores 1 e 2 LOTADOS e Servidor 3 (h2b-server-3.onrender.com) é o único aberto",
      svs.json?.ok === true && _sv(1)?.status === "lotado" && _sv(2)?.status === "lotado" &&
      _sv(3)?.status === "aberto" && String(_sv(3)?.url || "").includes("h2b-server-3.onrender.com"),
      JSON.stringify((svs.json?.servers || []).map((x) => x.id + ":" + x.status + ":" + x.url)));
    let _admSet = null; try { _admSet = JSON.parse(fs.readFileSync(path.join(DATA, "admin_settings.json"), "utf8")); } catch {}
    check("🌐 v58: migração gravou a lista nova no disco com a flag one-shot (edição futura do dono vale)",
      _admSet?._migSrv3 === true && (_admSet?.servers || []).length === 3,
      `_migSrv3=${_admSet?._migSrv3} servidores=${(_admSet?.servers || []).length}`);

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
    // v56: verificação Google — a Política de Privacidade precisa existir e
    // conter a declaração canônica de Limited Use em inglês (o revisor procura
    // exatamente por ela). Servidor completo também menciona ler respostas.
    const priv = await get("/privacidade");
    check("🔏 /privacidade existe com a declaração Limited Use (exigência da verificação Google)",
      priv.status === 200 && priv.body.includes("Limited Use requirements") && priv.body.includes("gmail.send"),
      `status=${priv.status}`);
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

    // v53: GUARDA DE FUNÇÃO-FANTASMA — bug real (25/07, achado por Playwright
    // na varredura pré-deploy): switchProfileTab chamava renderProfileList(),
    // renomeada num refactor antigo — todo clique na sub-aba Perfis estourava
    // ReferenceError. E no admin, excluir conta chamava loadUsers(), que
    // também não existe. Esta guarda varre os DOIS arquivos: toda função
    // chamada em onclick/onchange/etc. E toda chamada com prefixo de ação
    // (render/load/show/open/close/update/refresh/toggle) tem que estar
    // DEFINIDA no arquivo. Comentários são removidos antes; chamadas
    // protegidas por typeof não contam.
    for (const _file of ["index.html", "admin.html"]) {
      const _raw = fs.readFileSync(path.join(__dirname, _file), "utf8");
      // Só comentários de LINHA INTEIRA saem (onde nomes antigos costumam ser
      // citados). Strip de /* */ é perigoso demais em arquivo de 1MB com
      // regex/strings — um "/*" dentro de string engoliria meio arquivo.
      const _src = _raw.replace(/^[ \t]*\/\/[^\n]*/gm, "");
      const _defs = new Set();
      for (const m of _src.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/window\.([a-zA-Z_$][\w$]*)\s*=/g)) _defs.add(m[1]);
      for (const m of _src.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) _defs.add(m[1]); // métodos de objeto: nome(args){
      const _guarded = new Set();
      for (const m of _src.matchAll(/typeof\s+([a-zA-Z_$][\w$]*)/g)) _guarded.add(m[1]);
      const _missing = new Set();
      for (const m of _src.matchAll(/on(?:click|change|input|submit)="\s*([a-zA-Z_$][\w$]*)\s*\(/g)) {
        if (!_defs.has(m[1]) && !_guarded.has(m[1]) && !["if"].includes(m[1])) _missing.add("handler:" + m[1]);
      }
      for (const m of _src.matchAll(/(?<![.\w$"'`])((?:render|load|show|open|close|update|refresh|toggle)[A-Z][\w$]*)\s*\(/g)) {
        if (!_defs.has(m[1]) && !_guarded.has(m[1])) _missing.add(m[1]);
      }
      check(`👻 ${_file}: nenhuma função chamada que não existe (classe do bug renderProfileList)`,
        _missing.size === 0, [..._missing].join(", "));
    }

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

    // v48: INCIDENTE REAL "vagas sumiram" — o fixture semeou /data com
    // jul2025 TRUNCADO e h2a VAZIO. O boot tem que ter recuperado os dois
    // pelas cópias bundled do código (com e-mails), regravado /data e a
    // lista de planilhas tem que mostrar vagas disponíveis de verdade.
    const shl = await get("/api/sheets-list");
    const _shJul = (shl.json?.sheets || []).find((s) => s.key === "jul2025");
    const _shH2a = (shl.json?.sheets || []).find((s) => s.key === "h2a-jun2026");
    check("🩹 planilha de inverno (jul2025) recuperada da cópia truncada em /data",
      _shJul && _shJul.count > 2000 && _shJul.available > 2000, JSON.stringify(_shJul || {}).slice(0, 120));
    check("🩹 planilha H-2A recuperada da cópia vazia em /data",
      _shH2a && _shH2a.count > 4000 && _shH2a.available > 4000, JSON.stringify(_shH2a || {}).slice(0, 120));
    let _julDisk = null; try { _julDisk = JSON.parse(fs.readFileSync(path.join(DATA, "jul2025_compact.json"), "utf8")); } catch {}
    check("🩹 /data/jul2025_compact.json foi regravado são (auto-reparo no boot)",
      Array.isArray(_julDisk) && _julDisk.length > 2000, `linhas no disco: ${Array.isArray(_julDisk) ? _julDisk.length : "ilegível"}`);

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

    // v47: GUARDA ESTRUTURAL das vias quentes de persistência — indexApp e os
    // callbacks de header do Gmail rodam a CADA e-mail enviado (manual e
    // automático); não dá pra disparar envio real de Gmail no smoke, então a
    // guarda confere direto no código-fonte que essas vias usam
    // persistDebounced (nunca persist síncrono, que grava o banco inteiro
    // travando o servidor pra todo mundo — bug real "site lento", 23/07).
    const _srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const _idxAppBody = (_srvSrc.match(/function indexApp\([\s\S]*?\n\}/) || [""])[0];
    check("⚡ indexApp (roda a cada e-mail enviado) grava DEBOUNCED, nunca síncrono",
      _idxAppBody.includes("persistDebounced(APPIDX_FILE") && !/(?<!Debounced)\(?persist\(APPIDX_FILE/.test(_idxAppBody),
      _idxAppBody ? "" : "função indexApp não encontrada no server.js");
    const _gmailCbs = [...(_srvSrc.matchAll(/gmailHeaderMsgId = h\.messageId; (persist\w*)\(/g))].map((m) => m[1]);
    check("⚡ callbacks de header do Gmail (por e-mail) gravam o histórico DEBOUNCED",
      _gmailCbs.length === 2 && _gmailCbs.every((f) => f === "persistDebounced"),
      `encontrados: ${_gmailCbs.join(", ") || "nenhum"}`);

    // v72: SÓ-ENVIO PERMANENTE E UNIVERSAL nos 3 servidores (ordem do dono,
    // 26/07/2026 — "não precisa mais pedir autenticação pro Google pra ler
    // respostas, apenas enviar e-mails"). GMAIL_SEND_ONLY não é mais um
    // toggle por env; é uma constante hardcoded true, e OAUTH_SCOPES pede
    // SOMENTE gmail.send — nunca readonly/modify. Regressão aqui faria
    // QUALQUER servidor voltar a pedir escopo de leitura ao Google.
    const _scopeUses = (_srvSrc.match(/scope:OAUTH_SCOPES/g) || []).length;
    const _sendOnlyConst = (_srvSrc.match(/const GMAIL_SEND_ONLY\s*=\s*(true|false)\s*;/) || [])[1] || "";
    const _scopesLine = (_srvSrc.match(/const OAUTH_SCOPES\s*=\s*"([^"]+)"/) || [])[1] || "";
    check("✉️ OAuth usa OAUTH_SCOPES nos 2 pontos, GMAIL_SEND_ONLY=true fixo, escopo é SÓ gmail.send (nunca readonly/modify)",
      _scopeUses === 2 && _sendOnlyConst === "true" && _scopesLine.includes("gmail.send") && !_scopesLine.includes("readonly") && !_scopesLine.includes("modify"),
      `usos=${_scopeUses} | GMAIL_SEND_ONLY=${_sendOnlyConst} | escopos="${_scopesLine.slice(0, 90)}"`);

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

    // v57 (dono, 25/07): aprovar NÃO pede mais senha — o portão é a SESSÃO de
    // admin (Google), e quem aprovou fica registrado pelo e-mail logado.
    // Não-admin tentando ativar → 403 (o portão que importa continua de pé).
    const naoAdm = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    check("🔒 não-admin NÃO consegue ativar pedido (403 — portão é a sessão, não senha)", naoAdm.status === 403, `status=${naoAdm.status}`);
    // troca pro ADMIN pra aprovar
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const bad = await req2("PATCH", "/api/pedido/" + pdId, { status: "Banana" });
    check("status fora da máquina de estados → 400", bad.status === 400, bad.body.slice(0, 100));
    const act = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
    check("ativação SEM senha (admin logado) → plano ativado e editor registrado", act.json?.ok === true && act.json?.planoKey === "vipro", act.body.slice(0, 160));
    const dupAct = await req2("PATCH", "/api/pedido/" + pdId, { status: "ativo" });
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

    // ═══ v59: 🌍 FATURAMENTO GLOBAL — os 3 servidores somados ═══
    // Rota peer sem token → 403; com o token derivado da DATA_ENC_KEY → ok.
    const finNoTok = await get("/api/servers/financeiro");
    check("🌍 rota peer de financeiro SEM token → 403 (dinheiro nunca fica público)",
      finNoTok.status === 403, `status=${finNoTok.status}`);
    const _peerTok = crypto.createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const finTok = await new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/servers/financeiro", method: "GET", headers: { "x-peer-fin": _peerTok } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
      }); r.on("error", reject); r.end();
    });
    check("🌍 rota peer COM token responde as entradas (admin nunca na soma)",
      finTok.status === 200 && finTok.json?.ok === true && typeof finTok.json?.entradas?.total === "number",
      JSON.stringify(finTok.json?.entradas || {}).slice(0, 120));
    const fg = await get("/api/admin/financeiro-global");
    check("🌍 Faturamento Global: lista os 3 servidores e soma (self na hora)",
      fg.json?.ok === true && (fg.json?.servidores || []).length === 3 &&
      fg.json.servidores.some((x) => x.self && x.ok) && fg.json?.global?.total >= 147 && fg.json?.peerAuth === true,
      JSON.stringify({ total: fg.json?.global?.total, n: (fg.json?.servidores || []).length }).slice(0, 120));
    // v60: servidores antigos (1/2, intocados por ordem do dono) entram na
    // soma pelo TOTAL INFORMADO manualmente — salvo nas configurações.
    const _fgBase = fg.json?.global?.total || 0;
    // (no smoke este servidor se resolve como id 1 — então o manual entra no 2)
    await req2("POST", "/api/admin/settings", { fgManual2: 5000 });
    const fg2 = await get("/api/admin/financeiro-global");
    const _srv2m = (fg2.json?.servidores || []).find((x) => x.id === 2);
    check("🌍 total manual do servidor antigo soma no global (R$5.000 informado no 2)",
      fg2.json?.ok === true && _srv2m?.manual === true && fg2.json.global.total === _fgBase + 5000,
      JSON.stringify({ total: fg2.json?.global?.total, esperado: _fgBase + 5000 }).slice(0, 120));

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

    // v49/v50: 🌾 Robô "Vagas Novas H-2A" — ponta a ponta com o feed falso (o
    // caminho /h2a/ serve 14 vagas H-300 novas + 1 duplicada + 1 sem e-mail).
    // ENTRA ativa nova, SAI inativa (regra do dono: "planilha sempre completa").
    // O total esperado é calculado do PRÓPRIO bundle com a MESMA regra de
    // inatividade (status morto OU temporada encerrada) — independente da
    // data em que o teste rodar, e de o ciclo de boot já ter rodado ou não.
    const _h2aBundle = JSON.parse(fs.readFileSync(path.join(__dirname, "h2a_jun2026_compact.json"), "utf8"));
    const _hojeISO = new Date().toISOString().slice(0, 10);
    const _deadRe = /denied|withdrawn|invalidat|expired|cancel/i;
    const h2aVivas = _h2aBundle.filter((r) => !_deadRe.test(String(r.st || "")) && !(r.de && /^\d{4}-\d{2}-\d{2}$/.test(r.de) && r.de < _hojeISO)).length;
    const hn1 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: sincroniza — entram as 14 novas, saem as de temporada encerrada",
      hn1.json?.ok === true && hn1.json?.total === h2aVivas + 14 && (hn1.json?.added === 14 || hn1.json?.jaTinha >= 14),
      `esperado total=${h2aVivas + 14} | ` + hn1.body.slice(0, 160));
    const hn2 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: 2ª rodada não duplica NADA (0 novas, total estável)",
      hn2.json?.ok === true && hn2.json?.added === 0 && hn2.json?.jaTinha >= 14 && hn2.json?.total === h2aVivas + 14,
      hn2.body.slice(0, 160));
    // v50: feed passa a trazer a vaga 14 RETIRADA (withdrawn) — o robô tem
    // que atualizar o status e REMOVER exatamente ela da planilha.
    fs.writeFileSync(path.join(DATA, "h2a_feed_withdraw.flag"), "1");
    const hn3 = await req2("POST", "/api/admin/sheet/h2a-novas-run", {});
    check("🌾 Vagas Novas H-2A: vaga que virou 'withdrawn' no DOL é RETIRADA da planilha",
      hn3.json?.ok === true && hn3.json?.removidas === 1 && hn3.json?.atualizadas >= 1 && hn3.json?.total === h2aVivas + 13,
      hn3.body.slice(0, 160));
    fs.unlinkSync(path.join(DATA, "h2a_feed_withdraw.flag"));
    const slH2a = await get("/api/sheets-list");
    const _h2aRow = (slH2a.json?.sheets || []).find((x) => x.key === "h2a-jun2026");
    check("🌾 vagas novas H-2A já contam como disponíveis pros usuários (sem aba nova)",
      _h2aRow && _h2aRow.count === h2aVivas + 13 && _h2aRow.available >= 13, JSON.stringify(_h2aRow || {}).slice(0, 140));

    // v51 (dono): a H-2B mais NOVA (jul2026, semeada e publicada no boot) vem
    // PRIMEIRO na lista (o front a põe à esquerda com o selo MAIS NOVA) —
    // e quando a lista de janeiro sair, latestH2bKey() promove sozinha.
    check("⭐ H-2B mais nova (jul2026) vem PRIMEIRO na lista e marcada como latest",
      slH2a.json?.sheets?.[0]?.key === "jul2026" && slH2a.json.sheets[0].latest === true && slH2a.json?.latestH2b === "jul2026",
      JSON.stringify({ first: slH2a.json?.sheets?.[0]?.key, latestH2b: slH2a.json?.latestH2b }));
    // Planilhas antigas NÃO somem nunca — ficam publicadas pra sempre (regra
    // do dono); só o status delas deixa de ser conferido pelo robô Fresca.
    check("♾️ planilhas H-2B antigas continuam publicadas (ficam lá pra sempre)",
      ["jan2026", "jul2025"].every((k) => (slH2a.json?.sheets || []).some((s2) => s2.key === k)),
      (slH2a.json?.sheets || []).map((s2) => s2.key).join(", "));

    // ═══ v53: ORDEM DO DONO — "admin não paga, então admin NUNCA conta como
    // dinheiro". Pedido criado por uma conta da lista real de admins
    // (mod-config) não pode aparecer na Conferência nem somar na Visão do
    // Dono, e as contas de admin não podem poluir a tela de Duplicadas.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "ndrkick.2@gmail.com", name: "Andrio Kickhofel" });
    const pdAdm = await req2("POST", "/api/pedido", { plano: "vipro", dias: 30, valorTotal: 150, userName: "Andrio Kickhofel" });
    check("🚫 pedido de conta admin é criado normalmente (fluxo não quebra)", pdAdm.json?.ok === true || !!pdAdm.json?.pedidoId, pdAdm.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", name: "Smoke", isAdmin: true });
    const cfAdm = await get("/api/admin/conferencia");
    const _temAdmRow = (cfAdm.json?.rows || []).some((r) => String(r.email || "").toLowerCase() === "ndrkick.2@gmail.com");
    check("🚫 Conferência NÃO lista pedido de conta admin (admin não é receita)", cfAdm.json?.ok === true && !_temAdmRow, _temAdmRow ? "BUG: pedido do admin apareceu na Conferência" : "ok");
    // Neste ponto o ÚNICO pedido pendente do fixture é o do admin — com a
    // exclusão certa, a mesa do dono tem que estar zerada.
    const drAdm = await get("/api/admin/dono-resumo");
    check("🚫 Visão do Dono NÃO soma pedido pendente de admin na mesa",
      drAdm.json?.ok === true && (drAdm.json?.pendentes?.qtd || 0) === 0 && (drAdm.json?.pendentes?.valor || 0) === 0, JSON.stringify(drAdm.json?.pendentes));

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

    // ═══ 💎 v64: SISTEMA DE DIAMANTES — o novo caminho do dinheiro ═══
    // Doação PIX → admin aprova → 💎 REAIS; troca por plano ativa NA HORA
    // (sem lançar caixa de novo); só 💎 real transfere; bônus é gasto primeiro.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com", name: "Doador" });
    const dp1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 150, userName: "Doador", userWhatsapp: "53 9 9999-9999", userCity: "Pelotas" });
    const dpId = dp1.json?.pedidoId || dp1.json?.pedido?.id;
    check("💎 doação criada (R$150 → pedido tipo doacao)", dp1.json?.ok === true && !!dpId, dp1.body.slice(0, 140));
    const dmAntes = await get("/api/diamonds");
    check("💎 saldo começa zerado", dmAntes.json?.ok === true && dmAntes.json?.saldo?.real === 0 && dmAntes.json?.saldo?.bonus === 0, dp1.body.slice(0, 100));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpAct = await req2("PATCH", "/api/pedido/" + dpId, { status: "ativo" });
    check("💎 aprovação da doação credita 100 💎 REAIS (R$150 ÷ 1,50)", dpAct.json?.ok === true && dpAct.json?.diamantes === 100, dpAct.body.slice(0, 140));
    const finD = await get("/api/admin/financeiro");
    check("💎 doação aprovada lançou R$150 no livro-caixa", (finD.json?.pagamentos || []).some((x) => x.pedidoId === dpId && x.valor === 150));
    // bônus do admin: 20 💎 de brinde (intransferíveis, gastos primeiro)
    const admB = await req2("POST", "/api/admin/diamonds", { email: "doador@test.com", bonus: 20, nota: "brinde smoke" });
    check("💎 admin credita 20 💎 de brinde", admB.json?.ok === true && admB.json?.saldo?.bonus === 20, admB.body.slice(0, 100));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const dm1 = await get("/api/diamonds");
    check("💎 saldo do doador: 100 reais + 20 bônus", dm1.json?.saldo?.real === 100 && dm1.json?.saldo?.bonus === 20, JSON.stringify(dm1.json?.saldo));
    // transferir 30 💎 → só do REAL (bônus fica intocado)
    const tx1 = await req2("POST", "/api/diamonds/transfer", { para: "comprador@test.com", qtd: 30 });
    check("💎 transferência de 30 💎 sai SÓ do saldo real (bônus intacto)", tx1.json?.ok === true && tx1.json?.saldo?.real === 70 && tx1.json?.saldo?.bonus === 20, tx1.body.slice(0, 120));
    const txMuito = await req2("POST", "/api/diamonds/transfer", { para: "comprador@test.com", qtd: 999 });
    check("💎 transferir mais do que tem de REAL é barrado (402)", txMuito.status === 402, `status=${txMuito.status}`);
    // troca por plano: VIP 30d = 67 💎 (100/1,50) — gasta os 20 de bônus PRIMEIRO
    const tr1 = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("💎 troca por VIP 30d custa 67 💎 e ativa na hora", tr1.json?.ok === true && tr1.json?.preco === 67 && tr1.json?.saldo?.bonus === 0 && tr1.json?.saldo?.real === 23, tr1.body.slice(0, 140));
    const stD = await get("/api/status");
    check("💎 doador está VIP ativo depois da troca", stD.json?.plan === "vip" && stD.json?.vip?.active === true, JSON.stringify({ plan: stD.json?.plan, vip: !!stD.json?.vip?.active }));
    // a TROCA não pode lançar caixa de novo (o dinheiro entrou na doação)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com" });
    const finD3 = await get("/api/admin/financeiro");
    const entradasDoador = (finD3.json?.pagamentos || []).filter((x) => x.email === "doador@test.com");
    check("💎 troca por plano NÃO duplica o caixa (só a doação conta)", entradasDoador.length === 1, JSON.stringify(entradasDoador.map((x) => x.valor)));
    // saldo insuficiente é recusado com 402
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const tr2 = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 365 });
    check("💎 troca sem saldo suficiente → 402", tr2.status === 402, `status=${tr2.status}`);

    // ═══ 💎 v77 (dono, 28/07: "usuário comprou 250 reais em diamantes e
    // ativou o DoublePro, mas não aparece lá que ele está com o doublepro")
    // ═══════════════════════════════════════════════════════════════════
    // CAUSA RAIZ ACHADA: doação creditava 💎 com Math.floor(valorTotal÷1,5),
    // mas planoPrecoDiamantes() cobra o preço do plano com Math.round(). Pra
    // planos cujo preço em R$ não é múltiplo exato de 1,5 (DoublePro 30d =
    // R$250 = 166,67💎 "cru"), doar EXATAMENTE o valor de tabela do plano
    // creditava 166💎 (floor) mas o plano custava 167💎 (round) — 1💎 curto,
    // sem nenhum aviso claro, e o admin não tinha como enxergar isso na
    // hora (daí "não sei se tá funcionando"). Corrigido: doação agora usa a
    // MESMA regra (round) que o preço do plano — doar o valor de tabela de
    // qualquer plano sempre cobre EXATAMENTE aquele plano, nunca mais falta
    // 1💎 por causa de arredondamento diferente dos 2 lados da mesma conta.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doadorround@test.com", name: "Doador Round" });
    const dpR1 = await req2("POST", "/api/pedido", { tipo: "doacao", valorTotal: 250, userName: "Doador Round", userWhatsapp: "53 9 9999-9999", userCity: "Pelotas" });
    const dpRId = dpR1.json?.pedidoId || dpR1.json?.pedido?.id;
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpRAct = await req2("PATCH", "/api/pedido/" + dpRId, { status: "ativo" });
    check("💎 v77: doar EXATAMENTE o preço de tabela do DoublePro 30d (R$250) credita 167💎 (round), não mais 166 (floor)",
      dpRAct.json?.ok === true && dpRAct.json?.diamantes === 167, dpRAct.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doadorround@test.com" });
    const trDPR = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 30 });
    check("💎 v77: com o crédito corrigido, dá EXATAMENTE pra trocar por DoublePro 30d (sem faltar 1💎)",
      trDPR.json?.ok === true && trDPR.json?.preco === 167 && trDPR.json?.saldo?.real === 0, trDPR.body.slice(0, 160));

    // ═══ 💎 v77b (achado revisando o v77): corrigir o VALOR de uma doação
    // JÁ APROVADA atualizava o caixa mas nunca reajustava os diamantes já
    // creditados — mesma classe de bug do arredondamento (13f), só que
    // pelo caminho de CORREÇÃO manual em vez da aprovação original. Testa
    // as 2 rotas que corrigem valor (ambas usadas pelo admin.html): PATCH
    // /api/pedido/:id {corrigirValor} (Conferência) e POST
    // /api/admin/pedido-set-valor (tela de Pedidos). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    // doadorround está com saldo 0 (gastou os 167💎 no DoublePro) — corrige
    // o valor da doação pra CIMA (R$250→R$300, precisa de 200💎) e credita
    // a diferença (33💎) sem precisar de saldo prévio (crédito nunca falha).
    const corrPatch = await req2("PATCH", "/api/pedido/" + dpRId, { corrigirValor: 300 });
    check("💎 v77b: corrigirValor (Conferência) recalcula e credita a diferença de diamantes (+33💎)",
      corrPatch.json?.ok === true && corrPatch.json?.diamCorrecao?.aplicado === 33 && corrPatch.json?.diamCorrecao?.faltou === 0,
      corrPatch.body.slice(0, 200));
    const dmAfterUp = await get("/api/admin/diamonds/user/doadorround@test.com");
    check("💎 v77b: saldo do doadorround refletiu o +33💎 da correção pra cima", dmAfterUp.json?.saldo?.real === 33, JSON.stringify(dmAfterUp.json?.saldo));
    // corrige pra BAIXO agora (R$300→R$100, precisa só de 67💎) — tem que
    // remover 133💎, mas só sobram 33💎 no saldo (o resto já foi gasto no
    // DoublePro) — remove o que der (33) e ACUSA o que faltou (100), nunca
    // deixa saldo negativo.
    const corrPost = await req2("POST", "/api/admin/pedido-set-valor", { pedidoId: dpRId, valor: 100 });
    check("💎 v77b: pedido-set-valor remove o que der do saldo quando a correção pra baixo não cabe mais (33 removidos, 100 acusados como já gastos)",
      corrPost.json?.ok === true && corrPost.json?.diamCorrecao?.aplicado === -33 && corrPost.json?.diamCorrecao?.faltou === 100,
      corrPost.body.slice(0, 200));
    const dmAfterDown = await get("/api/admin/diamonds/user/doadorround@test.com");
    check("💎 v77b: saldo nunca fica negativo — foi a 0, não a -100", dmAfterDown.json?.saldo?.real === 0, JSON.stringify(dmAfterDown.json?.saldo));

    // ═══ 🛡️ v79 (Diego, 29/07 — áudio no WhatsApp: "ativei DoublePro pro
    // Esdras várias vezes e não entra, volta pro VipPro") ═══
    // CAUSA RAIZ: /api/admin/set-plan chamava addManualVipDays/addAutoVipDays
    // (que leem e gravam manualExpires/autoExpires atualizados) e DEPOIS
    // sobrescrevia o vip inteiro com um snapshot tirado ANTES dessas duas
    // chamadas — apagando silenciosamente os +30 dias que tinham acabado de
    // ser gravados. Corrigido: relê o usuário DEPOIS de addManualVipDays/
    // addAutoVipDays antes do setUser final. Este teste reproduz o cenário
    // exato: usuário com VipPro real e válido, admin faz upgrade pra
    // DoublePro — o autoExpires TEM que refletir os +30 dias novos, não
    // ficar travado na data antiga.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "esdras@test.com", name: "Esdras" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const setVipro = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "vipro" });
    check("🛡️ v79: set-plan ativa VipPro pra Esdras (estado inicial, igual o caso real)", setVipro.json?.ok === true, setVipro.body.slice(0, 140));
    const liveBefore = await get("/api/admin/live");
    const esdrasBefore = (liveBefore.json?.users || []).find((u) => u.email === "esdras@test.com");
    const autoExpiresAntes = esdrasBefore?.vip?.autoExpires || 0;
    check("🛡️ v79: Esdras está com VipPro ativo e autoExpires no futuro (~30d)", esdrasBefore?.plan === "vipro" && autoExpiresAntes > Date.now() + 25 * 86400_000, JSON.stringify({ plan: esdrasBefore?.plan, autoExpires: autoExpiresAntes }));
    // upgrade pra DoublePro — igual o Diego tentou fazer várias vezes
    const setDouble = await req2("POST", "/api/admin/set-plan", { email: "esdras@test.com", plan: "doublepro" });
    check("🛡️ v79: set-plan aceita o upgrade pra DoublePro", setDouble.json?.ok === true, setDouble.body.slice(0, 140));
    const liveAfter = await get("/api/admin/live");
    const esdrasAfter = (liveAfter.json?.users || []).find((u) => u.email === "esdras@test.com");
    check("🛡️ v79: DoublePro aparece pro admin logo depois de ativar (não volta pro VipPro)", esdrasAfter?.plan === "doublepro", JSON.stringify({ plan: esdrasAfter?.plan }));
    check("🛡️ v79: autoExpires foi EXTENDIDO pelos +30d novos, não ficou travado na data antiga do VipPro",
      esdrasAfter?.vip?.autoExpires > autoExpiresAntes + 25 * 86400_000,
      JSON.stringify({ antes: autoExpiresAntes, depois: esdrasAfter?.vip?.autoExpires, diffDias: Math.round(((esdrasAfter?.vip?.autoExpires || 0) - autoExpiresAntes) / 86400_000) }));
    // confirma pelo lado do PRÓPRIO usuário também (mesma checagem dupla do v77)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "esdras@test.com" });
    const stEsdras = await get("/api/status");
    check("🛡️ v79: /api/status do próprio Esdras também mostra DoublePro (nunca diverge do que o admin vê)", stEsdras.json?.plan === "doublepro" && stEsdras.json?.vip?.active === true, JSON.stringify({ plan: stEsdras.json?.plan }));
    // 🚨 ordem do dono (29/07, direto após o caso Esdras): "se a pessoa
    // comprou DoublePro tem que ter EXATAMENTE 400 manual + 400 auto — não
    // pode ficar com o limite de VipPro (200/200)". Antes desse fix, esse
    // usuário ficava com plan:"free" (0 de tudo) — pior ainda que 200/200.
    check("🚨 v79: Esdras com DoublePro tem EXATAMENTE 400 manual + 400 automático (não 200/200 do VipPro)",
      stEsdras.json?.manualLimit === 400 && stEsdras.json?.autoLimit === 400,
      JSON.stringify({ manualLimit: stEsdras.json?.manualLimit, autoLimit: stEsdras.json?.autoLimit }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // ═══ ⬆️ v80 (ordem do dono, 29/07): UPGRADE DE PLANO — quem já tem plano
    // pago ativo paga só a DIFERENÇA em 💎 (mesmo período) pra subir de tier
    // — NUNCA reinicia nem soma dias. Cobre exatamente os 3 requisitos do
    // dono: (1) desconta os diamantes certos, (2) dias continuam os mesmos,
    // (3) nunca duplica o caixa (upgrade é 100% em diamantes). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "upgradeuser@test.com", name: "Upgrade User" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const upTop = await req2("POST", "/api/admin/diamonds", { email: "upgradeuser@test.com", real: 300, nota: "top-up smoke upgrade" });
    check("⬆️ v80: top-up credita 300💎 pro teste de upgrade", upTop.json?.ok === true, upTop.body.slice(0, 120));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "upgradeuser@test.com" });
    // Começa no VIP 30d (67💎) — plano mais barato, só manual, SEM automático ainda.
    const upBuyVip = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("⬆️ v80: compra VIP 30d (67💎) pra começar o teste de upgrade", upBuyVip.json?.ok === true && upBuyVip.json?.preco === 67, upBuyVip.body.slice(0, 140));
    const stVipAntes = await get("/api/status");
    const manualExpiresAntes = stVipAntes.json?.vip?.manualExpires;
    check("⬆️ v80: VIP 30d ativo, SÓ manual (sem automático ainda)", stVipAntes.json?.plan === "vip" && manualExpiresAntes > Date.now() && !(stVipAntes.json?.vip?.autoExpires > Date.now()), JSON.stringify(stVipAntes.json?.vip));
    // Upgrade pra VIPRO — diferença: 100💎(vipro/30d) - 67💎(vip/30d) = 33💎
    const upgVipro = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: upgrade VIP→VIPRO cobra EXATAMENTE a diferença (33💎), não o preço cheio (100💎)", upgVipro.json?.ok === true && upgVipro.json?.diferenca === 33, upgVipro.body.slice(0, 160));
    const stVipro = await get("/api/status");
    check("⬆️ v80: upgrade NÃO mexeu no manualExpires — dias continuam EXATAMENTE os mesmos de antes", stVipro.json?.vip?.manualExpires === manualExpiresAntes, JSON.stringify({ antes: manualExpiresAntes, depois: stVipro.json?.vip?.manualExpires }));
    check("⬆️ v80: automático foi destravado pela 1ª vez, mas até a MESMA data do manual (nunca ganhou +30d novos)", stVipro.json?.vip?.autoExpires === manualExpiresAntes, JSON.stringify({ manualExpiresAntes, autoExpiresDepois: stVipro.json?.vip?.autoExpires }));
    check("⬆️ v80: plano e limites viraram VIPRO de verdade (200 manual + 200 auto)", stVipro.json?.plan === "vipro" && stVipro.json?.manualLimit === 200 && stVipro.json?.autoLimit === 200, JSON.stringify({ plan: stVipro.json?.plan, manualLimit: stVipro.json?.manualLimit, autoLimit: stVipro.json?.autoLimit }));
    // Upgrade de novo, VIPRO→DOUBLEPRO — diferença: 167💎(doublepro/30d) - 100💎(vipro/30d) = 67💎
    const upgDouble = await req2("POST", "/api/plans/upgrade", { novoPlano: "doublepro" });
    check("⬆️ v80: upgrade VIPRO→DOUBLEPRO cobra EXATAMENTE a diferença (67💎)", upgDouble.json?.ok === true && upgDouble.json?.diferenca === 67, upgDouble.body.slice(0, 160));
    const stDouble2 = await get("/api/status");
    check("⬆️ v80: 2º upgrade TAMBÉM não mexeu nos dias — manualExpires e autoExpires continuam os mesmos do início", stDouble2.json?.vip?.manualExpires === manualExpiresAntes && stDouble2.json?.vip?.autoExpires === manualExpiresAntes, JSON.stringify(stDouble2.json?.vip));
    check("⬆️ v80: agora com DoublePro de verdade — 400 manual + 400 automático (não ficou preso em 200/200)", stDouble2.json?.plan === "doublepro" && stDouble2.json?.manualLimit === 400 && stDouble2.json?.autoLimit === 400, JSON.stringify({ plan: stDouble2.json?.plan, manualLimit: stDouble2.json?.manualLimit, autoLimit: stDouble2.json?.autoLimit }));
    // Saldo final: 300 - 67(compra vip) - 33(upgrade vipro) - 67(upgrade doublepro) = 133
    const dmUpFinal = await get("/api/diamonds");
    check("⬆️ v80: saldo final bate exatamente com as 3 cobranças (300-67-33-67=133💎) — nada cobrado a mais ou a menos", dmUpFinal.json?.saldo?.real === 133, JSON.stringify(dmUpFinal.json?.saldo));
    // Downgrade/mesmo-tier tem que ser recusado
    const upSame = await req2("POST", "/api/plans/upgrade", { novoPlano: "doublepro" });
    check("⬆️ v80: 'upgrade' pro MESMO tier que já tem é recusado (400)", upSame.status === 400, `status=${upSame.status}`);
    const upDowngrade = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: 'upgrade' pra um tier INFERIOR é recusado (400) — upgrade não é downgrade disfarçado", upDowngrade.status === 400, `status=${upDowngrade.status}`);
    // Sem plano pago ativo não pode "upgradar"
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "semplano@test.com", name: "Sem Plano" });
    const upSemPlano = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: quem não tem plano pago ativo não consegue 'upgrade' (tem que comprar direto)", upSemPlano.status === 400, `status=${upSemPlano.status}`);
    // Saldo insuficiente pro upgrade → 402, educado
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pobreupgrade@test.com", name: "Pobre Upgrade" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const upPobreVip = await req2("POST", "/api/admin/set-plan", { email: "pobreupgrade@test.com", plan: "vip" }); // usa o admin (sem gastar diamante) só pra ter um VIP ativo
    check("⬆️ v80: (setup) admin ativou VIP pro teste de saldo insuficiente", upPobreVip.json?.ok === true, upPobreVip.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "pobreupgrade@test.com" });
    const upPobre = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("⬆️ v80: upgrade sem 💎 suficiente → 402 (nunca ativa de graça)", upPobre.status === 402, upPobre.body.slice(0, 160));
    // Financeiro (caixa) NUNCA recebe entrada nova por causa do upgrade —
    // upgrade é 100% em diamantes, dinheiro já entrou quando os 💎 foram doados.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const finUpgrade = await get("/api/admin/financeiro");
    const entradasUpgradeUser = (finUpgrade.json?.pagamentos || []).filter((x) => x.email === "upgradeuser@test.com");
    check("⬆️ v80: upgrade NUNCA lança entrada no caixa (100% diamantes — dinheiro já contou na doação original)", entradasUpgradeUser.length === 0, JSON.stringify(entradasUpgradeUser));

    // ═══ 💎 v81 (ordem do dono, 29/07/2026 — "eu e o Diego temos limite
    // infinito"): admin/DM pode testar troca/upgrade de plano GRÁTIS (só pra
    // testar a funcionalidade) — nunca desconta diamante de verdade, nunca
    // gera lançamento, nunca conta em nenhum agregado do site. MAS se o
    // admin DOAR diamantes pra um usuário de verdade, isso CONTA normal —
    // o destinatário recebe 💎 real de verdade e aparece no extrato como
    // doação do admin, sem descontar nada do admin (poço infinito). ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dmSaldoAntes = await get("/api/diamonds");
    check("💎 v81: admin começa com saldo 0 (nunca comprou nada de verdade)", dmSaldoAntes.json?.saldo?.real === 0 && dmSaldoAntes.json?.saldo?.bonus === 0, JSON.stringify(dmSaldoAntes.json?.saldo));
    check("💎 v81: /api/diamonds avisa 'diamantesInfinitos:true' pra conta admin", dmSaldoAntes.json?.diamantesInfinitos === true, JSON.stringify(dmSaldoAntes.json));
    const overviewAntes = await get("/api/admin/diamonds/overview");
    const gastoTrocaAntes = overviewAntes.json?.totals?.totalGastoEmTrocasPorPlano || 0;
    const transferAntes = overviewAntes.json?.totals?.totalTransferidoEntreUsuarios || 0;
    // Admin "compra" VIP 30d SEM ter diamante nenhum — tem que funcionar (é teste).
    const dmBuyVip = await req2("POST", "/api/diamonds/trocar", { plano: "vip", dias: 30 });
    check("💎 v81: admin com 0💎 consegue trocar por VIP mesmo assim (diamante infinito de teste)", dmBuyVip.json?.ok === true, dmBuyVip.body.slice(0, 160));
    check("💎 v81: saldo do admin continua EXATAMENTE 0 depois da troca — não gastou de verdade", dmBuyVip.json?.saldo?.real === 0 && dmBuyVip.json?.saldo?.bonus === 0, JSON.stringify(dmBuyVip.json?.saldo));
    const stDmVip = await get("/api/status");
    check("💎 v81: plano BRUTO do admin virou vip de verdade (vip.plan/manualExpires gravados)", stDmVip.json?.vip?.plan === "vip" && stDmVip.json?.vip?.manualExpires > Date.now(), JSON.stringify(stDmVip.json?.vip));
    const dmManualExpiresAntes = stDmVip.json?.vip?.manualExpires;
    const dmLedgerAposTroca = await get("/api/diamonds");
    check("💎 v81: NENHUM lançamento 'troca' no extrato do admin — teste não conta em lugar nenhum", !(dmLedgerAposTroca.json?.ledger || []).some((e) => e.tipo === "troca"), JSON.stringify(dmLedgerAposTroca.json?.ledger));
    // Upgrade também grátis, com os dias intocados (mesma regra do usuário normal)
    const dmUpgVipro = await req2("POST", "/api/plans/upgrade", { novoPlano: "vipro" });
    check("💎 v81: admin faz upgrade VIP→VIPRO de graça (0💎 cobrados de verdade)", dmUpgVipro.json?.ok === true, dmUpgVipro.body.slice(0, 160));
    const stDmVipro = await get("/api/status");
    check("💎 v81: upgrade do admin também preserva os dias (manualExpires intocado)", stDmVipro.json?.vip?.manualExpires === dmManualExpiresAntes && stDmVipro.json?.vip?.plan === "vipro", JSON.stringify(stDmVipro.json?.vip));
    const dmSaldoAposUpgrade = await get("/api/diamonds");
    check("💎 v81: saldo do admin AINDA é 0 depois do upgrade também — e nenhum lançamento 'upgrade' no extrato", dmSaldoAposUpgrade.json?.saldo?.real === 0 && !(dmSaldoAposUpgrade.json?.ledger || []).some((e) => e.tipo === "upgrade"), JSON.stringify(dmSaldoAposUpgrade.json));
    const overviewDepoisTroca = await get("/api/admin/diamonds/overview");
    check("💎 v81: troca/upgrade de teste do admin NÃO mexeu nos agregados do site (totalGastoEmTrocasPorPlano igual antes e depois)", (overviewDepoisTroca.json?.totals?.totalGastoEmTrocasPorPlano || 0) === gastoTrocaAntes, JSON.stringify({ antes: gastoTrocaAntes, depois: overviewDepoisTroca.json?.totals?.totalGastoEmTrocasPorPlano }));

    // Doação do admin pra usuário de verdade — ISSO conta.
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "receberadmin@test.com", name: "Recebe Doacao Admin" });
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dmDoa = await req2("POST", "/api/diamonds/transfer", { para: "receberadmin@test.com", qtd: 15 });
    check("💎 v81: admin doa 15💎 pra usuário real MESMO com saldo 0 (poço infinito, nunca bloqueia)", dmDoa.json?.ok === true, dmDoa.body.slice(0, 160));
    check("💎 v81: saldo do admin continua 0 depois de doar — a doação NUNCA sai do saldo dele", dmDoa.json?.saldo?.real === 0, JSON.stringify(dmDoa.json?.saldo));
    const dmLedgerAposDoacao = await get("/api/diamonds");
    const dmTransferOut = (dmLedgerAposDoacao.json?.ledger || []).find((e) => e.tipo === "transfer_out" && e.para === "receberadmin@test.com");
    check("💎 v81: extrato do PRÓPRIO admin registra a doação pra auditoria (qtd certa), mas com real:0 (não descontou de verdade)", !!dmTransferOut && dmTransferOut.qtd === -15 && dmTransferOut.real === 0, JSON.stringify(dmTransferOut));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "receberadmin@test.com" });
    const dmRecebeu = await get("/api/diamonds");
    check("💎 v81: destinatário recebeu 15💎 REAIS de verdade (pode gastar/repassar)", dmRecebeu.json?.saldo?.real === 15, JSON.stringify(dmRecebeu.json?.saldo));
    const dmTransferIn = (dmRecebeu.json?.ledger || []).find((e) => e.tipo === "transfer_in");
    check("💎 v81: extrato do destinatário mostra a doação atribuída CERTINHO ao e-mail do admin", dmTransferIn?.de === "smoke@test.com" && dmTransferIn?.qtd === 15, JSON.stringify(dmTransferIn));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const overviewDepoisDoacao = await get("/api/admin/diamonds/overview");
    check("💎 v81: doação do admin CONTA nos agregados do site (totalTransferidoEntreUsuarios subiu exatamente 15) — diferente da troca/upgrade de teste, essa é real",
      (overviewDepoisDoacao.json?.totals?.totalTransferidoEntreUsuarios || 0) === transferAntes + 15,
      JSON.stringify({ antes: transferAntes, depois: overviewDepoisDoacao.json?.totals?.totalTransferidoEntreUsuarios }));

    // ═══ GUARDA PONTA A PONTA da troca por DoublePro vista pelo lado do
    // ADMIN, não só pelo /api/status do próprio usuário (que já era testado
    // acima só pro plano vip). Cobre as 2 rotas que o painel admin realmente
    // usa (renderUsersTable via /api/admin/users e o polling de refreshAll
    // via /api/admin/live) — se getPlan()/isVipActive() divergirem entre o
    // que o usuário vê e o que o admin vê, esta guarda pega. ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const dpTop = await req2("POST", "/api/admin/diamonds", { email: "doador@test.com", real: 300, nota: "top-up smoke doublepro" });
    check("💎 v77: top-up admin credita 300 💎 reais pro teste de DoublePro", dpTop.json?.ok === true && dpTop.json?.saldo?.real === 323, dpTop.body.slice(0, 140));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "doador@test.com" });
    const trDP = await req2("POST", "/api/diamonds/trocar", { plano: "doublepro", dias: 30 });
    check("💎 v77: troca por DoublePro 30d custa 167 💎 e responde ok", trDP.json?.ok === true && trDP.json?.preco === 167 && trDP.json?.saldo?.real === 156, trDP.body.slice(0, 160));
    const stDP = await get("/api/status");
    check("💎 v77: /api/status (usuário) mostra plan=doublepro e vip ativo", stDP.json?.plan === "doublepro" && stDP.json?.vip?.active === true, JSON.stringify({ plan: stDP.json?.plan, vip: !!stDP.json?.vip?.active }));
    check("🚨 v77: quem trocou 💎 por DoublePro tem EXATAMENTE 400 manual + 400 automático (mesma régua do v79 pro caminho de diamantes)",
      stDP.json?.manualLimit === 400 && stDP.json?.autoLimit === 400,
      JSON.stringify({ manualLimit: stDP.json?.manualLimit, autoLimit: stDP.json?.autoLimit }));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const adUsers = await get("/api/admin/users");
    const doadorNaListaUsers = (adUsers.json?.users || []).find((u) => u.email === "doador@test.com");
    check("💎 v77: /api/admin/users (Todos Usuários) MOSTRA doublepro pro admin — o gap que o dono reportou",
      doadorNaListaUsers?.plan === "doublepro" && doadorNaListaUsers?.vip?.active === true,
      JSON.stringify({ plan: doadorNaListaUsers?.plan, vipActive: doadorNaListaUsers?.vip?.active, autoExpires: doadorNaListaUsers?.vip?.autoExpires }));
    const adLive = await get("/api/admin/live");
    const doadorNaListaLive = (adLive.json?.users || []).find((u) => u.email === "doador@test.com");
    check("💎 v77: /api/admin/live (Visão Geral/VIP & Planos) TAMBÉM mostra doublepro",
      doadorNaListaLive?.plan === "doublepro", JSON.stringify({ plan: doadorNaListaLive?.plan }));

    // ═══ 💎 v77: PAINEL COMPLETO DE DIAMANTES (ranking + extrato por usuário
    // + agregados) — ordem do dono: "quero ver quem tem mais diamantes, o
    // que qualquer usuário comprou, como foi usado, 20+ informações" ═══
    const dOver = await get("/api/admin/diamonds/overview");
    check("💎 v77: overview responde ok com os campos principais (totals/ranking/topDoadores/atividadeRecente)",
      dOver.json?.ok === true && dOver.json?.totals && Array.isArray(dOver.json?.ranking) && Array.isArray(dOver.json?.topDoadores) && Array.isArray(dOver.json?.atividadeRecente),
      dOver.body.slice(0, 200));
    check("💎 v77: ranking vem ordenado do MAIOR saldo pro menor",
      dOver.json.ranking.every((r, i, arr) => i === 0 || arr[i - 1].total >= r.total), JSON.stringify(dOver.json.ranking.slice(0, 5)));
    const doadorNoRanking = (dOver.json?.ranking || []).find((r) => r.email === "doador@test.com");
    check("💎 v77: doador@test.com aparece no ranking com o plano doublepro e saldo correto (156💎 real)",
      doadorNoRanking?.plano === "doublepro" && doadorNoRanking?.real === 156, JSON.stringify(doadorNoRanking));
    check("💎 v77: totals.usuariosComSaldo + usuariosSemSaldo bate com o total de usuários do servidor",
      dOver.json.totals.usuariosComSaldo + dOver.json.totals.usuariosSemSaldo === dOver.json.totals.usuariosTotal,
      JSON.stringify(dOver.json.totals));
    check("💎 v77: trocasPorPlano contabilizou as trocas de VIP e DoublePro feitas neste teste",
      dOver.json?.trocasPorPlano?.vip?.count >= 1 && dOver.json?.trocasPorPlano?.doublepro?.count >= 2,
      JSON.stringify(dOver.json?.trocasPorPlano));
    const doadorNoTop = (dOver.json?.topDoadores || []).find((r) => r.email === "doador@test.com");
    check("💎 v77: topDoadores lista doador@test.com com os 100💎 reais da doação original",
      doadorNoTop?.realDoado === 100, JSON.stringify(doadorNoTop));

    const dUserFicha = await get("/api/admin/diamonds/user/doador@test.com");
    check("💎 v77: ficha individual (/api/admin/diamonds/user/:email) mostra saldo, plano e extrato completo",
      dUserFicha.json?.ok === true && dUserFicha.json?.plano === "doublepro" && dUserFicha.json?.saldo?.real === 156 && Array.isArray(dUserFicha.json?.ledger) && dUserFicha.json.ledger.length >= 5,
      dUserFicha.body.slice(0, 200));
    const dUser404 = await get("/api/admin/diamonds/user/naoexiste@test.com");
    check("💎 v77: ficha de e-mail inexistente → 404 (não quebra, não inventa)", dUser404.status === 404);

    // não-admin NUNCA vê o painel de diamantes de todo mundo (dado financeiro sensível)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const dOverAsUser = await get("/api/admin/diamonds/overview");
    check("💎 v77: usuário comum recebe 403 no overview de diamantes (painel é admin-only)", dOverAsUser.status === 403);
    const dUserFichaAsUser = await get("/api/admin/diamonds/user/doador@test.com");
    check("💎 v77: usuário comum recebe 403 na ficha de diamantes de outra pessoa", dUserFichaAsUser.status === 403);
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });

    // quem recebeu a transferência pode gastar (30 💎 reais no comprador)
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "comprador@test.com" });
    const dmC = await get("/api/diamonds");
    check("💎 comprador recebeu os 30 💎 reais da transferência", dmC.json?.saldo?.real === 30, JSON.stringify(dmC.json?.saldo));

    // ═══ 🎁 v68: MISSÕES — recompensas em 💎 bônus (retroativas) ═══
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const ms1 = await get("/api/missions");
    const msPerfil = (ms1.json?.missoes || []).find((m) => m.id === "perfil_completo");
    check("🎁 /api/missions lista as 5 missões com progresso", ms1.json?.ok === true && (ms1.json?.missoes || []).length === 5, ms1.body.slice(0, 140));
    check("🎁 perfil completo (fixture tem perfil+CV) é premiado RETROATIVAMENTE", msPerfil?.done === true, JSON.stringify(msPerfil));
    const dmM = await get("/api/diamonds");
    check("🎁 missão creditou 💎 BÔNUS (intransferível, gasto primeiro)", (dmM.json?.saldo?.bonus || 0) >= 3 && (dmM.json?.ledger || []).some((l) => l.tipo === "missao"), JSON.stringify(dmM.json?.saldo));
    await get("/api/missions"); // reabrir a tela não pode pagar de novo
    const dmM2 = await get("/api/diamonds");
    check("🎁 missão paga UMA vez só (reabrir não duplica)", (dmM2.json?.saldo?.bonus || 0) === (dmM.json?.saldo?.bonus || 0), `antes=${dmM.json?.saldo?.bonus} depois=${dmM2.json?.saldo?.bonus}`);

    // ═══ 🗄️ v69: BACKUP ENTRE IRMÃOS — rota de recepção blindada ═══
    const zlibB = require("zlib");
    const _peerTokB = crypto.createHmac("sha256", "smoke-enc-key-1234567890").update("h2b-peer-financeiro-v1").digest("hex");
    const _gzB = zlibB.gzipSync(JSON.stringify({ v: 1, ts: 1, serverId: 1, files: { "financeiro.json": "{\"pagamentos\":[]}" } }));
    const rawPost = (p, buf, hdrs) => new Promise((resolve, reject) => {
      const r = http.request(BASE + p, { method: "POST", headers: { ...hdrs, "Content-Length": buf.length } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
      }); r.on("error", reject); r.write(buf); r.end();
    });
    const br403 = await rawPost("/api/servers/backup-receive", _gzB, { "x-backup-from": "1" });
    check("🗄️ backup-receive SEM token → 403 (dados nunca ficam públicos)", br403.status === 403, `status=${br403.status}`);
    const brOk = await rawPost("/api/servers/backup-receive", _gzB, { "x-peer-fin": _peerTokB, "x-backup-from": "1", "x-backup-stamp": "2026-07-26", "Content-Type": "application/gzip" });
    check("🗄️ backup do irmão é aceito e confirma os bytes", brOk.json?.ok === true && brOk.json?.bytes === _gzB.length, brOk.body.slice(0, 100));
    check("🗄️ blob gzip gravado no disco (backups_peers/srv1)", fs.existsSync(path.join(DATA, "backups_peers", "srv1", "2026-07-26.json.gz")));
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "smoke@test.com", isAdmin: true });
    const bst = await get("/api/admin/backup-peers");
    check("🗄️ admin vê o backup recebido na visão de status", bst.json?.ok === true && (bst.json?.recebidos || []).some((r) => r.de === "srv1"), bst.body.slice(0, 140));
    // DRILL DE RESTAURAÇÃO (regra da casa: ensaiada de verdade, nunca presumida)
    const { execSync: _exec } = require("child_process");
    const _restDir = path.join(DATA, "restaurado-drill");
    _exec(`node restaurar_backup_irmao.js "${path.join(DATA, "backups_peers", "srv1", "2026-07-26.json.gz")}" "${_restDir}"`, { cwd: __dirname, stdio: "pipe" });
    const _restOk = fs.existsSync(path.join(_restDir, "financeiro.json")) && fs.readFileSync(path.join(_restDir, "financeiro.json"), "utf8") === '{"pagamentos":[]}';
    check("🗄️ DRILL de restauração: 1 comando devolve os arquivos do pacote intactos", _restOk);

    // ═══ 🛡️ v73: AQUECIMENTO DE CONTA GMAIL NOVA (proteção anti-bloqueio) ═══
    // Pedido real do dono: "tem gente sendo bloqueada pelo Google". A defesa:
    // conta recém-conectada manda pouco nos primeiros dias, ganha volume aos
    // poucos — e uma conta suspensa isolada não trava as outras contas saudáveis.
    const { warmupCapForSender: _warmupFn, daysSince: _daysSinceFn } = require("./mod-engine-core.js");
    check("🌱 aquecimento: conta de HOJE (dia 0) tem teto de 15/dia", _warmupFn(new Date().toISOString()) === 15, `cap=${_warmupFn(new Date().toISOString())}`);
    check("🌱 aquecimento: conta de 4 dias tem teto de 40/dia", _warmupFn(Date.now() - 4 * 86400_000) === 40, `cap=${_warmupFn(Date.now() - 4 * 86400_000)}`);
    check("🌱 aquecimento: conta de 10 dias tem teto de 100/dia", _warmupFn(Date.now() - 10 * 86400_000) === 100, `cap=${_warmupFn(Date.now() - 10 * 86400_000)}`);
    check("🌱 aquecimento: conta de 20 dias já GRADUOU (sem teto extra, null)", _warmupFn(Date.now() - 20 * 86400_000) === null, `cap=${_warmupFn(Date.now() - 20 * 86400_000)}`);
    check("🌱 aquecimento: sem data conhecida (addedAt ausente) NUNCA bloqueia por falta de dado", _warmupFn(undefined) === null && _daysSinceFn(undefined) === Infinity);

    // Estrutural (mesmo padrão da checagem de escopo OAuth): confirma que a
    // defesa central existe no código-fonte — regressão aqui é séria
    // (usuário real ficando bloqueado pelo Google de novo).
    check("🛡️ getSenderToken PREFERE o pool dentro do teto de aquecimento (round-robin ainda evita conta em risco quando tem opção)",
      _srvSrc.includes("warmupCapForSender(c.addedAt)") && _srvSrc.includes("const withinWarmup"),
      "trecho warmupCapForSender/withinWarmup não encontrado");
    check("🛡️ conta suspensa (não-principal) é ISOLADA (blocked:true) e o automático CONTINUA pelas outras — não pausa tudo à toa",
      _srvSrc.includes('blocked:true,blockedReason:errType') && _srvSrc.includes("automático CONTINUA pelas outras contas"),
      "lógica de isolamento por sender não encontrada");

    // ═══ 🛡️ v76: aquecimento NUNCA mais pausa o automático (ordem do dono,
    // 27/07, cliente pago vendo "waiting_warmup" travado: "eu quero nao nunca
    // pare o automático") ═══ — o teto por conta virou preferência de
    // rodízio, não bloqueio: se TODAS as contas já bateram o teto de hoje,
    // usa a menos carregada mesmo assim e segue no intervalo normal, em vez
    // de pausar até amanhã.
    check("🛡️ round-robin não lança mais WARMUP_CAP_REACHED quando todas as contas estão no teto (usa o pool inteiro em vez de travar)",
      !_srvSrc.includes("else throw new Error(\"WARMUP_CAP_REACHED\")"),
      "ainda existe um throw incondicional de WARMUP_CAP_REACHED no round-robin");
    check("🛡️ status waiting_warmup (pausa de até 3h esperando o teto zerar) foi REMOVIDO do motor automático",
      !_srvSrc.includes('status:"waiting_warmup"'),
      "status waiting_warmup ainda sendo atribuído — automático ainda pode pausar por aquecimento");

    // ═══ 🛡️ v77c: BUG REAL achado revisando o v77b — /api/admin/pedido-set-valor
    // referenciava uma variável `body` que NUNCA existia no escopo (faltava
    // o readBody/JSON.parse). Sem try/catch ao redor, o ReferenceError
    // acontecia DENTRO do callback assíncrono do request handler e nunca
    // virava resposta HTTP — a requisição ficava PENDURADA PRA SEMPRE (o
    // admin via a tela girando; o smoke-test, que não tinha cobertura pra
    // essa rota antes do v77b, travou o processo inteiro por +40min até eu
    // achar). Guarda estrutural: confirma que a rota lê o body de verdade e
    // nunca mais referencia uma variável `body` não declarada.
    check("🛡️ /api/admin/pedido-set-valor lê o body de verdade (JSON.parse(await readBody)) — nunca mais trava a requisição pra sempre",
      !_srvSrc.includes("const {pedidoId,valor}=body;") && /pedido-set-valor[\s\S]{0,1200}?JSON\.parse\(await readBody\(req\)\)/.test(_srvSrc),
      "rota pedido-set-valor não encontrada lendo o body via readBody logo depois do pathname check, ou o padrão quebrado antigo voltou");

    // ═══ 🛡️ v75: rate limit do Google NÃO pausa mais o automático ═══
    // Ordem do dono (27/07): "automático só deve parar se o Google bloquear,
    // se não bloquear vai enviar sempre". Rate limit (429) é só o Google
    // pedindo pra desacelerar, não um bloqueio de verdade — antes disso
    // pausava a fila por até 12h ("O Google pediu uma pausa"); agora só
    // segue no intervalo humanizado normal, sem nunca atribuir o status
    // waiting_rate_limit de novo (suspensão/desativação de conta continua
    // pausando de verdade — isso É bloqueio real).
    check("🛡️ rate limit do Google não pausa mais a fila (só segue no intervalo normal)",
      _srvSrc.includes("Seguindo no ritmo normal — não é um bloqueio") && !_srvSrc.includes('status:"waiting_rate_limit"') && !_srvSrc.includes("status:'waiting_rate_limit'"),
      "mensagem nova não encontrada, ou status waiting_rate_limit ainda sendo atribuído em algum lugar");
    check("🛡️ bloqueio de verdade (conta suspensa/desativada) continua pausando — só o rate limit parou de pausar",
      _srvSrc.includes('errType === "suspended" || errType === "send_disabled"'));

    // ═══ 🎯 v74: RESPOSTAS CERTAS (admin-only, exceção isolada ao 13d) ═══
    // Sem ADMIN_REPLY_CLIENT_ID/SECRET nas envs de teste, a feature tem que
    // ficar 100% INERTE (nunca chama o Google) mas as rotas continuam
    // respondendo direito pro admin — é o comportamento "banner de setup".
    check("🎯 client OAuth de Respostas Certas é ISOLADO do CLIENT_ID público (nunca reaproveita)",
      _srvSrc.includes("ADMIN_REPLY_CLIENT_ID") && _srvSrc.includes("ADMIN_REPLY_CLIENT_SECRET") && _srvSrc.includes('ADMIN_REPLY_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.readonly"'),
      "consts ADMIN_REPLY_CLIENT_ID/SECRET/SCOPES não encontrados");
    check("🎯 rota OAuth de leitura é isolada da rota de login público (/oauth/admin-reply/*, nunca /oauth/callback)",
      _srvSrc.includes('"/oauth/admin-reply/start"') && _srvSrc.includes('"/oauth/admin-reply/callback"'));
    check("🎯 feedback do 👎 fica ISOLADO do DB_AI_KB (nunca vaza resposta privada pro IA Chat de outros usuários)",
      _srvSrc.includes("DB_REPLY_FEEDBACK") && !/DB_AI_KB\.entries\.(unshift|push)\(.*replyBody/.test(_srvSrc),
      "DB_REPLY_FEEDBACK não encontrado ou parece misturado com DB_AI_KB");
    const _rcBlockStart = _srvSrc.indexOf("RESPOSTAS CERTAS (admin-only) — OAuth de LEITURA isolado");
    const _rcBlockEnd = _srvSrc.indexOf("Admin: Central de Incidentes", _rcBlockStart);
    const _rcBlock = _rcBlockStart !== -1 && _rcBlockEnd !== -1 ? _srvSrc.slice(_rcBlockStart, _rcBlockEnd) : "";
    const _rcIsAdminCount = (_rcBlock.match(/isAdminVip\(p\)/g) || []).length;
    check("🎯 todas as rotas /api/admin/reply-triage/* checam isAdminVip antes de responder",
      _rcBlock && _rcIsAdminCount >= 5, `bloco encontrado=${!!_rcBlock}, isAdminVip(p) contado=${_rcIsAdminCount} (esperado >=5)`);

    const rcStatus = await get("/api/admin/reply-triage/status");
    check("🎯 /api/admin/reply-triage/status responde ok pro admin (sessão de teste tem isAdmin:true)",
      rcStatus.status === 200 && rcStatus.json?.ok === true, rcStatus.body.slice(0, 160));
    check("🎯 sem ADMIN_REPLY_CLIENT_ID/SECRET no ambiente de teste → configured:false (banner de setup, NUNCA chama o Google)",
      rcStatus.json?.configured === false, JSON.stringify(rcStatus.json));
    check("🎯 nenhuma conta conectada no fixture → accounts:[]",
      Array.isArray(rcStatus.json?.accounts) && rcStatus.json.accounts.length === 0);

    const rcList = await get("/api/admin/reply-triage/list");
    check("🎯 /api/admin/reply-triage/list responde ok e vazio (nada foi classificado ainda)",
      rcList.status === 200 && rcList.json?.ok === true && Array.isArray(rcList.json?.entries) && rcList.json.entries.length === 0,
      rcList.body.slice(0, 160));

    const rcScan = await req2("POST", "/api/admin/reply-triage/scan-now", {});
    check("🎯 scan-now recusa educadamente (não configurado no ambiente de teste) — nunca tenta chamar o Google sem client isolado",
      rcScan.status === 503 && /não configurado/i.test(rcScan.json?.error || ""), rcScan.body.slice(0, 160));

    // Ponta a ponta: /api/status expõe o campo primaryWarmup de verdade (o
    // fixture cliente@test.com não tem created_at → fail-open correto: sem
    // dado de quando a conta nasceu, NUNCA bloqueia por falta de informação
    // — comportamento de segurança, não um bug).
    await req2("POST", "/api/test/login", { token: TEST_TOKEN, email: "cliente@test.com" });
    const stW = await get("/api/status");
    check("🌱 /api/status expõe primaryWarmup (fail-open: sem created_at no fixture → sem teto, nunca bloqueia à toa)", stW.json?.primaryWarmup && stW.json.primaryWarmup.cap === null, JSON.stringify(stW.json?.primaryWarmup));

    // 🎯 usuário comum (não-admin) NUNCA acessa Respostas Certas — é dado
    // privado do admin (respostas de e-mail de outra pessoa).
    const rcAsUser = await get("/api/admin/reply-triage/status");
    check("🎯 usuário comum recebe 403 em Respostas Certas (aba é admin-only de verdade, não só escondida no menu)",
      rcAsUser.status === 403, rcAsUser.body.slice(0, 120));

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

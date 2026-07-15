/* ═══════════════════════════════════════════════════════════════════════
   🚀 mod-admin-v2.js — PAINEL ADMINISTRATIVO H2BApply v2 (backend)
   ─────────────────────────────────────────────────────────────────────────
   Novo grupo de rotas /api/admin/v2/* que alimenta o admin-v2.html.
   NÃO altera nenhuma rota antiga. Segue o contrato modular do projeto:

     createAdminV2Router(ctx) → async (req,res,pathname) →
       true  = rota tratada
       false = server segue o fluxo normal

   Entregas deste módulo:
   • AUDITORIA PERMANENTE  — todo ajuste administrativo gera registro
     imutável em /data/audit_v2.json (quem, quando, campo, valor anterior,
     valor novo, motivo, IP, dispositivo). Nunca é apagado.
   • DASHBOARD INTELIGENTE — cards de usuários, receita (dia/semana/mês/
     ano), pedidos pendentes, bots, e-mails, CPU/RAM/disco, alertas.
   • EDIÇÃO UNIVERSAL      — POST user/edit edita qualquer campo do
     usuário (inclui renomear e-mail com migração de todas as stores),
     exigindo apenas o nome do administrador responsável.
   • CORREÇÃO DE PAGAMENTO — fix-value corrige o valor no livro-caixa e
     no pedido de origem; receita/relatórios refletem na hora (fonte
     única já é DB_FINANCEIRO — lição KB-053).
   • CENTRO DE BOTS        — motor automático, coleta DOL, enriquecimento,
     watchdogs e sentinel numa única visão, com ações.
   • CENTRAL DE IA         — status Gemini, KB, modelos, sonda de latência.
   • CENTRAL DE LOGS       — envio, financeiro, administrativo, auditoria,
     com filtro, busca, paginação e export CSV.
   • FINANCEIRO/RELATÓRIOS — séries diárias/mensais, lucro, conversão.
   • BACKUP                — snapshot manual de /data, listagem e restore.
   • CONFIGURAÇÕES         — leitura/escrita central de admin_settings.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");

function createAdminV2Router(ctx){
  const {
    getSess, getUser, setUser, isAdminVip, isAdminEmail, json, readBody,
    DB_USERS, DB_HIST, DB_AUTO, DB_PEDIDOS, DB_FINANCEIRO, DB_LOGS, DB_KB,
    DB_NOTES, DB_ALERTS, DB_SHEETS_META,
    getPlan, getAutoJob, setAutoJob, getHist,
    persistUsers, persistPedidos, persistFinanceiro, persistAuto,
    DATA_DIR, getGeminiKey, scheduleAuto, httpsReq,
    ADMIN_SETTINGS, persistAdminSettings,
  } = ctx;

  /* ───────────────────────── Auditoria permanente ───────────────────── */
  const AUDIT_FILE = path.join(DATA_DIR, "audit_v2.json");
  let DB_AUDIT = [];
  try{ DB_AUDIT = JSON.parse(fs.readFileSync(AUDIT_FILE,"utf8")); if(!Array.isArray(DB_AUDIT)) DB_AUDIT=[]; }catch{ DB_AUDIT=[]; }
  let _auditTimer=null;
  function persistAudit(){
    clearTimeout(_auditTimer);
    _auditTimer=setTimeout(()=>{ try{
      const tmp=AUDIT_FILE+".tmp";
      fs.writeFileSync(tmp,JSON.stringify(DB_AUDIT));
      fs.renameSync(tmp,AUDIT_FILE);
    }catch(e){ console.warn("[audit-v2]",e.message); } },300);
  }
  function clientIp(req){
    return (req.headers["x-forwarded-for"]||"").split(",")[0].trim() || req.socket?.remoteAddress || "?";
  }
  function audit(req, entry){
    const rec = {
      id: crypto.randomBytes(6).toString("hex"),
      ts: Date.now(),
      admin: entry.admin || "?",
      sessionEmail: entry.sessionEmail || "",
      action: entry.action || "edit",
      target: entry.target || "",
      field: entry.field || "",
      oldValue: entry.oldValue===undefined ? null : entry.oldValue,
      newValue: entry.newValue===undefined ? null : entry.newValue,
      reason: entry.reason || "",
      note: entry.note || "",
      ip: clientIp(req),
      device: (req.headers["user-agent"]||"").slice(0,180),
    };
    DB_AUDIT.push(rec);
    persistAudit();
    return rec;
  }

  /* ─────────────────────────── Helpers ──────────────────────────────── */
  function requireAdmin(req,res){
    const s=getSess(req);
    if(!s?.user_email){ json(res,401,{error:"Não autenticado. Faça login pelo app e volte."}); return null; }
    const u=getUser(s.user_email);
    if(!isAdminVip(u)){ json(res,403,{error:"Acesso restrito a administradores."}); return null; }
    return s;
  }
  async function body(req){ try{ return JSON.parse((await readBody(req))||"{}"); }catch{ return null; } }

  const DAY=86400_000;
  function startOfDayBRT(ts){ const d=new Date(ts-3*3600_000); d.setUTCHours(0,0,0,0); return d.getTime()+3*3600_000; }
  function payTs(pg){ 
    const t=v=>{ if(!v)return 0; if(typeof v==="number")return v; const n=Date.parse(v); return isNaN(n)?0:n; };
    return t(pg.dataPagamento)||t(pg.data)||pg.criadoEm||pg.ts||0;
  }
  function payVal(pg){ const n=parseFloat(String(pg.valor??pg.value??0).replace(",","."));return isNaN(n)?0:n; }

  function getByPath(obj,p){ return p.split(".").reduce((o,k)=>o?.[k],obj); }
  const _DANGEROUS_KEYS=new Set(["__proto__","constructor","prototype"]);
  function setByPath(obj,p,v){
    const keys=p.split(".");
    // v18-SEC: bloqueia poluição de protótipo — nenhum segmento do path pode
    // ser __proto__/constructor/prototype, senão dá pra sobrescrever
    // Object.prototype (ex: isAdmin=true) e promover QUALQUER conta a admin,
    // já que quase todos os gates do servidor checam `p?.isAdmin`.
    if(keys.some(k=>_DANGEROUS_KEYS.has(k)))throw new Error("Caminho de configuração inválido.");
    const last=keys.pop();
    let o=obj; for(const k of keys){ if(typeof o[k]!=="object"||o[k]===null)o[k]={}; o=o[k]; }
    o[last]=v;
  }
  function coerce(value){
    if(value==="true")return true; if(value==="false")return false;
    if(value===null||value===undefined||value==="")return value;
    if(typeof value==="string"&&/^-?\d+(\.\d+)?$/.test(value.trim()))return parseFloat(value);
    return value;
  }

  // cache leve p/ métricas caras
  let _dashCache=null,_dashCacheTs=0;

  function flatSendLogs(limit){
    const out=[];
    const L=DB_LOGS()||{};
    for(const [email,arr] of Object.entries(L)){
      if(!Array.isArray(arr))continue;
      for(const r of arr) out.push({...r,email});
    }
    out.sort((a,b)=>(b.ts||0)-(a.ts||0));
    return limit?out.slice(0,limit):out;
  }

  /* ═══════════════════════════ ROUTER ════════════════════════════════ */
  return async function handleAdminV2Routes(req,res,pathname){
    if(!pathname.startsWith("/api/admin/v2/")) return false;
    const s=requireAdmin(req,res); if(!s) return true;
    const route=pathname.slice("/api/admin/v2/".length);
    const now=Date.now();

    /* ── DASHBOARD ──────────────────────────────────────────────────── */
    if(route==="dashboard"&&req.method==="GET"){
      if(_dashCache && now-_dashCacheTs<15_000){ json(res,200,_dashCache); return true; }
      const users=Object.values(DB_USERS()||{});
      const auto=DB_AUTO()||{};
      const pedidos=DB_PEDIDOS()||[];
      const fin=DB_FINANCEIRO()||{pagamentos:[],gastos:[]};
      const today0=startOfDayBRT(now);
      const week0=today0-6*DAY;
      const month0=(()=>{const d=new Date(now-3*3600_000);d.setUTCDate(1);d.setUTCHours(0,0,0,0);return d.getTime()+3*3600_000;})();
      const year0=(()=>{const d=new Date(now-3*3600_000);d.setUTCMonth(0,1);d.setUTCHours(0,0,0,0);return d.getTime()+3*3600_000;})();

      let revDay=0,revWeek=0,revMonth=0,revYear=0,revTotal=0;
      const daily={}; // últimos 30 dias p/ gráfico
      for(const pg of (fin.pagamentos||[])){
        const ts=payTs(pg),v=payVal(pg); if(!v)continue;
        revTotal+=v;
        if(ts>=today0)revDay+=v;
        if(ts>=week0)revWeek+=v;
        if(ts>=month0)revMonth+=v;
        if(ts>=year0)revYear+=v;
        if(ts>=today0-29*DAY){ const k=new Date(ts-3*3600_000).toISOString().slice(0,10); daily[k]=(daily[k]||0)+v; }
      }
      const revSeries=[]; for(let i=29;i>=0;i--){const k=new Date(today0-3*3600_000-i*DAY).toISOString().slice(0,10);revSeries.push({d:k.slice(5),v:Math.round((daily[k]||0)*100)/100});}

      // e-mails enviados hoje/mês + envios por dia (7d)
      let mailsToday=0, mailsMonth=0, jobsSentTotal=0;
      const sends7={}; 
      for(const arr of Object.values(DB_LOGS()||{})){
        if(!Array.isArray(arr))continue;
        for(const r of arr){
          if(r.status&&String(r.status).startsWith("erro"))continue;
          const ts=r.ts||0; jobsSentTotal++;
          if(ts>=today0)mailsToday++;
          if(ts>=month0)mailsMonth++;
          if(ts>=today0-6*DAY){const k=new Date(ts-3*3600_000).toISOString().slice(0,10);sends7[k]=(sends7[k]||0)+1;}
        }
      }
      const sendSeries=[];for(let i=6;i>=0;i--){const k=new Date(today0-3*3600_000-i*DAY).toISOString().slice(0,10);sendSeries.push({d:k.slice(5),v:sends7[k]||0});}

      const jobs=Object.entries(auto);
      const botsActive=jobs.filter(([,j])=>j?.active&&!String(j.status||"").startsWith("paused")).length;
      const botsPaused=jobs.filter(([,j])=>String(j?.status||"").startsWith("paused")).length;
      const botsError=jobs.filter(([,j])=>j?.status==="paused_auth_error"||j?.status==="paused_corrupt_queue").length;

      const vips=users.filter(u=>{const v=u.vip;return v&&(Math.max(v.manualExpires||0,v.autoExpires||0)>now);});
      const online=users.filter(u=>(u.lastSeen||u.last_seen||0)>now-10*60_000).length;
      const news7=users.filter(u=>Date.parse(u.created_at||0)>now-7*DAY).length;
      const pendentes=pedidos.filter(p=>p.status==="pendente");
      const criticos=pendentes.filter(p=>now-(p.createdAt||0)>24*3600_000);

      // sistema
      let disk=null; try{ const st=fs.statfsSync(DATA_DIR); disk={freeGB:+(st.bavail*st.bsize/1e9).toFixed(2), totalGB:+(st.blocks*st.bsize/1e9).toFixed(2)}; }catch{}
      const mem={usedMB:Math.round((os.totalmem()-os.freemem())/1e6), totalMB:Math.round(os.totalmem()/1e6)};
      const load=os.loadavg()[0];
      const sheetsMeta=DB_SHEETS_META?DB_SHEETS_META():{};
      let totalVagas=0; try{ for(const m of Object.values(sheetsMeta||{})) totalVagas+=(m.count||0); }catch{}

      const payload={
        ok:true, ts:now,
        cards:{
          usuarios:{ total:users.length, online, novos7d:news7, vips:vips.length },
          receita:{ dia:revDay, semana:revWeek, mes:revMonth, ano:revYear, total:revTotal },
          pedidos:{ pendentes:pendentes.length, criticos:criticos.length, total:pedidos.length },
          bots:{ ativos:botsActive, pausados:botsPaused, erros:botsError, total:jobs.length },
          emails:{ hoje:mailsToday, mes:mailsMonth, total:jobsSentTotal },
          vagas:{ extras:totalVagas },
          sistema:{ cpuLoad:+load.toFixed(2), cpus:os.cpus().length, mem, disk, uptimeH:+(process.uptime()/3600).toFixed(1), node:process.version },
          ia:{ kbEntries:(DB_KB()?.entries||[]).length, keyOk:!!(getGeminiKey&&getGeminiKey()) },
        },
        graficos:{ receita30d:revSeries, envios7d:sendSeries },
        alertas:[
          ...(criticos.length?[{tipo:"pedido",nivel:"alto",msg:`${criticos.length} pedido(s) pendente(s) há mais de 24h`}]:[]),
          ...(botsError?[{tipo:"bot",nivel:"alto",msg:`${botsError} robô(s) com erro de autenticação/fila`}]:[]),
          ...(vips.filter(u=>{const e=Math.max(u.vip?.manualExpires||0,u.vip?.autoExpires||0);return e>now&&e<now+3*DAY;}).length?[{tipo:"vip",nivel:"medio",msg:"VIPs vencendo em até 3 dias"}]:[]),
        ],
        auditRecent:DB_AUDIT.slice(-12).reverse(),
        logsRecent:flatSendLogs(12),
      };
      _dashCache=payload;_dashCacheTs=now;
      json(res,200,payload); return true;
    }

    /* ── USUÁRIOS: lista paginada com busca/ordenação ───────────────── */
    if(route==="users"&&req.method==="GET"){
      const u=new URL(req.url,"http://x");
      const q=(u.searchParams.get("q")||"").toLowerCase();
      const sort=u.searchParams.get("sort")||"created_desc";
      const page=Math.max(1,parseInt(u.searchParams.get("page")||"1"));
      const per=Math.min(100,Math.max(5,parseInt(u.searchParams.get("per")||"25")));
      const fPlan=u.searchParams.get("plan")||"";
      let list=Object.values(DB_USERS()||{}).map(x=>{
        const job=getAutoJob(x.email);
        const exp=Math.max(x.vip?.manualExpires||0,x.vip?.autoExpires||0);
        return {
          email:x.email,name:x.name||"",picture:x.picture||"",phone:x.phone||"",
          created_at:x.created_at||null, lastSeen:x.lastSeen||x.last_seen||0,
          plan:getPlan(x), vipExpira:exp||null, vipAtivo:exp>now,
          diasRestantes:exp>now?Math.ceil((exp-now)/DAY):0,
          cvCount:(x.cvs||[]).length, isAdmin:!!x.isAdmin,
          tags:x.tagsAdmin||[], bot:job?{active:!!job.active,status:job.status||"",fila:job.queue?.length||0}:null,
        };
      });
      if(q)list=list.filter(x=>x.email.toLowerCase().includes(q)||x.name.toLowerCase().includes(q)||(x.phone||"").includes(q));
      if(fPlan)list=list.filter(x=>x.plan===fPlan);
      const sorters={
        created_desc:(a,b)=>Date.parse(b.created_at||0)-Date.parse(a.created_at||0),
        created_asc:(a,b)=>Date.parse(a.created_at||0)-Date.parse(b.created_at||0),
        name:(a,b)=>a.name.localeCompare(b.name),
        vip_desc:(a,b)=>(b.vipExpira||0)-(a.vipExpira||0),
        seen_desc:(a,b)=>(b.lastSeen||0)-(a.lastSeen||0),
      };
      list.sort(sorters[sort]||sorters.created_desc);
      const total=list.length;
      json(res,200,{ok:true,total,page,per,pages:Math.ceil(total/per),users:list.slice((page-1)*per,page*per)});
      return true;
    }

    /* ── USUÁRIO: página completa (perfil 360°) ─────────────────────── */
    if(route==="user"&&req.method==="GET"){
      const u=new URL(req.url,"http://x");
      const email=(u.searchParams.get("email")||"").trim().toLowerCase();
      const usr=getUser(email);
      if(!usr){json(res,404,{error:"Usuário não encontrado."});return true;}
      const hist=getHist(email)||[];
      const job=getAutoJob(email);
      const pedidos=(DB_PEDIDOS()||[]).filter(p=>String(p.email||"").toLowerCase()===email);
      const pags=((DB_FINANCEIRO()||{}).pagamentos||[]).filter(p=>String(p.email||"").toLowerCase()===email);
      const auditUser=DB_AUDIT.filter(a=>a.target===email).slice(-100).reverse();
      const exp=Math.max(usr.vip?.manualExpires||0,usr.vip?.autoExpires||0);
      const t0=startOfDayBRT(now);
      const enviadosHoje=hist.filter(h=>(h.ts||0)>=t0).length;
      const enviados30=hist.filter(h=>(h.ts||0)>=t0-29*DAY).length;
      json(res,200,{ok:true,user:{
        email:usr.email,name:usr.name,picture:usr.picture,phone:usr.phone||"",country:usr.country||"",
        created_at:usr.created_at,lastSeen:usr.lastSeen||usr.last_seen||0,
        plan:getPlan(usr),planRaw:usr.plan||"free",isAdmin:!!usr.isAdmin,
        vip:usr.vip||null,vipAtivo:exp>now,diasRestantes:exp>now?Math.ceil((exp-now)/DAY):0,
        cvs:(usr.cvs||[]).map(c=>({name:c.name||c.filename||"cv",size:c.size||null})),
        profiles:(usr.profiles||[]).map(p=>({name:p.name||"",email:p.email||""})),
        senderEmails:(usr.senderEmails||[]).map(x=>x.email||x),
        googleConectado:!!usr.refresh_token,
        settings:usr.settings||{},
        tagsAdmin:usr.tagsAdmin||[],obsAdmin:usr.obsAdmin||"",
        adminEditHistory:(usr.adminEditHistory||[]).slice(-30).reverse(),
      },
      stats:{enviadosHoje,enviados30,totalEnviados:hist.length},
      bot:job?{active:!!job.active,status:job.status,fila:job.queue?.length||0,source:job.source||"",stats:job.stats||null}:null,
      envios:hist.slice(-60).reverse(),
      pedidos:pedidos.map(p=>({id:p.id,plan:p.plan,valor:p.valor,status:p.status,createdAt:p.createdAt})),
      pagamentos:pags.map(p=>({id:p.id,valor:payVal(p),data:payTs(p),plano:p.plano||p.plan||"",source:p.source||""})),
      auditoria:auditUser});
      return true;
    }

    /* ── EDIÇÃO UNIVERSAL (só exige nome do admin) ──────────────────── */
    if(route==="user/edit"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const email=(b.email||"").trim().toLowerCase();
      const field=(b.field||"").trim();
      const adminName=(b.adminName||"").trim();
      if(!email||!field){json(res,400,{error:"Informe email e field."});return true;}
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      const usr=getUser(email);
      if(!usr){json(res,404,{error:"Usuário não encontrado."});return true;}
      const value=coerce(b.value);

      // Renomear e-mail = migração completa de stores
      if(field==="email"){
        const novo=String(value||"").trim().toLowerCase();
        if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(novo)){json(res,400,{error:"E-mail novo inválido."});return true;}
        if(getUser(novo)){json(res,409,{error:"Já existe usuário com esse e-mail."});return true;}
        const U=DB_USERS(),H=DB_HIST?DB_HIST():null,A=DB_AUTO(),L=DB_LOGS();
        usr.email=novo; U[novo]=usr; delete U[email];
        if(H&&H[email]){H[novo]=H[email];delete H[email];}
        if(A[email]){A[novo]=A[email];delete A[email];}
        if(L&&L[email]){L[novo]=L[email];delete L[email];}
        persistUsers&&persistUsers(); persistAuto&&persistAuto();
        audit(req,{admin:adminName,sessionEmail:s.user_email,action:"rename_email",target:email,field:"email",oldValue:email,newValue:novo,reason:b.reason||"",note:b.note||""});
        json(res,200,{ok:true,email:novo,msg:"E-mail renomeado e stores migradas."});
        return true;
      }

      const oldValue=getByPath(usr,field);
      // v18-SEC: setByPath pode lançar se o path tentar poluir o protótipo —
      // NUNCA deixar essa exceção subir sem resposta (handler http.createServer
      // sem try/catch = requisição pendurada pra sempre, ver lição KB no topo do server.js).
      try{ setByPath(usr,field,value); }catch(e){ json(res,400,{error:e.message}); return true; }
      // rastro no formato legado também (compatibilidade com painel antigo)
      usr.adminEditHistory=[...(usr.adminEditHistory||[]).slice(-49),{ts:now,admin:adminName,field,old:oldValue,novo:value,motivo:b.reason||""}];
      setUser(email,usr);
      const rec=audit(req,{admin:adminName,sessionEmail:s.user_email,action:"user_edit",target:email,field,oldValue,newValue:value,reason:b.reason||"",note:b.note||""});
      json(res,200,{ok:true,field,oldValue,newValue:value,audit:rec.id});
      return true;
    }

    /* ── CORREÇÃO DE VALOR DE PAGAMENTO (propaga tudo) ──────────────── */
    if(route==="payment/fix-value"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const adminName=(b.adminName||"").trim();
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      const novoValor=parseFloat(String(b.valor).replace(",","."));
      if(isNaN(novoValor)||novoValor<0){json(res,400,{error:"Valor inválido."});return true;}
      const fin=DB_FINANCEIRO();
      const pg=(fin.pagamentos||[]).find(x=>String(x.id)===String(b.id));
      if(!pg){json(res,404,{error:"Pagamento não encontrado no livro-caixa."});return true;}
      const antigo=payVal(pg);
      pg.valor=novoValor;
      pg.corrigidoPor=adminName; pg.corrigidoEm=now;
      // propaga ao pedido de origem, se houver
      let pedidoAtualizado=null;
      if(pg.pedidoId){
        const pd=(DB_PEDIDOS()||[]).find(x=>String(x.id)===String(pg.pedidoId));
        if(pd){pd.valor=novoValor;pedidoAtualizado=pd.id;}
      }
      persistFinanceiro&&persistFinanceiro(); persistPedidos&&persistPedidos();
      _dashCache=null; // receita reflete imediatamente
      const rec=audit(req,{admin:adminName,sessionEmail:s.user_email,action:"payment_fix",target:String(pg.email||""),field:`pagamento:${pg.id}.valor`,oldValue:antigo,newValue:novoValor,reason:b.reason||"correção de valor",note:pedidoAtualizado?`pedido ${pedidoAtualizado} atualizado junto`:""});
      json(res,200,{ok:true,id:pg.id,antigo,novo:novoValor,pedidoAtualizado,audit:rec.id});
      return true;
    }

    /* ── AUDITORIA: consulta (nunca apaga) ──────────────────────────── */
    if(route==="audit"&&req.method==="GET"){
      const u=new URL(req.url,"http://x");
      const q=(u.searchParams.get("q")||"").toLowerCase();
      const page=Math.max(1,parseInt(u.searchParams.get("page")||"1"));
      const per=Math.min(100,parseInt(u.searchParams.get("per")||"30"));
      let list=[...DB_AUDIT].reverse();
      if(q)list=list.filter(a=>JSON.stringify(a).toLowerCase().includes(q));
      json(res,200,{ok:true,total:list.length,page,per,items:list.slice((page-1)*per,page*per)});
      return true;
    }

    /* ── CENTRO DE BOTS ─────────────────────────────────────────────── */
    if(route==="bots"&&req.method==="GET"){
      const auto=DB_AUTO()||{};
      const jobs=Object.entries(auto).map(([email,j])=>({
        email,active:!!j.active,status:j.status||"?",fila:j.queue?.length||0,
        source:j.source||"",enviadosHoje:j.stats?.today||j.todayCount||null,lastSend:j.lastSendTs||j.lastSend||0,
      }));
      const byStatus={};for(const j of jobs)byStatus[j.status]=(byStatus[j.status]||0)+1;
      json(res,200,{ok:true,
        motorAuto:{total:jobs.length,byStatus,jobs:jobs.sort((a,b)=>(b.lastSend||0)-(a.lastSend||0)).slice(0,300)},
        coletaDOL:global._dolBuildStatus||global._buildStatus||{estado:"parado"},
        enriquecimento:global._enrichStatus||{estado:"parado"},
        sentinel:global._healthSentinel||null,
      });
      return true;
    }
    if(route==="bots/action"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const adminName=(b.adminName||"").trim();
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      const email=(b.email||"").trim().toLowerCase();
      const action=b.action;
      const job=getAutoJob(email);
      if(!job){json(res,404,{error:"Robô não encontrado para este usuário."});return true;}
      const before=job.status;
      if(action==="stop"){ setAutoJob(email,{active:false,status:"parado_admin"}); }
      else if(action==="pause"){ setAutoJob(email,{status:"paused"}); }
      else if(action==="restart"){
        setAutoJob(email,{active:true,status:"resuming",lastError:null});
        try{ scheduleAuto&&scheduleAuto(email,3000); }catch(e){ console.warn("[v2 bots]",e.message); }
      } else { json(res,400,{error:"Ação inválida (stop|pause|restart)."}); return true; }
      audit(req,{admin:adminName,sessionEmail:s.user_email,action:"bot_"+action,target:email,field:"auto.status",oldValue:before,newValue:getAutoJob(email)?.status,reason:b.reason||""});
      json(res,200,{ok:true,email,status:getAutoJob(email)?.status});
      return true;
    }

    /* ── CENTRAL DE IA ──────────────────────────────────────────────── */
    if(route==="ai"&&req.method==="GET"){
      const kb=DB_KB()||{entries:[]};
      json(res,200,{ok:true,provedores:[{
        nome:"Gemini",ativo:!!(getGeminiKey&&getGeminiKey()),
        modelos:["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash (Vision)"],
        usos:["Chat/assistente","Pré-check de comprovante (Vision)","Auditoria","Cover letter"],
      }],
      kb:{entradas:kb.entries.length,ultimas:kb.entries.slice(-5).map(e=>({id:e.id,titulo:e.titulo||e.problema?.slice(0,80)}))}});
      return true;
    }
    if(route==="ai/probe"&&req.method==="POST"){
      const key=getGeminiKey&&getGeminiKey();
      if(!key){json(res,200,{ok:false,error:"Chave Gemini ausente."});return true;}
      const t0=Date.now();
      try{
        const r=await httpsReq({hostname:"generativelanguage.googleapis.com",path:`/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,method:"POST",headers:{"Content-Type":"application/json"}},JSON.stringify({contents:[{parts:[{text:"responda apenas: ok"}]}]}));
        json(res,200,{ok:true,latenciaMs:Date.now()-t0,status:r.status||r.statusCode||200});
      }catch(e){json(res,200,{ok:false,latenciaMs:Date.now()-t0,error:e.message});}
      return true;
    }

    /* ── CENTRAL DE LOGS ────────────────────────────────────────────── */
    if(route==="logs"&&req.method==="GET"){
      const u=new URL(req.url,"http://x");
      const tipo=u.searchParams.get("tipo")||"envios";
      const q=(u.searchParams.get("q")||"").toLowerCase();
      const page=Math.max(1,parseInt(u.searchParams.get("page")||"1"));
      const per=Math.min(200,parseInt(u.searchParams.get("per")||"50"));
      const csv=u.searchParams.get("csv")==="1";
      let items=[];
      if(tipo==="envios") items=flatSendLogs(5000).map(r=>({ts:r.ts,email:r.email,para:r.to,status:r.status,vaga:r.jobTitle,empresa:r.company,tipo:r.type||r.mode||""}));
      else if(tipo==="financeiro"){const fin=DB_FINANCEIRO()||{};items=[...(fin.pagamentos||[]).map(p=>({ts:payTs(p),email:p.email,evento:"pagamento",valor:payVal(p),detalhe:p.plano||p.plan||"",id:p.id})),...(fin.gastos||[]).map(g=>({ts:payTs(g),email:g.pagoPor||"",evento:"gasto",valor:-payVal(g),detalhe:g.descricao||g.desc||"",id:g.id}))].sort((a,b)=>b.ts-a.ts);}
      else if(tipo==="auditoria") items=[...DB_AUDIT].reverse();
      else if(tipo==="pedidos") items=(DB_PEDIDOS()||[]).map(p=>({ts:p.createdAt,email:p.email,plano:p.plan,valor:p.valor,status:p.status,id:p.id})).sort((a,b)=>(b.ts||0)-(a.ts||0));
      if(q)items=items.filter(x=>JSON.stringify(x).toLowerCase().includes(q));
      if(csv){
        const cols=items.length?Object.keys(items[0]):[];
        const esc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
        const body=[cols.join(";"),...items.slice(0,20000).map(r=>cols.map(c=>esc(r[c])).join(";"))].join("\n");
        res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="logs_${tipo}.csv"`});
        res.end("\uFEFF"+body); return true;
      }
      json(res,200,{ok:true,tipo,total:items.length,page,per,items:items.slice((page-1)*per,page*per)});
      return true;
    }

    /* ── FINANCEIRO ─────────────────────────────────────────────────── */
    if(route==="finance"&&req.method==="GET"){
      const fin=DB_FINANCEIRO()||{pagamentos:[],gastos:[]};
      const meses={};
      let receita=0,despesa=0;
      for(const p of fin.pagamentos||[]){const v=payVal(p);receita+=v;const k=new Date(payTs(p)-3*3600_000).toISOString().slice(0,7);(meses[k]=meses[k]||{r:0,g:0}).r+=v;}
      for(const g of fin.gastos||[]){const v=payVal(g);despesa+=v;const k=new Date(payTs(g)-3*3600_000).toISOString().slice(0,7);(meses[k]=meses[k]||{r:0,g:0}).g+=v;}
      const serie=Object.entries(meses).sort(([a],[b])=>a.localeCompare(b)).slice(-12).map(([m,x])=>({m,receita:+x.r.toFixed(2),despesa:+x.g.toFixed(2),lucro:+(x.r-x.g).toFixed(2)}));
      json(res,200,{ok:true,receita:+receita.toFixed(2),despesa:+despesa.toFixed(2),lucro:+(receita-despesa).toFixed(2),
        pagamentos:(fin.pagamentos||[]).slice().sort((a,b)=>payTs(b)-payTs(a)).slice(0,500).map(p=>({id:p.id,email:p.email,valor:payVal(p),data:payTs(p),plano:p.plano||p.plan||"",source:p.source||"",pedidoId:p.pedidoId||null,corrigidoPor:p.corrigidoPor||null})),
        gastos:(fin.gastos||[]).slice().sort((a,b)=>payTs(b)-payTs(a)).slice(0,300).map(g=>({id:g.id,desc:g.descricao||g.desc||"",valor:payVal(g),data:payTs(g),pagoPor:g.pagoPor||""})),
        serieMensal:serie});
      return true;
    }

    /* ── RELATÓRIOS ─────────────────────────────────────────────────── */
    if(route==="reports"&&req.method==="GET"){
      const users=Object.values(DB_USERS()||{});
      const fin=DB_FINANCEIRO()||{pagamentos:[]};
      const pedidos=DB_PEDIDOS()||[];
      const planos={};for(const u of users){const p=getPlan(u);planos[p]=(planos[p]||0)+1;}
      const pagantes=new Set((fin.pagamentos||[]).map(p=>String(p.email||"").toLowerCase()).filter(Boolean));
      const conversao=users.length?+(pagantes.size/users.length*100).toFixed(1):0;
      const ticket=pagantes.size?+( (fin.pagamentos||[]).reduce((s,p)=>s+payVal(p),0)/ (fin.pagamentos||[]).length ).toFixed(2):0;
      const aprovados=pedidos.filter(p=>p.status==="aprovado").length;
      json(res,200,{ok:true,
        usuarios:{total:users.length,porPlano:planos},
        conversao:{pagantesUnicos:pagantes.size,taxaPct:conversao,ticketMedio:ticket},
        pedidos:{total:pedidos.length,aprovados,pendentes:pedidos.filter(p=>p.status==="pendente").length},
      });
      return true;
    }

    /* ── BACKUP ─────────────────────────────────────────────────────── */
    const BK_DIR=path.join(DATA_DIR,"backups");
    if(route==="backup/list"&&req.method==="GET"){
      let list=[]; try{ list=fs.readdirSync(BK_DIR).filter(d=>/^\d{4}-/.test(d)).sort().reverse().map(d=>{const p=path.join(BK_DIR,d);let files=[];try{files=fs.readdirSync(p);}catch{}return{name:d,files:files.length};}); }catch{}
      json(res,200,{ok:true,backups:list.slice(0,60)}); return true;
    }
    if(route==="backup/create"&&req.method==="POST"){
      const b=await body(req)||{};
      const adminName=(b.adminName||"").trim();
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      try{
        const stamp=new Date(now-3*3600_000).toISOString().replace(/[:T]/g,"-").slice(0,19);
        const dir=path.join(BK_DIR,stamp); fs.mkdirSync(dir,{recursive:true});
        let n=0;
        for(const f of fs.readdirSync(DATA_DIR)){
          if(!f.endsWith(".json"))continue;
          try{fs.copyFileSync(path.join(DATA_DIR,f),path.join(dir,f));n++;}catch{}
        }
        audit(req,{admin:adminName,sessionEmail:s.user_email,action:"backup_create",target:"sistema",field:"backup",newValue:stamp,note:`${n} arquivos`});
        json(res,200,{ok:true,name:stamp,files:n});
      }catch(e){json(res,500,{error:e.message});}
      return true;
    }
    if(route==="backup/restore"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const adminName=(b.adminName||"").trim();
      if(!adminName||b.confirm!=="RESTAURAR"){json(res,400,{error:'Envie adminName e confirm:"RESTAURAR".'});return true;}
      const name=String(b.name||"").replace(/[^0-9\-]/g,"");
      const dir=path.join(BK_DIR,name);
      if(!name||!fs.existsSync(dir)){json(res,404,{error:"Backup não encontrado."});return true;}
      try{
        // segurança: snapshot automático antes de restaurar
        const pre=path.join(BK_DIR,"pre-restore-"+Date.now());fs.mkdirSync(pre,{recursive:true});
        for(const f of fs.readdirSync(DATA_DIR))if(f.endsWith(".json"))try{fs.copyFileSync(path.join(DATA_DIR,f),path.join(pre,f));}catch{}
        let n=0;
        for(const f of fs.readdirSync(dir)){try{fs.copyFileSync(path.join(dir,f),path.join(DATA_DIR,f));n++;}catch{}}
        audit(req,{admin:adminName,sessionEmail:s.user_email,action:"backup_restore",target:"sistema",field:"backup",newValue:name,note:`${n} arquivos restaurados; reinicie o servidor para recarregar as stores`});
        json(res,200,{ok:true,restored:n,aviso:"Arquivos restaurados em disco. REINICIE o servidor para as stores em memória recarregarem."});
      }catch(e){json(res,500,{error:e.message});}
      return true;
    }

    /* ── CONFIGURAÇÕES CENTRAIS ─────────────────────────────────────── */
    if(route==="config"&&req.method==="GET"){
      const st={...((ADMIN_SETTINGS?ADMIN_SETTINGS():{})||{})};
      delete st.editorPasswords; // nunca expor
      json(res,200,{ok:true,settings:st});
      return true;
    }
    if(route==="config"&&req.method==="POST"){
      const b=await body(req); if(!b){json(res,400,{error:"Body inválido."});return true;}
      const adminName=(b.adminName||"").trim();
      if(!adminName){json(res,400,{error:"Informe o nome do administrador responsável."});return true;}
      if(String(b.key||"").startsWith("editorPasswords")){json(res,403,{error:"Senhas de editor não são editáveis por aqui."});return true;}
      const st=(ADMIN_SETTINGS?ADMIN_SETTINGS():null);
      if(!st){json(res,500,{error:"Store de configurações indisponível."});return true;}
      const old=getByPath(st,b.key);
      try{ setByPath(st,b.key,coerce(b.value)); }catch(e){ json(res,400,{error:e.message}); return true; }
      persistAdminSettings&&persistAdminSettings();
      audit(req,{admin:adminName,sessionEmail:s.user_email,action:"config_set",target:"config",field:b.key,oldValue:old,newValue:coerce(b.value),reason:b.reason||""});
      json(res,200,{ok:true,key:b.key,oldValue:old,newValue:coerce(b.value)});
      return true;
    }

    json(res,404,{error:"Rota v2 desconhecida: "+route});
    return true;
  };
}

module.exports={createAdminV2Router};

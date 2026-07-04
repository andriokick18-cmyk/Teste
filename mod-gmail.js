/* ═══════════════════════════════════════════════════════════════════════
   📧 src/gmail.js — Fase 1 da Transformação · Módulo 2 (extraído do server.js)
   Helpers PUROS de e-mail: httpsReq, normalizeEmail, buildMime,
   buildMimeWithHeaders. Sem estado, sem sessões — as funções que USAM
   sessão (gmailSend etc.) permanecem no server.js por enquanto.
   Extração mecânica: corpos idênticos aos originais.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const https = require("https");
const crypto = require("crypto");

function httpsReq(opts,body){return new Promise((res,rej)=>{const p=body?(typeof body==="string"?body:JSON.stringify(body)):null;const r=https.request(opts,resp=>{const ch=[];resp.on("data",c=>ch.push(c));resp.on("end",()=>{const raw=Buffer.concat(ch).toString();try{res({status:resp.statusCode,body:JSON.parse(raw)});}catch{res({status:resp.statusCode,body:raw});}});});r.on("error",rej);r.setTimeout(15000,()=>{r.destroy();rej(new Error("Timeout"));});if(p)r.write(p);r.end();});}

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

function buildMime({to,subject,text,fromName,fromEmail,attachments=[]}){ // v15-SEC: normaliza to
  to = normalizeEmail(to) || to;
  const bnd="----H2B"+crypto.randomBytes(8).toString("hex");const b64=s=>Buffer.from(s).toString("base64");const L=[`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`,`To: ${to}`];L.push(`Subject: =?UTF-8?B?${b64(subject)}?=`,"MIME-Version: 1.0");if(!attachments.length){L.push("Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text);}else{L.push(`Content-Type: multipart/mixed; boundary="${bnd}"`,"",`--${bnd}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: 7bit","",text,"");for(const a of attachments){const aMime=a.mime||"application/octet-stream";L.push(`--${bnd}`,`Content-Type: ${aMime}; name="${a.name}"`,"Content-Transfer-Encoding: base64",`Content-Disposition: attachment; filename="${a.name}"`,"", ...(a.data.match(/.{1,76}/g)||[a.data]),"");}L.push(`--${bnd}--`);}return Buffer.from(L.join("\r\n")).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}

module.exports = { httpsReq, normalizeEmail, buildMime };

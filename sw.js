// ══════════════════════════════════════════════════════════
//  H2BApply — Service Worker v2.4
//  Estratégia: Network-first para APIs,
//              Cache-first para fontes/ícones (stale-while-revalidate)
//              HTML NUNCA cacheado (preserva cookie de sessão OAuth)
//  + Push Notifications + notificationclick + message handler
// ══════════════════════════════════════════════════════════
//
//  HISTÓRICO DE CORREÇÕES:
//
//  v2.1 (bug) — CACHE_NAME dinâmico via hash assíncrono.
//    Problema: activate disparava com nome antigo e apagava o cache
//    recém-criado no install. SW interceptava "/" sem cache → cookie
//    de sessão se perdia no redirect pós-OAuth.
//
//  v2.2 — CACHE_NAME fixo (como no backup estável).
//
//  v2.3 — HTML removido do SHELL_URLS e nunca cacheado.
//    Motivo: cookie h2b_session é setado via Set-Cookie no /oauth/callback.
//    Se SW devolve "/" do cache, o browser não envia o cookie em /api/status
//    → app acha que está deslogado → loop de login infinito.
//    BUG-013: fetch de fontes retornava undefined ao falhar; corrigido para 503.
//
//  v2.4 — Bump de versão para forçar reinstalação limpa em todos os clientes.
//    Nenhuma mudança lógica; apenas limpeza de código e documentação.
//
const CACHE_NAME = "h2bapply-v6";

// Recursos estáticos que ficam em cache para uso offline.
// HTML NÃO entra aqui — ver motivo acima (cookie de sessão).
const SHELL_URLS = [
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap",
  "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.29.0/dist/tabler-icons.min.css",
];

// ── Instalação: pré-carrega o shell ──────────────────────
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[sw] Cache miss:", url, err.message);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// ── Ativação: remove todos os caches de versões anteriores ───
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log("[sw] Removendo cache antigo:", k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: estratégia por tipo de requisição ─────────────
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== "GET") return;
  if (url.protocol === "chrome-extension:") return;

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/oauth/") ||
    url.pathname.startsWith("/proxy")
  ) {
    return;
  }

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    (e.request.headers.get("accept") || "").includes("text/html")
  ) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches
          .match("/index.html")
          .then((r) => r || new Response("Offline", { status: 503 }))
      )
    );
    return;
  }

  if (
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com") ||
    url.hostname.includes("jsdelivr.net")
  ) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request)
          .then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(
            () =>
              cached ||
              new Response("", {
                status: 503,
                statusText: "Service Unavailable",
              })
          );
        return cached || fetchPromise;
      })
    );
    return;
  }

  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── Push Notifications ────────────────────────────────────
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = {
      title: "H2BApply",
      body: e.data ? e.data.text() : "Nova notificação",
    };
  }

  const title = data.title || "✈️ H2BApply";
  const options = {
    body: data.body || "Você tem uma nova notificação.",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "h2b-notif",
    data: {
      url: data.url || "/?tab=respostas",
      sound: data.sound || "aviao",
      appId: data.appId || null,
    },
    requireInteraction: true,
    vibrate: [200, 100, 200],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification Click ─────────────────────────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  const notifData = e.notification.data || {};
  const targetUrl = notifData.url || "/?tab=respostas";
  const sound = notifData.sound || "aviao";
  const appId = notifData.appId || null;

  e.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          try {
            const clientUrl = new URL(client.url);
            if (
              clientUrl.origin === self.location.origin &&
              "focus" in client
            ) {
              client.focus();
              client.postMessage({ type: "navigate", url: targetUrl, sound, appId });
              return;
            }
          } catch {
            /* client.url pode ser opaco em alguns contextos */
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});

// ── Message Handler ───────────────────────────────────────
self.addEventListener("message", (e) => {
  if (!e.data) return;

  if (e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (e.data.type === "PING") {
    e.source?.postMessage({ type: "PONG", cacheName: CACHE_NAME });
    return;
  }
});

// ── Notification Close ────────────────────────────────────
self.addEventListener("notificationclose", (_e) => {
  // Telemetria silenciosa — sem ação necessária por ora
});

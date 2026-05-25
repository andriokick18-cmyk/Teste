# H2BApply 🇺🇸✈️

Plataforma de candidatura automática para vagas **H-2B e H-2A** nos Estados Unidos.

## O que faz

- Envia candidaturas automáticas por Gmail para empresas certificadas pelo DOL
- Gerencia perfis de e-mail com rotação de assuntos e corpos (anti-spam)
- Suporta upload de currículo PDF e cover letter
- Exibe vagas das planilhas DOL (Jan/2026, Jul/2025) e Seasonal Jobs
- Sistema de ranking, indicações, notificações e planos VIP

## Stack

- **Backend:** Node.js puro (sem frameworks)
- **Frontend:** HTML/CSS/JS vanilla (SPA)
- **Auth:** Google OAuth 2.0 (Gmail)
- **Deploy:** Render.com

## Estrutura

```
├── server.js              # Backend completo (Node.js)
├── index.html             # Frontend (SPA)
├── admin.html             # Painel administrativo + Robô de Teste v2.0
├── sw.js                  # Service Worker (PWA)
├── manifest.json          # PWA manifest
├── package.json           # Dependências
├── .env.example           # Variáveis de ambiente necessárias
├── jan2026_compact.json   # Planilha DOL Janeiro 2026
├── jul2025_compact.json   # Planilha DOL Julho 2025
└── icon-*.png             # Ícones PWA
```

## Setup

### 1. Clonar e instalar
```bash
git clone https://github.com/seu-usuario/h2bapply.git
cd h2bapply
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Editar .env com suas credenciais
```

### 3. Variáveis obrigatórias no `.env`
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
ADMIN_EMAIL=seu@email.com
APP_URL=https://seu-dominio.com
```

### 4. Rodar localmente
```bash
npm start
```

## Deploy no Render

1. Conectar o repositório no [Render.com](https://render.com)
2. **Build Command:** `npm install`
3. **Start Command:** `node server.js`
4. Adicionar todas as variáveis do `.env.example` no painel do Render
5. Criar um **Persistent Disk** em `/data` para salvar dados dos usuários

## Robô de Teste (Admin)

Acesse `/admin` → **🤖 Robô de Teste v2.0**

O robô cria perfis, sobe PDFs, envia e-mails reais, testa o automático completo e limpa tudo no final. Exclusivo para administradores.

## Licença

Privado — todos os direitos reservados.

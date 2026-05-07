# RunPanel

Self-hosted deployment panel for managing applications and services. Deploy from GitHub, ZIP uploads, or Docker — with real-time logs, file editing, and process management.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker)

## ✨ Features

- 📦 **Project Management** — Create projects as containers for apps and services
- 🚀 **Multi-Runtime Deploy** — Node.js (auto-detect npm/bun/yarn/pnpm), Docker, or Custom (any language)
- 🔗 **GitHub Integration** — Auto-deploy on push via webhooks
- 🐳 **Docker Services** — Provision PostgreSQL, MySQL, Redis, MongoDB with one click
- 🧱 **Docker Templates** — Pre-configured Nginx, Apache, Caddy deployments
- 📊 **Real-time Monitoring** — CPU, RAM, disk, uptime stats with live polling
- ⚡ **Process Management** — Start, stop, restart, deploy, re-build via PM2 or Docker
- 📜 **Live Logs** — Stream PM2/Docker process output in the browser
- 📁 **File Manager** — Browse and edit project files with integrated editor (Ctrl+S to save)
- 💻 **Interactive Terminal** — Shell access to project directories
- 🔐 **Environment Variables** — Encrypted storage, import from .env files
- 🔄 **Crash Recovery** — Auto-detects stuck deployments on server restart
- 📱 **Responsive UI** — Mobile-friendly with collapsible sidebar

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React 19) |
| UI | HeroUI v3 + Tailwind CSS v4 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Process Manager | PM2 (native apps), Docker (containers) |
| Auth | bcrypt password hashing, cookie sessions |
| Validation | Zod schemas |
| Icons | Iconify Solar set |

## ⚡ Quick Start

### Prerequisites

- Node.js 18+
- npm or bun
- Docker (optional, for container services)
- PM2 (`npm install -g pm2`) for native process management

### 📥 Install

```bash
git clone https://github.com/your-username/runpanel.git
cd runpanel
npm install
```

### ▶️ Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

Open `http://localhost:3000` — first visit prompts you to set an admin password.

### 🔧 Environment

Create `.env` (optional):

```env
RUNPANEL_DATA_DIR=./data          # Where repos, DB, and configs are stored
RUNPANEL_SECRET=your-secret-key   # Encryption key (auto-generated if not set)
```

## 🏗 Architecture

```
RunPanel
├── app/                    # Next.js App Router pages + API routes
│   ├── (auth)/             # 🔐 Login page
│   ├── (panel)/            # 📊 Dashboard, project detail, services
│   └── api/                # 🔌 REST API endpoints
├── components/             # 🧩 Shared UI components
├── lib/                    # ⚙️ Config, DB, auth, validation, types
├── services/               # 🔧 Backend services
│   ├── builders/           # 🏗 Node, Docker, Custom build pipelines
│   ├── process-drivers/    # ⚡ PM2 and Docker process management
│   └── service-templates/  # 🐳 Database provisioning templates
└── data/                   # 💾 Runtime data (gitignored)
    ├── repos/              # 📂 Cloned/uploaded project source code
    ├── pm2/                # 📜 PM2 wrapper scripts
    └── runpanel.db         # 🗄 SQLite database
```

## 📖 How It Works

### 📦 Projects

A **project** is a container that holds an **app** (your deployed code) and **services** (databases, caches).

1. 🆕 Create a project (just a name)
2. ➕ Add an app — choose source (GitHub/ZIP) and runtime (Node.js/Docker/Custom)
3. 🐳 Add services — PostgreSQL, MySQL, Redis, MongoDB, or Docker templates
4. 🚀 Deploy — RunPanel builds and starts your app

### 🔄 Deploy Modes

| Mode | Behavior |
|------|----------|
| 🚀 **Deploy** | Git pull → install → build → stop old → start new |
| 🔨 **Re-Build** | Stop → clean caches → install → build → start (keeps local file changes) |

### 🧩 Runtime Types

| Runtime | Description |
|---------|-------------|
| 🟢 **Node.js** | Auto-detects package manager, installs deps, builds, starts |
| 🐳 **Docker** | Builds from Dockerfile or pulls template image |
| ⚙️ **Custom** | You specify install, build, and start commands (Python, Go, Ruby, etc.) |

### 💻 Custom Commands

For Custom and Node.js runtimes, you can specify multi-line commands:

```
# Install (each line runs in the same shell session)
python3 -m venv venv
venv\Scripts\activate.bat
pip install -r requirements.txt

# Start (first line only)
venv\Scripts\python main.py
```

## 🔌 API

All API routes require authentication via session cookie.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | 📦 List all projects with services |
| `POST` | `/api/projects` | 🆕 Create project |
| `PATCH` | `/api/projects/:id` | ✏️ Update project config |
| `DELETE` | `/api/projects/:id` | 🗑 Delete project + all services |
| `POST` | `/api/projects/:id/deploy` | 🚀 Trigger deploy/rebuild |
| `POST` | `/api/projects/:id/control` | ⚡ Start/stop/restart process |
| `GET` | `/api/projects/:id/status` | 📊 Process info (PID, memory, CPU) |
| `GET` | `/api/projects/:id/logs?source=process` | 📜 Live process logs |
| `GET` | `/api/projects/:id/files?path=/` | 📁 Browse project files |
| `GET/PUT` | `/api/projects/:id/files/content?path=...` | ✏️ Read/write file |
| `GET` | `/api/services` | 🐳 List all services |
| `POST` | `/api/services` | ➕ Provision service |
| `DELETE` | `/api/services/:id` | 🗑 Remove service + container |
| `GET` | `/api/metrics` | 📊 Server CPU, RAM, disk, uptime |
| `POST` | `/api/webhooks/github/:projectId` | 🔗 GitHub webhook endpoint |

## 🔐 Security

- 🔑 Password hashed with bcrypt
- 🚫 Rate limiting on login (5 attempts / 15 min per IP)
- 🛡 Path traversal protection on file operations
- ✅ Webhook signature verification (HMAC-SHA256)
- 🔒 Environment variables encrypted at rest
- 📦 ZIP upload validates magic bytes
- ⏱ Terminal sessions auto-cleanup after 10 min idle

## 📄 License

MIT

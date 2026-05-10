# Backgammon Full-Stack Web App (Scaffold)

This repository contains the initial scaffold for a backgammon web app.

Current scope:
- Next.js frontend with TypeScript
- FastAPI backend
- Health endpoint at `GET /health`
- Docker Compose setup

Game logic/UI is intentionally not implemented yet.

## Project Structure

```text
.
├─ frontend/      # Next.js (TypeScript) app
├─ backend/       # FastAPI app
└─ shared-docs/   # Shared documentation
```

## Prerequisites

- Node.js 20+
- Python 3.12+
- Docker + Docker Compose (optional, for containerized run)

## Local Development (Without Docker)

### 1) Run backend

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

### 2) Run frontend

In a new terminal:

```bash
cd frontend
npm install
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

## Run with Docker Compose

From repository root:

```bash
docker compose up --build
```

Services:
- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend: [http://localhost:8000](http://localhost:8000)
- Health: [http://localhost:8000/health](http://localhost:8000/health)

Stop services:

```bash
docker compose down
```

# DispatchBoard

Monorepo:
- `frontend/`: Next.js dashboard (Supabase-backed)
- `backend/`: Express + Postgres API (Twilio WhatsApp webhook + PDF parsing)

## Local development

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

### Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

## Deployment

### Frontend on Vercel (from this repo)
1. Push this repo to GitHub.
2. In Vercel, **Import Project** → select this repo.
3. Set **Root Directory** to `frontend`.
4. Set environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_INTAKE_API_URL` (your Railway backend URL)
5. Deploy.

### Backend on Railway (from this repo)
1. In Railway, **New Project** → **Deploy from GitHub** → select this repo.
2. Set **Root Directory** to `backend` (recommended), or keep repo root and use the commands in `railwayapp.json`.
3. Set environment variables (see `backend/.env.example`), commonly:
   - `DATABASE_URL`
   - `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL`
   - `ALLOWED_ORIGINS` (include your Vercel URL)
4. Deploy and set your Twilio webhook to: `https://YOUR_RAILWAY_DOMAIN/api/twilio-webhook`

## Repo hygiene

- Secrets and local files are ignored via `.gitignore` (e.g. `.env*`, `node_modules/`, build outputs, and documents like `*.pdf`).

# Household Inventory

A mobile-first PWA for Dan and Abby to track shared household inventory. Scan a grocery receipt, review parsed items, and commit them to inventory in one tap. Check what's at home from the store, even offline.

## Stack

- **Frontend:** Preact + Vite PWA — `frontend/`
- **Backend:** Cloudflare Worker — `worker/`
- **Database & Auth:** Supabase (Postgres + magic-link auth + Storage)
- **AI:** Anthropic API (Haiku for receipt parsing)
- **Hosting:** GitHub Pages (frontend), Cloudflare Workers (backend)

## Local Development

### Frontend

```bash
cd frontend
cp .env.example .env.local   # fill in your Supabase + Worker values
npm install
npm run dev
```

### Worker

```bash
cd worker
npm install
wrangler dev
```

Secrets are managed via `wrangler secret put <NAME>` — see `.env.example` for the list.

## Deployment

Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`), which builds the frontend with Vite and deploys to GitHub Pages. Worker deployments are manual via `wrangler deploy`.

## Project Spec

See [SPEC.md](SPEC.md) for architecture decisions, data model, and build phases. The spec is a living document — update it in the same commit as any decision change.

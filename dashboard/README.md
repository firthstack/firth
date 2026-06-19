# Firth Dashboard

Terminal-themed web dashboard for Firth: auth, project/branch CRUD, and resource-handle
metadata. It is a pure client of the Firth control-plane API.

## Local development

1. Run the control plane locally (it must be reachable from the browser):
   `cd ../control-plane && npm run dev` (defaults to http://localhost:3000).
2. Copy `.env.example` to `.env` and set:
   - `VITE_FIRTH_API_URL` — the control-plane base URL (e.g. `http://localhost:3000`).
   - `VITE_INSFORGE_URL` — your InsForge backend URL.
   - `VITE_INSFORGE_ANON_KEY` — the InsForge anon key.
3. `npm install && npm run dev` — opens the Vite dev server on http://localhost:5173
   (the control plane's default CORS origin).

## Tests

`npm test` — Vitest + Testing Library + jsdom, fully offline (faked api + auth, no network).

## OAuth (Google / GitHub)

Email/password works with no extra setup. OAuth requires a one-time operator step in the
InsForge backend: enable the Google/GitHub providers with their client credentials and add
this dashboard's origin (`http://localhost:5173` in dev, the deployed origin in prod) to the
allowed redirect URLs.

## Deploy (InsForge sites)

`npm run build` produces `dist/`. Deploy it with the InsForge CLI:
`npx @insforge/cli deployments deploy dist`. Set the three `VITE_*` vars for the build
environment so the bundle points at the deployed control plane and backend.

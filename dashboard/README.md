# Firth Dashboard

Terminal-themed web dashboard for Firth: auth, project/branch CRUD, and resource-handle
metadata. It is a pure client of the Firth control-plane API.

## Local development

1. Run the control plane locally (it must be reachable from the browser):
   `cd ../control-plane && npm run dev` (defaults to http://localhost:8080).
2. Copy `.env.example` to `.env` and set:
   - `VITE_FIRTH_API_URL` — the control-plane base URL (e.g. `http://localhost:8080`).
3. `npm install && npm run dev` — opens the Vite dev server on http://localhost:5173
   (the control plane's default CORS origin).

## Auth

All authentication goes through the control-plane `/auth/*` endpoints (email + password).
No InsForge backend or OAuth credentials are required.
OAuth sign-in is intentionally not present; it will be re-added later via a proper proxy.

## Tests

`npm test` — Vitest + Testing Library + jsdom, fully offline (faked api + auth, no network).

## Deploy

`npm run build` produces `dist/`. Set `VITE_FIRTH_API_URL` for the build environment so the
bundle points at the deployed control plane.

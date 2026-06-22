# Firth Homepage Refine — Design

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Goal

Refine the Firth dashboard's pre-auth landing page (`dashboard/src/views/Home.tsx`) to lead with the core positioning — **branchable & governable, agent-native infrastructure** — while keeping the existing terminal aesthetic (green-on-black monospace). Today's single compact panel becomes a short scrolling landing page with four sections: a command-as-hero, core features, a new "how it works", and the existing install/use block.

## Scope

- **In scope:** `dashboard/src/views/Home.tsx` (restructure + new copy), `dashboard/src/theme.css` (styles for the new sections), `dashboard/src/views/Home.test.tsx` (update assertions). Purely presentational.
- **Out of scope:** any control-plane / API change; auth flow; the `[ get started → ]` behavior (still calls the existing `onGetStarted`); a marketing nav bar, pricing, or testimonials (the reference sites have these; Firth's landing stays a single focused page); new dependencies. No new fonts/colors beyond the existing theme tokens.
- **Deploy:** dashboard only (frontend) — `deployments deploy dashboard` with the `VITE_FIRTH_API_URL` prod override. No control-plane redeploy.

## Style constraints (unchanged theme)

Use the existing theme tokens in `theme.css`: `--bg #0a0e0a`, `--bg-panel #0e140e`, `--border #1f3a1f`, `--fg #c8e6c8`, `--fg-dim #6a8a6a`, `--green #6ee06e`, `--amber #e0b24a`, `--red #e06c6c`, `--mono` font. Reuse the `Panel` primitive and `firth-dim` utility. Faux-terminal `$ firth --cmd` blocks are the section device, matching the current page and the reference sites (db9.ai "Query it. Or `cat` it.", exe.dev "ssh exe.dev") which both lead with a command and keep a terminal-minimal look.

## Layout (top → bottom)

A compact top **wordmark** then four sections, all inside the `firth-home` container (max-width ~760px, centered, as today).

### Wordmark (replaces the large ASCII banner)
A small one-line `firth` wordmark in `--green`, with `data-testid="firth-banner"` (preserves the existing banner test and the brand mark without competing with the command-hero). The large 6-line ASCII banner is removed.

### ① Hero — command-as-hero
A faux terminal showing the "magic" of `project create`, then the positioning line + a one-line sub-claim, then the CTA row.

```
$ firth project create my-app
  ✓ postgres · storage · compute  → ./.env
  ✓ branch 'main' ready

branchable & governable infrastructure for agents.
// branch your backend like code · audit & gate agent actions at the credential seam

[ get started → ]    $ npm i -g firth
```

- The command line (`$ firth project create my-app`) is dim-prompt + normal text; the `✓` lines are `--green`.
- "branchable & governable infrastructure for agents." is the headline (normal `--fg`, slightly larger/bold via a class).
- The `//` line is `firth-dim`.
- `[ get started → ]` is the existing `TButton` calling `onGetStarted`; `$ npm i -g firth` sits beside it as a dim inline hint (not a button).

### ② Core features — `$ firth --features`
A terminal block (reuse the `firth-home__features` table device) listing the three features, with the two pillars annotated.

```
$ firth --features
• provision        postgres · storage · compute — one command, creds → ./.env
• CoW postgres      copy-on-write branches — full data, isolated, instant      ← branchable
• govern + audit    every action on the timeline; policy-gate deletes, deploys & secret reads   ← governable
```

- Feature names (`provision`, `CoW postgres`, `govern + audit`) in `--fg`; descriptions `firth-dim`.
- The `← branchable` / `← governable` pillar tags in `--amber` (or dim) — they tie the features back to the hero's two pillars. (If they crowd the row on narrow widths, drop them to a second dim line; the plan should handle wrapping.)

### ③ How it works — `$ firth --how` (new)
The lifecycle as five numbered command steps (on-brand; mirrors the reference sites' command focus).

```
$ firth --how
1. provision   firth project create    db · storage · compute, creds in ./.env
2. branch      firth branch create     isolated CoW postgres + fresh compute (storage shared)
3. deploy      firth deploy            ship your container to the branch's compute
4. observe     firth events            agent actions ↔ resource side-effects, per branch
5. govern      firth policy / approve  gate deletes, deploys & secret reads; one-shot approvals
```

- Step number + the `firth …` command in `--fg` (command in `--green`), the trailing note `firth-dim`. Reuse the features-table layout for alignment.

### ④ Install & use — `$ firth --install` (kept)
Keep the current block verbatim (the user asked to keep it "as currently"):

```
$ firth --install
npm install -g firth          # the cli · requires node ≥ 20
firth login                   # sign in (email / password)
firth project create my-app   # provision db · storage · compute → ./.env
```
Plus the existing dim hint: `no install? npx firth --help. docs: firth <cmd> --help`.

## Component structure

Keep everything in `Home.tsx`, but split the four sections into small local components in that file — `Hero`, `Features`, `HowItWorks`, `Install` — mirroring the `ProjectDetail` card pattern (`PostgresCard`/`StorageCard`). `Home` composes the wordmark + the four sections + the CTA. This keeps each unit small and readable; no new files unless a section grows beyond ~40 lines.

## Copy (verbatim, accuracy-checked)

These are the exact strings (kept honest — no overclaiming):
- Headline: `branchable & governable infrastructure for agents.`
- Hero sub-line: `// branch your backend like code · audit & gate agent actions at the credential seam`
- Hero command + output: `$ firth project create my-app` / `✓ postgres · storage · compute  → ./.env` / `✓ branch 'main' ready`
- Features: as in ② above.
- How it works: as in ③ above (storage is **shared** across branches — stated, since it's true and a common gotcha).
- Install: as in ④ (unchanged from current).

Claims map to real behavior: branching = Neon-native copy-on-write branch + fresh compute, shared storage (per the SKILL/architecture); observe = the agent-action↔side-effect timeline; govern = policy gate on `secrets.read`/`deploy`/`project.delete`/`branch.delete` with one-shot approvals. "every action on the timeline" refers to Observe (which does record all events); gating applies to the high-blast-radius set (hence "policy-gate deletes, deploys & secret reads", not "gate everything").

## Testing

Update `dashboard/src/views/Home.test.tsx` (vitest + jsdom + @testing-library):
- **Keep:** `firth-banner` testid present (now the wordmark); `$ firth --install` + `npm install -g firth` present; `[ get started → ]` click calls `onGetStarted`.
- **Change:** the tagline assertion (`/a builder platform for agents/i`) → the new headline `/branchable & governable infrastructure for agents/i`; the feature assertion (`/unified secrets/i`) → a new feature, e.g. `/CoW postgres/i`.
- **Add:** a "how it works" assertion — e.g. `$ firth --how` present and a step like `/firth branch create/i`.
- Tests must verify rendered text/behavior, not implementation details. Run `cd dashboard && npm test && npm run build` green before done.

## Success criteria

The landing page renders as a single scrolling terminal-styled page with the four sections + wordmark; the hero leads with the `project create` command + the branchable/governable positioning; copy is accurate; all dashboard tests + build pass; deploys to InsForge Sites unchanged except content.

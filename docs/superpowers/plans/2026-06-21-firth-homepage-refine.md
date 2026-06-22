# Firth Homepage Refine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the dashboard's pre-auth landing (`dashboard/src/views/Home.tsx`) into a short scrolling terminal-styled page — a command-as-hero leading with "branchable & governable infrastructure for agents", core features, a new "how it works" lifecycle, and the existing install block.

**Architecture:** Pure frontend change to one React view + its stylesheet + its test. `Home.tsx` is split into four small local section components (`Hero`, `Features`, `HowItWorks`, `Install`) composed by `Home`, mirroring `ProjectDetail`'s card pattern. Styling uses only the existing theme tokens; new CSS classes are added to `theme.css`. No control-plane/API/auth changes.

**Tech Stack:** React + TypeScript, Vite, vitest + jsdom + @testing-library/react, the existing terminal theme (`dashboard/src/theme.css`) and `Terminal` primitives (`Panel`, `Row`, `TButton`).

## Global Constraints

- **Theme only:** use existing tokens from `theme.css` — `--bg #0a0e0a`, `--bg-panel #0e140e`, `--border #1f3a1f`, `--fg #c8e6c8`, `--fg-dim #6a8a6a`, `--green #6ee06e`, `--amber #e0b24a`, `--red #e06c6c`, `--mono`. No new fonts/colors/deps.
- **Copy is verbatim** from this plan (accuracy-checked — do not reword; e.g. "policy-gate deletes, deploys & secret reads", not "gate everything"; storage is "shared" across branches).
- **Behavior unchanged:** the page takes `{ onGetStarted: () => void }`; exactly one `[ get started → ]` button, in the hero, calling `onGetStarted`. Keep `data-testid="firth-banner"` on the wordmark.
- **Scope:** only `dashboard/src/views/Home.tsx`, `dashboard/src/views/Home.test.tsx`, `dashboard/src/theme.css`. Purely presentational.
- TDD: update the failing tests first → confirm fail → implement → pass → commit. Stage only the files each task names (never `git add -A`). Run dashboard commands from `dashboard/`.

## File structure

- `dashboard/src/views/Home.tsx` — rewritten: `Home` composes `<Wordmark>` (inline) + `Hero` + a `Panel` containing `Features` + `HowItWorks` + `Install`. Each section a small local component.
- `dashboard/src/views/Home.test.tsx` — updated assertions (wordmark, new headline, CoW-postgres feature, how-it-works, install kept, CTA).
- `dashboard/src/theme.css` — append classes for the new sections (hero, headline, command block, pillar tags, how-it-works command cell, wordmark).

---

### Task 1: Restructure `Home.tsx` into the four sections + update tests

**Files:**
- Modify: `dashboard/src/views/Home.tsx` (full rewrite)
- Test: `dashboard/src/views/Home.test.tsx` (update assertions)

**Interfaces:**
- Consumes: `Panel`, `Row`, `TButton` from `../ui/Terminal`; the `onGetStarted: () => void` prop.
- Produces (CSS class names Task 2 styles): `firth-home__wordmark`, `firth-home__mark`, `firth-home__hero`, `firth-home__cmd`, `firth-home__ok`, `firth-home__headline`, `firth-home__sub`, `firth-home__cta-hint`, `firth-home__pillar`, `firth-home__cmd-cell`. Reuses existing classes: `firth-home`, `firth-home__session`, `firth-home__block`, `firth-home__features`, `firth-home__feat-name`, `firth-home__hint`, `firth-dim`.

- [ ] **Step 1: Update the tests to the new structure (they will fail against the current Home)**

Replace the entire contents of `dashboard/src/views/Home.test.tsx` with:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Home } from './Home'

describe('Home', () => {
  it('renders the firth wordmark', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByTestId('firth-banner')).toBeInTheDocument()
  })

  it('leads with the branchable & governable positioning', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText(/branchable & governable infrastructure for agents/i)).toBeInTheDocument()
  })

  it('renders the core features incl. CoW postgres', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText(/CoW postgres/i)).toBeInTheDocument()
  })

  it('renders the how-it-works lifecycle', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText('$ firth --how')).toBeInTheDocument()
    expect(screen.getByText(/firth branch create/i)).toBeInTheDocument()
  })

  it('shows how to install the firth cli', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText('$ firth --install')).toBeInTheDocument()
    expect(screen.getByText('npm install -g firth')).toBeInTheDocument()
  })

  it('clicking get started calls onGetStarted', async () => {
    const onGetStarted = vi.fn()
    render(<Home onGetStarted={onGetStarted} />)
    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    expect(onGetStarted).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd dashboard && npx vitest run src/views/Home.test.tsx`
Expected: FAIL — the current Home has the old tagline/features and no `$ firth --how`; assertions for the new headline, `CoW postgres`, and `$ firth --how` fail.

- [ ] **Step 3: Rewrite `Home.tsx`**

Replace the entire contents of `dashboard/src/views/Home.tsx` with:

```tsx
import { Panel, Row, TButton } from '../ui/Terminal'

function Hero({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <section className="firth-home__hero">
      <div className="firth-home__cmd">
        <div><span className="firth-dim">$</span> firth project create my-app</div>
        <div className="firth-home__ok">✓ postgres · storage · compute  → ./.env</div>
        <div className="firth-home__ok">✓ branch 'main' ready</div>
      </div>
      <h1 className="firth-home__headline">branchable &amp; governable infrastructure for agents.</h1>
      <p className="firth-home__sub firth-dim">
        // branch your backend like code · audit &amp; gate agent actions at the credential seam
      </p>
      <Row>
        <TButton onClick={onGetStarted}>[ get started → ]</TButton>
        <span className="firth-home__cta-hint firth-dim">$ npm i -g firth</span>
      </Row>
    </section>
  )
}

function Features() {
  return (
    <div className="firth-home__block">
      <span className="firth-dim">$ firth --features</span>
      <table className="firth-home__features">
        <tbody>
          <tr>
            <td className="firth-home__feat-name">• provision</td>
            <td className="firth-dim">postgres · storage · compute — one command, creds → ./.env</td>
            <td className="firth-home__pillar"></td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">• CoW postgres</td>
            <td className="firth-dim">copy-on-write branches — full data, isolated, instant</td>
            <td className="firth-home__pillar">← branchable</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">• govern + audit</td>
            <td className="firth-dim">every action on the timeline; policy-gate deletes, deploys &amp; secret reads</td>
            <td className="firth-home__pillar">← governable</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="firth-home__block">
      <span className="firth-dim">$ firth --how</span>
      <table className="firth-home__features">
        <tbody>
          <tr>
            <td className="firth-home__feat-name">1. provision</td>
            <td className="firth-home__cmd-cell">firth project create</td>
            <td className="firth-dim">db · storage · compute, creds in ./.env</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">2. branch</td>
            <td className="firth-home__cmd-cell">firth branch create</td>
            <td className="firth-dim">isolated CoW postgres + fresh compute (storage shared)</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">3. deploy</td>
            <td className="firth-home__cmd-cell">firth deploy</td>
            <td className="firth-dim">ship your container to the branch's compute</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">4. observe</td>
            <td className="firth-home__cmd-cell">firth events</td>
            <td className="firth-dim">agent actions ↔ resource side-effects, per branch</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">5. govern</td>
            <td className="firth-home__cmd-cell">firth policy / approve</td>
            <td className="firth-dim">gate deletes, deploys &amp; secret reads; one-shot approvals</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function Install() {
  return (
    <div className="firth-home__block">
      <span className="firth-dim">$ firth --install</span>
      <table className="firth-home__features">
        <tbody>
          <tr>
            <td className="firth-home__feat-name">npm install -g firth</td>
            <td className="firth-dim"># the cli · requires node ≥ 20</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">firth login</td>
            <td className="firth-dim"># sign in (email / password)</td>
          </tr>
          <tr>
            <td className="firth-home__feat-name">firth project create my-app</td>
            <td className="firth-dim"># provision db · storage · compute → ./.env</td>
          </tr>
        </tbody>
      </table>
      <p className="firth-dim firth-home__hint">
        no install? <code>npx firth --help</code>. docs: <code>firth &lt;cmd&gt; --help</code>
      </p>
    </div>
  )
}

export function Home({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="firth-home">
      <div className="firth-home__wordmark">
        <span data-testid="firth-banner" className="firth-home__mark">firth</span>
      </div>

      <Hero onGetStarted={onGetStarted} />

      <Panel title="firth">
        <div className="firth-home__session">
          <Features />
          <HowItWorks />
          <Install />
        </div>
      </Panel>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd dashboard && npx vitest run src/views/Home.test.tsx`
Expected: PASS (6 tests). If `getByText` reports multiple matches, a string appears in more than one place — the copy above is deliberately unique per assertion (`firth branch create`, `CoW postgres`, `$ firth --how`, `$ firth --install`, `npm install -g firth` each occur once).

- [ ] **Step 5: Run the full dashboard suite + build (catch any App-shell coupling)**

Run: `cd dashboard && npm test && npm run build`
Expected: all tests pass, `tsc -b && vite build` clean. (The new sections have no styles yet — that's Task 2; the build/tests don't depend on CSS.)

- [ ] **Step 6: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add dashboard/src/views/Home.tsx dashboard/src/views/Home.test.tsx
git commit -m "feat(dashboard): command-hero homepage — branchable/governable positioning + how-it-works"
```

---

### Task 2: Style the new sections in `theme.css`

**Files:**
- Modify: `dashboard/src/theme.css` (append new classes)

**Interfaces:**
- Consumes: the class names produced by Task 1 (`firth-home__wordmark`, `firth-home__mark`, `firth-home__hero`, `firth-home__cmd`, `firth-home__ok`, `firth-home__headline`, `firth-home__sub`, `firth-home__cta-hint`, `firth-home__pillar`, `firth-home__cmd-cell`) and the existing tokens/classes.
- Produces: visual styling only; no exported interface.

- [ ] **Step 1: Append the new styles to `theme.css`**

Add to the end of `dashboard/src/theme.css` (the existing `.firth-home*` rules stay; these extend them):

```css
/* ── homepage refine (command-hero) ───────────────────────────── */
.firth-home__wordmark { text-align: center; margin-bottom: 1.25rem; }
.firth-home__mark {
  color: var(--green);
  font-weight: 700;
  letter-spacing: 0.35em;
  text-transform: lowercase;
}
.firth-home__hero { margin-bottom: 2rem; }
.firth-home__cmd { margin: 0 0 1rem; line-height: 1.6; }
.firth-home__ok { color: var(--green); }
.firth-home__headline {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--fg);
  margin: 0 0 0.5rem;
  line-height: 1.3;
}
.firth-home__sub { margin: 0 0 1rem; }
.firth-home__cta-hint { margin-left: 1rem; }
.firth-home__cmd-cell {
  color: var(--green);
  white-space: nowrap;
  padding: 0.1rem 0.75rem 0.1rem 0;
  vertical-align: top;
}
.firth-home__pillar {
  color: var(--amber);
  white-space: nowrap;
  padding-left: 1rem;
  vertical-align: top;
}
/* Narrow screens: the pillar tags are decorative — drop them rather than overflow */
@media (max-width: 600px) {
  .firth-home__pillar { display: none; }
  .firth-home__headline { font-size: 1.2rem; }
}
```

- [ ] **Step 2: Build to confirm the stylesheet compiles + bundles**

Run: `cd dashboard && npm run build`
Expected: `tsc -b && vite build` clean (the CSS is imported by the app entry; a syntax error would fail the build).

- [ ] **Step 3: Run the full dashboard suite (styles must not break tests)**

Run: `cd dashboard && npm test`
Expected: all tests pass (jsdom ignores CSS, so this just confirms nothing else regressed).

- [ ] **Step 4: Commit**

```bash
cd /Users/junwen/Work/Personal/firth
git add dashboard/src/theme.css
git commit -m "style(dashboard): terminal styling for the command-hero homepage sections"
```

---

## After both tasks

- Final whole-branch review, then finish the branch (merge to main).
- **Deploy (dashboard only):** from the repo root,
  `npx @insforge/cli deployments deploy dashboard --env '{"VITE_FIRTH_API_URL":"https://firth-control-plane-0662c2ef-202a-4feb-8267-5501b3b60037.fly.dev"}' -y`
  (the `--env` override is required each time — `dashboard/.env` holds the localhost dev value). No control-plane redeploy.

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
            <td className="firth-dim">isolated postgres + fresh compute (storage shared)</td>
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

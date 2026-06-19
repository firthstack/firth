import { Panel, Row, TButton } from '../ui/Terminal'

const BANNER = `
███████╗██╗██████╗ ████████╗██╗  ██╗
██╔════╝██║██╔══██╗╚══██╔══╝██║  ██║
█████╗  ██║██████╔╝   ██║   ███████║
██╔══╝  ██║██╔══██╗   ██║   ██╔══██║
██║     ██║██║  ██║   ██║   ██║  ██║
╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝`.trim()

export function Home({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="firth-home">
      <div className="firth-home__banner">
        <pre data-testid="firth-banner" className="firth-home__ascii">{BANNER}</pre>
        <p className="firth-home__tagline firth-dim">// a builder platform for agents &amp; developers</p>
      </div>

      <Panel title="firth">
        <div className="firth-home__session">
          <div className="firth-home__block">
            <span className="firth-dim">$ firth --about</span>
            <p>
              orchestrates Neon (db) · Tigris (storage) · Fly (compute) under one<br />
              control surface — provisioned under firth's own accounts<br />
              (account-of-record), cost passed through near-cost.<br />
              orchestrator, not a reseller — the product is integration + governance.
            </p>
          </div>

          <div className="firth-home__block">
            <span className="firth-dim">$ firth --features</span>
            <table className="firth-home__features">
              <tbody>
                <tr>
                  <td className="firth-home__feat-name">• unified secrets</td>
                  <td className="firth-dim">one boundary · encrypted at rest · never hardcoded</td>
                </tr>
                <tr>
                  <td className="firth-home__feat-name">• runtime observability</td>
                  <td className="firth-dim">agent actions ↔ resource side-effects, per branch</td>
                </tr>
                <tr>
                  <td className="firth-home__feat-name">• failure analysis</td>
                  <td className="firth-dim">cross-stack triage on the timeline</td>
                </tr>
                <tr>
                  <td className="firth-home__feat-name">• branching</td>
                  <td className="firth-dim">per-project isolated branches (neon-native)</td>
                </tr>
              </tbody>
            </table>
          </div>

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
        </div>
      </Panel>

      <Row>
        <TButton onClick={onGetStarted}>[ get started → ]</TButton>
      </Row>
    </div>
  )
}

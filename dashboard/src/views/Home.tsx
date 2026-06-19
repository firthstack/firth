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

      <Panel title="about">
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
        </div>
      </Panel>

      <Row>
        <TButton onClick={onGetStarted}>[ get started → ]</TButton>
      </Row>
    </div>
  )
}

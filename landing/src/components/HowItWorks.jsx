import ScrollReveal from './ScrollReveal'

const steps = [
  {
    num: '01',
    title: 'Create a profile',
    body: 'Name your profile, choose an engine (CloakBrowser or Camoufox), set a proxy and fingerprint persona. The profile directory is provisioned immediately.',
    arrow: true,
  },
  {
    num: '02',
    title: 'Connect your agent',
    body: 'Copy the bearer token from MCP → Connect. Add Seknova to your Cursor, Claude Desktop, Codex, or Kiro config — or let Projects write the config file automatically.',
    arrow: true,
  },
  {
    num: '03',
    title: 'Let your agent work',
    body: <>Your agent calls <code style={{fontFamily:'monospace',color:'var(--accent)',fontSize:'0.9em'}}>launch_profile</code>, then navigates, clicks, types, and reads pages. Login state persists across every session.</>,
    arrow: false,
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="how-section">
      <div className="inner">
        <p className="section-eyebrow">Setup</p>
        <h2 className="section-h2">From install to <em>agent-ready</em><br />in three steps.</h2>
        <div className="how-steps">
          {steps.map((s, i) => (
            <ScrollReveal key={s.num} delay={i * 0.1} className="how-step">
              <div className="step-num" aria-hidden="true">{s.num}</div>
              <div className="step-content">
                <h3 className="step-h3">{s.title}</h3>
                <p className="step-p">{s.body}</p>
              </div>
              {s.arrow && (
                <svg className="step-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              )}
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  )
}

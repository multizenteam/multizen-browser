import ScrollReveal from './ScrollReveal'

const features = [
  {
    badge: 'MCP',
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
        <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
      </svg>
    ),
    title: 'Native MCP Server',
    body: <>A Streamable HTTP endpoint at <code style={{fontFamily:'monospace',color:'var(--accent)',fontSize:'0.9em'}}>127.0.0.1:7777/mcp</code> exposes every browser-drive tool — navigate, click, type, screenshot, cookies, tabs — to any MCP client.</>,
    extra: (
      <div className="mcp-diagram" aria-hidden="true">
        <div className="mcp-node">Claude / Cursor</div>
        <div className="mcp-arrow"></div>
        <div className="mcp-node server">:7777/mcp</div>
        <div className="mcp-arrow delay"></div>
        <div className="mcp-node">Browser</div>
      </div>
    ),
  },
  {
    badge: 'Multi-session',
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    ),
    title: 'Parallel Browser Sessions',
    body: 'Run dozens of isolated Chromium and Firefox profiles at the same time. Each gets its own cookies, storage, proxy, fingerprint, and timezone — zero bleed between them.',
  },
  {
    badge: null,
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2C8.5 2 6 5 6 8c0 4 6 14 6 14s6-10 6-14c0-3-2.5-6-6-6z"/>
        <circle cx="12" cy="8" r="2"/>
      </svg>
    ),
    title: 'Anti-detect Engine',
    body: 'Canvas, WebGL, audio, fonts, and WebRTC fingerprints spoofed at the C++ level in a patched Chromium. No JS injection — the patch lives in V8 and Blink themselves.',
  },
  {
    badge: 'Sync',
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
      </svg>
    ),
    title: 'Encrypted Cloud Sync',
    body: 'Profiles and MCP project configs sync across your Macs via S3, R2, or any S3-compatible store. No backend server. Coordination is pure atomic conditional writes — Kopia encrypts the data.',
  },
  {
    badge: null,
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
    title: 'Persistent Sessions',
    body: 'Cookies, IndexedDB, localStorage all persist on disk per profile. Your AI agent logs in once and stays logged in — across restarts, across AI sessions.',
  },
  {
    badge: 'Open Source',
    icon: (
      <svg className="feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    title: 'Self-hosted & MIT',
    body: <>No account, no license server, no telemetry. Profiles live in plain SQLite on your disk. <a href="https://github.com/irensaltali/sekvona" target="_blank" rel="noopener" style={{color:'var(--accent)'}}>Fork it on GitHub</a> — it's fully MIT licensed.</>,
  },
]

export default function Features() {
  return (
    <section id="features" className="features-section">
      <div className="inner">
        <ScrollReveal className="features-header">
          <p className="section-eyebrow">Capabilities</p>
          <h2 className="section-h2">Everything your agents need.<br /><em>Nothing they don't.</em></h2>
          <p className="section-sub">Seknova is the MCP manager for browser sessions — real browsers, real sessions, real control.</p>
        </ScrollReveal>
        <div className="features-grid">
          {features.map((f, i) => (
            <ScrollReveal key={f.title} delay={i * 0.08}>
              <div className="feature-item">
                {f.badge && <div className="feat-badge">{f.badge}</div>}
                {f.icon}
                <h3 className="feature-h3">{f.title}</h3>
                <p className="feature-p">{f.body}</p>
                {f.extra}
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  )
}

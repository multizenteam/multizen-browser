const platforms = [
  {
    name: 'macOS',
    sub: 'Apple Silicon & Intel DMG',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8zm-1-13v4H7l5 5 5-5h-4V7h-2z"/></svg>,
  },
  {
    name: 'Windows',
    sub: 'x64 Installer',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M0 0h11.377v11.372H0zm12.623 0H24v11.372H12.623zM0 12.623h11.377V24H0zm12.623 0H24V24H12.623z"/></svg>,
  },
  {
    name: 'Linux',
    sub: 'x86-64 AppImage',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 2c1.66 0 3.19.5 4.46 1.35L5.35 16.46A7.96 7.96 0 0 1 4 12c0-4.42 3.58-8 8-8zm0 16c-1.66 0-3.19-.5-4.46-1.35l11.11-11.11A7.96 7.96 0 0 1 20 12c0 4.42-3.58 8-8 8z"/></svg>,
  },
]

export default function Download() {
  return (
    <section id="download" className="download-section">
      <div className="inner">
        <h2 className="download-h2">Ready to give your agents<br /><em>real browsers?</em></h2>
        <p className="download-sub">Download Seknova for your platform. Free, open source, MIT licensed.</p>
        <div className="platform-row">
          {platforms.map(p => (
            <a
              key={p.name}
              href="https://github.com/irensaltali/sekvona/releases/latest"
              target="_blank"
              rel="noopener"
              className="platform-btn"
            >
              {p.icon}
              <div>
                <div className="platform-name">{p.name}</div>
                <div style={{fontSize:'11px',color:'var(--fg-faint)'}}>{p.sub}</div>
              </div>
            </a>
          ))}
        </div>
        <a href="https://github.com/irensaltali/sekvona" target="_blank" rel="noopener" className="github-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
          </svg>
          Star on GitHub · irensaltali/sekvona
        </a>
      </div>
    </section>
  )
}

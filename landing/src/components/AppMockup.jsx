import { useEffect, useState } from 'react'

const profiles = [
  { initial: 'S', cls: 'av-blue',   name: 'Sales Outreach', engine: 'CloakBrowser', engineCls: 'tag-cloak', proxy: 'US · New York',    running: true  },
  { initial: 'R', cls: 'av-purple', name: 'Research EU',    engine: 'Camoufox',     engineCls: 'tag-camou', proxy: 'DE · Berlin',     running: true  },
  { initial: 'Q', cls: 'av-green',  name: 'QA Testing',     engine: 'CloakBrowser', engineCls: 'tag-cloak', proxy: 'GB · London',     running: false },
  { initial: 'A', cls: 'av-amber',  name: 'Analytics APAC', engine: 'Camoufox',     engineCls: 'tag-camou', proxy: 'SG · Singapore',  running: false },
]

export default function AppMockup() {
  const [activeNav, setActiveNav] = useState('Profiles')
  const [flashIdx, setFlashIdx] = useState(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let idx = 0
    function flash() {
      setFlashIdx(idx % profiles.length)
      setTimeout(() => setFlashIdx(null), 1200)
      idx++
      setTimeout(flash, 2200 + Math.random() * 1000)
    }
    const t = setTimeout(flash, 1800)
    return () => clearTimeout(t)
  }, [])

  const navItems = [
    { label: 'Profiles', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>, group: 'Workspace' },
    { label: 'Projects', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>, group: null },
    { label: 'MCP Server', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>, group: 'System' },
    { label: 'Settings', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>, group: null },
  ]

  return (
    <div className="mockup-section">
      <div className="inner">
        <div className="mac-window" role="img" aria-label="Seknova app showing 4 browser profiles">
          <div className="mac-titlebar">
            <div className="traffic-lights" aria-hidden="true">
              <div className="tl tl-red"></div>
              <div className="tl tl-yellow"></div>
              <div className="tl tl-green"></div>
            </div>
            <div className="mac-title">Seknova — 4 profiles</div>
          </div>
          <div className="mac-body">
            <nav className="mac-sidebar" aria-label="App sidebar">
              {navItems.map((item, i) => (
                <div key={item.label}>
                  {item.group && <div className="sidebar-label">{item.group}</div>}
                  <div
                    className={`sidebar-item${activeNav === item.label ? ' active' : ''}`}
                    onClick={() => setActiveNav(item.label)}
                  >
                    {item.icon}
                    {item.label}
                  </div>
                </div>
              ))}
            </nav>
            <main className="mac-main">
              <div className="main-topbar">
                <span className="main-title-row">All Profiles</span>
                <button className="btn-new">+ New Profile</button>
              </div>
              <div className="profile-grid">
                {profiles.map((p, i) => (
                  <div key={p.name} className={`profile-card${flashIdx === i ? ' launching' : ''}`}>
                    <div className={`avatar ${p.cls}`}>{p.initial}</div>
                    <div className="profile-info">
                      <div className="profile-name">{p.name}</div>
                      <div className="profile-tags">
                        <span className={`tag ${p.engineCls}`}>{p.engine}</span>
                        <span className="tag tag-proxy">{p.proxy}</span>
                      </div>
                      <div className="profile-status">
                        <span className={`status-dot ${p.running ? 'dot-running' : 'dot-idle'}`}></span>
                        {p.running ? 'Running' : 'Idle'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}

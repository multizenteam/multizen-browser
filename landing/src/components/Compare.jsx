const rows = [
  { feature: 'Native MCP server',              seknova: 'check', bb: 'check',   go: 'cross'   },
  { feature: 'Drives browser through MCP',     seknova: 'check', bb: 'check',   go: 'cross'   },
  { feature: 'Anti-detect at C++ level',       seknova: 'check', bb: 'partial', go: 'check'   },
  { feature: 'Persistent login across sessions', seknova: 'check', bb: 'cross',  go: 'check'   },
  { feature: 'Self-hosted',                    seknova: 'check', bb: 'cross',   go: 'cross'   },
  { feature: 'Pay per browser-hour',           seknova: 'cross', bb: 'check',   go: 'partial' },
  { feature: 'Open source core',               seknova: 'check-mit', bb: 'partial-sdk', go: 'cross' },
]

function Cell({ val }) {
  if (val === 'check')     return <span className="check">✓</span>
  if (val === 'check-mit') return <span className="check">✓ MIT</span>
  if (val === 'cross')     return <span className="cross">✗</span>
  if (val === 'partial')   return <span className="partial">Partial</span>
  if (val === 'partial-sdk') return <span className="partial">SDK only</span>
  return null
}

export default function Compare() {
  return (
    <section id="compare" className="compare-section">
      <div className="inner">
        <p className="section-eyebrow">Compare</p>
        <h2 className="section-h2">Why Seknova?</h2>
        <p className="section-sub">The only self-hosted solution that pairs native MCP with C++-level anti-detect and persistent login.</p>
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th></th>
                <th className="col-seknova">Seknova</th>
                <th>Browserbase / Hyperbrowser</th>
                <th>GoLogin / AdsPower</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.feature}>
                  <td className="feature-col">{r.feature}</td>
                  <td><Cell val={r.seknova} /></td>
                  <td><Cell val={r.bb} /></td>
                  <td><Cell val={r.go} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

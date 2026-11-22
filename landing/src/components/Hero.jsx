import { useEffect, useRef } from 'react'

export default function Hero() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let w, h, rafId

    const rings = Array.from({ length: 11 }, (_, i) => ({
      rx: 0.52 + i * 0.09, ry: 0.28 + i * 0.045,
      opacity: 0.03 + i * 0.009,
      speed: 0.00008 + i * 0.00003,
      phase: (i / 11) * Math.PI * 2,
    }))

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect()
      w = canvas.width = rect.width
      h = canvas.height = rect.height
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function draw(ts) {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2, cy = h / 2
      rings.forEach((r, i) => {
        const a = r.phase + ts * r.speed
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a)
        ctx.beginPath()
        ctx.ellipse(0, 0, r.rx * w * 0.5, r.ry * h * 0.5, 0, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(32,62,96,${r.opacity})`
        ctx.lineWidth = 1 + (i % 3) * 0.5
        ctx.stroke(); ctx.restore()
      })
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.55)
      grad.addColorStop(0, 'rgba(137,207,255,0.025)')
      grad.addColorStop(1, 'rgba(6,11,18,0)')
      ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h)
      if (!reduced) rafId = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    if (reduced) draw(0)
    else rafId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <section className="hero-wrap" aria-label="Hero">
      <canvas ref={canvasRef} id="depth-canvas" aria-hidden="true" />
      <div className="inner hero-content">
        <div className="hero-badge"><span></span>Open Source · MIT License</div>
        <h1 className="hero-h1">
          <em>Multi-session browsers</em><br />
          <strong>managed by AI agents.</strong>
        </h1>
        <p className="hero-sub">
          Run dozens of isolated browser profiles simultaneously. Control every one through a native MCP server. Sync across machines with no backend.
        </p>
        <div className="hero-actions">
          <a href="#download" className="btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download for Mac
          </a>
          <a href="https://github.com/irensaltali/sekvona" target="_blank" rel="noopener" className="btn-ghost">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
            </svg>
            View on GitHub
          </a>
        </div>
        <p className="hero-compat">
          Works with Claude <span className="hero-compat-dot">·</span> Cursor <span className="hero-compat-dot">·</span> Codex <span className="hero-compat-dot">·</span> Kiro
        </p>
      </div>
    </section>
  )
}

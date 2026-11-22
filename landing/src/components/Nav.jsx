export default function Nav() {
  return (
    <nav className="nav">
      <div className="inner nav-inner">
        <a href="/" className="nav-logo" aria-label="Seknova home">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
            <defs>
              <linearGradient id="g1" x2=".75" y2="1" gradientUnits="objectBoundingBox">
                <stop stopColor="#203e60"/><stop offset="1" stopColor="#0b192b"/>
              </linearGradient>
            </defs>
            <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g1)"/>
            <g transform="rotate(-8 64 64)">
              <path fill="#e3f4ff" d="M98 32v9a5 5 0 0 1-5 5H55l-9 10 24 7-12 12-23-7c-9-3-12-11-6-19l14-16a13 13 0 0 1 10-5h17l5 4z"/>
              <path fill="#89cfff" transform="rotate(180 64 64)" d="M98 32v9a5 5 0 0 1-5 5H55l-9 10 24 7-12 12-23-7c-9-3-12-11-6-19l14-16a13 13 0 0 1 10-5h17l5 4z"/>
            </g>
          </svg>
          Seknova
        </a>
        <ul className="nav-links">
          <li><a href="#features">Features</a></li>
          <li><a href="#how-it-works">How it works</a></li>
          <li><a href="#compare">Compare</a></li>
          <li><a href="https://github.com/irensaltali/sekvona" target="_blank" rel="noopener">Docs</a></li>
        </ul>
        <div className="nav-actions">
          <a href="https://buymeacoffee.com/irensaltali" target="_blank" rel="noopener" className="bmc-btn" aria-label="Buy me a coffee">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-.789-1.624-.389-.449-.889-.801-1.45-.99-1.028-.336-2.066-.09-3.001.206-.404.126-.811.267-1.22.407-.409.14-.82.28-1.235.405-.657.198-1.325.374-1.998.526l-.165.038c-.437.098-.882.182-1.33.254-.448.072-.9.133-1.355.183-.455.05-.912.09-1.37.117-.459.027-.919.044-1.38.052l-.16.004c-.49.011-.98.015-1.47.015-.482 0-.963-.003-1.44-.01-.477-.007-.952-.02-1.424-.04-.473-.02-.942-.046-1.41-.079-.467-.033-.93-.072-1.39-.117a16.1 16.1 0 0 1-1.345-.183c-.448-.072-.893-.156-1.33-.254l-.165-.038c-.673-.152-1.341-.328-1.998-.526-.415-.125-.826-.265-1.235-.405-.409-.14-.816-.281-1.22-.407-.935-.296-1.973-.542-3.001-.206-.562.189-1.062.541-1.451.99-.401.461-.67 1.026-.789 1.624l-.132.666c-.038.195-.056.393-.056.591v5.25c0 .91.172 1.814.508 2.656.336.842.828 1.613 1.447 2.267.619.654 1.355 1.19 2.167 1.57.812.38 1.692.57 2.578.57h11.5c.887 0 1.766-.19 2.579-.57.812-.38 1.548-.916 2.167-1.57.619-.654 1.11-1.425 1.447-2.267.336-.842.508-1.746.508-2.656V7.006c0-.198-.018-.396-.056-.591z"/>
            </svg>
            Support
          </a>
          <a href="https://github.com/irensaltali/sekvona" target="_blank" rel="noopener" className="btn-ghost-sm" aria-label="GitHub">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
            </svg>
            GitHub
          </a>
          <a href="#download" className="btn-primary-sm">Download</a>
        </div>
      </div>
    </nav>
  )
}

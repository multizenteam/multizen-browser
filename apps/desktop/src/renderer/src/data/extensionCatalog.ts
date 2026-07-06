/**
 * Curated, MV3-only Chrome Web Store catalog powering the in-app "Discover"
 * extension picker. Static + bundled: no runtime network, no scraping, no
 * fingerprint impact. Every entry is a hand-verified Manifest V3 extension —
 * the install pipeline rejects MV2 (`crxPipeline.ts`), so an MV2 id here would
 * fail to install and look broken.
 *
 * Ids are the genuine 32-char (a–p) Chrome Web Store ids. To refresh/extend the
 * list, re-run the curation pass (see specs/BACKLOG.md #9) and keep MV3-only.
 */

export interface CatalogCategory {
  id: string;
  label: string;
}

export interface CatalogExtension {
  /** 32-char lowercase a–p Chrome Web Store id. */
  id: string;
  name: string;
  /** One short line; shown under the name in the picker. */
  description: string;
  /** Category id (see CATALOG_CATEGORIES). */
  category: string;
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { id: "adblock", label: "Ad blocking" },
  { id: "privacy", label: "Privacy & anti-track" },
  { id: "productivity", label: "Productivity & tabs" },
  { id: "password", label: "Passwords & wallets" },
  { id: "developer", label: "Developer tools" },
  { id: "utility", label: "Utilities" },
  { id: "social", label: "Social & shopping" },
];

// Verified curation pass (2026-07-05): each entry confirmed against its live
// Chrome Web Store page — 32-char id, exact name, and MV3 status (explicit MV3
// statement, or a recent 2024-2026 update while still installable after Chrome
// fully disabled MV2 in stable). Classic uBlock Origin is intentionally absent
// (MV2). Keep MV3-only when extending.
export const CATALOG_EXTENSIONS: CatalogExtension[] = [
  // Ad blocking
  { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", name: "uBlock Origin Lite", description: "Efficient declarative MV3 content blocker", category: "adblock" },
  { id: "bgnkhhnnamicmpeenaelnjfhikgbkllg", name: "AdGuard AdBlocker", description: "Blocks ads, pop-ups and trackers across sites", category: "adblock" },
  { id: "cfhdojbkjhnklbpkdaibdccddilifddb", name: "Adblock Plus - free ad blocker", description: "Blocks ads on YouTube and across the web", category: "adblock" },
  { id: "mlomiejdfkolichcflejclcbmpeaniij", name: "Ghostery Tracker & Ad Blocker", description: "Blocks ads and stops trackers, speeds up pages", category: "adblock" },

  // Privacy & anti-track
  { id: "pkehgijcmpdhfbdbbnkijodmdjhbjlgp", name: "Privacy Badger", description: "EFF tool that auto-blocks hidden trackers", category: "privacy" },
  { id: "ihcjicgdanjaechkgeegckofjjedodee", name: "Malwarebytes Browser Guard", description: "Blocks malware, scams, phishing and trackers", category: "privacy" },
  { id: "edibdbjcniadpccecjdfdjjppcpchdlm", name: "I still don't care about cookies", description: "Hides or blocks cookie consent pop-ups", category: "privacy" },

  // Productivity & tabs
  { id: "laookkfknpbbblfpciffpaejjkokdgca", name: "Momentum", description: "Personal dashboard new-tab page for focus", category: "productivity" },
  { id: "chphlpgkkbolifaimnlloiipkdnihall", name: "OneTab", description: "Collapse open tabs into a list to save memory", category: "productivity" },
  { id: "hddnkoipeenegfoeaoibdmnaalmgkpip", name: "Toby: Tab Management Tool", description: "Save and organize browser tabs into collections", category: "productivity" },
  { id: "knheggckgoiihginacbkhaalnibhilkk", name: "Notion Web Clipper", description: "Save any web page into Notion with one click", category: "productivity" },
  { id: "kbfnbcaeplbcioakkpcpgfkobkghlhen", name: "Grammarly: AI Writing Assistant", description: "Grammar, spelling and clarity suggestions", category: "productivity" },

  // Passwords & wallets
  { id: "nngceckbapebfimnlniiiahkandclblb", name: "Bitwarden Password Manager", description: "Open-source password manager and generator", category: "password" },
  { id: "ghmbeldphafepmbegfdlkpapadhbakde", name: "Proton Pass: Free Password Manager", description: "Encrypted password manager by Proton", category: "password" },
  { id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa", name: "1Password – Password Manager", description: "Sign in, save and generate passwords", category: "password" },
  { id: "oboonakemofpalcgghocfoadofidjkkk", name: "KeePassXC-Browser", description: "KeePassXC integration for the browser", category: "password" },
  { id: "nkbihfbeogaeaoehlefnkodbefgpgknn", name: "MetaMask", description: "Ethereum crypto wallet and Web3 login", category: "password" },
  { id: "bfnaelmomeimhlpmgjnjophhpkkoljpa", name: "Phantom", description: "Multichain crypto wallet for DeFi and NFTs", category: "password" },

  // Developer tools
  { id: "fmkadmapgofadopljbjfkapdkoienihi", name: "React Developer Tools", description: "Adds React debugging to Chrome DevTools", category: "developer" },
  { id: "lmhkpmbekcpmknklioeibfkpmmfibljd", name: "Redux DevTools", description: "Inspect Redux application state changes", category: "developer" },
  { id: "gppongmhjkpfnbhagpmjfkannfbllamg", name: "Wappalyzer - Technology profiler", description: "Identify technologies used on websites", category: "developer" },
  { id: "bcjindcccaagfpapjjmafapmmgkkhgoa", name: "JSON Formatter", description: "Pretty-prints JSON responses in the browser", category: "developer" },
  { id: "nhdogjmejiglipccpnnnanhbledajbpd", name: "Vue.js devtools", description: "Debugging tools for Vue.js applications", category: "developer" },
  { id: "bhlhnicpbhignbdhedgjhgdocnmhomnp", name: "ColorZilla", description: "Eyedropper, color picker and gradient tools", category: "developer" },

  // Utilities
  { id: "lmjnegcaeklhafolokijcfjliaokphfk", name: "Video DownloadHelper", description: "Download videos from the web", category: "utility" },
  { id: "fdpohaocaechififmbbbbbknoalclacl", name: "GoFullPage - Full Page Screen Capture", description: "Capture a full-page screenshot of any page", category: "utility" },
  { id: "nlipoenfbbikpbjkfpfillcgkoblgpmj", name: "Awesome Screenshot & Screen Recorder", description: "Capture and record the screen", category: "utility" },
  { id: "eimadpbcbfnmbkopoojfekhnkhdbieeh", name: "Dark Reader", description: "Dark mode for every website", category: "utility" },

  // Social & shopping
  { id: "bmnlcjabgnpnenekpadlanbbkooimhnj", name: "PayPal Honey: Automated Coupons & Rewards", description: "Finds coupon codes and rewards when shopping", category: "social" },
  { id: "chhjbpecpncaggjpdakmflnfcopglcmi", name: "Rakuten: Get Cash Back For Shopping", description: "Earn cash back at online stores", category: "social" },
  { id: "neebplgakaahbhdphmkckjjcegoiijjo", name: "Keepa - Amazon Price Tracker", description: "Amazon price history charts and drop alerts", category: "social" },
];

// MultiZen Companion — content script on Chrome Web Store detail pages. The
// native install path is dead in CloakBrowser, so we replace the disabled "Add
// to Chrome" button with our own "Add to MultiZen" in the same spot and hide
// Google's "Switch/Install Chrome" promos.
//
// CloakBrowser runs content scripts in an ISOLATED world (it ignores manifest
// world:MAIN) and suppresses console CDP events, so we can't reach the host via
// a window binding or console. Instead we write the chosen id to a DOM
// attribute on <html> (the DOM is shared across worlds); the host polls it.
(function () {
  "use strict";

  function extractId() {
    const m = /\/detail\/[^/]+\/([a-p]{32})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // Channel to MultiZen: write the id to a DOM attribute on <html>. CloakBrowser
  // puts this content script in an isolated world, but the DOM is shared, so the
  // host (which polls via CDP) reads it. Stamp a nonce so repeats are distinct.
  function signalHost(id) {
    try {
      document.documentElement.setAttribute(
        "data-mz-add-ext",
        JSON.stringify({ id: id, n: Date.now() }),
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  function setState(btn, text, tone) {
    btn.textContent = text;
    btn.style.pointerEvents = "none";
    btn.style.opacity = "0.9";
    if (tone === "ok") btn.style.background = "#16a34a";
    if (tone === "err") btn.style.background = "#b91c1c";
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = "mz-add-to-multizen";
    btn.type = "button";
    btn.textContent = "Add to MultiZen";
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "height:40px",
      "padding:0 24px",
      "margin:0",
      "border:0",
      "border-radius:20px",
      "font:500 14px 'Google Sans',Roboto,system-ui,-apple-system,sans-serif",
      "letter-spacing:0.2px",
      "color:#fff",
      "cursor:pointer",
      "white-space:nowrap",
      "background:linear-gradient(90deg,#6366f1,#a855f7)",
      "box-shadow:0 1px 2px rgba(60,64,67,0.30),0 1px 3px 1px rgba(60,64,67,0.15)",
      "transition:filter 120ms ease",
    ].join(";");
    btn.addEventListener("mouseenter", function () {
      btn.style.filter = "brightness(1.07)";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.filter = "none";
    });
    btn.addEventListener("click", function () {
      // Read the id at click time — the store is an SPA and may have navigated.
      const id = extractId();
      if (!id) {
        setState(btn, "Couldn't read extension ID", "err");
        return;
      }
      signalHost(id);
      setState(btn, "Adding… (reopening profile)", "ok");
    });
    return btn;
  }

  // A genuinely VISIBLE native "Add to Chrome" button. Some pages/locales still
  // render it; when they do we replace it in place. On the current Web Store for
  // non-Chrome browsers Google collapses this to 0×0 / display:none and shows a
  // promo banner instead (see findInstallBanner), so require real size here.
  //
  // Anchor STRUCTURALLY, not by the button's text: the CTA label is localized
  // ("Add to Chrome" / "Chrome に追加" / "В Chrome" …), so a text match only
  // worked on the English store. The primary CTA lives inside a stable action
  // container (div.OdjmDb) regardless of UI language — match that.
  function isVisibleContainer(container) {
    if (!container) return false;
    if (container.style && container.style.display === "none") return false;
    if (container.querySelector && container.querySelector("#mz-add-to-multizen")) return false;
    const r = container.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1; // collapsed → 0×0 for non-Chrome
  }

  function findVisibleNativeAdd() {
    // Primary, locale-independent: the action container holding the CTA button.
    // The detail page's related-extension cards also use this container, so pick
    // the TOPMOST visible one — the header CTA sits above the related cards.
    const containers = document.querySelectorAll("div.OdjmDb");
    let best = null;
    let bestTop = Infinity;
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      if (!c.querySelector("button")) continue;
      if (!isVisibleContainer(c)) continue;
      const top = c.getBoundingClientRect().top;
      if (top < bestTop) {
        bestTop = top;
        best = c;
      }
    }
    if (best) return best;
    // Fallback for older/other layouts: match the English label directly.
    const spans = document.querySelectorAll("span");
    for (let i = 0; i < spans.length; i++) {
      if ((spans[i].textContent || "").trim() !== "Add to Chrome") continue;
      const btn = spans[i].closest("button");
      if (!btn) continue;
      const container = btn.closest("div.OdjmDb") || btn.parentElement || btn;
      if (isVisibleContainer(container)) return container;
    }
    return null;
  }

  // The non-Chrome CTA banner Google shows in place of the install button:
  // "Switch to Chrome to install extensions and themes  [Install Chrome]". This
  // is the VISIBLE spot a non-Chrome user looks at, so when the native button is
  // hidden we anchor our button here and hide the banner.
  function findInstallBanner() {
    const divs = document.querySelectorAll("div");
    for (let i = 0; i < divs.length; i++) {
      const t = (divs[i].textContent || "").trim();
      if (t.length === 0 || t.length > 120) continue;
      if (!/Switch to Chrome to install extensions/i.test(t)) continue;
      const r = divs[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue; // not the visible one
      if (divs[i].querySelector("#mz-add-to-multizen")) continue;
      return divs[i];
    }
    return null;
  }

  let placedPath = "";
  function placeButton() {
    if (!extractId()) return;
    // SPA navigated to a different extension → drop our old button and re-place.
    if (placedPath && placedPath !== location.pathname) {
      const old = document.getElementById("mz-add-to-multizen");
      if (old) old.remove();
      placedPath = "";
    }
    if (document.getElementById("mz-add-to-multizen")) return; // already placed here

    // Primary: a visible native "Add to Chrome" → sit in its place.
    const native = findVisibleNativeAdd();
    if (native && native.parentElement) {
      placedPath = location.pathname;
      const btn = makeButton();
      native.parentElement.insertBefore(btn, native);
      native.style.setProperty("display", "none", "important");
      // If a redundant install banner is also present, hide it too (normally
      // mutually exclusive with a visible native button, but cheap to guard).
      hideInstallBanner();
      return;
    }
    // Fallback (current non-Chrome layout): native button is hidden and the
    // "Switch to Chrome to install…" banner takes its place. Put our button at
    // the banner's spot and hide the banner itself.
    const banner = findInstallBanner();
    if (banner && banner.parentElement) {
      placedPath = location.pathname;
      const btn = makeButton();
      banner.parentElement.insertBefore(btn, banner);
      banner.style.setProperty("display", "none", "important");
      banner.setAttribute("data-mz-promo-hidden", "1");
    }
  }

  // Hide the inline install banner if present (without anchoring to it). Used by
  // the native-button branch so a stray banner never lingers alongside our
  // button. findInstallBanner skips banners that already contain our button.
  function hideInstallBanner() {
    const banner = findInstallBanner();
    if (banner) {
      banner.style.setProperty("display", "none", "important");
      banner.setAttribute("data-mz-promo-hidden", "1");
    }
  }

  // True if `node` contains (or is) our button or the native install control.
  // Used as a hard fence so the promo-hider never nukes the action area —
  // these can share an ancestor with the "Switch to Chrome" promo, and hiding
  // that ancestor was wiping our button + page content.
  function containsActionUi(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.querySelector && node.querySelector("#mz-add-to-multizen")) return true;
    const spans = node.querySelectorAll ? node.querySelectorAll("span") : [];
    for (let i = 0; i < spans.length; i++) {
      if ((spans[i].textContent || "").trim() === "Add to Chrome") return true;
    }
    return false;
  }

  // Hide Google's "Switch to Chrome?" MODAL dialog shown to non-Chrome browsers
  // ("…Google recommends using Chrome…  No thanks / Yes"). The INLINE install
  // banner ("Switch to Chrome to install extensions…") is intentionally NOT
  // handled here — placeButton() owns it (anchors our button there, then hides
  // it). Targeting it here too caused a race: this could hide the banner while
  // it was still 0-width, before placeButton could anchor, leaving no button.
  // Climb to the promo container but STOP before (a) anything large enough to be
  // the page itself, or (b) any node that holds our button or the native install
  // control. Hide only a promo-only node. Marks to avoid loops.
  function hideSwitchBanner() {
    const needles = ["Switch to Chrome?", "recommends using Chrome"];
    // Scan spans + divs — covers a promo whose text is split across child spans
    // (the parent div's textContent still matches), without walking the whole
    // DOM. getBoundingClientRect only runs for the few nodes that match a needle.
    const nodes = document.querySelectorAll("span,div");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const text = el.textContent || "";
      if (text.length === 0 || text.length > 200) continue;
      let hit = false;
      for (let j = 0; j < needles.length; j++) if (text.indexOf(needles[j]) !== -1) hit = true;
      if (!hit) continue;
      // The matched element itself must not wrap the action UI.
      if (containsActionUi(el)) continue;
      let node = el;
      for (let up = 0; up < 5 && node.parentElement; up++) {
        const p = node.parentElement;
        // Fence: never ascend into a node that contains our button / the native
        // install control — that ancestor is the action area, not the promo.
        if (containsActionUi(p)) break;
        const r = p.getBoundingClientRect();
        if (r.height > window.innerHeight * 0.5 || r.width > window.innerWidth * 0.9) break;
        node = p;
      }
      if (containsActionUi(node)) continue; // final safety: don't hide the action area
      if (node.getAttribute("data-mz-promo-hidden")) continue; // already hidden
      node.setAttribute("data-mz-promo-hidden", "1");
      node.style.setProperty("display", "none", "important");
    }
  }

  function tick() {
    placeButton();
    hideSwitchBanner();
  }

  tick();
  let t = null;
  const schedule = function () {
    if (t) return;
    t = setTimeout(function () {
      t = null;
      tick();
    }, 300);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  // Safety net for SPA history navigations that don't mutate enough to trigger
  // the observer in time. Kept infrequent to avoid steady main-thread work.
  setInterval(tick, 2000);
})();

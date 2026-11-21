import {
  useEffect,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  PreviewFrame as PreviewFramePayload,
  PreviewInputEvent,
} from "@multizen/types";

/**
 * Live browser preview for a running profile.
 *
 * Frames arrive over the `profiles:preview-frame` IPC push channel as base64
 * JPEGs (no data-URL prefix). We decode them into an `ImageBitmap` and paint
 * them on a `<canvas>`.
 *
 * Decoding is coalesced through `requestAnimationFrame`: several frames that
 * arrive between two paints cost a single decode + draw, and only the newest
 * one is kept.
 *
 * INTERACTIVE in full mode: pointer, keyboard and wheel events are forwarded
 * to the page producing the screencast. Compact stays a read-only thumbnail.
 */

/** Aspect used until the first frame tells us the real viewport shape. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * Upper bound for the canvas backing store width. Cards are ~300 CSS px wide,
 * so capping keeps a dozen simultaneously previewing tiles from each holding a
 * multi-megabyte canvas; the expanded modal needs the extra detail to stay sharp.
 */
function maxBackingWidth(expanded: boolean, displayWidth = 0): number {
  if (!expanded) return 640;
  return Math.max(640, Math.min(1440, Math.ceil(displayWidth)));
}

/**
 * The card slot keeps a sane shape whatever the live viewport reports — an
 * extreme portrait viewport must not stretch the grid row.
 */
const MIN_ASPECT = 0.75;
const MAX_ASPECT = 2.1;

function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** DOM modifier flags → CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
function cdpModifiers(event: ModifierKeys): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** DOM pointer button index → CDP button name. */
function pointerButton(button: number): "none" | "left" | "middle" | "right" | "back" | "forward" {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

/** DOM pointer button index → CDP `buttons` bit (DOM and CDP order differ). */
function pointerButtonBit(button: number): number {
  switch (button) {
    case 0:
      return 1; // left
    case 1:
      return 4; // middle
    case 2:
      return 2; // right
    case 3:
      return 8; // back
    case 4:
      return 16; // forward
    default:
      return 0;
  }
}

interface Props {
  profileId: string;
  /**
   * "compact" renders a small fixed-size thumbnail for the dense list row
   * (where the grid card's full-width preview would break the row layout).
   */
  variant?: "full" | "compact";
  /** Expanded modal preview: sharper frames and a faster paint gate. */
  expanded?: boolean;
}

/* ────────────────────────── stream lifecycle ────────────────────────── */

interface StreamEntry {
  /** Number of mounted consumers (grid card, list card, …). */
  refs: number;
  /** Whether the main process is currently streaming frames for this profile. */
  running: boolean;
  /** A `previewStart` call is in flight — no second start may be issued. */
  starting: boolean;
  /** Pending "last consumer left" stop timer — cancelled by a re-mount. */
  stopTimer: number | null;
}

/** Per-profile stream registry — one preview stream per profile, refcounted. */
const streams = new Map<string, StreamEntry>();

/**
 * Per-profile operation queue. Start/stop calls are serialized so a rapid
 * mount → unmount → mount cycle can never interleave into a stopped stream.
 */
const queues = new Map<string, Promise<void>>();

function serialize<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(profileId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(profileId, tail);
  void tail.then(() => {
    if (queues.get(profileId) === tail) queues.delete(profileId);
  });
  return next;
}

/**
 * The preview slice of the preload API. Typed on `MultizenApi`, but the
 * renderer can run before the bridge is installed (e.g. in a test harness),
 * so every access is optional.
 */
interface PreviewApi {
  previewStart?: (id: string) => Promise<boolean>;
  previewStop?: (id: string) => Promise<void>;
  onPreviewFrame?: (cb: (frame: PreviewFramePayload) => void) => () => void;
  /** Raise the profile's browser window. */
  previewFocus?: (id: string) => Promise<void>;
  /** Forward one input event into the screencast's page. */
  previewInput?: (id: string, event: PreviewInputEvent) => Promise<void>;
}

function previewApi(): PreviewApi | null {
  if (typeof window === "undefined") return null;
  const profiles = window.multizen?.profiles as unknown as PreviewApi | undefined;
  return profiles ?? null;
}

/** The focus bridge, whichever name the preload exposed it under. */
function focusBridge(): ((id: string) => Promise<void>) | null {
  const api = previewApi();
  return api?.previewFocus ?? null;
}

/** Start (or join) the preview stream for a profile. */
function acquireStream(profileId: string): void {
  let entry = streams.get(profileId);
  if (!entry) {
    entry = { refs: 0, running: false, starting: false, stopTimer: null };
    streams.set(profileId, entry);
  }
  if (entry.stopTimer !== null) {
    window.clearTimeout(entry.stopTimer);
    entry.stopTimer = null;
  }
  entry.refs += 1;
  if (entry.running || entry.starting) return;

  entry.starting = true;
  void serialize(profileId, async () => {
    const api = previewApi();
    if (!api?.previewStart) return;
    const current = streams.get(profileId);
    if (!current || current.refs <= 0) return;
    try {
      current.running = (await api.previewStart(profileId)) === true;
    } catch {
      current.running = false;
    }
  }).finally(() => {
    const current = streams.get(profileId);
    if (current) current.starting = false;
  });
}

/** Leave the preview stream; the last consumer out stops it. */
function releaseStream(profileId: string): void {
  const entry = streams.get(profileId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;

  // Defer the stop by a tick so a StrictMode remount (mount → cleanup → mount)
  // does not tear the stream down and immediately rebuild it.
  entry.stopTimer = window.setTimeout(() => {
    const current = streams.get(profileId);
    if (!current || current.refs > 0) return;
    streams.delete(profileId);
    void serialize(profileId, async () => {
      const api = previewApi();
      if (!api?.previewStop) return;
      try {
        await api.previewStop(profileId);
      } catch {
        /* the profile may already be gone — nothing to clean up */
      }
    });
  }, 0);
}

/* ───────────────────────────── decoding ─────────────────────────────── */

type DecodedFrame = ImageBitmap | HTMLImageElement;

function frameSize(source: DecodedFrame): { width: number; height: number } {
  if ("naturalWidth" in source) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

function closeFrame(source: DecodedFrame | null): void {
  if (source && "close" in source) source.close();
}

/** base64 JPEG → decoded image source. `createImageBitmap` first, `Image` fallback. */
async function decodeFrame(data: string): Promise<DecodedFrame> {
  // The contract says "base64 JPEG, no data: prefix" — tolerate a prefix
  // anyway so a future producer change cannot break the preview.
  const payload = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/jpeg" });

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path */
    }
  }

  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("preview frame decode failed"));
    image.src = `data:image/jpeg;base64,${payload}`;
  });
}

/* ────────────────────────────── component ───────────────────────────── */

export function ProfilePreview({
  profileId,
  variant = "full",
  expanded = false,
}: Props): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingRef = useRef<PreviewFramePayload | null>(null);
  const decodingRef = useRef(false);
  const lastSeqRef = useRef(Number.NEGATIVE_INFINITY);
  const mountedRef = useRef(true);
  /** Latest frame viewport (CSS px). Set on arrival, before the frame paints. */
  const viewportRef = useRef<{ width: number; height: number } | null>(null);
  /** Kept in a ref so callbacks captured by the subscription stay current. */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Last paint timestamp — the paint gate reads this on every frame arrival. */
  const lastPaintAtRef = useRef(0);
  /** At most one deferred-paint timer exists at any time. */
  const paintTimerRef = useRef<number | null>(null);
  /** Previous pointer-down position, for double-click detection. */
  const lastDownRef = useRef<{ time: number; x: number; y: number } | null>(null);
  /** The pending press: its clickCount is reused on up/cancel/lost capture. */
  const pressRef = useRef<{
    time: number;
    x: number;
    y: number;
    clickCount: number;
  } | null>(null);
  /** Pointer id we currently hold capture on, if any. */
  const captureIdRef = useRef<number | null>(null);
  /** Guards so React state setters only run when their value really changes. */
  const aspectRef = useRef(DEFAULT_ASPECT);
  const hasFrameRef = useRef(false);

  const [hasFrame, setHasFrame] = useState(false);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const apply = (s: { virtualBrowserPreview: boolean }): void => {
      if (!alive) return;
      setPreviewEnabled(s.virtualBrowserPreview !== false);
      setSettingsReady(true);
    };
    if (!window.multizen?.settings) {
      setSettingsReady(true);
      return;
    }
    void window.multizen.settings.get().then(apply).catch(() => {
      if (alive) setSettingsReady(true);
    });
    const off = window.multizen.settings.onChanged(apply);
    return () => { alive = false; off(); };
  }, []);

  // The expanded preview fills its host purely in CSS (`w-full h-full` +
  // canvas `object-fit: contain`), so it tracks any modal resize — including
  // focus mode — without JS measurement that can latch onto a mid-animation
  // size. The canvas's 12px inset keeps a small breathing margin.

  // Stream lifecycle — mount starts the preview, unmount stops it. The
  // registry guarantees a single stream per profile even if several cards
  // show the same profile at once.
  useEffect(() => {
    if (!settingsReady || !previewEnabled) return;
    mountedRef.current = true;
    acquireStream(profileId);
    return () => {
      mountedRef.current = false;
      releaseStream(profileId);
    };
  }, [profileId, previewEnabled, settingsReady]);

  // No point paying for screencasts while MultiZen itself is in the background.
  useEffect(() => {
    if (!settingsReady || !previewEnabled) return;
    const onVisibility = (): void => {
      if (document.hidden) releaseStream(profileId);
      else acquireStream(profileId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [profileId, previewEnabled, settingsReady]);

  // Reconfigure the live stream when this preview opens (expanded) or closes
  // back to a card. A missing bridge is a no-op.
  useEffect(() => {
    if (!settingsReady || !previewEnabled) return;
    const previewQuality = window.multizen?.profiles?.previewQuality;
    if (typeof previewQuality !== "function") return;
    void previewQuality(profileId, expanded).catch(() => {
      /* the profile may already be gone — quality is best-effort */
    });
    if (!expanded) return;
    return () => {
      void previewQuality(profileId, false).catch(() => {
        /* the profile may already be gone — quality is best-effort */
      });
    };
  }, [profileId, expanded, previewEnabled, settingsReady]);

  // Frame subscription + rAF-coalesced painting.
  useEffect(() => {
    if (!settingsReady || !previewEnabled) return;
    const off = previewApi()?.onPreviewFrame?.((frame) => {
      if (frame.profileId !== profileId) return;
      if (frame.seq <= lastSeqRef.current) {
        // A restarted preview session resets its counter — re-baseline.
        // Anything else is a stale/duplicated frame.
        if (frame.seq > 1) return;
        lastSeqRef.current = Number.NEGATIVE_INFINITY;
      }
      if (frame.width > 0 && frame.height > 0) {
        viewportRef.current = { width: frame.width, height: frame.height };
      }
      pendingRef.current = frame;
      schedule();
    });

    return () => {
      off?.();
      if (paintTimerRef.current !== null) {
        window.clearTimeout(paintTimerRef.current);
        paintTimerRef.current = null;
      }
      pendingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, previewEnabled, settingsReady]);

  function schedule(): void {
    if (decodingRef.current || paintTimerRef.current !== null) return;
    // rAF quantizes to display ticks (~21/41 fps); absolute timers give a
    // stable 16 fps in cards and 30 fps in Expand.
    const interval = expandedRef.current ? 33 : 62;
    const delay = Math.max(0, interval - (performance.now() - lastPaintAtRef.current));
    paintTimerRef.current = window.setTimeout(() => {
      paintTimerRef.current = null;
      void pump();
    }, delay);
  }

  async function pump(): Promise<void> {
    const frame = pendingRef.current;
    pendingRef.current = null;
    if (!frame) return;

    decodingRef.current = true;
    let source: DecodedFrame | null = null;
    try {
      source = await decodeFrame(frame.data);
      const canvas = canvasRef.current;
      if (!canvas) return;

      paint(canvas, source, expandedRef.current, canvas.clientWidth);
      lastPaintAtRef.current = performance.now();
      lastSeqRef.current = frame.seq;

      const boxAspect = clampAspect(
        frame.width > 0 && frame.height > 0 ? frame.width / frame.height : DEFAULT_ASPECT,
      );
      if (!mountedRef.current) return;
      if (!hasFrameRef.current) {
        hasFrameRef.current = true;
        setHasFrame(true);
      }
      if (Math.abs(aspectRef.current - boxAspect) >= 0.001) {
        aspectRef.current = boxAspect;
        setAspect(boxAspect);
      }
    } catch {
      /* a single bad frame must not break the stream */
    } finally {
      decodingRef.current = false;
      closeFrame(source);
      if (pendingRef.current) schedule();
    }
  }

  function sendInput(event: PreviewInputEvent): void {
    const previewInput = previewApi()?.previewInput;
    if (!previewInput) return;
    void previewInput(profileId, event).catch(() => {
      /* the profile may already be gone — input is best-effort */
    });
  }

  /** Canvas rect → screencast viewport CSS pixels (canvas uses object-fit: contain). */
  function toViewportPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return null;
    const { width: frameW, height: frameH } = viewport;
    if (frameW <= 0 || frameH <= 0) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const scale = Math.min(rect.width / frameW, rect.height / frameH);
    const offX = (rect.width - frameW * scale) / 2;
    const offY = (rect.height - frameH * scale) / 2;
    return {
      x: clamp((clientX - rect.left - offX) / scale, 0, frameW),
      y: clamp((clientY - rect.top - offY) / scale, 0, frameH),
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const point = toViewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });

    // Hold capture so a release outside the surface still reaches us.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      captureIdRef.current = event.pointerId;
    } catch {
      captureIdRef.current = null;
    }

    const now = performance.now();
    const previous = lastDownRef.current;
    const clickCount =
      previous !== null &&
      now - previous.time < 500 &&
      Math.abs(event.clientX - previous.x) <= 12 &&
      Math.abs(event.clientY - previous.y) <= 12
        ? 2
        : 1;
    lastDownRef.current = { time: now, x: event.clientX, y: event.clientY };
    pressRef.current = { time: now, x: event.clientX, y: event.clientY, clickCount };

    sendInput({
      kind: "mousePressed",
      ...point,
      modifiers: cdpModifiers(event),
      button: pointerButton(event.button),
      buttons: pointerButtonBit(event.button),
      clickCount,
    });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const point = toViewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({
      kind: "mouseMoved",
      ...point,
      modifiers: cdpModifiers(event),
      button: "none",
      buttons: event.buttons,
    });
  }

  function releaseCapture(target: HTMLDivElement, pointerId: number): void {
    if (captureIdRef.current === null) return;
    captureIdRef.current = null;
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* capture was already released implicitly */
    }
  }

  function handlePointerRelease(event: ReactPointerEvent<HTMLDivElement>): void {
    const press = pressRef.current;
    pressRef.current = null;
    releaseCapture(event.currentTarget, event.pointerId);
    const point = toViewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({
      kind: "mouseReleased",
      ...point,
      modifiers: cdpModifiers(event),
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: press?.clickCount ?? 1,
    });
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    captureIdRef.current = null;
    const point = toViewportPoint(event.clientX, event.clientY);
    if (!point) return;
    sendInput({
      kind: "mouseReleased",
      ...point,
      modifiers: cdpModifiers(event),
      button: pointerButton(event.button),
      buttons: 0,
      clickCount: press.clickCount,
    });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    const point = toViewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({
      kind: "mouseWheel",
      ...point,
      modifiers: cdpModifiers(event),
      button: "none",
      buttons: event.buttons,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    });
  }

  function keyFields(event: ReactKeyboardEvent<HTMLDivElement>) {
    return {
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      nativeVirtualKeyCode: event.keyCode,
      modifiers: cdpModifiers(event),
    };
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    event.preventDefault();
    const fields = keyFields(event);
    // A composing char is committed by compositionend → insertText; avoid a double insert.
    if (event.key.length === 1 && !event.nativeEvent.isComposing) {
      sendInput({ kind: "keyDown", ...fields, text: event.key, unmodifiedText: event.key });
    } else {
      sendInput({ kind: "rawKeyDown", ...fields });
    }
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>): void {
    event.preventDefault();
    sendInput({ kind: "keyUp", ...keyFields(event) });
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLDivElement>): void {
    if (!event.data) return;
    event.preventDefault();
    sendInput({ kind: "insertText", text: event.data });
  }

  const canFocus = focusBridge() !== null;
  const compact = variant === "compact";

  const surface = (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-x-0 block w-full"
        style={{
          objectFit: "contain",
          top: expanded ? 12 : 0,
          height: expanded ? "calc(100% - 24px)" : "100%",
        }}
      />

      {!hasFrame && (
        <div
          className={
            compact
              ? "absolute inset-0 flex items-center justify-center"
              : "absolute inset-0 flex items-center justify-center gap-1.5"
          }
        >
          <span
            className="w-[6px] h-[6px] rounded-full"
            style={{
              background: "#34d399",
              opacity: 0.7,
              animation: "mz-dotpulse 1.6s ease-in-out infinite",
            }}
          />
          {!compact && <span className="mono text-[10px] text-slate-500">live preview…</span>}
        </div>
      )}

      {hasFrame && !compact && (
        <span
          className="absolute top-1.5 right-1.5 mono text-[9px] px-1.5 py-[2px] rounded-md"
          style={{
            background: "rgba(8,9,13,0.72)",
            color: "#34d399",
            boxShadow: "inset 0 0 0 1px rgba(52,211,153,0.25)",
          }}
        >
          live
        </span>
      )}
    </>
  );

  if (!settingsReady || !previewEnabled) return null;
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => {
          void focusProfileBrowser(profileId);
        }}
        title={
          canFocus
            ? "Live preview (read-only) — click to bring the browser window to the front"
            : "Live preview (read-only)"
        }
        className="relative block shrink-0 p-0 border-0 bg-transparent cursor-pointer overflow-hidden rounded-[6px]"
        style={{
          width: 64,
          height: 36,
          background: "rgba(255,255,255,0.02)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        {surface}
      </button>
    );
  }

  return (
    <div
      ref={boxRef}
      role="group"
      tabIndex={0}
      aria-label={`Interactive live browser preview for profile ${profileId}`}
      className="relative block w-full shrink-0 p-0 border-0 bg-transparent cursor-pointer overflow-hidden rounded-[12px]"
      style={{
        width: "100%",
        height: expanded ? "100%" : undefined,
        aspectRatio: expanded ? undefined : `${aspect}`,
        background: "rgba(255,255,255,0.02)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        outline: focused ? "1px solid rgba(52,211,153,0.55)" : "none",
        outlineOffset: "1px",
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerRelease}
      onPointerCancel={handlePointerRelease}
      onLostPointerCapture={handleLostPointerCapture}
      onWheel={handleWheel}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onCompositionEnd={handleCompositionEnd}
    >
      {surface}
    </div>
  );
}

/**
 * Paint the frame into the canvas backing store. CSS sizes the canvas to the
 * slot with `object-fit: contain`, so the whole live viewport stays visible
 * (letterboxed) instead of being cropped.
 *
 * The backing store is capped by {@link maxBackingWidth}: cards stay cheap,
 * while the expanded modal keeps enough pixels to look sharp.
 */
function paint(
  canvas: HTMLCanvasElement,
  source: DecodedFrame,
  expanded: boolean,
  displayWidth: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height } = frameSize(source);
  if (width <= 0 || height <= 0) return;

  const scale = Math.min(1, maxBackingWidth(expanded, displayWidth) / width);
  const backingW = Math.max(1, Math.round(width * scale));
  const backingH = Math.max(1, Math.round(height * scale));

  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  ctx.drawImage(source, 0, 0, backingW, backingH);
}

/**
 * Raise the profile's real browser window. The main process answers with
 * `Target.activateTarget` on the profile's first page target — the same
 * mechanism the MCP `activate_tab` tool uses. When the channel is not
 * available the click is a harmless no-op (the preview stays read-only).
 */
async function focusProfileBrowser(profileId: string): Promise<void> {
  const focus = focusBridge();
  if (!focus) return;
  try {
    await focus(profileId);
  } catch {
    /* the browser may already be gone */
  }
}

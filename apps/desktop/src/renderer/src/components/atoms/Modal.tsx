import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Generic modal primitive. Handles:
 *   - portal to <body>
 *   - backdrop blur + fade-in
 *   - click-outside → close
 *   - ESC → close
 *   - focus trap (focus first focusable on open, restore prior focus on close)
 *   - body-scroll lock
 *   - optional `confirmClose` gate — useful for dirty-form discard prompts
 *
 * Stack: nested modals work — each registers its own ESC handler and only
 * the topmost modal handles the key. Backdrop click on a modal that has
 * a child modal open is ignored (the child captures it first).
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Optional gate. Called before close (ESC, backdrop, X button). Return
   * true to allow close, false to cancel. Async is supported — the modal
   * stays open until the promise resolves.
   */
  confirmClose?: () => boolean | Promise<boolean>;
  /** Title shown in the modal header. */
  title?: ReactNode;
  /** Optional subtitle line under the title. */
  subtitle?: ReactNode;
  /** Modal max width in px. Default 560. */
  width?: number;
  /** Right-side action buttons in the footer. */
  footer?: ReactNode;
  /** Hide the default header (X button + title). */
  hideHeader?: boolean;
  /** Additional class on the modal panel. */
  panelClassName?: string;
  children: ReactNode;
}

// Track the modal stack so only the topmost handles ESC + backdrop. The
// stack is keyed by an internal id so order is preserved.
const modalStack: number[] = [];
let nextModalId = 1;

export function Modal({
  open,
  onClose,
  confirmClose,
  title,
  subtitle,
  width = 560,
  footer,
  hideHeader,
  panelClassName,
  children,
}: ModalProps): JSX.Element | null {
  const idRef = useRef<number>(0);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [closing, setClosing] = useState(false);

  // Wrap onClose with the optional confirm gate.
  const tryClose = useCallback(async () => {
    if (closing) return;
    if (confirmClose) {
      const ok = await confirmClose();
      if (!ok) return;
    }
    onClose();
  }, [confirmClose, onClose, closing]);

  // Stack registration — first effect runs on mount, last on unmount.
  useEffect(() => {
    if (!open) return;
    if (idRef.current === 0) idRef.current = nextModalId++;
    modalStack.push(idRef.current);
    return () => {
      const i = modalStack.indexOf(idRef.current);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [open]);

  // ESC key — only topmost modal reacts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Topmost wins.
      if (modalStack[modalStack.length - 1] !== idRef.current) return;
      e.stopPropagation();
      void tryClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, tryClose]);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus management: focus first focusable on open, restore prior on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      if (!panelRef.current) return;
      // Prefer an explicitly-tagged field (e.g. the sheet's Name input) over the
      // first tab-order element, which would otherwise be a nav/rail button.
      const candidate =
        panelRef.current.querySelector<HTMLElement>("[data-autofocus]") ??
        panelRef.current.querySelector<HTMLElement>(
          "input, textarea, select, button, [tabindex]:not([tabindex='-1'])",
        );
      candidate?.focus();
    }, 60);
    return () => {
      window.clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (modalStack[modalStack.length - 1] !== idRef.current) return;
    void tryClose();
  };

  return createPortal(
    <div
      role="presentation"
      onMouseDown={onBackdropClick}
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{
        background: "rgba(5,6,10,0.55)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        animation: closing ? undefined : "mz-fade-in 180ms ease-out",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={`relative flex flex-col mx-6 ${panelClassName ?? ""}`}
        style={{
          width: "100%",
          maxWidth: width,
          maxHeight: "calc(100vh - 64px)",
          background: "rgba(15,16,22,0.96)",
          borderRadius: 18,
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.08), 0 36px 96px -24px rgba(0,0,0,0.7), 0 0 0 1px rgba(168,85,247,0.06)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          animation: "mz-modal-pop 220ms cubic-bezier(0.2,0.8,0.2,1)",
        }}
      >
        {!hideHeader && (
          <div
            className="flex items-start gap-3 px-5 pt-4 pb-3"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
          >
            <div className="flex-1 min-w-0">
              {title && (
                <div className="text-[15px] font-bold text-slate-100 leading-tight">
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="text-[12px] text-slate-500 mt-1">{subtitle}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void tryClose()}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div
            className="flex items-center justify-end gap-2 px-5 py-3"
            style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Stylized confirm dialog built on top of {@link Modal}. Resolves a
 * promise with the user's choice — convenient for `confirmClose` gates.
 *
 * Usage:
 *   const ok = await confirm({
 *     title: "Discard your changes?",
 *     confirmLabel: "Discard",
 *     destructive: true,
 *   });
 */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmHostState extends ConfirmOptions {
  open: boolean;
  resolve?: (value: boolean) => void;
}

let confirmHostSetter:
  | ((next: ConfirmHostState) => void)
  | null = null;

export function ConfirmHost(): JSX.Element | null {
  const [state, setState] = useState<ConfirmHostState>({
    open: false,
    title: "",
  });

  useEffect(() => {
    confirmHostSetter = setState;
    return () => {
      confirmHostSetter = null;
    };
  }, []);

  const close = (value: boolean): void => {
    state.resolve?.(value);
    setState((s) => ({ ...s, open: false, resolve: undefined }));
  };

  return (
    <Modal
      open={state.open}
      onClose={() => close(false)}
      width={420}
      hideHeader
      panelClassName="!rounded-2xl"
    >
      <div className="px-5 pt-5 pb-4">
        <div className="text-[15px] font-bold text-slate-100">{state.title}</div>
        {state.body && (
          <div className="text-[13px] text-slate-400 mt-2 leading-relaxed">
            {state.body}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={() => close(false)}
            className="px-3 h-8 text-[12px] rounded-lg text-slate-300 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
          >
            {state.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => close(true)}
            autoFocus
            className="px-3 h-8 text-[12px] rounded-lg font-medium transition-colors"
            style={{
              background: state.destructive
                ? "rgba(239,68,68,0.18)"
                : "linear-gradient(180deg, rgba(168,85,247,0.95), rgba(168,85,247,0.75))",
              color: state.destructive ? "#fca5a5" : "white",
              boxShadow: state.destructive
                ? "inset 0 0 0 1px rgba(239,68,68,0.4)"
                : "inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 12px -2px rgba(168,85,247,0.4)",
            }}
          >
            {state.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!confirmHostSetter) {
    // Fallback when host isn't mounted (rare — shouldn't happen).
    return Promise.resolve(window.confirm(opts.title));
  }
  return new Promise((resolve) => {
    confirmHostSetter!({
      ...opts,
      open: true,
      resolve,
    });
  });
}

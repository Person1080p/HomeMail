import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/* ---------- toasts ---------- */

interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action, reporting failures as toasts. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast(success, 'success');
        return r;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        return undefined;
      }
    },
    [toast],
  );
}

/* ---------- modal ---------- */

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------- dropdown menu ---------- */

export function Menu({ trigger, children, align = 'left' }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className={`menu menu-${align}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ---------- context menu ---------- */

export type MenuEntry =
  | 'separator'
  | { heading: string }
  | { label: string; icon?: string; shortcut?: string; danger?: boolean; onSelect?: () => void; submenu?: MenuEntry[] };

/** A right-click menu at a screen position, kept inside the viewport. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} onContextMenu={(e) => e.preventDefault()}>
      <MenuLevel entries={entries} at={{ x, y }} onClose={onClose} autoFocus />
    </div>,
    document.body,
  );
}

function MenuLevel({
  entries,
  at,
  onClose,
  onBack,
  autoFocus,
}: {
  entries: MenuEntry[];
  /** Where to open: a point for the root menu, or the item a submenu hangs off. */
  at: { x: number; y: number } | { item: HTMLElement };
  onClose: () => void;
  onBack?: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [openSub, setOpenSub] = useState<{ index: number; item: HTMLElement; focus: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ('item' in at) {
      const r = at.item.getBoundingClientRect();
      left = r.right + w <= vw - 4 ? r.right : r.left - w;
      top = r.top - 4;
    } else {
      left = at.x + w <= vw - 4 ? at.x : at.x - w;
      top = at.y + h <= vh - 4 ? at.y : at.y - h;
    }
    setPos({ left: Math.max(4, Math.min(left, vw - w - 4)), top: Math.max(4, Math.min(top, vh - h - 4)) });
    // A submenu opened from the keyboard starts on its first item; one opened by hovering leaves focus alone.
    if (autoFocus) ('item' in at ? (items()[0] ?? el) : el).focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(':scope > .ctx-item') ?? [])];
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const sub = i >= 0 ? (list[i].dataset.sub as string | undefined) : undefined;
    switch (e.key) {
      case 'ArrowDown':
        list[(i + 1) % list.length]?.focus();
        break;
      case 'ArrowUp':
        list[(i - 1 + list.length) % list.length]?.focus();
        break;
      case 'Home':
        list[0]?.focus();
        break;
      case 'End':
        list[list.length - 1]?.focus();
        break;
      case 'ArrowRight':
        if (sub) setOpenSub({ index: Number(sub), item: list[i], focus: true });
        break;
      case 'ArrowLeft':
        if (!onBack) return;
        onBack();
        break;
      case 'Escape':
        (onBack ?? onClose)();
        break;
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="menu ctx-menu"
      role="menu"
      tabIndex={-1}
      // Measured before it's placed; opacity rather than visibility so it can take focus meanwhile.
      style={pos ?? { left: 0, top: 0, opacity: 0 }}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry === 'separator') return <div key={index} className="ctx-sep" role="separator" />;
        if ('heading' in entry)
          return (
            <div key={index} className="ctx-heading">
              {entry.heading}
            </div>
          );
        const hasSub = !!entry.submenu?.length;
        return (
          <button
            key={index}
            className={`ctx-item ${entry.danger ? 'danger' : ''} ${openSub?.index === index ? 'sub-open' : ''}`}
            role="menuitem"
            tabIndex={-1}
            aria-haspopup={hasSub || undefined}
            aria-expanded={hasSub ? openSub?.index === index : undefined}
            data-sub={hasSub ? index : undefined}
            onMouseEnter={(e) => {
              const item = e.currentTarget;
              item.focus();
              if (hasSub) setOpenSub({ index, item, focus: false });
              else setOpenSub(null);
            }}
            onClick={(e) => {
              if (hasSub) {
                setOpenSub({ index, item: e.currentTarget, focus: true });
                return;
              }
              onClose();
              entry.onSelect?.();
            }}
          >
            {entry.icon ? <Icon name={entry.icon} size={15} /> : <span className="ctx-icon-space" />}
            <span className="ctx-label">{entry.label}</span>
            {entry.shortcut && <kbd className="ctx-shortcut">{entry.shortcut}</kbd>}
            {hasSub && <Icon name="chevronRight" size={13} className="ctx-arrow" />}
          </button>
        );
      })}
      {openSub && (
        <MenuLevel
          key={openSub.index}
          entries={(entries[openSub.index] as { submenu: MenuEntry[] }).submenu}
          at={{ item: openSub.item }}
          autoFocus={openSub.focus}
          onClose={onClose}
          onBack={() => {
            openSub.item.focus();
            setOpenSub(null);
          }}
        />
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  );
}

/* ---------- formatting ---------- */

export function formatDate(iso: string | null, long = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (long) return d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 86400_000 && d < now) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const addrText = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const addrShort = (a: { name: string; address: string } | null) => (a ? a.name || a.address : '');

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Escapes plain text and turns URLs and emails into links. */
export function linkify(text: string): string {
  return escapeHtml(text).replace(
    /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|\b([\w.+-]+@[\w-]+\.[\w.-]+\w)/g,
    (m, url) => (url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${m}</a>` : `<a href="mailto:${m}">${m}</a>`),
  );
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

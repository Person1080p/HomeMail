import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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

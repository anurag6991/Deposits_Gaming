'use client';

import { useEffect, useState } from 'react';

/**
 * The whole component vocabulary for this app.
 *
 * Kept deliberately small. The brief asked for something a publisher understands
 * immediately, so there is one button, one card, one table, one progress bar —
 * no variants library, no theming layer, nothing to learn.
 */

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const variants = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    // 44px min height: a publisher taps these all day on a phone.
    md: 'px-4 py-2.5 text-sm min-h-[44px]',
    lg: 'px-6 py-3 text-base min-h-[52px]',
  };

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A single headline number. The publisher dashboard is mostly these. */
export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'warn' | 'danger' | 'ok';
}) {
  const tones = {
    default: 'text-slate-900',
    ok: 'text-emerald-600',
    warn: 'text-amber-600',
    danger: 'text-red-600',
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function Progress({
  completed,
  target,
  label,
}: {
  completed: number;
  target: number;
  label?: string;
}) {
  const pct = target > 0 ? Math.min(100, Math.round((completed / target) * 100)) : 0;
  const complete = target > 0 && completed >= target;

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        {label && <span className="text-slate-600">{label}</span>}
        <span className="font-medium tabular-nums text-slate-900">
          {completed} / {target}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all ${complete ? 'bg-emerald-500' : 'bg-brand-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700',
    ok: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    danger: 'bg-red-50 text-red-700',
    info: 'bg-brand-50 text-brand-700',
  };
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * A field with a copy button.
 *
 * This is the single most-used control in the app — a publisher copies seven of
 * these per lead — so it confirms visibly and stays a large tap target.
 */
export function CopyField({ label, value }: { label: string; value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  if (!value) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard is blocked on insecure origins; select the text instead so the
      // publisher can copy manually rather than being silently stuck.
      const el = document.getElementById(`copy-${label}`) as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-500">{label}</p>
        <input
          id={`copy-${label}`}
          readOnly
          value={value}
          className="w-full truncate bg-transparent text-sm font-medium text-slate-900 outline-none"
        />
      </div>
      <Button variant="secondary" size="sm" onClick={copy} className="shrink-0">
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** Counts down to a server-supplied timestamp. Display only — the API re-checks. */
export function Countdown({ until, onDone }: { until: string | null; onDone?: () => void }) {
  const [remaining, setRemaining] = useState(() => secondsLeft(until));

  useEffect(() => {
    setRemaining(secondsLeft(until));
    if (!until) return;

    const timer = setInterval(() => {
      const next = secondsLeft(until);
      setRemaining(next);
      if (next <= 0) {
        clearInterval(timer);
        onDone?.();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [until, onDone]);

  if (!until || remaining <= 0) return null;

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <span className="tabular-nums font-medium">
      {h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`}
    </span>
  );
}

function secondsLeft(until: string | null): number {
  if (!until) return 0;
  return Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-sm text-red-600">{error}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  children: React.ReactNode;
}) {
  const tones = {
    info: 'bg-brand-50 text-brand-700 border-brand-100',
    ok: 'bg-emerald-50 text-emerald-800 border-emerald-100',
    warn: 'bg-amber-50 text-amber-800 border-amber-100',
    danger: 'bg-red-50 text-red-800 border-red-100',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

export function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Badge, Button, Card, Empty, Field, inputClass, Spinner } from '@/components/ui';

/**
 * Offers list, creation, assignment, and extension.
 *
 * Expired offers show red. That state comes from the server's `expired` flag, so
 * it stays correct even if the nightly status job has not run yet.
 */

interface OfferRow {
  id: string;
  name: string;
  brand: string;
  countryCode: string;
  status: string;
  startDate: string;
  expiryDate: string;
  expired: boolean;
  monthlyLeadTarget: number;
  monthlyDepositTarget: number;
  monthlyDepositAmountTarget: string;
  assignedPublishers: number;
  owner: { id: string; fullName: string };
}

interface PublisherRow {
  id: string;
  fullName: string;
  email: string;
  status: string;
}

const DEFAULTS = {
  name: '',
  brand: '',
  countryCode: 'US',
  url: '',
  description: '',
  publisherInstructions: '',
  monthlyLeadTarget: '100',
  monthlyDepositTarget: '50',
  monthlyDepositAmountTarget: '10000',
  leadIntervalMinutes: '5',
  depositIntervalMinutes: '120',
  gameplayIntervalDays: '3',
};

export default function OffersPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<OfferRow | null>(null);
  const [extending, setExtending] = useState<OfferRow | null>(null);

  const offers = useQuery({
    queryKey: ['offers'],
    queryFn: () => api<OfferRow[]>('/offers'),
    enabled: Boolean(user),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/offers/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['offers'] }),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Offers</h1>
          <Button onClick={() => setCreating(true)}>New offer</Button>
        </div>

        {offers.isLoading && <Spinner />}
        {offers.data?.length === 0 && <Empty>No offers yet. Create the first one.</Empty>}

        <div className="space-y-3">
          {offers.data?.map((o) => (
            <div
              key={o.id}
              className={`rounded-xl border bg-white p-4 ${
                o.expired ? 'border-red-300 bg-red-50/40' : 'border-slate-200'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{o.name}</p>
                  <p className="text-xs text-slate-500">
                    {o.brand} · {o.countryCode} · {o.assignedPublishers} publishers · owned by{' '}
                    {o.owner.fullName}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={o.status === 'ACTIVE' ? 'ok' : o.status === 'PAUSED' ? 'warn' : 'neutral'}>
                    {o.status}
                  </Badge>
                  {o.expired && <Badge tone="danger">Expired</Badge>}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-slate-500">Lead target</p>
                  <p className="font-medium tabular-nums">{o.monthlyLeadTarget}/mo</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Deposit target</p>
                  <p className="font-medium tabular-nums">{o.monthlyDepositTarget}/mo</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Amount target</p>
                  <p className="font-medium tabular-nums">${o.monthlyDepositAmountTarget}</p>
                </div>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Expires {new Date(o.expiryDate).toLocaleDateString()}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => setAssigning(o)}>
                  Assign publishers
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setExtending(o)}>
                  Extend
                </Button>
                {o.status === 'ACTIVE' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatus.mutate({ id: o.id, status: 'PAUSED' })}
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatus.mutate({ id: o.id, status: 'ACTIVE' })}
                  >
                    Activate
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {creating && (
        <CreateOfferModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['offers'] });
          }}
        />
      )}

      {assigning && (
        <AssignModal
          offer={assigning}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            void qc.invalidateQueries({ queryKey: ['offers'] });
          }}
        />
      )}

      {extending && (
        <ExtendModal
          offer={extending}
          onClose={() => setExtending(null)}
          onDone={() => {
            setExtending(null);
            void qc.invalidateQueries({ queryKey: ['offers'] });
          }}
        />
      )}
    </Shell>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function CreateOfferModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState(DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const set = (key: keyof typeof DEFAULTS) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api('/offers', {
        method: 'POST',
        body: {
          name: form.name,
          brand: form.brand,
          countryCode: form.countryCode,
          url: form.url,
          description: form.description || undefined,
          publisherInstructions: form.publisherInstructions || undefined,
          monthlyLeadTarget: Number(form.monthlyLeadTarget),
          monthlyDepositTarget: Number(form.monthlyDepositTarget),
          monthlyDepositAmountTarget: form.monthlyDepositAmountTarget,
          // Minutes in the UI because nobody thinks in seconds; converted here.
          leadIntervalSeconds: Number(form.leadIntervalMinutes) * 60,
          depositIntervalSeconds: Number(form.depositIntervalMinutes) * 60,
          gameplayIntervalDays: Number(form.gameplayIntervalDays),
          status: 'ACTIVE',
        },
      }),
    onSuccess: onDone,
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else setError('Could not create the offer.');
    },
  });

  return (
    <Modal title="New offer" onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Offer name" error={fields.name}>
            <input value={form.name} onChange={set('name')} className={inputClass} />
          </Field>
          <Field label="Brand" error={fields.brand}>
            <input value={form.brand} onChange={set('brand')} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Country" error={fields.countryCode}>
            <select value={form.countryCode} onChange={set('countryCode')} className={inputClass}>
              {['US', 'GB', 'CA', 'AU', 'DE', 'IN', 'NZ', 'IE', 'ZA'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Offer URL" error={fields.url}>
            <input value={form.url} onChange={set('url')} placeholder="https://" className={inputClass} />
          </Field>
        </div>

        <Field label="Instructions for publishers">
          <input
            value={form.publisherInstructions}
            onChange={set('publisherInstructions')}
            placeholder="Shown on the task screen"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Leads / month" error={fields.monthlyLeadTarget}>
            <input inputMode="numeric" value={form.monthlyLeadTarget} onChange={set('monthlyLeadTarget')} className={inputClass} />
          </Field>
          <Field label="Deposits / month" error={fields.monthlyDepositTarget}>
            <input inputMode="numeric" value={form.monthlyDepositTarget} onChange={set('monthlyDepositTarget')} className={inputClass} />
          </Field>
          <Field label="Amount / month ($)" error={fields.monthlyDepositAmountTarget}>
            <input inputMode="decimal" value={form.monthlyDepositAmountTarget} onChange={set('monthlyDepositAmountTarget')} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Lead gap (min)">
            <input inputMode="numeric" value={form.leadIntervalMinutes} onChange={set('leadIntervalMinutes')} className={inputClass} />
          </Field>
          <Field label="Deposit gap (min)">
            <input inputMode="numeric" value={form.depositIntervalMinutes} onChange={set('depositIntervalMinutes')} className={inputClass} />
          </Field>
          <Field label="Gameplay every (days)">
            <input inputMode="numeric" value={form.gameplayIntervalDays} onChange={set('gameplayIntervalDays')} className={inputClass} />
          </Field>
        </div>

        <p className="text-xs text-slate-500">
          Targets are shared across every publisher assigned to this offer. Expiry defaults to 90 days
          and can be extended later.
        </p>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={!form.name || !form.brand || !form.url || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create offer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AssignModal({
  offer,
  onClose,
  onDone,
}: {
  offer: OfferRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  const publishers = useQuery({
    queryKey: ['publishers'],
    queryFn: () => api<PublisherRow[]>('/users?role=PUBLISHER&status=ACTIVE'),
  });

  const assign = useMutation({
    mutationFn: () =>
      api(`/offers/${offer.id}/publishers`, { method: 'POST', body: { publisherIds: selected } }),
    onSuccess: onDone,
  });

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Modal title={`Assign publishers — ${offer.name}`} onClose={onClose}>
      {publishers.isLoading && <Spinner />}
      {publishers.data?.length === 0 && <Empty>No active publishers yet.</Empty>}

      <div className="space-y-1">
        {publishers.data?.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={() => toggle(p.id)}
              className="h-4 w-4"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{p.fullName}</span>
              <span className="block truncate text-xs text-slate-500">{p.email}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="flex-1"
          disabled={selected.length === 0 || assign.isPending}
          onClick={() => assign.mutate()}
        >
          Assign {selected.length > 0 ? selected.length : ''}
        </Button>
      </div>
    </Modal>
  );
}

function ExtendModal({
  offer,
  onClose,
  onDone,
}: {
  offer: OfferRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const defaultDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const extend = useMutation({
    mutationFn: () =>
      api(`/offers/${offer.id}/extend`, {
        method: 'POST',
        body: { newExpiryDate: date, reason: reason || undefined },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not extend.'),
  });

  return (
    <Modal title={`Extend — ${offer.name}`} onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-3 text-sm text-slate-600">
        Currently expires {new Date(offer.expiryDate).toLocaleDateString()}
      </p>
      <Field label="New expiry date">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
      </Field>
      <div className="mt-3">
        <Field label="Reason (optional)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={extend.isPending} onClick={() => extend.mutate()}>
          Extend
        </Button>
      </div>
    </Modal>
  );
}

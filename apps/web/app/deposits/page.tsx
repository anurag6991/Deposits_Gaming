'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Badge, Button, Card, Empty, Field, inputClass, Spinner } from '@/components/ui';

/**
 * Publisher deposits, with the gameplay traffic-light.
 *
 * Overdue is decided by the server (`overdue` on each row), not recomputed here.
 * A client-side date comparison would drift from the filter and show a red row
 * the "overdue" filter does not return.
 */

interface DepositRow {
  id: string;
  depositedAt: string;
  amount: string;
  method: string;
  status: 'ACTIVE' | 'COMPLETED';
  currentBalance: string;
  accountName: string;
  accountEmail: string;
  lastGameplayAt: string | null;
  nextGameplayDueAt: string | null;
  overdue: boolean;
  offer: { id: string; name: string; brand: string; countryCode: string };
}

type GameplayFilter = 'ALL' | 'OVERDUE' | 'DUE' | 'OK';

function DepositsScreen() {
  const { user, loading } = useRequireAuth(['PUBLISHER']);
  const params = useSearchParams();
  const qc = useQueryClient();

  const [gameplay, setGameplay] = useState<GameplayFilter>(
    (params.get('gameplay') as GameplayFilter) ?? 'ALL',
  );
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'COMPLETED'>('');
  const [confirming, setConfirming] = useState<DepositRow | null>(null);
  const [editing, setEditing] = useState<DepositRow | null>(null);
  const [withdrawing, setWithdrawing] = useState<DepositRow | null>(null);

  const deposits = useQuery({
    queryKey: ['deposits', gameplay, status],
    queryFn: () => {
      const q = new URLSearchParams();
      if (gameplay !== 'ALL') q.set('gameplay', gameplay);
      if (status) q.set('status', status);
      return api<{ rows: DepositRow[]; total: number }>(`/deposits?${q}`);
    },
    enabled: Boolean(user),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['deposits'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const confirmGameplay = useMutation({
    mutationFn: (id: string) => api(`/deposits/${id}/gameplay`, { method: 'POST' }),
    onSuccess: () => {
      setConfirming(null);
      invalidate();
    },
  });

  if (loading || !user) return <Spinner />;

  const filters: Array<{ key: GameplayFilter; label: string }> = [
    { key: 'ALL', label: 'All' },
    { key: 'OVERDUE', label: 'Overdue' },
    { key: 'DUE', label: 'Due soon' },
    { key: 'OK', label: 'OK' },
  ];

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Deposits</h1>

        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setGameplay(f.key)}
              className={`rounded-full px-3 py-1.5 text-sm ${
                gameplay === f.key ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | 'ACTIVE' | 'COMPLETED')}
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
          </select>
        </div>

        {deposits.isLoading && <Spinner />}
        {deposits.data?.rows.length === 0 && <Empty>No deposits yet.</Empty>}

        <div className="space-y-3">
          {deposits.data?.rows.map((d) => (
            <div
              key={d.id}
              className={`rounded-xl border bg-white p-4 ${
                d.overdue ? 'border-red-300 bg-red-50/40' : 'border-slate-200'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.offer.name}</p>
                  <p className="text-xs text-slate-500">
                    {d.offer.brand} · {new Date(d.depositedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">${d.amount}</p>
                  <p className="text-xs text-slate-500">Balance ${d.currentBalance}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone={d.status === 'ACTIVE' ? 'info' : 'neutral'}>{d.status}</Badge>
                {d.overdue ? (
                  <Badge tone="danger">Gameplay overdue</Badge>
                ) : d.nextGameplayDueAt ? (
                  <Badge tone="ok">
                    Next game {new Date(d.nextGameplayDueAt).toLocaleDateString()}
                  </Badge>
                ) : null}
              </div>

              {d.status === 'ACTIVE' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setConfirming(d)}>
                    Play game
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(d)}>
                    Update balance
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setWithdrawing(d)}>
                    Withdraw
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {confirming && (
        <Modal title="Have you played the game today?" onClose={() => setConfirming(null)}>
          <p className="text-sm text-slate-600">
            {confirming.offer.name} — ${confirming.amount}
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={confirmGameplay.isPending}
              onClick={() => confirmGameplay.mutate(confirming.id)}
            >
              Yes, confirm
            </Button>
          </div>
        </Modal>
      )}

      {editing && (
        <BalanceModal
          deposit={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}

      {withdrawing && (
        <WithdrawModal
          deposit={withdrawing}
          onClose={() => setWithdrawing(null)}
          onDone={() => {
            setWithdrawing(null);
            invalidate();
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
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function BalanceModal({
  deposit,
  onClose,
  onDone,
}: {
  deposit: DepositRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(deposit.currentBalance);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/deposits/${deposit.id}/balance`, { method: 'POST', body: { newBalance: value } }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update.'),
  });

  return (
    <Modal title="Update balance" onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-3 text-sm text-slate-600">Current balance ${deposit.currentBalance}</p>
      <Field label="New balance (USD)">
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={inputClass} />
      </Field>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

function WithdrawModal({
  deposit,
  onClose,
  onDone,
}: {
  deposit: DepositRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/deposits/${deposit.id}/withdrawals`, { method: 'POST', body: { amount } }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not record it.'),
  });

  return (
    <Modal title="Record withdrawal" onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-3 text-sm text-slate-600">Available balance ${deposit.currentBalance}</p>
      <Field label="Amount withdrawn (USD)">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="50.00"
          className={inputClass}
        />
      </Field>
      <p className="mt-2 text-xs text-slate-500">
        The balance updates automatically — you do not need to change it separately.
      </p>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={!amount || save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

export default function DepositsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DepositsScreen />
    </Suspense>
  );
}

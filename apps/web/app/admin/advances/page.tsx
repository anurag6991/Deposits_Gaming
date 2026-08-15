'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Badge, Button, Card, Empty, Field, inputClass, Spinner, Stat } from '@/components/ui';

interface AdvanceRow {
  id: string;
  amount: string;
  monthKey: string;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  paidOn: string | null;
  notes: string | null;
  publisher: { id: string; fullName: string };
  manager: { id: string; fullName: string } | null;
}

interface PublisherRow {
  id: string;
  fullName: string;
}

export default function AdminAdvancesPage() {
  const { user, loading } = useRequireAuth(['SUPER_ADMIN', 'MANAGER']);
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const advances = useQuery({
    queryKey: ['admin-advances'],
    queryFn: () => api<{ rows: AdvanceRow[]; total: string }>('/advances'),
    enabled: Boolean(user),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/advances/${id}`, {
        method: 'PATCH',
        body: {
          status,
          paidOn: status === 'PAID' ? new Date().toISOString().slice(0, 10) : undefined,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-advances'] }),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Advances</h1>
          <Button onClick={() => setAdding(true)}>Record advance</Button>
        </div>

        <Stat label="Total (excluding cancelled)" value={`$${advances.data?.total ?? '0'}`} />

        <Card title="All advances">
          {advances.isLoading && <Spinner />}
          {advances.data?.rows.length === 0 && <Empty>No advances recorded yet.</Empty>}

          <div className="space-y-2">
            {advances.data?.rows.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.publisher.fullName}</p>
                  <p className="text-xs text-slate-500">
                    {a.monthKey}
                    {a.manager ? ` · ${a.manager.fullName}` : ''}
                    {a.paidOn ? ` · paid ${new Date(a.paidOn).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold tabular-nums">${a.amount}</span>
                  <Badge
                    tone={a.status === 'PAID' ? 'ok' : a.status === 'PENDING' ? 'warn' : 'neutral'}
                  >
                    {a.status}
                  </Badge>
                  {a.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setStatus.mutate({ id: a.id, status: 'PAID' })}
                    >
                      Mark paid
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {adding && (
        <AddAdvanceModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['admin-advances'] });
          }}
        />
      )}
    </Shell>
  );
}

function AddAdvanceModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [publisherId, setPublisherId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const publishers = useQuery({
    queryKey: ['users', 'PUBLISHER'],
    queryFn: () => api<PublisherRow[]>('/users?role=PUBLISHER&status=ACTIVE'),
  });

  const create = useMutation({
    mutationFn: () =>
      api('/advances', {
        method: 'POST',
        body: { publisherId, amount, notes: notes || undefined },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not record it.'),
  });

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Record advance</h2>
        <div className="mt-3 space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label="Publisher">
            <select
              value={publisherId}
              onChange={(e) => setPublisherId(e.target.value)}
              className={inputClass}
            >
              <option value="">Choose…</option>
              {publishers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Amount (USD)">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Notes (optional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
          </Field>

          <p className="text-xs text-slate-500">
            Recorded as pending. Mark it paid once the money has actually moved.
          </p>

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!publisherId || !amount || create.isPending}
              onClick={() => create.mutate()}
            >
              Record
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

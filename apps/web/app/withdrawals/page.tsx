'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Card, Empty, Spinner, Stat } from '@/components/ui';

interface WithdrawalRow {
  id: string;
  amount: string;
  method: string | null;
  withdrawnAt: string;
  notes: string | null;
  deposit: { id: string; accountName: string; currentBalance: string };
  offer: { id: string; name: string; brand: string };
}

export default function WithdrawalsPage() {
  const { user, loading } = useRequireAuth(['PUBLISHER']);

  const withdrawals = useQuery({
    queryKey: ['withdrawals'],
    queryFn: () => api<{ rows: WithdrawalRow[]; total: string }>('/withdrawals'),
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Withdrawals</h1>

        <Stat label="Total withdrawn" value={`$${withdrawals.data?.total ?? '0'}`} />

        <Card title="History">
          {withdrawals.isLoading && <Spinner />}
          {withdrawals.data?.rows.length === 0 && (
            <Empty>
              No withdrawals yet. Record one from the Deposits screen using the Withdraw button.
            </Empty>
          )}

          <div className="space-y-2">
            {withdrawals.data?.rows.map((w) => (
              <div
                key={w.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{w.offer.name}</p>
                  <p className="text-xs text-slate-500">
                    {w.deposit.accountName} · {new Date(w.withdrawnAt).toLocaleDateString()}
                    {w.method ? ` · ${w.method}` : ''}
                  </p>
                </div>
                <p className="shrink-0 font-semibold tabular-nums">${w.amount}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Shell>
  );
}

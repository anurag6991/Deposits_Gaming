'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Badge, Card, Empty, Spinner, Stat } from '@/components/ui';

interface AdvanceRow {
  id: string;
  amount: string;
  monthKey: string;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  paidOn: string | null;
  notes: string | null;
  manager: { id: string; fullName: string } | null;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export default function AdvancesPage() {
  const { user, loading } = useRequireAuth(['PUBLISHER']);

  const advances = useQuery({
    queryKey: ['advances'],
    queryFn: () => api<{ rows: AdvanceRow[]; total: string }>('/advances'),
    enabled: Boolean(user),
  });

  if (loading || !user) return <Spinner />;

  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = advances.data?.rows
    .filter((a) => a.monthKey === thisMonth && a.status !== 'CANCELLED')
    .reduce((sum, a) => sum + Number(a.amount), 0);

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Advances</h1>

        <div className="grid grid-cols-2 gap-3">
          <Stat label="This month" value={`$${current ?? 0}`} />
          <Stat label="All time" value={`$${advances.data?.total ?? '0'}`} />
        </div>

        <Card title="History">
          {advances.isLoading && <Spinner />}
          {advances.data?.rows.length === 0 && (
            <Empty>No advances recorded. Your manager adds these.</Empty>
          )}

          <div className="space-y-2">
            {advances.data?.rows.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{monthLabel(a.monthKey)}</p>
                  <p className="text-xs text-slate-500">
                    {a.manager?.fullName ?? 'Manager'}
                    {a.paidOn ? ` · paid ${new Date(a.paidOn).toLocaleDateString()}` : ''}
                  </p>
                  {a.notes && <p className="mt-1 text-xs text-slate-500">{a.notes}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">${a.amount}</p>
                  <Badge
                    tone={a.status === 'PAID' ? 'ok' : a.status === 'PENDING' ? 'warn' : 'neutral'}
                  >
                    {a.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Shell>
  );
}

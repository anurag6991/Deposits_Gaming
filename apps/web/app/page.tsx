'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import { Alert, Button, Card, Countdown, Empty, Progress, Spinner, Stat } from '@/components/ui';

/**
 * Publisher home.
 *
 * The brief asked for something understandable at a glance: today's numbers,
 * the offers they can work right now, and anything overdue. Nothing else.
 */

interface DashboardData {
  leads: { today: number; month: number; target: number; remaining: number };
  deposits: { today: number; month: number; target: number; remaining: number };
  overdueGameplay: number;
  waitingTimers?: number;
  activeOffers: number;
}

interface EligibleOffer {
  offerId: string;
  name: string;
  brand: string;
  countryCode: string;
  expired: boolean;
  lead: {
    completed: number;
    target: number;
    remaining: number;
    today: number;
    nextAvailableAt: string | null;
    available: boolean;
  };
  deposit: {
    completed: number;
    target: number;
    remaining: number;
    today: number;
    amountCompleted: string;
    amountTarget: string;
    nextAvailableAt: string | null;
    available: boolean;
  };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function PublisherHome() {
  const { user, loading } = useRequireAuth(['PUBLISHER']);

  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/reports/dashboard'),
    enabled: Boolean(user),
  });

  const offers = useQuery({
    queryKey: ['eligible-offers'],
    queryFn: () => api<EligibleOffer[]>('/tasks/eligible-offers'),
    enabled: Boolean(user),
    // Timers tick down, so keep the list honest without the user refreshing.
    refetchInterval: 30_000,
  });

  if (loading || !user) return <Spinner />;

  const d = dashboard.data;

  return (
    <Shell>
      <div className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold">{greeting()}</h1>
          <p className="text-sm text-slate-500">{user.fullName}</p>
        </div>

        {d && d.overdueGameplay > 0 && (
          <Alert tone="danger">
            <div className="flex items-center justify-between gap-3">
              <span>
                {d.overdueGameplay} {d.overdueGameplay === 1 ? 'deposit needs' : 'deposits need'}{' '}
                gameplay
              </span>
              <Link href="/deposits?gameplay=OVERDUE" className="shrink-0 font-medium underline">
                View
              </Link>
            </div>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Leads today" value={d?.leads.today ?? '—'} sub={`${d?.leads.month ?? 0} this month`} />
          <Stat
            label="Deposits today"
            value={d?.deposits.today ?? '—'}
            sub={`${d?.deposits.month ?? 0} this month`}
          />
        </div>

        <Card title="Your offers">
          {offers.isLoading && <Spinner />}

          {offers.data?.length === 0 && (
            <Empty>No offers assigned yet. Your manager will assign them.</Empty>
          )}

          <div className="space-y-3">
            {offers.data?.map((offer) => {
              const canWork = offer.lead.available || offer.deposit.available;
              const soonest =
                offer.lead.nextAvailableAt && offer.deposit.nextAvailableAt
                  ? offer.lead.nextAvailableAt < offer.deposit.nextAvailableAt
                    ? offer.lead.nextAvailableAt
                    : offer.deposit.nextAvailableAt
                  : (offer.lead.nextAvailableAt ?? offer.deposit.nextAvailableAt);

              return (
                <div key={offer.offerId} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{offer.name}</p>
                      <p className="text-xs text-slate-500">
                        {offer.brand} · {offer.countryCode}
                      </p>
                    </div>
                    <Link href={`/work?offer=${offer.offerId}`} className="shrink-0">
                      <Button size="sm" disabled={!canWork}>
                        {canWork ? 'Start' : 'Waiting'}
                      </Button>
                    </Link>
                  </div>

                  <div className="mt-3 space-y-2">
                    <Progress
                      label="Leads"
                      completed={offer.lead.completed}
                      target={offer.lead.target}
                    />
                    <Progress
                      label="Deposits"
                      completed={offer.deposit.completed}
                      target={offer.deposit.target}
                    />
                  </div>

                  {!canWork && soonest && (
                    <p className="mt-2 text-xs text-slate-500">
                      Next available in{' '}
                      <Countdown until={soonest} onDone={() => void offers.refetch()} />
                    </p>
                  )}

                  {offer.lead.remaining === 0 && offer.deposit.remaining === 0 && (
                    <p className="mt-2 text-xs text-emerald-600">Monthly targets met</p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </Shell>
  );
}

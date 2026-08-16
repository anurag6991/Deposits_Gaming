'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isSafeHttpUrl } from '@deposits/shared';
import { api, ApiError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import {
  Alert,
  Button,
  Card,
  Countdown,
  CopyField,
  Empty,
  Field,
  inputClass,
  Progress,
  Spinner,
} from '@/components/ui';

/**
 * The task screen: pick an offer, pick lead or deposit, get an identity, do the
 * work on the brand's site, mark it done.
 *
 * Everything the publisher needs is on one screen, because they are switching
 * between this and another browser tab constantly.
 */

interface EligibleOffer {
  offerId: string;
  name: string;
  brand: string;
  countryCode: string;
  lead: { completed: number; target: number; today: number; nextAvailableAt: string | null; available: boolean };
  deposit: {
    completed: number;
    target: number;
    today: number;
    amountCompleted: string;
    amountTarget: string;
    nextAvailableAt: string | null;
    available: boolean;
  };
}

interface StartedTask {
  taskSessionId: string;
  type: 'LEAD' | 'DEPOSIT';
  expiresAt: string;
  offer: { id: string; name: string; brand: string; countryCode: string; url: string; instructions: string | null };
  identity: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  proxy: { id: string; host: string; port: number; protocol: string; username: string | null } | null;
}

function WorkScreen() {
  const { user, loading } = useRequireAuth(['PUBLISHER']);
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();

  const [selectedOffer, setSelectedOffer] = useState<string>(params.get('offer') ?? '');
  const [task, setTask] = useState<StartedTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyPassword, setProxyPassword] = useState<string | null>(null);

  const offers = useQuery({
    queryKey: ['eligible-offers'],
    queryFn: () => api<EligibleOffer[]>('/tasks/eligible-offers'),
    enabled: Boolean(user),
    refetchInterval: 30_000,
  });

  const current = offers.data?.find((o) => o.offerId === selectedOffer);

  const start = useMutation({
    mutationFn: (type: 'LEAD' | 'DEPOSIT') =>
      api<StartedTask>('/tasks/start', { method: 'POST', body: { offerId: selectedOffer, type } }),
    onSuccess: (data) => {
      setTask(data);
      setError(null);
      setProxyPassword(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not start the task.'),
  });

  const completeLead = useMutation({
    mutationFn: () => api(`/tasks/${task?.taskSessionId}/complete-lead`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setTask(null);
      void qc.invalidateQueries({ queryKey: ['eligible-offers'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the lead.'),
  });

  const abandon = useMutation({
    mutationFn: () => api(`/tasks/${task?.taskSessionId}/abandon`, { method: 'POST' }),
    onSuccess: () => {
      setTask(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['eligible-offers'] });
    },
  });

  const revealProxy = useMutation({
    mutationFn: () => api<{ password: string | null }>(`/proxies/${task?.proxy?.id}/credentials`),
    onSuccess: (data) => setProxyPassword(data.password),
  });

  if (loading || !user) return <Spinner />;

  return (
    <Shell>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Work</h1>

        {error && <Alert tone="danger">{error}</Alert>}

        {!task && (
          <>
            <Card title="Choose an offer">
              {offers.isLoading && <Spinner />}
              {offers.data?.length === 0 && <Empty>No offers assigned yet.</Empty>}

              <div className="space-y-2">
                {offers.data?.map((offer) => {
                  const selected = offer.offerId === selectedOffer;
                  const waiting = !offer.lead.available && !offer.deposit.available;
                  const soonest =
                    offer.lead.nextAvailableAt ?? offer.deposit.nextAvailableAt ?? null;

                  return (
                    <button
                      key={offer.offerId}
                      onClick={() => setSelectedOffer(offer.offerId)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        selected ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{offer.name}</p>
                          <p className="text-xs text-slate-500">
                            {offer.brand} · {offer.countryCode}
                          </p>
                        </div>
                        <div className="shrink-0 text-right text-xs">
                          <p className="tabular-nums text-slate-600">
                            L {offer.lead.completed}/{offer.lead.target}
                          </p>
                          <p className="tabular-nums text-slate-600">
                            D {offer.deposit.completed}/{offer.deposit.target}
                          </p>
                        </div>
                      </div>
                      {waiting && soonest && (
                        <p className="mt-2 text-xs text-amber-600">
                          Available in <Countdown until={soonest} onDone={() => void offers.refetch()} />
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </Card>

            {current && (
              <Card title={`${current.name} — what are you doing?`}>
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <Progress label="Leads this month" completed={current.lead.completed} target={current.lead.target} />
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-slate-500">
                        {current.lead.today} done today
                        {!current.lead.available && current.lead.nextAvailableAt && (
                          <>
                            {' · next in '}
                            <Countdown
                              until={current.lead.nextAvailableAt}
                              onDone={() => void offers.refetch()}
                            />
                          </>
                        )}
                      </span>
                      <Button
                        size="sm"
                        disabled={!current.lead.available || start.isPending}
                        onClick={() => start.mutate('LEAD')}
                      >
                        Start lead
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 p-3">
                    <Progress
                      label="Deposits this month"
                      completed={current.deposit.completed}
                      target={current.deposit.target}
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      Amount ${current.deposit.amountCompleted} / ${current.deposit.amountTarget}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-slate-500">
                        {current.deposit.today} done today
                        {!current.deposit.available && current.deposit.nextAvailableAt && (
                          <>
                            {' · next in '}
                            <Countdown
                              until={current.deposit.nextAvailableAt}
                              onDone={() => void offers.refetch()}
                            />
                          </>
                        )}
                      </span>
                      <Button
                        size="sm"
                        disabled={!current.deposit.available || start.isPending}
                        onClick={() => start.mutate('DEPOSIT')}
                      >
                        Start deposit
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}

        {task && (
          <>
            <Card
              title={task.type === 'LEAD' ? 'Lead in progress' : 'Deposit in progress'}
              action={
                <span className="text-xs text-slate-500">
                  Expires in <Countdown until={task.expiresAt} onDone={() => setTask(null)} />
                </span>
              }
            >
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {/* The API rejects non-http(s) schemes on write, but a link is
                      rendered from stored data, so it is re-checked here too:
                      a javascript: URL that ever reached the database must not
                      become executable just because it is displayed. */}
                  {isSafeHttpUrl(task.offer.url) ? (
                    <a href={task.offer.url} target="_blank" rel="noopener noreferrer">
                      <Button>Open website</Button>
                    </a>
                  ) : (
                    <Alert tone="danger">
                      This offer has an invalid web address. Ask an admin to fix it.
                    </Alert>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => void navigator.clipboard.writeText(task.offer.url)}
                  >
                    Copy link
                  </Button>
                </div>

                {task.offer.instructions && <Alert tone="info">{task.offer.instructions}</Alert>}
              </div>
            </Card>

            <Card title="Use these details">
              <div className="space-y-3">
                <CopyField label="First name" value={task.identity.firstName} />
                <CopyField label="Last name" value={task.identity.lastName} />
                <CopyField label="Email" value={task.identity.email} />
                <CopyField label="Phone" value={task.identity.phone} />
                <CopyField label="Address" value={task.identity.address} />
                <CopyField label="City" value={task.identity.city} />
                <CopyField label="State" value={task.identity.state} />
                <CopyField label="Postal code" value={task.identity.postalCode} />
              </div>
            </Card>

            {task.proxy && (
              <Card title="Proxy">
                <div className="space-y-3">
                  <CopyField label="Host" value={task.proxy.host} />
                  <CopyField label="Port" value={String(task.proxy.port)} />
                  <CopyField label="Username" value={task.proxy.username} />
                  {proxyPassword ? (
                    <CopyField label="Password" value={proxyPassword} />
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => revealProxy.mutate()}
                      disabled={revealProxy.isPending}
                    >
                      Show password
                    </Button>
                  )}
                </div>
              </Card>
            )}

            {task.type === 'LEAD' ? (
              <div className="flex gap-2">
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={completeLead.isPending}
                  onClick={() => completeLead.mutate()}
                >
                  {completeLead.isPending ? 'Saving…' : 'Lead completed'}
                </Button>
                <Button variant="secondary" size="lg" onClick={() => abandon.mutate()}>
                  Cancel
                </Button>
              </div>
            ) : (
              <DepositForm
                taskSessionId={task.taskSessionId}
                defaultName={`${task.identity.firstName} ${task.identity.lastName}`}
                defaultEmail={task.identity.email ?? ''}
                onDone={() => {
                  setTask(null);
                  void qc.invalidateQueries({ queryKey: ['eligible-offers'] });
                  void qc.invalidateQueries({ queryKey: ['dashboard'] });
                  router.push('/deposits');
                }}
                onCancel={() => abandon.mutate()}
              />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

function DepositForm({
  taskSessionId,
  defaultName,
  defaultEmail,
  onDone,
  onCancel,
}: {
  taskSessionId: string;
  defaultName: string;
  defaultEmail: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [accountName, setAccountName] = useState(defaultName);
  const [accountEmail, setAccountEmail] = useState(defaultEmail);
  const [accountSecret, setAccountSecret] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Card');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api('/deposits', {
        method: 'POST',
        body: {
          taskSessionId,
          accountName,
          accountEmail,
          accountSecret: accountSecret || undefined,
          amount,
          method,
        },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the deposit.'),
  });

  return (
    <Card title="Record the deposit">
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Account name">
          <input value={accountName} onChange={(e) => setAccountName(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Account email">
          <input
            type="email"
            value={accountEmail}
            onChange={(e) => setAccountEmail(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Account password (optional)">
          <input
            type="text"
            value={accountSecret}
            onChange={(e) => setAccountSecret(e.target.value)}
            placeholder="Stored encrypted"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (USD)">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              className={inputClass}
            />
          </Field>

          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
              <option>Card</option>
              <option>Bank transfer</option>
              <option>E-wallet</option>
              <option>Crypto</option>
              <option>Other</option>
            </select>
          </Field>
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            size="lg"
            className="flex-1"
            disabled={!amount || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? 'Saving…' : 'Deposit completed'}
          </Button>
          <Button variant="secondary" size="lg" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function WorkPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<Spinner />}>
      <WorkScreen />
    </Suspense>
  );
}

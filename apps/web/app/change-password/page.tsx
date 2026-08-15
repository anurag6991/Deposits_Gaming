'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Field, inputClass } from '@/components/ui';

export default function ChangePasswordPage() {
  const { user, logout } = useAuth();
  const router = useRouter();

  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setError(null);
    setSaving(true);

    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      // Changing a password revokes every session, including this one, so the
      // only correct next step is a fresh sign-in.
      await logout();
      router.replace('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">Choose a password</h1>
          <p className="mt-1 text-sm text-slate-500">
            {user?.mustChangePassword
              ? 'Set your own password before continuing.'
              : 'Update your password.'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label="Current password">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="New password">
            <input
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Confirm new password">
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />
          </Field>

          <p className="text-xs text-slate-500">
            At least 12 characters, with an uppercase letter, a lowercase letter and a number.
          </p>

          <Button type="submit" size="lg" className="w-full" disabled={saving}>
            {saving ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      </div>
    </div>
  );
}

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { AuthProvider } from '@/lib/auth';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Counters and timers change constantly, so nothing is cached long.
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: (count, error) => {
              // Never retry an auth or permission failure — it will not fix
              // itself and each retry burns the rate limit.
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return count < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Deposits Gaming',
  description: 'Internal testing management platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Publishers work on phones; do not trap them at one zoom level.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

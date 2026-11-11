import type { Metadata } from 'next';
import { Rubik } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppNav } from '@/components/AppNav';
import { THEME_INIT_SCRIPT } from '@/lib/themeScript';
import './globals.css';

const rubik = Rubik({ subsets: ['latin'], variable: '--font-rubik', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'LeadScout', template: '%s · LeadScout' },
  description: 'Self-hosted job lead generation: live pipeline, ranked leads, applications.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={rubik.variable} suppressHydrationWarning>
      <head>
        {/* Sets <html data-theme> before first paint; see lib/themeScript.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex h-dvh overflow-hidden">
        <AppNav />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}

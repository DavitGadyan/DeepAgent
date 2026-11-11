'use client';
import { History, ListChecks, Radar, Settings2, Workflow } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

const LINKS = [
  { href: '/', label: 'Pipeline', Icon: Workflow },
  { href: '/leads', label: 'Leads', Icon: ListChecks },
  { href: '/runs', label: 'Runs', Icon: History },
  { href: '/setup', label: 'Setup', Icon: Settings2 },
];

const isCurrent = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);

/** Slim left rail: an icon with a small label under it, so the graph keeps the width. */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="flex w-[4.5rem] shrink-0 flex-col gap-1 border-r border-line bg-surface p-1.5"
    >
      <Link
        href="/"
        className="mb-2 grid place-items-center py-2"
        aria-label="LeadScout"
        title="LeadScout"
      >
        <Radar size={22} className="text-accent" aria-hidden="true" />
      </Link>
      {LINKS.map(({ href, label, Icon }) => (
        <Link
          key={href}
          href={href}
          className="nav__link"
          aria-current={isCurrent(pathname, href) ? 'page' : undefined}
        >
          <Icon size={18} aria-hidden="true" />
          {label}
        </Link>
      ))}
      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </nav>
  );
}

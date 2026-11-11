import { FileText } from 'lucide-react';
import { leadFileUrl } from '@/lib/api';

const isPreview = (name: string) => name.toLowerCase().endsWith('.png');

/** Files the applier wrote for this lead; PNG previews are shown inline. */
export function ApplicationFiles({ jobId, files }: { jobId: string; files: string[] }) {
  if (files.length === 0) {
    return <p className="text-[0.8rem] text-muted">The application folder has no files.</p>;
  }
  return (
    <div className="grid gap-3">
      <ul className="grid gap-1">
        {files.map((name) => (
          <li key={name}>
            <a
              href={leadFileUrl(jobId, name)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[0.82rem] text-body underline decoration-line-strong hover:decoration-fg"
            >
              <FileText size={14} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="break-all">{name}</span>
            </a>
          </li>
        ))}
      </ul>
      {files.filter(isPreview).map((name) => (
        <a key={name} href={leadFileUrl(jobId, name)} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by the orchestrator, not a static asset */}
          <img
            src={leadFileUrl(jobId, name)}
            alt={`Preview of ${name}`}
            className="w-full rounded-md border border-line bg-paper"
          />
        </a>
      ))}
    </div>
  );
}

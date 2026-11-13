'use client';
import { api } from '@/lib/api';
import { KIND_LABEL } from '@/lib/pipeline/kinds';
import { pipelineSources } from '@/lib/sources';
import type { Pipeline } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState, Loading } from '@/components/ui/States';
import { ProfileForm } from './ProfileForm';
import { SettingsForm } from './SettingsForm';

/** Read-only: models are configured on the backend, not from this page. */
function AgentList({ pipeline }: { pipeline: Pipeline }) {
  const agents = pipeline.nodes.filter((node) => node.kind !== 'source');
  return (
    <section className="card mm">
      <h2 className="card__title">Agents</h2>
      <table className="tbl">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Kind</th>
            <th>Model</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td className="font-semibold whitespace-nowrap text-fg">{agent.label}</td>
              <td className="whitespace-nowrap" data-kind={agent.kind}>
                <span className="mr-1.5 inline-block size-2 rounded-sm bg-(--mm-c)" />
                {KIND_LABEL[agent.kind]}
              </td>
              <td className="font-mono text-[0.76rem] whitespace-nowrap">{agent.model || '—'}</td>
              <td className="text-soft">{agent.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The Setup page: what the pipeline looks for, how the applier signs in, your profile,
 * and which model each agent runs on. */
export function SetupView() {
  const settings = useApi('settings', api.settings);
  const pipeline = useApi('pipeline', api.pipeline);
  const profile = useApi('profile', api.profile);

  const error = settings.error ?? pipeline.error ?? profile.error;
  if (error && (!settings.data || !pipeline.data || !profile.data)) {
    const retry = () => {
      settings.reload();
      pipeline.reload();
      profile.reload();
    };
    return <ErrorState error={error} onRetry={retry} />;
  }
  if (!settings.data || !pipeline.data || !profile.data) {
    return <Loading label="Loading settings…" />;
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-3 p-4">
      <PageHeader title="Setup" detail="Changes apply to the next run." />
      <SettingsForm
        key={JSON.stringify(settings.data)}
        initial={settings.data}
        sources={pipelineSources(pipeline.data)}
        onSaved={settings.mutate}
      />
      <h2 className="mt-4 text-[1rem] font-semibold text-fg">Your profile</h2>
      <ProfileForm
        key={JSON.stringify(profile.data)}
        initial={profile.data}
        onSaved={profile.mutate}
      />
      <AgentList pipeline={pipeline.data} />
    </div>
  );
}

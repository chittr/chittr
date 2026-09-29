import type { AgentState, MaintenanceState } from './types.js';

export function maintenanceLabel(maintenance: MaintenanceState): string {
  return maintenance.purpose === 'recovery' ? 'Catch-up' : 'Compaction';
}

export function participantStatus(
  agent: Pick<
    AgentState,
    'connection' | 'activity' | 'stopped' | 'detail' | 'error' | 'maintenance'
  > & { active?: unknown },
): { status: string; detail: string } {
  const maintaining = agent.maintenance?.status === 'running';
  if (!agent.stopped && maintaining)
    return {
      status:
        agent.maintenance!.purpose === 'recovery' || agent.connection === 'connecting'
          ? 'Catching up on the chat'
          : 'Compacting context',
      detail: agent.maintenance!.detail ?? 'Preparing the chat context',
    };
  const status = agent.stopped
    ? 'Stopped'
    : agent.connection === 'connecting'
      ? 'Connecting'
      : agent.connection === 'unavailable'
        ? 'Unavailable'
        : agent.activity === 'waiting'
          ? 'Waiting for you'
          : agent.activity === 'available'
            ? 'Available'
            : agent.activity[0]!.toUpperCase() + agent.activity.slice(1);
  return {
    status,
    detail:
      agent.error ??
      agent.detail ??
      (agent.connection === 'connecting'
        ? 'Starting the provider session'
        : agent.active
          ? 'Working on the conversation'
          : 'Ready for your next message'),
  };
}

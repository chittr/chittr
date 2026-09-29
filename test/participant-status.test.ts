import { expect, it } from 'vitest';
import { participantStatus, maintenanceLabel } from '../src/participant-status.js';
import type { AgentState } from '../src/types.js';

it.each(['requested', 'waiting'] as const)(
  'keeps the active tool visible while compaction is %s',
  (status) => {
    const agent = {
      connection: 'ready',
      activity: 'working',
      detail: 'read_file',
      active: { startedAt: '', messageIds: ['m1'] },
      maintenance: {
        purpose: 'compaction',
        status,
        route: 'native',
        detail: 'Waiting for current turn',
      },
    } as AgentState;
    expect(participantStatus(agent)).toEqual({ status: 'Working', detail: 'read_file' });
    agent.maintenance!.status = 'running';
    expect(participantStatus(agent).status).toBe('Compacting context');
  },
);

it('shows the real recovery step instead of an idle or generic connection detail', () => {
  const agent = {
    connection: 'connecting',
    activity: 'available',
    detail: 'Ready for your next message',
    maintenance: {
      purpose: 'recovery',
      status: 'running',
      route: 'replacement',
      detail: 'Summarizing earlier messages (1 of 2)',
    },
  } as AgentState;
  expect(participantStatus(agent)).toEqual({
    status: 'Catching up on the chat',
    detail: 'Summarizing earlier messages (1 of 2)',
  });
  agent.maintenance!.detail = 'Loading the chat context into a fresh session';
  expect(participantStatus(agent).detail).toBe(agent.maintenance!.detail);
  expect(maintenanceLabel(agent.maintenance!)).toBe('Catch-up');
  agent.connection = 'ready';
  agent.maintenance!.status = 'completed';
  expect(participantStatus(agent).status).toBe('Available');
  agent.stopped = true;
  agent.maintenance!.status = 'cancelled';
  agent.error = 'Recovery interrupted';
  expect(participantStatus(agent)).toEqual({ status: 'Stopped', detail: 'Recovery interrupted' });
});

import type { TaskStatus } from '../state/types.js';
import type { TaskAction } from './types.js';

const transitions: Record<string, TaskStatus> = {
  'queued:start': 'in-progress',
  'queued:fail': 'failed',
  'in-progress:complete': 'completed',
  'in-progress:fail': 'failed',
  'in-progress:interrupt': 'interrupted',
  'failed:retry': 'queued',
  'interrupted:start': 'in-progress',
  'interrupted:retry': 'queued',
  'completed:fix-comments': 'queued',
  'failed:fix-comments': 'queued',
};

export function transition(currentStatus: TaskStatus, action: TaskAction): TaskStatus {
  const key = `${currentStatus}:${action}`;
  const next = transitions[key];
  if (!next) {
    throw new Error(`Invalid transition: cannot apply "${action}" to task in "${currentStatus}" status`);
  }
  return next;
}

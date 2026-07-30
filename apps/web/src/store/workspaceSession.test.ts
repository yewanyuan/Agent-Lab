import { describe, expect, it, vi } from 'vitest';
import { readWorkspaceSession } from './workspaceSession';

describe('workspace session', () => {
  it('restores only a valid versioned project pointer and view', () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ version: 1, state: { projectId: 'project-1', activeView: 'evaluations' } })) };
    expect(readWorkspaceSession(storage)).toEqual({ projectId: 'project-1', activeView: 'evaluations' });
  });

  it('rejects corrupt, legacy, local, or unknown-view state', () => {
    expect(readWorkspaceSession({ getItem: () => '{bad' })).toBeNull();
    expect(readWorkspaceSession({ getItem: () => JSON.stringify({ version: 0, state: { projectId: 'p', activeView: 'runs' } }) })).toBeNull();
    expect(readWorkspaceSession({ getItem: () => JSON.stringify({ version: 1, state: { projectId: 'proj-local', activeView: 'design' } }) })).toBeNull();
    expect(readWorkspaceSession({ getItem: () => JSON.stringify({ version: 1, state: { projectId: 'p', activeView: 'other' } }) })).toBeNull();
  });
});

import type { WorkspaceView } from '../types';

const STORAGE_KEY = 'agentlab.workspace.session.v1';
const VERSION = 1;
const views: WorkspaceView[] = ['design', 'runs', 'evaluations', 'versions'];

export interface WorkspaceSession {
  projectId: string;
  activeView: WorkspaceView;
}

export const readWorkspaceSession = (storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): WorkspaceSession | null => {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as { version?: number; state?: Partial<WorkspaceSession> };
    if (value.version !== VERSION || !value.state?.projectId || value.state.projectId === 'proj-local' || !views.includes(value.state.activeView as WorkspaceView)) return null;
    return { projectId: value.state.projectId, activeView: value.state.activeView as WorkspaceView };
  } catch { return null; }
};

export const writeWorkspaceSession = (state: WorkspaceSession) => {
  if (typeof localStorage === 'undefined' || state.projectId === 'proj-local') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, state })); } catch { /* Keep the in-memory workspace when storage is unavailable. */ }
};

export const clearWorkspaceSession = () => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* Ignore unavailable storage. */ }
};

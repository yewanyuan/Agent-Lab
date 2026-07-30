import { create } from 'zustand';

const STORAGE_KEY = 'agentlab.ui.preferences.v1';
const VERSION = 1;
export const FONT_SCALE_MIN = 80;
export const FONT_SCALE_MAX = 140;
export const FONT_SCALE_PRESETS = [90, 100, 110, 120] as const;
const DEFAULT_SCALE = 100;

interface PreferenceEnvelope { version: number; state: { fontScale: number | string }; }
interface PreferencesState { fontScale: number; setFontScale: (fontScale: number) => void; }

// Coerce legacy string scales ('90'..'120') and numeric values to a clamped integer percent.
const clampScale = (value: unknown): number | null => {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric < FONT_SCALE_MIN || numeric > FONT_SCALE_MAX) return null;
  return numeric;
};

export const readPreferences = (storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): number => {
  if (!storage) return DEFAULT_SCALE;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as Partial<PreferenceEnvelope>;
    if (value.version !== VERSION) return DEFAULT_SCALE;
    return clampScale(value.state?.fontScale) ?? DEFAULT_SCALE;
  } catch { return DEFAULT_SCALE; }
};

const writePreferences = (fontScale: number) => {
  if (typeof localStorage === 'undefined') return;
  const value: PreferenceEnvelope = { version: VERSION, state: { fontScale } };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Keep the in-memory preference when storage is unavailable. */ }
};

export const usePreferencesStore = create<PreferencesState>((set) => ({
  fontScale: readPreferences(),
  setFontScale: (fontScale) => { const clamped = clampScale(fontScale); if (clamped === null) return; writePreferences(clamped); set({ fontScale: clamped }); },
}));

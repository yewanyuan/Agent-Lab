import { describe, expect, it, vi } from 'vitest';
import { readPreferences, usePreferencesStore } from './preferences';

describe('device preferences', () => {
  it('accepts the current version and coerces a known scale', () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ version: 1, state: { fontScale: '110' } })) };
    expect(readPreferences(storage)).toBe(110);
  });

  it('accepts a custom numeric scale in range', () => {
    expect(readPreferences({ getItem: () => JSON.stringify({ version: 1, state: { fontScale: 115 } }) })).toBe(115);
  });

  it('falls back for corrupt, old, or out-of-range values', () => {
    expect(readPreferences({ getItem: () => '{bad' })).toBe(100);
    expect(readPreferences({ getItem: () => JSON.stringify({ version: 0, state: { fontScale: '120' } }) })).toBe(100);
    expect(readPreferences({ getItem: () => JSON.stringify({ version: 1, state: { fontScale: 250 } }) })).toBe(100);
  });

  it('keeps the in-memory scale when browser storage rejects writes', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => usePreferencesStore.getState().setFontScale(120)).not.toThrow();
    expect(usePreferencesStore.getState().fontScale).toBe(120);
    write.mockRestore();
  });
});

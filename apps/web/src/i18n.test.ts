import { describe, expect, it } from 'vitest';
import { readLocale } from './i18n';

describe('locale preference', () => {
  it('uses a valid saved locale before browser detection', () => {
    expect(readLocale({ getItem: () => 'en' }, 'zh-CN')).toBe('en');
    expect(readLocale({ getItem: () => 'zh-CN' }, 'en-US')).toBe('zh-CN');
  });

  it('detects Chinese browsers and safely falls back to English', () => {
    expect(readLocale({ getItem: () => 'invalid' }, 'zh-TW')).toBe('zh-CN');
    expect(readLocale({ getItem: () => null }, 'fr-FR')).toBe('en');
  });
});

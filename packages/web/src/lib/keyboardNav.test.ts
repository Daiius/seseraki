import { describe, expect, it } from 'vitest';
import { isNavIgnored, navActionOf } from './keyboardNav';

const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null };

describe('navActionOf（手送りのキー）', () => {
  it('← → Home End を向きに振り分け、ほかは null', () => {
    expect(navActionOf('ArrowLeft')).toBe('back');
    expect(navActionOf('ArrowRight')).toBe('forward');
    expect(navActionOf('Home')).toBe('first');
    expect(navActionOf('End')).toBe('last');
    expect(navActionOf('Escape')).toBeNull();
    expect(navActionOf('a')).toBeNull();
    expect(navActionOf('constructor')).toBeNull();
    expect(navActionOf('toString')).toBeNull();
  });
});

describe('isNavIgnored（ブラウザ既定に譲る）', () => {
  it('修飾キー併用は譲る', () => {
    expect(isNavIgnored(plain)).toBe(false);
    expect(isNavIgnored({ ...plain, ctrlKey: true })).toBe(true);
    expect(isNavIgnored({ ...plain, shiftKey: true })).toBe(true);
  });
});

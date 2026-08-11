import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Template } from './template.ts';
import { saveTemplates, loadTemplates, mergeTemplates } from './template-store.ts';
import { ncc } from './template.ts';

function fakeTemplate(kind: Template['kind'], side: Template['side'], seed = 1): Template {
  const w = 8;
  const h = 9;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = (i * seed) % 256;
  return { kind, side, samples: 3, img: { width: w, height: h, data } };
}

describe('saveTemplates / loadTemplates', () => {
  it('保存して読み込むと画素がそのまま戻る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      const path = join(dir, 'templates.json');
      const original = [fakeTemplate('+P', 'sente', 3), fakeTemplate('+R', 'gote', 7)];
      saveTemplates(original, path);

      const loaded = loadTemplates(path);
      expect(loaded).not.toBeNull();
      expect(loaded).toHaveLength(2);
      for (const [i, t] of loaded!.entries()) {
        expect(t.kind).toBe(original[i].kind);
        expect(t.side).toBe(original[i].side);
        expect(t.samples).toBe(original[i].samples);
        // 画素が変質していないことを相関で確かめる
        expect(ncc(t.img, original[i].img)).toBeCloseTo(1, 10);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('マスの寸法が食い違えば読み込まない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      const path = join(dir, 'templates.json');
      saveTemplates([fakeTemplate('+P', 'sente')], path);
      expect(loadTemplates(path, { width: 8, height: 9 })).not.toBeNull();
      // 解像度やレイアウトが変わった場合。照合できないので使わせない。
      expect(loadTemplates(path, { width: 75, height: 82 })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ファイルが無ければ null', () => {
    expect(loadTemplates('/nonexistent/templates.json')).toBeNull();
  });

  it('寸法が揃っていないテンプレートは保存させない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      const a = fakeTemplate('+P', 'sente');
      const b = fakeTemplate('+R', 'gote');
      b.img = { width: 4, height: 4, data: new Uint8Array(16) };
      expect(() => saveTemplates([a, b], join(dir, 't.json'))).toThrow(/寸法/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeTemplates', () => {
  it('持っていない種類だけ足す', () => {
    const base = [fakeTemplate('P', 'sente'), fakeTemplate('P', 'gote')];
    const extra = [fakeTemplate('P', 'sente', 9), fakeTemplate('+P', 'sente')];
    const merged = mergeTemplates(base, extra);
    expect(merged).toHaveLength(3);
    // 既にある P(sente) は差し替えられていない
    expect(ncc(merged[0].img, base[0].img)).toBeCloseTo(1, 10);
  });
});

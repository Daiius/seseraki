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

  it('マスの寸法が食い違えば引き伸ばして合わせる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      const path = join(dir, 'templates.json');
      saveTemplates([fakeTemplate('+P', 'sente')], path);
      expect(loadTemplates(path, { width: 8, height: 9 })![0].img.width).toBe(8);
      // 解像度やレイアウトが違う相手。捨てずに合わせる（かつては null にしていた）。
      const scaled = loadTemplates(path, { width: 75, height: 82 })!;
      expect(scaled[0].img.width).toBe(75);
      expect(scaled[0].img.height).toBe(82);
      expect(scaled[0].kind).toBe('+P');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('寸法を指定せずに読むと、保存されたままの寸法で返る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      // 保存し直すときに使う経路。引き伸ばした絵を書き戻さないため。
      const path = join(dir, 'templates.json');
      saveTemplates([fakeTemplate('+P', 'sente')], path);
      const raw = loadTemplates(path)!;
      expect(raw[0].img.width).toBe(8);
      expect(raw[0].img.height).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ファイルが無ければ null', () => {
    expect(loadTemplates('/nonexistent/templates.json')).toBeNull();
  });

  it('寸法の違うテンプレートを混ぜて保存できる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    try {
      // 出所が違えば切り出し寸法も違う（動画のマスと、外から受け取った絵）。
      // 揃えるために保存時へ引き伸ばすと補間が積み重なるので、そのまま置く。
      const path = join(dir, 't.json');
      const a = fakeTemplate('+P', 'sente');
      const b = fakeTemplate('+R', 'gote');
      b.img = { width: 4, height: 4, data: new Uint8Array(16).fill(120) };
      saveTemplates([a, b], path);
      const loaded = loadTemplates(path)!;
      expect(loaded[0].img.width).toBe(8);
      expect(loaded[1].img.width).toBe(4);
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

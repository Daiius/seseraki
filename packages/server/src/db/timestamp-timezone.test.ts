// DB の日時が「どの時刻帯の壁時計として書かれ、どう読まれるか」を固定するテスト。
//
// この欠陥（日時が +9h ずれて見える）は **実 DB で走らせるまで見つからなかった**。
// drizzle 側の変換も、MySQL 側のセッション時刻帯も、単体では正しく振る舞うのに、
// **組み合わせたときだけ**壊れるためで、どちらか片方を見ていても気づけない。
// なのでここでは「drizzle の実際の変換関数」と「セッション時刻帯を持つ MySQL の模型」を
// 噛み合わせて、往復で何が起きるかを書き下ろす。
//
// 🔴 変換関数は**スキーマの実物から取る**（`kifus.playedAt`）。drizzle の実装が変わったら
// このテストが落ちる——それが狙い。

import { describe, expect, it } from 'vitest';
import { kifus } from './schema.js';

/** drizzle が JS の値 → DB へ送る壁時計文字列（`toISOString()` ベース） */
const toDriver = (value: Date): string =>
  kifus.playedAt.mapToDriverValue(value) as string;

/** drizzle が DB の壁時計文字列 → JS の Date（`+0000` を足して読む） */
const fromDriver = (value: string): Date =>
  kifus.playedAt.mapFromDriverValue(value) as Date;

/**
 * MySQL の `TIMESTAMP` 列の模型。
 *
 * `TIMESTAMP` は**内部で UTC の instant を保持**し、読み書きのたびに
 * **セッションの `time_zone`** で壁時計へ／から変換する。この 1 点だけを再現する。
 */
class TimestampColumn {
  /** 保持している instant（ms） */
  private stored = 0;

  constructor(private readonly sessionOffsetHours: number) {}

  /** クライアントが送ってきた壁時計文字列を、セッション時刻帯として解釈して格納 */
  write(wallClock: string): void {
    this.stored = Date.parse(`${wallClock.replace(' ', 'T')}Z`) - this.sessionOffsetHours * 3_600_000;
  }

  /** MySQL の `now()`。実時刻をセッション時刻帯の壁時計にして書く＝ instant はそのまま */
  writeNow(now: Date): void {
    this.stored = now.getTime();
  }

  /** クライアントへ返す壁時計文字列（セッション時刻帯） */
  read(): string {
    return new Date(this.stored + this.sessionOffsetHours * 3_600_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
  }

  /** 実際に保持されている instant */
  instant(): Date {
    return new Date(this.stored);
  }
}

const NOW = new Date('2026-09-10T12:34:56.000Z');

describe('セッション時刻帯が JST（＝修正前）', () => {
  const JST = 9;

  it('now() 由来の列は +9h 未来に見える（これが症状）', () => {
    const column = new TimestampColumn(JST);
    column.writeNow(NOW);

    // instant は正しく入っているのに、返る壁時計（JST）を drizzle が UTC と読む
    expect(column.instant().toISOString()).toBe(NOW.toISOString());
    expect(fromDriver(column.read()).toISOString()).toBe('2026-09-10T21:34:56.000Z');
  });

  it('JS が書いた列は往復すると一致するが、保存された instant は 9h 手前', () => {
    const column = new TimestampColumn(JST);
    column.write(toDriver(NOW));

    // 画面上は正しく見える（読み書きの誤解釈が打ち消し合う）
    expect(fromDriver(column.read()).toISOString()).toBe(NOW.toISOString());
    // ⚠ 中身はずれている。ここが「切替と同時に +9h の是正が要る」理由
    expect(column.instant().toISOString()).toBe('2026-09-10T03:34:56.000Z');
  });
});

describe("セッション時刻帯が UTC（＝修正後: SET time_zone = '+00:00'）", () => {
  const UTC = 0;

  it('now() 由来の列が正しく読める（既存行も含めて直る。backfill 不要）', () => {
    const column = new TimestampColumn(UTC);
    column.writeNow(NOW);
    expect(fromDriver(column.read()).toISOString()).toBe(NOW.toISOString());
  });

  it('JS が書いた列は instant まで正しく保存される', () => {
    const column = new TimestampColumn(UTC);
    column.write(toDriver(NOW));
    expect(column.instant().toISOString()).toBe(NOW.toISOString());
    expect(fromDriver(column.read()).toISOString()).toBe(NOW.toISOString());
  });

  it('切替前に JS が書いた既存行は 9h 手前に見える → +9h の是正で戻る', () => {
    // 旧セッション（JST）で書いた行を、そのまま新セッション（UTC）で読む
    const written = new TimestampColumn(9);
    written.write(toDriver(NOW));
    const legacyInstant = written.instant();

    const read = new TimestampColumn(UTC);
    read.writeNow(legacyInstant);
    expect(fromDriver(read.read()).toISOString()).toBe('2026-09-10T03:34:56.000Z');

    // shift-js-timestamps.ts が流す `+ INTERVAL 9 HOUR` に相当
    const shifted = new Date(legacyInstant.getTime() + 9 * 3_600_000);
    expect(shifted.toISOString()).toBe(NOW.toISOString());
  });
});

describe('drizzle の変換そのもの', () => {
  it('DB から返る壁時計を無条件に UTC として読む', () => {
    // `createPool({ timezone })` を足しても効かない理由がこれ。
    // drizzle-orm/mysql2 の session が typeCast で TIMESTAMP を文字列のまま受け取るため、
    // mysql2 の日時変換は通らず、この関数だけが解釈を決める。
    expect(fromDriver('2026-09-10 12:34:56').toISOString()).toBe(
      '2026-09-10T12:34:56.000Z',
    );
  });

  it('JS の Date を UTC の壁時計として送る', () => {
    expect(toDriver(NOW)).toBe('2026-09-10 12:34:56.000');
  });
});

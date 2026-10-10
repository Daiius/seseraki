/**
 * RLS の掛け忘れ・素通りの仕組みを**カタログで**照合する（prd/14 §4「RLS の形」・prd/15 §11）。
 *
 * 振る舞い（未設定なら 0 件・他人の行が見えない・書けない・system ロールは全件）は `roles.db.test.ts`
 * が非 superuser のロールで確かめる。ここは「新しい表を足したのにポリシーを付け忘れた」
 * 「RLS を迂回する関数・ビューを作った」を構造で落とす。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { client } from './db/index.js';

afterAll(async () => {
  await client.end();
});

/** RLS を掛けない表（Better Auth の表。所有者で絞る行ではない）。足すときは理由を書く */
const WITHOUT_RLS: Record<string, string> = {
  users: 'Better Auth の user 表を兼ねる。ログインの経路は自分の行を id で引く',
  session: 'Better Auth',
  account: 'Better Auth',
  verification: 'Better Auth',
};

/** 所有者の列（名前候補だけ `user_id`） */
const OWNER_COLUMN: Record<string, string> = { user_aliases: 'user_id' };

async function publicTables(): Promise<
  { table: string; rls: boolean; force: boolean; columns: string[] }[]
> {
  const { rows } = await client.query<{
    table: string;
    rls: boolean;
    force: boolean;
    columns: string[];
  }>(`
    select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force,
           array_agg(a.attname::text order by a.attnum) as columns
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     group by c.relname, c.relrowsecurity, c.relforcerowsecurity
     order by c.relname`);
  return rows;
}

describe('RLS の掛け忘れ（カタログの照合）', () => {
  it('kifu_id / drill_id を持つ表（kifus 配下）はすべて owner_id も持つ', async () => {
    const missing = (await publicTables())
      .filter((t) => t.columns.includes('kifu_id') || t.columns.includes('drill_id'))
      .filter((t) => !t.columns.includes('owner_id'))
      .map((t) => t.table);
    expect(missing).toEqual([]);
  });

  it('public の表は「RLS あり」か「RLS を掛けない許可リスト」のどちらか（新しい表は必ずどちらかに決める）', async () => {
    const tables = await publicTables();
    const undecided = tables.filter((t) => !t.rls && !(t.table in WITHOUT_RLS)).map((t) => t.table);
    expect(undecided).toEqual([]);
    // 許可リストの表に RLS が付いていたら、それも食い違い（リストを直す）
    expect(tables.filter((t) => t.rls && t.table in WITHOUT_RLS).map((t) => t.table)).toEqual([]);
  });

  it('owner_id を持つ表と名前候補は RLS が有効で、FORCE は付けない', async () => {
    const scoped = (await publicTables()).filter(
      (t) => t.columns.includes('owner_id') || t.table in OWNER_COLUMN,
    );
    expect(scoped.map((t) => t.table).sort()).toEqual(
      [
        'drill_attempts',
        'drills',
        'kifu_analyses',
        'kifu_positions',
        'kifu_tactics',
        'kifus',
        'user_aliases',
        'video_kifu_sources',
      ].sort(),
    );
    for (const t of scoped) {
      // ⚠ FORCE を付けると表の所有者（管理ロール）のマイグレーションの埋め戻しが黙って 0 行になる
      expect({ table: t.table, rls: t.rls, force: t.force }).toEqual({
        table: t.table,
        rls: true,
        force: false,
      });
    }
  });

  it('RLS を掛けた表はすべて、所有者の列を app.user_id と比べるポリシーを USING と WITH CHECK の両方に持つ', async () => {
    const rlsTables = (await publicTables()).filter((t) => t.rls).map((t) => t.table);
    const { rows } = await client.query<{
      table: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename as table, permissive, roles::text[] as roles, cmd, qual, with_check
         from pg_policies where schemaname = 'public' order by tablename, policyname`,
    );
    for (const table of rlsTables) {
      const column = OWNER_COLUMN[table] ?? 'owner_id';
      const policies = rows.filter((r) => r.table === table);
      expect(policies, table).toHaveLength(1);
      const [policy] = policies;
      expect({ table, permissive: policy.permissive, roles: policy.roles, cmd: policy.cmd }).toEqual({
        table,
        permissive: 'PERMISSIVE',
        roles: ['public'],
        cmd: 'ALL',
      });
      // 例: ((owner_id)::text = current_setting('app.user_id'::text, true))
      // 括弧・型の注釈・空白の書き方は Postgres の逆解析に任せ、それらを落として比べる
      const normalize = (expr: string | null) =>
        (expr ?? '').replace(/::text/g, '').replace(/[()\s]/g, '');
      const expected = `${column}=current_setting'app.user_id',true`;
      expect(normalize(policy.qual), `${table} USING`).toBe(expected);
      expect(normalize(policy.with_check), `${table} WITH CHECK`).toBe(expected);
    }
    // 他に RLS の無い表へポリシーを書いても効かない（掛け忘れの兆候）
    expect(rows.filter((r) => !rlsTables.includes(r.table)).map((r) => r.table)).toEqual([]);
  });
});

describe('RLS を素通りする仕組みが無いこと（カタログの照合）', () => {
  /** RLS を掛けた表の名前 */
  async function scopedTables(): Promise<string[]> {
    return (await publicTables()).filter((t) => t.rls).map((t) => t.table);
  }

  it('SECURITY DEFINER の関数が RLS を掛けた表を参照していない', async () => {
    const tables = await scopedTables();
    const { rows } = await client.query<{ name: string; src: string }>(`
      select n.nspname || '.' || p.proname as name, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef
         and n.nspname not in ('pg_catalog', 'information_schema')
         and n.nspname not like 'pg_toast%'`);
    const offenders = rows
      .filter((r) => tables.some((t) => new RegExp(`\\b${t}\\b`).test(r.src)))
      .map((r) => r.name);
    expect(offenders).toEqual([]);
  });

  it('RLS を掛けた表を参照するビューは security_invoker 付きだけ（マテリアライズドビューは無い）', async () => {
    const tables = await scopedTables();
    const { rows } = await client.query<{
      view: string;
      kind: string;
      options: string[] | null;
      ref: string;
    }>(
      `select distinct v.relname as view, v.relkind::text as kind, v.reloptions as options, t.relname as ref
         from pg_class v
         join pg_namespace n on n.oid = v.relnamespace
         join pg_rewrite r on r.ev_class = v.oid
         join pg_depend d on d.objid = r.oid
                         and d.classid = 'pg_rewrite'::regclass
                         and d.refclassid = 'pg_class'::regclass
         join pg_class t on t.oid = d.refobjid
        where v.relkind in ('v', 'm')
          and n.nspname not in ('pg_catalog', 'information_schema')
          and t.oid <> v.oid
          and t.relname = any($1)`,
      [tables],
    );
    const offenders = rows.filter(
      (r) => r.kind === 'm' || !(r.options ?? []).includes('security_invoker=true'),
    );
    expect(offenders).toEqual([]);
  });
});

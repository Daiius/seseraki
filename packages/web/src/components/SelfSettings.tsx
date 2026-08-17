import { useState } from 'react';
import type { InferResponseType } from 'hono/client';
import { client } from '../lib/honoClient';

type Me = InferResponseType<typeof client.api.users.me.$get, 200>;

/**
 * 「自分」の設定（prd/11 §6.3）。表示名と、対局者名と突き合わせる**名前候補**。
 *
 * 🔒 **名前候補を変えると、その場で主体側（`kifus.subjectSide`）が引き直される**
 * （prd/11 §4.2）。手動の再導出に頼ると、変えた直後に画面の数字が古いまま残り、
 * しかも間違っていることが画面から分からない。
 */
export function SelfSettings({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (fn: () => Promise<Response>, ok: (n: number) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error ?? `失敗しました (${res.status})`);
        return;
      }
      const body = (await res.json()) as { rederived?: number };
      setMessage(ok(body.rederived ?? 0));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 mt-6">
      <h3 className="text-lg font-semibold">自分</h3>
      <p className="text-sm text-base-content/70">
        棋譜の対局者名がここに挙げた名前のどれかに一致すれば、その対局は自分のものと判定します
        （勝敗・戦型の自分/相手・局面検索の主体側）。
      </p>

      <label className="flex items-center gap-2 text-sm">
        <span className="whitespace-nowrap">表示名</span>
        <input
          className="input input-sm input-bordered"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-label="表示名"
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || displayName.trim() === me.displayName}
          onClick={() =>
            run(
              () =>
                client.api.users.me.$patch({ json: { displayName: displayName.trim() } }),
              () => '表示名を変えた',
            )
          }
        >
          保存
        </button>
      </label>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">名前候補</h4>
        {/* ⚠ 旧名を消すと、その名前で指した過去の棋譜が「自分の対局」でなくなる（prd/11 §2.2） */}
        <p className="text-xs text-base-content/60">
          名前を変えたときは<strong>足す</strong>。古い名前を消すと、その名前で指した
          過去の棋譜が自分の対局でなくなり、成績から落ちます。
          <br />
          期間は<strong>空のままでよい</strong>。同じ名前を別の人が使い始めるなど、
          <strong>取り違えが起きたときだけ</strong>埋めます。
        </p>
        {me.aliases.length === 0 && (
          <div className="alert alert-warning text-sm">
            名前候補がありません。設定するまで勝敗も戦型の自分/相手も判定できません。
          </div>
        )}
        <ul className="flex flex-col gap-2">
          {me.aliases.map((a) => (
            <AliasRow key={a.id} alias={a} busy={busy} run={run} />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input input-sm input-bordered"
            placeholder="対局者名を足す"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="足す対局者名"
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || newName.trim().length === 0}
            onClick={() =>
              run(
                () =>
                  client.api.users.me.aliases.$post({ json: { name: newName.trim() } }),
                (n) => {
                  setNewName('');
                  return `足した（${n} 局の主体側を引き直した）`;
                },
              )
            }
          >
            追加
          </button>
        </div>
      </div>

      {me.unresolvedSubjects > 0 && (
        <div className="alert alert-warning text-sm">
          主体側が決まらない棋譜が {me.unresolvedSubjects} 件あります。
          両対局者ともここの名前に一致している（同じ名前を別の人が使っている）か、
          自分の対局ではない棋譜です。
        </div>
      )}
      {message && <p className="text-sm">{message}</p>}
    </section>
  );
}

function AliasRow({
  alias,
  busy,
  run,
}: {
  alias: Me['aliases'][number];
  busy: boolean;
  run: (fn: () => Promise<Response>, ok: (n: number) => string) => Promise<void>;
}) {
  const [from, setFrom] = useState(alias.validFrom ?? '');
  const [to, setTo] = useState(alias.validTo ?? '');
  const hasPeriod = alias.validFrom !== null || alias.validTo !== null;
  // ⚠ 期間は既定で隠す。**設定するのは取り違えが起きたときだけ**（prd/11 §5.2）なので、
  // 常に出しておくと「埋めるべき欄」に見える
  const [open, setOpen] = useState(hasPeriod);
  const changed = (alias.validFrom ?? '') !== from || (alias.validTo ?? '') !== to;

  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono min-w-32">{alias.name}</span>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => setOpen(!open)}
        >
          {hasPeriod ? `期間 ${alias.validFrom ?? ''}〜${alias.validTo ?? ''}` : '期間を設定'}
        </button>
        <button
          type="button"
          className="btn btn-xs btn-ghost text-error"
          disabled={busy}
          onClick={() => {
            if (
              !confirm(
                `「${alias.name}」を消すと、この名前で指した過去の棋譜が自分の対局で\nなくなり、成績から落ちます。消しますか？`,
              )
            )
              return;
            void run(
              () =>
                client.api.users.me.aliases[':id'].$delete({
                  param: { id: String(alias.id) },
                }),
              (n) => `消した（${n} 局の主体側を引き直した）`,
            );
          }}
        >
          削除
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-2 pl-4">
          <input
            type="date"
            className="input input-xs input-bordered w-36"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label={`${alias.name} の有効開始日`}
          />
          <span className="opacity-60">〜</span>
          <input
            type="date"
            className="input input-xs input-bordered w-36"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label={`${alias.name} の有効終了日`}
          />
          <button
            type="button"
            className="btn btn-xs"
            disabled={busy || !changed}
            onClick={() =>
              run(
                () =>
                  client.api.users.me.aliases[':id'].$patch({
                    param: { id: String(alias.id) },
                    json: { validFrom: from || null, validTo: to || null },
                  }),
                (n) => `期間を変えた（${n} 局の主体側を引き直した）`,
              )
            }
          >
            保存
          </button>
        </div>
      )}
    </li>
  );
}

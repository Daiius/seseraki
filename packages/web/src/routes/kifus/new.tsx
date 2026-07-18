import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { client } from '../../lib/honoClient';

export const Route = createFileRoute('/kifus/new')({
  component: NewKifuPage,
});

function NewKifuPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [kifText, setKifText] = useState('');
  const [sourceTz, setSourceTz] = useState<'auto' | 'JST' | 'UTC'>('auto');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await client.api.kifus.$post({
        json: { title: title.trim() || undefined, kifText, sourceTz },
      });
      if (!res.ok) throw new Error('Failed to create kifu');
      const { id } = await res.json();
      navigate({ to: '/kifus/$id', params: { id: String(id) } });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">棋譜を登録</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-2xl">
        <label className="form-control w-full">
          <div className="label">
            <span className="label-text">タイトル</span>
            <span className="label-text-alt whitespace-normal text-right opacity-60">
              任意・空なら「先手 vs 後手」を自動生成
            </span>
          </div>
          <input
            type="text"
            className="input input-bordered w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 第82期名人戦 第1局"
          />
        </label>
        <label className="form-control w-full">
          <div className="label">
            <span className="label-text">KIF テキスト</span>
          </div>
          <textarea
            className="textarea textarea-bordered w-full h-64 font-mono"
            value={kifText}
            onChange={(e) => setKifText(e.target.value)}
            placeholder="KIF形式の棋譜をここに貼り付け..."
            required
          />
        </label>
        <label className="form-control w-full max-w-xs">
          <div className="label">
            <span className="label-text">開始日時のタイムゾーン</span>
          </div>
          <select
            className="select select-bordered"
            value={sourceTz}
            onChange={(e) =>
              setSourceTz(e.target.value as 'auto' | 'JST' | 'UTC')
            }
          >
            <option value="auto">自動（KIF 署名から判定・不明なら JST）</option>
            <option value="JST">JST（日本時間）</option>
            <option value="UTC">UTC（開始日時が UTC のアプリ）</option>
          </select>
          <div className="label whitespace-normal">
            <span className="label-text-alt opacity-60">
              アプリによって開始日時が UTC のことがある。並び順がずれる場合は明示指定する
            </span>
          </div>
        </label>
        <button
          type="submit"
          className="btn btn-primary w-fit"
          disabled={submitting}
        >
          {submitting ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            '登録'
          )}
        </button>
      </form>
    </div>
  );
}

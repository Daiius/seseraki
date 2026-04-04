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
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await client.kifus.$post({ json: { title, kifText } });
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
          </div>
          <input
            type="text"
            className="input input-bordered w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 第82期名人戦 第1局"
            required
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

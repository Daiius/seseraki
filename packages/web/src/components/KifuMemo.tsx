import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { client } from '../lib/honoClient';

export function KifuMemo({
  kifuId,
  memo,
}: {
  kifuId: number;
  memo: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await client.kifus[':id'].$patch({
        param: { id: String(kifuId) },
        json: { memo: draft },
      });
      if (!res.ok) {
        setError(`保存失敗 (${res.status})`);
        return;
      }
      setDraft('');
      router.invalidate();
    } catch {
      setError('サーバーに接続できません');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {memo && (
        <div>
          <h4 className="text-sm font-semibold mb-1">現在のメモ</h4>
          <pre className="whitespace-pre-wrap font-mono text-xs bg-base-100 p-2 rounded">
            {memo}
          </pre>
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold mb-1">
          {memo ? '上書き更新' : '貼り付け'}
        </h4>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Markdown を貼り付けてください（保存すると上書きされます）"
          className="textarea textarea-bordered font-mono text-xs h-48 w-full"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || draft.length === 0}
        >
          {saving ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            '保存'
          )}
        </button>
        {error && <span className="text-error text-sm">{error}</span>}
      </div>
    </div>
  );
}

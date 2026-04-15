import { useState } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { checkSession, login } from '../lib/auth';

type LoginSearch = { redirect?: string };

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search }) => {
    if (await checkSession()) {
      throw redirect({ to: search.redirect ?? '/' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect: redirectTo } = Route.useSearch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const ok = await login(username, password);
      if (!ok) {
        setError('ユーザー名またはパスワードが違います');
        return;
      }
      if ('credentials' in navigator && 'PasswordCredential' in window) {
        try {
          const CredCtor = (
            window as unknown as {
              PasswordCredential: new (init: {
                id: string;
                password: string;
              }) => Credential;
            }
          ).PasswordCredential;
          await navigator.credentials.store(
            new CredCtor({ id: username, password }),
          );
        } catch {
          // ignore: Safari など未対応ブラウザ
        }
      }
      await navigate({ to: redirectTo ?? '/' });
    } catch {
      setError('サーバーに接続できません');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="card bg-base-200 w-full max-w-sm shadow"
      >
        <div className="card-body">
          <h1 className="card-title font-logo text-3xl justify-center mb-2">
            細流棋
          </h1>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">ユーザー名</span>
            </div>
            <input
              type="text"
              name="username"
              autoComplete="username"
              className="input input-bordered w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">パスワード</span>
            </div>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              className="input input-bordered w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <div className="alert alert-error mt-2">{error}</div>}
          <button
            type="submit"
            className="btn btn-primary mt-4"
            disabled={submitting}
          >
            {submitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              'ログイン'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

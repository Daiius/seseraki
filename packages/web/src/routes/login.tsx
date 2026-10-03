import { useState } from 'react';
import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import {
  devLogin,
  fetchMe,
  loginErrorMessage,
  logout,
  signInWithGoogle,
  type MeStatus,
} from '../lib/auth';
import { Logo } from '../components/Logo';

type LoginSearch = { redirect?: string; error?: string };

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    // Google ログインが失敗すると Better Auth が `?error=<code>` を付けて戻す
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  beforeLoad: async ({ search }) => {
    // サーバーに届かないときは null（画面で知らせる）
    const me: MeStatus | null = await fetchMe().catch(() => null);
    if (me?.kind === 'owner') {
      throw redirect({ to: search.redirect ?? '/' });
    }
    return { me };
  },
  component: LoginPage,
});

/** `?as=` に渡せる名前（server の検査と同じ形） */
const DEV_AS_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * dev ログインを出すか。server は手元のオリジン（http の localhost）でしか開かないので（prd/07 §6.1）、
 * remote dev（公開オリジン）では押しても 404 になるボタンを出さない
 */
const SHOW_DEV_LOGIN =
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect: redirectTo, error: errorCode } = Route.useSearch();
  const { me } = Route.useRouteContext();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devAs, setDevAs] = useState('alice');

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = () =>
    run(async () => {
      // 戻り先は同一オリジンの相対パス（server の trustedOrigins で検査される）
      await signInWithGoogle(redirectTo ?? '/');
    });

  const handleDevLogin = (as?: string) =>
    run(async () => {
      await devLogin(as);
      await navigate({ to: redirectTo ?? '/' });
    });

  const handleLogout = () =>
    run(async () => {
      await logout();
      // 同じ画面のまま beforeLoad をやり直し、ログイン前の表示に戻す
      await router.invalidate();
    });

  const shownError = error ?? loginErrorMessage(errorCode);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card bg-base-200 w-full max-w-sm shadow">
        <div className="card-body">
          <h1 className="card-title text-3xl justify-center mb-2">
            <Logo />
          </h1>

          {me?.kind === 'forbidden' ? (
            // 所有者以外のアカウント（所有者ゲート。prd/07 §5.1）。別のアカウントで入り直せるようにする
            <>
              <div role="alert" className="alert alert-warning">
                このアカウントでは利用できません
              </div>
              <button
                type="button"
                className="btn btn-primary mt-4"
                onClick={() => void handleLogout()}
                disabled={busy}
              >
                ログアウト
              </button>
            </>
          ) : (
            <>
              {me === null && (
                <div role="alert" className="alert alert-error">
                  サーバーに接続できません
                </div>
              )}
              {shownError && (
                <div role="alert" className="alert alert-error">
                  {shownError}
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary mt-4"
                onClick={() => void handleGoogle()}
                disabled={busy}
              >
                {busy ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  'Google でログイン'
                )}
              </button>
            </>
          )}

          {/* 手元の dev のときだけ（prd/07 §6.1）。本番のビルドでは import.meta.env.DEV が false になり丸ごと消える */}
          {SHOW_DEV_LOGIN && (
            <div className="mt-6 border-t border-base-300 pt-4 space-y-2">
              <p className="text-sm text-base-content/70">開発用</p>
              <button
                type="button"
                className="btn btn-outline btn-sm w-full"
                onClick={() => void handleDevLogin()}
                disabled={busy}
              >
                dev ログイン（所有者）
              </button>
              <div className="join w-full">
                <input
                  type="text"
                  className="input input-bordered input-sm join-item flex-1"
                  aria-label="dev ユーザー名"
                  value={devAs}
                  onChange={(e) => setDevAs(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-outline btn-sm join-item"
                  onClick={() => void handleDevLogin(devAs)}
                  disabled={busy || !DEV_AS_PATTERN.test(devAs)}
                >
                  別ユーザーで
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import {
  createRootRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { checkSession, logout } from '../lib/auth';
import { Logo } from '../components/Logo';

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/login') return;
    const authed = await checkSession();
    if (!authed) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: RootComponent,
});

function RootComponent() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isLogin = pathname === '/login';

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login', search: { redirect: undefined } });
  };

  return (
    <div className="min-h-screen">
      {!isLogin && (
        <nav className="navbar bg-base-200">
          <div className="flex-1">
            <Link to="/" className="btn btn-ghost text-2xl" aria-label="細流棋">
              <Logo />
            </Link>
          </div>
          <div className="flex-none gap-2">
            <Link to="/kifus/new" className="btn btn-primary btn-sm">
              棋譜を登録
            </Link>
            {/* モバイル幅でも「棋譜を登録」を潰さないよう、設定は文言ではなく歯車アイコンで置く */}
            <Link
              to="/settings"
              className="btn btn-ghost btn-sm btn-square"
              aria-label="設定"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="size-5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.379.137.75.43.992l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.379-.138-.75-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </Link>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleLogout}
            >
              ログアウト
            </button>
          </div>
        </nav>
      )}
      <main className="max-w-3xl mx-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}

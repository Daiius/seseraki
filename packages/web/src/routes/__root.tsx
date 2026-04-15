import {
  createRootRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { checkSession, logout } from '../lib/auth';

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

  if (isLogin) {
    return (
      <div className="min-h-screen">
        <Outlet />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <nav className="navbar bg-base-200">
        <div className="flex-1">
          <Link to="/" className="btn btn-ghost text-2xl font-logo">
            細流棋
          </Link>
        </div>
        <div className="flex-none gap-2">
          <Link to="/kifus/new" className="btn btn-primary btn-sm">
            棋譜を登録
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            ログアウト
          </button>
        </div>
      </nav>
      <main className="container mx-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}

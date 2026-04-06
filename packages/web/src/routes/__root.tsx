import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <nav className="navbar bg-base-200">
        <div className="flex-1">
          <Link to="/" className="btn btn-ghost text-xl">
            細流棋
          </Link>
        </div>
        <div className="flex-none">
          <Link to="/kifus/new" className="btn btn-primary btn-sm">
            棋譜を登録
          </Link>
        </div>
      </nav>
      <main className="container mx-auto p-4">
        <Outlet />
      </main>
    </div>
  ),
});

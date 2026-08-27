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
import {
  Bars3Icon,
  ChartBarIcon,
  CogIcon,
  ListBulletIcon,
  LogoutIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  VideoCameraIcon,
} from '../components/icons';

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/login') return;
    // DEV 専用の UI ギャラリーは認証を通さず開けるようにする（props で状態を固定して
    // スクショ確認するための置き場。本番ではルート自体が中身を出さない）
    if (import.meta.env.DEV && location.pathname === '/dev-gallery') return;
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

  /**
   * ヘッダーのメニューを閉じる。
   *
   * daisyUI の dropdown は JS を持たず `:focus-within` で開閉するため、中の項目を押しても
   * フォーカスが内側に残って開きっぱなしになる。押した要素のフォーカスを明示的に外す。
   */
  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

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
          {/* 常用する導線だけを表に出す。使用頻度の低いものは末尾のメニューへ畳む。
              表の項目はモバイル幅ではアイコンだけにして横並びが潰れないようにする */}
          <div className="flex-none gap-1 sm:gap-2">
            <Link
              to="/"
              className="btn btn-ghost btn-sm max-sm:btn-square"
              aria-label="棋譜一覧"
            >
              <ListBulletIcon className="sm:hidden" />
              <span className="max-sm:hidden">棋譜一覧</span>
            </Link>
            <Link
              to="/kifus/new"
              className="btn btn-primary btn-sm max-sm:btn-square"
              aria-label="棋譜を登録"
            >
              <PlusIcon className="sm:hidden" />
              <span className="max-sm:hidden">棋譜を登録</span>
            </Link>
            <Link
              to="/stats"
              className="btn btn-ghost btn-sm btn-square"
              aria-label="戦型別成績"
            >
              <ChartBarIcon />
            </Link>
            <Link
              to="/positions"
              search={{ pos: undefined }}
              className="btn btn-ghost btn-sm btn-square"
              aria-label="局面検索"
            >
              <MagnifyingGlassIcon />
            </Link>
            {/* 動画解析・設定・ログアウトはたまにしか使わないのでメニューへ。
                幅では出し分けない（デスクトップでも同じ場所にある方が探しやすい） */}
            <div className="dropdown dropdown-end">
              <button
                type="button"
                tabIndex={0}
                className="btn btn-ghost btn-sm btn-square"
                aria-label="メニュー"
              >
                <Bars3Icon />
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu menu-sm bg-base-100 rounded-box z-20 mt-1 w-44 p-1 shadow"
              >
                {/* 項目を押しても dropdown は閉じないので、遷移・実行の前に明示的に閉じる */}
                <li>
                  <Link to="/video-analysis" onClick={closeMenu}>
                    <VideoCameraIcon className="size-4" />
                    動画解析
                  </Link>
                </li>
                <li>
                  <Link to="/settings" onClick={closeMenu}>
                    <CogIcon className="size-4" />
                    設定
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeMenu();
                      void handleLogout();
                    }}
                  >
                    <LogoutIcon className="size-4" />
                    ログアウト
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </nav>
      )}
      <main className="max-w-3xl mx-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}

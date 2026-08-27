import { useEffect, useRef } from 'react';
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
  ChevronDownIcon,
  CogIcon,
  ListBulletIcon,
  LogoutIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  VideoCameraIcon,
} from '../components/icons';

/*
 * ヘッダーのタッチターゲット寸法。
 *
 * モバイルの誤タップ対策として Apple HIG 44pt / WCAG 2.2 SC 2.5.5(AAA) の 44px を狙い、
 * ターゲット間は Material の 8dp 以上を取る。ただし 44px×5 + 8px×4 = 252px は、
 * navbar の padding とロゴを足すと 320px 幅（iPhone SE 等の下限）に収まらない。
 * そこで 375px 未満だけ「40px ターゲット / 間隔 4px / ロゴ縮小」へ落とす
 * （40px は WCAG 2.2 SC 2.5.8(AA) の下限 24px は十分上回る。溢れて押せなくなるより良い）。
 * デスクトップ幅（sm 以上）はポインタ操作なので btn-sm（32px）のまま。
 */
const ICON_BTN = 'btn btn-ghost btn-sm btn-square max-sm:size-11 max-[374px]:size-10';

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

  // メニューは `<details>` 版の dropdown。`:focus-within` 版と違って開閉が DOM の状態
  // （open 属性）に出るので、開いている見た目（トリガーの押下表示・chevron の回転）を
  // CSS だけで作れる
  const menuRef = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => {
    menuRef.current?.removeAttribute('open');
  };

  // `<details>` は素では外側クリックでも Esc でも閉じない。メニューとして振る舞わせる分だけ補う
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (!el?.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) el.removeAttribute('open');
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const el = menuRef.current;
      if (e.key !== 'Escape' || !el?.open) return;
      el.removeAttribute('open');
      // 閉じたあとフォーカスがどこにも無くならないようトリガーへ戻す
      el.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login', search: { redirect: undefined } });
  };

  return (
    <div className="min-h-screen">
      {!isLogin && (
        // ヘッダーのメニューはページ側のメニュー（kifus/$id のケバブ・z-20）より必ず上に出す。
        // nav 自身に z-index を与えて stacking context を作り、中身をまとめて持ち上げる
        <nav className="navbar bg-base-200 relative z-30">
          <div className="flex-1">
            {/* ロゴは極小幅でだけ縮める（44px ターゲットを優先して幅を譲る） */}
            <Link
              to="/"
              className="btn btn-ghost text-2xl max-sm:px-2 max-[374px]:px-1 max-[374px]:text-xl"
              aria-label="細流棋"
            >
              <Logo />
            </Link>
          </div>
          {/* 常用する導線だけを表に出す。使用頻度の低いものは末尾のメニューへ畳む。
              表の項目はモバイル幅ではアイコンだけにして横並びが潰れないようにする。
              「棋譜を登録」は最も頻繁に押す書き込み操作なので先頭に置く */}
          <div className="flex flex-none items-center gap-2 pe-2 max-[374px]:gap-1">
            <Link
              to="/kifus/new"
              className="btn btn-primary btn-sm max-sm:btn-square max-sm:size-11 max-[374px]:size-10"
              aria-label="棋譜を登録"
            >
              <PlusIcon className="sm:hidden" />
              <span className="max-sm:hidden">棋譜を登録</span>
            </Link>
            <Link to="/" className={ICON_BTN} aria-label="棋譜一覧">
              <ListBulletIcon />
            </Link>
            <Link to="/stats" className={ICON_BTN} aria-label="戦型別成績">
              <ChartBarIcon />
            </Link>
            <Link
              to="/positions"
              search={{ pos: undefined }}
              className={ICON_BTN}
              aria-label="局面検索"
            >
              <MagnifyingGlassIcon />
            </Link>
            {/*
              動画解析・設定・ログアウトはたまにしか使わないのでメニューへ。幅では出し分けない
              （デスクトップでも同じ場所にある方が探しやすい）。

              「押すと開く」ことを伝えるために 3 つ重ねている:
              (1) 左に余白を足して他のボタンから離す（gap 8px に対し ms-3 で計 20px）。
                  右も navbar の padding に pe-2 を足して 16px 空け、左右に独立して見せる。
                  余白で種類の違いは十分伝わるので、縦罫は入れない（余白と罫の二重は過剰）
              (2) chevron-down を添える——「この先に何かある」ことを示す一般的な記号
              (3) 開いている間はトリガーを押下状態にし、chevron を 180° 回す

              記号は ☰ のままにした。この中身はページ固有の操作ではなくヘッダーの行き先
              （動画解析・設定・ログアウト）なので ☰ の方が意味に合い、︙ は kifus/$id の
              ページ内操作メニューで既に使っているため、同じ記号を別の階層に当てたくない
            */}
            <details ref={menuRef} className="dropdown dropdown-end group ms-3">
              <summary
                className="btn btn-ghost btn-sm gap-1 px-2 list-none max-sm:h-11 max-[374px]:h-10 max-[374px]:px-1 group-open:btn-active [&::-webkit-details-marker]:hidden"
                aria-haspopup="menu"
                aria-label="メニュー"
              >
                <Bars3Icon />
                <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
              </summary>
              <ul
                role="menu"
                className="dropdown-content menu menu-sm bg-base-100 rounded-box z-20 mt-1 w-44 p-1 shadow"
              >
                {/* 項目を押しても dropdown は閉じないので、遷移・実行の前に明示的に閉じる */}
                <li role="none">
                  <Link role="menuitem" to="/video-analysis" onClick={closeMenu}>
                    <VideoCameraIcon className="size-4" />
                    動画解析
                  </Link>
                </li>
                <li role="none">
                  <Link role="menuitem" to="/settings" onClick={closeMenu}>
                    <CogIcon className="size-4" />
                    設定
                  </Link>
                </li>
                <li role="none">
                  <button
                    role="menuitem"
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
            </details>
          </div>
        </nav>
      )}
      <main className="max-w-3xl mx-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}

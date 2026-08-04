// 将棋ドメインの純ロジック（prd/02-architecture.md §3.2）。
// web / server / worker のどこからでも使えるよう、環境依存を持ち込まない。
export * from './board';
export * from './tactics';

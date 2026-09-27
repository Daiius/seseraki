// 静的配信のデプロイで「何をするか」を決める純粋な関数（prd/02-architecture.md §5）。
//
// assets/ には「今回」と「1 つ前」のデプロイのファイルだけを残す。全部消すと、デプロイ前から
// 開いていたタブが旧チャンクを取りに来て 404 になり、上書きだけだと古いファイルが溜まるため。
// ここには副作用を置かない（接続・転送は runner に注入する。deploy.ts）。

/** 接続先と、使う ssh の多重化ソケット。 */
export type DeployConfig = {
  /** ssh の宛先（`~/.ssh/config` の Host 名など）。 */
  host: string;
  /** 配信ディレクトリ（リモートの絶対パス）。`assets/` はこの直下。 */
  root: string;
  /** 世代の一覧（current.txt / prev.txt）を置く配信外のディレクトリ（リモートの絶対パス）。 */
  state: string;
  /** ローカルのビルド成果物（`index.html` と `assets/` を含むディレクトリ）。 */
  distDir: string;
  /** ssh の ControlPath（ControlMaster のソケット）。 */
  controlPath: string;
};

/** ControlMaster を切るまでの猶予（秒）。最後の接続が閉じてから数えるので、手順の間隔より長ければよい。 */
export const CONTROL_PERSIST_SECONDS = 120;

// ---------------------------------------------------------------------------
// 検証とクォート
// ---------------------------------------------------------------------------

/**
 * `assets/` 直下のファイル名として受け付けるか。削除の対象になりうるので厳しめに見る。
 * `/`・`..`・空文字・先頭の `-`（コマンドのオプションに化ける）・制御文字（一覧の行区切りを壊す）を拒否する。
 */
export function isValidAssetName(name: string): boolean {
  if (name === '' || name === '.') return false;
  if (name.includes('/') || name.includes('..')) return false;
  if (name.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

/**
 * リモートの絶対パスとして受け付けるか。`/` そのもの・相対パス・`..` の成分・
 * 空白やシェルのメタ文字を含むものは拒否する（rsync の `host:path` にもそのまま載せるため）。
 */
export function isValidRemoteDir(path: string): boolean {
  if (!/^\/[A-Za-z0-9._@+\-/]*$/.test(path)) return false;
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return false;
  return segments.every((s) => s !== '.' && s !== '..');
}

/** ssh の宛先として受け付けるか。オプションに化ける先頭 `-` と空白を拒否する。 */
export function isValidHost(host: string): boolean {
  return /^[A-Za-z0-9._@:\[\]%-]+$/.test(host) && !host.startsWith('-');
}

/** POSIX シェルの単一引用符でクォートする。中の `'` は `'\''` で閉じて開き直す。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 末尾の `/` を落とす（`/srv/www/` と `/srv/www` を同じに扱う）。 */
export function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** 設定を検証して正規化する。不正なら理由を並べて投げる。 */
export function normalizeConfig(cfg: DeployConfig): DeployConfig {
  const errors: string[] = [];
  if (!isValidHost(cfg.host))
    errors.push(`host が不正: ${JSON.stringify(cfg.host)}`);
  const root = trimTrailingSlash(cfg.root);
  const state = trimTrailingSlash(cfg.state);
  if (!isValidRemoteDir(root))
    errors.push(
      `root が不正（絶対パス・/ 以外・..なし）: ${JSON.stringify(cfg.root)}`,
    );
  if (!isValidRemoteDir(state))
    errors.push(
      `state が不正（絶対パス・/ 以外・..なし）: ${JSON.stringify(cfg.state)}`,
    );
  if (isValidRemoteDir(root) && isValidRemoteDir(state)) {
    // 一覧を配信ディレクトリの中に置くと、一覧自体が公開される。
    if (state === root || state.startsWith(`${root}/`)) {
      errors.push('state は配信ディレクトリ（root）の外に置くこと');
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { ...cfg, root, state, distDir: trimTrailingSlash(cfg.distDir) };
}

// ---------------------------------------------------------------------------
// リモートの出力の解釈
// ---------------------------------------------------------------------------

/** 改行区切りの一覧を読む。空行は捨てる。 */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '');
}

/** 世代の一覧。無ければ `null`（初回・または 1 つ前が無い）。 */
export type StateLists = { current: string[] | null; prev: string[] | null };

// ファイル名に `/` は入りえないので、区切りの行として曖昧にならない。
const CURRENT_MARKER = '/current';
const PREV_MARKER = '/prev';

/**
 * `readStateStep` の出力を読む。一覧に不正な名前があれば投げる
 * （一覧が壊れているときに、それを根拠に削除を決めない）。
 */
export function parseStateOutput(stdout: string): StateLists {
  const result: StateLists = { current: null, prev: null };
  let section: 'current' | 'prev' | null = null;
  for (const line of parseLines(stdout)) {
    if (line === CURRENT_MARKER || line === PREV_MARKER) {
      section = line === CURRENT_MARKER ? 'current' : 'prev';
      result[section] = [];
      continue;
    }
    if (section === null)
      throw new Error(`世代の一覧の出力を読めない: ${JSON.stringify(line)}`);
    if (!isValidAssetName(line)) {
      throw new Error(
        `${section}.txt に不正なファイル名がある: ${JSON.stringify(line)}`,
      );
    }
    result[section]!.push(line);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 計画
// ---------------------------------------------------------------------------

export type PlanInput = {
  /** 今回送る `assets/` のファイル名。 */
  local: string[];
  /** リモートの世代の一覧。 */
  state: StateLists;
  /** リモートの `assets/` にいま在るファイル名。 */
  remote: string[];
};

export type Plan = {
  /** 今回の一覧（整列・重複なし）。current.txt に書く。 */
  current: string[];
  /** デプロイ後に「1 つ前」として残る一覧。無ければ `null`（削除しない）。 */
  previous: string[] | null;
  /** current.txt を prev.txt にずらすか。 */
  rotate: boolean;
  /** 消す `assets/` のファイル名（整列済み）。 */
  toDelete: string[];
  /** リモートにあるが名前が不正なので触らないもの。 */
  ignoredRemote: string[];
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/**
 * 残すもの・消すものを決める。
 *
 * - 初回（current.txt が無い）は何も消さない。前からあったファイルが何者か分からないため。
 * - 2 回目以降は current.txt を prev.txt にずらし、「今回 ∪ 1 つ前」に無いものを消す。
 * - 今回が current.txt と同じ（同じビルドの再デプロイ）なら世代を進めない。進めると
 *   1 つ前が今回と同じになり、本当の 1 つ前を開いているタブの旧チャンクを消してしまう。
 */
export function computePlan(input: PlanInput): Plan {
  if (input.local.length === 0) {
    throw new Error('今回の assets/ が空。ビルドの取り違えを疑って中止する');
  }
  const invalidLocal = input.local.filter((n) => !isValidAssetName(n));
  if (invalidLocal.length > 0) {
    throw new Error(
      `今回の assets/ に不正なファイル名がある: ${invalidLocal.map((n) => JSON.stringify(n)).join(', ')}`,
    );
  }
  const current = [...new Set(input.local)].sort();
  const old = input.state.current;

  let previous: string[] | null;
  let rotate: boolean;
  if (old === null) {
    previous = null;
    rotate = false;
  } else if (sameSet(old, current)) {
    previous = input.state.prev;
    rotate = false;
  } else {
    previous = old;
    rotate = true;
  }

  const ignoredRemote = input.remote.filter((n) => !isValidAssetName(n)).sort();
  let toDelete: string[] = [];
  if (previous !== null) {
    const keep = new Set([...current, ...previous]);
    toDelete = [...new Set(input.remote)]
      .filter((n) => isValidAssetName(n) && !keep.has(n))
      .sort();
  }
  return { current, previous, rotate, toDelete, ignoredRemote };
}

/** current.txt に書く内容。 */
export function formatList(names: readonly string[]): string {
  return names.map((n) => `${n}\n`).join('');
}

/** 計画を人が読む形にする。 */
export function describePlan(plan: Plan, cfg: DeployConfig): string {
  const lines = [
    `転送: assets/ ${plan.current.length} ファイル → ${cfg.host}:${cfg.root}/assets/（削除なしで上書き）`,
    `転送: トップレベル（index.html など）を最後に → ${cfg.host}:${cfg.root}/`,
    `1 つ前の一覧: ${plan.previous === null ? 'なし（初回扱い・何も消さない）' : `あり（${plan.previous.length} ファイル）`}`,
    `世代: ${plan.rotate ? 'current.txt → prev.txt にずらして今回を current.txt へ' : '世代は進めない（current.txt を今回で書く）'}`,
    `削除: ${plan.toDelete.length} ファイル`,
    ...plan.toDelete.map((n) => `  - assets/${n}`),
  ];
  if (plan.ignoredRemote.length > 0) {
    lines.push(`名前が不正なので触らない: ${plan.ignoredRemote.length} 件`);
    lines.push(...plan.ignoredRemote.map((n) => `  ? ${JSON.stringify(n)}`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// コマンドの組み立て
// ---------------------------------------------------------------------------

/** 1 つの手順。`kind: 'write'` はリモートを書き換えるもの（dry-run では呼ばない）。 */
export type Step = {
  label: string;
  kind: 'read' | 'write';
  argv: string[];
  stdin?: string;
};

/** ssh の多重化オプション（ssh と rsync -e で共通）。 */
export function sshOptions(cfg: DeployConfig): string[] {
  return [
    '-o',
    `ControlPath=${cfg.controlPath}`,
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
}

/** リモートでシェルコマンドを 1 本実行する argv。ssh は残りの引数をリモートのシェルに渡す。 */
export function sshArgv(cfg: DeployConfig, remoteCommand: string): string[] {
  return ['ssh', ...sshOptions(cfg), cfg.host, remoteCommand];
}

/** rsync の `-e` に渡す文字列（rsync は空白で割り、引用符を解釈する）。 */
export function rsyncRsh(cfg: DeployConfig): string {
  return ['ssh', ...sshOptions(cfg)]
    .map((a) =>
      a.startsWith('ControlPath=')
        ? `ControlPath=${shellQuote(a.slice('ControlPath='.length))}`
        : a,
    )
    .join(' ');
}

export function readStateStep(cfg: DeployConfig): Step {
  const cur = shellQuote(`${cfg.state}/current.txt`);
  const prev = shellQuote(`${cfg.state}/prev.txt`);
  // cat の後の echo は、末尾に改行の無いファイルでも次の区切りと繋がらないようにするため。
  const cmd =
    `{ if [ -f ${cur} ]; then echo ${CURRENT_MARKER} && cat -- ${cur} && echo; fi; } && ` +
    `{ if [ -f ${prev} ]; then echo ${PREV_MARKER} && cat -- ${prev} && echo; fi; }`;
  return { label: 'read-state', kind: 'read', argv: sshArgv(cfg, cmd) };
}

export function listAssetsStep(cfg: DeployConfig): Step {
  const dir = shellQuote(`${cfg.root}/assets`);
  // POSIX の範囲で「直下の通常ファイル（シンボリックリンクを除く）」を 1 行 1 つ出す。
  const cmd =
    `if [ -d ${dir} ]; then cd -- ${dir} && ` +
    `for f in * .[!.]* ..?*; do if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\n' "$f"; fi; done; fi`;
  return { label: 'list-assets', kind: 'read', argv: sshArgv(cfg, cmd) };
}

export function uploadAssetsStep(cfg: DeployConfig): Step {
  return {
    label: 'upload-assets',
    kind: 'write',
    argv: [
      'rsync',
      '-rt',
      '-e',
      rsyncRsh(cfg),
      `${cfg.distDir}/assets/`,
      `${cfg.host}:${cfg.root}/assets/`,
    ],
  };
}

/**
 * index.html などトップレベルを送る。assets/ より後に呼ぶ（新しい index.html が未着のチャンクを指さないように）。
 * 名前にハッシュが付かないので `--checksum` で中身を比べる。サイズと更新時刻の比較だけだと、
 * ハッシュの長さが同じ index.html を同じ秒に書いたとき送り漏らす（テストで実際に踏んだ）。
 */
export function uploadTopLevelStep(cfg: DeployConfig): Step {
  return {
    label: 'upload-top-level',
    kind: 'write',
    argv: [
      'rsync',
      '-rt',
      '--checksum',
      '--exclude=/assets/',
      '-e',
      rsyncRsh(cfg),
      `${cfg.distDir}/`,
      `${cfg.host}:${cfg.root}/`,
    ],
  };
}

export function writeStateStep(cfg: DeployConfig, plan: Plan): Step {
  const dir = shellQuote(cfg.state);
  const cur = shellQuote(`${cfg.state}/current.txt`);
  const tmp = shellQuote(`${cfg.state}/current.txt.tmp`);
  const prev = shellQuote(`${cfg.state}/prev.txt`);
  const parts = [`mkdir -p -- ${dir}`, `cat > ${tmp}`];
  if (plan.rotate) parts.push(`mv -f -- ${cur} ${prev}`);
  parts.push(`mv -f -- ${tmp} ${cur}`);
  return {
    label: 'write-state',
    kind: 'write',
    argv: sshArgv(cfg, parts.join(' && ')),
    stdin: formatList(plan.current),
  };
}

/** 消すものが無ければ `null`。 */
export function deleteAssetsStep(cfg: DeployConfig, plan: Plan): Step | null {
  if (plan.toDelete.length === 0) return null;
  for (const n of plan.toDelete) {
    if (!isValidAssetName(n))
      throw new Error(`削除対象に不正なファイル名: ${JSON.stringify(n)}`);
  }
  const dir = shellQuote(`${cfg.root}/assets`);
  const cmd = `cd -- ${dir} && rm -f -- ${plan.toDelete.map(shellQuote).join(' ')}`;
  return { label: 'delete-assets', kind: 'write', argv: sshArgv(cfg, cmd) };
}

/** ControlMaster を閉じる argv。 */
export function closeMasterArgv(cfg: DeployConfig): string[] {
  return [
    'ssh',
    '-o',
    `ControlPath=${cfg.controlPath}`,
    '-O',
    'exit',
    cfg.host,
  ];
}

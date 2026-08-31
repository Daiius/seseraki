import type {
  BoardSize,
  ControlSize,
  DisplaySize,
  GraphSize,
} from '../lib/displaySize';

/**
 * 表示サイズの設定 UI（`lib/displaySize.ts`）。
 *
 * 盤を横幅いっぱいまで大きくするとモバイルでは縦が足りなくなり、評価値・読み筋が
 * 画面外へ押し出される。**縦のスペースをどちらへ回すかの好み**なので、正解を 1 つ決めずに
 * 選べるようにしてある。既定はどちらも現状維持。
 *
 * 2 択が一目で分かるよう `join` のトグル（ラジオ）で出す。しきい値のような数値入力にしないのは、
 * 中間の値に意味が無く、**実物を見て 2 つを見比べる**使い方になるため。
 */
export function DisplaySizeSettings({
  displaySize,
  onChange,
}: {
  displaySize: DisplaySize;
  onChange: (next: DisplaySize) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-base-content/70">
        盤と操作ボタンの大きさです（このブラウザに保存され、すべての画面に効きます）。
        とくにモバイルの縦画面では、盤を大きくするほど下の
        <strong>評価値・読み筋が画面の外へ押し出されます</strong>。
        盤の見やすさと情報の見やすさのどちらを取るかで選んでください。
      </p>
      <Choice<BoardSize>
        label="将棋盤"
        hint="「少し小さめ」は盤を約 15% 縮めて、そのぶんを下の情報に回します。"
        value={displaySize.boardSize}
        options={[
          { value: 'full', label: '横幅いっぱい（既定）' },
          { value: 'compact', label: '少し小さめ' },
        ]}
        onChange={(boardSize) => onChange({ ...displaySize, boardSize })}
      />
      <Choice<ControlSize>
        label="操作ボタン"
        hint="「小さめ」はモバイルでもボタンを 1 段小さくします（連打のしやすさは少し落ちます）。検討モードの操作ボタンも一緒に小さくなります。"
        value={displaySize.controlSize}
        options={[
          { value: 'normal', label: '現在のまま（既定）' },
          { value: 'compact', label: '小さめ' },
        ]}
        onChange={(controlSize) => onChange({ ...displaySize, controlSize })}
      />
      <Choice<GraphSize>
        label="評価値グラフ"
        hint="「半分」は推移の折れ線の縦幅を半分にします。形と悪手マーカーの位置は残るので、俯瞰の用途なら読めます。"
        value={displaySize.graphSize}
        options={[
          { value: 'normal', label: '現在のまま（既定）' },
          { value: 'compact', label: '半分' },
        ]}
        onChange={(graphSize) => onChange({ ...displaySize, graphSize })}
      />
    </div>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-semibold">{label}</span>
      <div className="join" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={`btn btn-sm join-item ${value === option.value ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-base-content/60">{hint}</span>
    </div>
  );
}

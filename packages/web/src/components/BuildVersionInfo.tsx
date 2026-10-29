import useSWR from 'swr';
import { client } from '../lib/honoClient';
import { formatBuildVersion, webBuildVersion, type BuildVersion } from '../lib/buildVersion';

async function fetchServerVersion(): Promise<BuildVersion | null> {
  const res = await client.api.version.$get();
  return res.ok ? await res.json() : null;
}

/**
 * web と server の版（prd/02 §5「版の確かめ方」）。設定ページの隅に小さく出す。
 * dirty（未コミットの変更を含むビルド）は短い SHA の後の `*`。server の版が取れなければ `unknown`
 */
export function BuildVersionInfo() {
  const web = webBuildVersion();
  const { data: server, error } = useSWR('build-version', fetchServerVersion, {
    revalidateOnFocus: false,
  });
  const serverLabel =
    server ? formatBuildVersion(server) : server === null || error ? 'unknown' : '…';
  return (
    <p
      className="mt-10 text-right text-xs text-base-content/40"
      title="* は未コミットの変更を含むビルド"
    >
      web {formatBuildVersion(web)} · server {serverLabel}
    </p>
  );
}

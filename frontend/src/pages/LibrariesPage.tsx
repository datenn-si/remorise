import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import libraries from '../libraries.json';
import { buttonClass } from '../lib/ui';

type LibraryEntry = {
  name: string;
  version: string;
  license: string;
  licenseUrl: string;
};

const GROUPS: { title: string; entries: LibraryEntry[] }[] = [
  { title: 'フロントエンド（実行時）', entries: libraries.frontend.runtime },
  { title: 'フロントエンド（開発）', entries: libraries.frontend.dev },
  { title: 'バックエンド（実行時）', entries: libraries.backend.runtime },
  { title: 'バックエンド（開発）', entries: libraries.backend.dev },
];

export function LibrariesPage() {
  useEffect(() => {
    document.title = '使用ライブラリ — Remorise';
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/settings/about" className={buttonClass}>
          Remorise についてへ戻る
        </Link>
        <h1 className="text-lg">使用ライブラリ</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <p className="text-sm leading-relaxed text-muted">
          直接依存するライブラリの一覧です（推移的な依存は含みません）。
        </p>
        {GROUPS.map((group) => (
          <section key={group.title} className="mt-8">
            <h2 className="text-base text-gold-text">{group.title}</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th className="py-1 pr-3 font-normal">名前</th>
                  <th className="py-1 pr-3 font-normal">バージョン</th>
                  <th className="py-1 font-normal">ライセンス</th>
                </tr>
              </thead>
              <tbody>
                {group.entries.map((entry) => (
                  <tr key={entry.name} className="border-b border-line/50">
                    <td className="py-1 pr-3">{entry.name}</td>
                    <td className="py-1 pr-3">{entry.version || '—'}</td>
                    <td className="py-1">
                      {entry.license ? (
                        entry.licenseUrl ? (
                          <a
                            href={entry.licenseUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            {entry.license}
                          </a>
                        ) : (
                          entry.license
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}

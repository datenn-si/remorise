import { useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { version } from '../../package.json';
import { useCharacterTerms } from '../hooks/useCharacterTerms';
import { getPreferences, subscribePreferences } from '../lib/preferences';
import { buttonClass } from '../lib/ui';

export function AboutPage() {
  const scheme = useSyncExternalStore(subscribePreferences, () => getPreferences().scheme);
  const { terms } = useCharacterTerms();
  const hasTerms = terms?.available === true;

  useEffect(() => {
    document.title = 'Remorise について — Remorise';
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/" className={buttonClass}>
          会話へ戻る
        </Link>
        <h1 className="text-lg">Remorise について</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        <picture>
          {scheme === 'device' && (
            <source media="(prefers-color-scheme: light)" srcSet="/logo-wordmark.svg" />
          )}
          <img
            src={scheme === 'light' ? '/logo-wordmark.svg' : '/logo-wordmark-dark.svg'}
            alt="Remorise のロゴ（コバンザメのアイコンと文字）"
            className="w-80 max-w-full"
          />
        </picture>
        <section className="mt-6 space-y-3 text-sm leading-relaxed">
          <p>
            Remorise
            は、ローカルLLMと会話するキャラクターアプリです。チャット、長期記憶、感情、好感度を一つの会話として保持します。記憶は時間とともに少しずつ忘れられ、会話の中で指摘されると思い出します。
          </p>
          <p>
            名前は Remember (you) + Memoria / Memorize +
            Rise（好感度の上昇）の造語で、アイコンは名前に似た魚のコバンザメが、上へ向かって泳ぐ姿です。
          </p>
        </section>
        <dl className="mt-8 space-y-2 text-sm">
          <Row term="アプリ名" value="Remorise" />
          <Row term="バージョン" value={`${version}（フロントエンド）`} />
          <Row term="作者" value="だてんし" />
          <Row term="ライセンス" value="AGPL-3.0 only" />
        </dl>
        <section className="mt-8 space-y-3 text-sm leading-relaxed">
          <h2 className="text-base text-gold-text">ライセンス</h2>
          <p>
            Remorise は GNU Affero General Public License v3.0 only（AGPL-3.0
            only）の下で公開される自由ソフトウェアです。このライセンスの条件に従って、使用、複製、改変、再配布ができます。改変した版をネットワーク越しに他の人が使える形で提供する場合は、その利用者にも対応するソースコードを提供する必要があります。詳細はライセンス全文を確認してください。
          </p>
          <p>
            コードでないアセットはこのライセンスの対象外です。権利者と取り扱いはクレジットに記載しています。
          </p>
          <div className="flex flex-wrap gap-3">
            <Link to="/settings/about/license" className={buttonClass}>
              ライセンス全文
            </Link>
            <Link to="/settings/about/credit" className={buttonClass}>
              クレジット
            </Link>
          </div>
        </section>
        <div className="mt-10 border-t border-line pt-6">
          <div className="flex flex-wrap gap-3">
            {hasTerms && (
              <Link to="/settings/about/terms" className={buttonClass}>
                キャラクター利用規約
              </Link>
            )}
            <Link to="/settings/about/privacy" className={buttonClass}>
              プライバシーポリシー
            </Link>
          </div>
          <p className="mt-2 text-sm text-muted">
            {hasTerms
              ? '読み込んでいるキャラクターの利用条件と、本ソフトウェアにおける情報の取り扱いです。'
              : '本ソフトウェアにおける情報の取り扱いです。'}
          </p>
        </div>
        <div className="mt-10 border-t border-line pt-6">
          <Link to="/settings/about/libraries" className={buttonClass}>
            使用ライブラリ
          </Link>
          <p className="mt-2 text-sm text-muted">
            このアプリが使うオープンソースライブラリの一覧（名前、バージョン、ライセンス）です。
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

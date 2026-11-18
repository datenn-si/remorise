import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import creditSource from '../content/credit.md?raw';
import licenseSource from '../content/license.txt?raw';
import privacySource from '../content/privacy-policy.md?raw';
import { useCharacterTerms } from '../hooks/useCharacterTerms';
import { buttonClass } from '../lib/ui';

// The privacy policy ships with the app: its source of truth is
// docs/privacy-policy.md and the bundled copy under src/content/
// renders here (a test keeps the two identical). The character
// terms are different: they belong to whoever authored the loaded
// character and are served by the backend from the character's
// folder (terms.md), so this page fetches them at runtime.
function LegalDocumentPage({ title, source }: { title: string; source: string }) {
  useEffect(() => {
    document.title = `${title} — Remorise`;
  }, [title]);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/settings/about" className={buttonClass}>
          Remorise についてへ戻る
        </Link>
      </header>
      <div className="legal-markdown min-h-0 flex-1 overflow-y-auto pb-10">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      </div>
    </div>
  );
}

export function CharacterTermsPage() {
  const { terms, error, loading } = useCharacterTerms();
  useEffect(() => {
    document.title = 'キャラクター利用規約 — Remorise';
  }, []);

  if (terms?.available) {
    return <LegalDocumentPage title="キャラクター利用規約" source={terms.markdown} />;
  }
  const note = loading
    ? '読み込んでいます…'
    : (error ?? 'このキャラクターには利用規約はありません。');
  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/settings/about" className={buttonClass}>
          Remorise についてへ戻る
        </Link>
      </header>
      <p className="text-sm leading-relaxed">{note}</p>
    </div>
  );
}

export function PrivacyPolicyPage() {
  return <LegalDocumentPage title="プライバシーポリシー" source={privacySource} />;
}

// The credit document ships with the app the same way: the source
// of truth is CREDIT.md at the repository root and the bundled copy
// under src/content/ renders here (a test keeps the two identical).
export function CreditPage() {
  return <LegalDocumentPage title="クレジット" source={creditSource} />;
}

// The project license ships with the app the same way as the privacy
// policy: the bundled copy under src/content/ mirrors the LICENSE
// file at the repository root (a test keeps the two identical). The
// license text is plain text, not markdown, so it renders as-is; the
// note above it states the scope the license does not cover.
export function LicensePage() {
  useEffect(() => {
    document.title = 'ライセンス — Remorise';
  }, []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4">
      <header className="flex items-center gap-3 py-4">
        <Link to="/settings/about" className={buttonClass}>
          Remorise についてへ戻る
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-auto pb-10">
        <p className="text-sm leading-relaxed whitespace-pre">
          {`このライセンス（AGPL-3.0）が適用されるのは、Remorise のソースコードだけです。
コードでないアセットは対象外であり、著作権はそれぞれの制作者に帰属します。
対象のアセットと取り扱いの詳細は、クレジットを参照してください。`}
        </p>
        <pre className="mt-6 text-xs leading-relaxed whitespace-pre">{licenseSource}</pre>
      </div>
    </div>
  );
}

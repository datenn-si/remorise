import {
  lazy,
  Suspense,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RouteErrorBoundary } from './components/common/RouteErrorBoundary';
import { useCharacter } from './hooks/useCharacter';
import { ChatPage } from './pages/ChatPage';
import { getPreferences, subscribePreferences } from './lib/preferences';
import { AWAY_PATHS } from './lib/routes';

// The chat page is the app; every other screen is visited rarely and
// loads on demand so none of its weight sits in the initial bundle.
const importSettingsPage = () =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage }));
const importAboutPage = () =>
  import('./pages/AboutPage').then((module) => ({ default: module.AboutPage }));
const importLibrariesPage = () =>
  import('./pages/LibrariesPage').then((module) => ({ default: module.LibrariesPage }));
const importLegalPage = () => import('./pages/LegalPage');
const importMemoriesPage = () =>
  import('./pages/MemoriesPage').then((module) => ({ default: module.MemoriesPage }));
const importPipelinePage = () =>
  import('./pages/PipelinePage').then((module) => ({ default: module.PipelinePage }));
const importSpriteDebugPage = () =>
  import('./pages/SpriteDebugPage').then((module) => ({ default: module.SpriteDebugPage }));

const ROUTE_IMPORTERS = [
  importSettingsPage,
  importAboutPage,
  importLibrariesPage,
  importLegalPage,
  importMemoriesPage,
  importPipelinePage,
  importSpriteDebugPage,
];

// A chunk that fails to download (a flaky phone link at the moment
// of navigation) is retried before the error boundary has to show:
// most failures are one dropped request, not a dead server.
function lazyWithRetry<T extends ComponentType>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await load();
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  });
}

const SettingsPage = lazyWithRetry(importSettingsPage);
const AboutPage = lazyWithRetry(importAboutPage);
const LibrariesPage = lazyWithRetry(importLibrariesPage);
const CharacterTermsPage = lazyWithRetry(() =>
  importLegalPage().then((module) => ({ default: module.CharacterTermsPage })),
);
const PrivacyPolicyPage = lazyWithRetry(() =>
  importLegalPage().then((module) => ({ default: module.PrivacyPolicyPage })),
);
const LicensePage = lazyWithRetry(() =>
  importLegalPage().then((module) => ({ default: module.LicensePage })),
);
const CreditPage = lazyWithRetry(() =>
  importLegalPage().then((module) => ({ default: module.CreditPage })),
);
const MemoriesPage = lazyWithRetry(importMemoriesPage);
const PipelinePage = lazyWithRetry(importPipelinePage);
const SpriteDebugPage = lazyWithRetry(importSpriteDebugPage);

export function App() {
  useEffect(() => {
    // Warm the route chunks while the chat page idles: reaching a
    // screen later should not depend on the link still being healthy
    // at the moment of the tap.
    const warm = () => {
      for (const load of ROUTE_IMPORTERS) void load().catch(() => {});
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const id = idleWindow.requestIdleCallback(warm, { timeout: 3_000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 2_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <BrowserRouter>
      <ChatShell />
    </BrowserRouter>
  );
}

function ChatShell() {
  const { pathname } = useLocation();
  const away = AWAY_PATHS.has(pathname);
  return (
    <>
      {/* Stay mounted so a running reply is still recorded on the other screens. */}
      <div className={away ? 'hidden' : 'contents'}>
        <ChatPage />
      </div>
      {away ? (
        <Suspense fallback={<div className="p-6 text-sm text-muted">読み込み中…</div>}>
          <RouteErrorBoundary key={pathname}>
            <Routes>
              <Route
                path="/memories"
                element={
                  <DebugGate>
                    <MemoriesPage />
                  </DebugGate>
                }
              />
              <Route
                path="/pipeline"
                element={
                  <DebugGate>
                    <PipelinePage />
                  </DebugGate>
                }
              />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/about" element={<AboutPage />} />
              <Route path="/settings/about/libraries" element={<LibrariesPage />} />
              <Route path="/settings/about/terms" element={<CharacterTermsPage />} />
              <Route path="/settings/about/privacy" element={<PrivacyPolicyPage />} />
              <Route path="/settings/about/license" element={<LicensePage />} />
              <Route path="/settings/about/credit" element={<CreditPage />} />
              <Route
                path="/sprites"
                element={
                  <DebugGate>
                    <SpriteGate>
                      <SpriteDebugPage />
                    </SpriteGate>
                  </DebugGate>
                }
              />
            </Routes>
          </RouteErrorBoundary>
        </Suspense>
      ) : null}
    </>
  );
}

function DebugGate({ children }: { children: ReactNode }) {
  const debug = useSyncExternalStore(subscribePreferences, () => getPreferences().debug);
  if (!debug) return <Navigate to="/settings" replace />;
  return children;
}

/**
 * The sprite debug page only exists for characters that actually have
 * sprite art: the backend reports availability on the layers payload,
 * and a character without any existing layer image has nothing to debug.
 */
function SpriteGate({ children }: { children: ReactNode }) {
  const character = useCharacter();
  if (character.loading) return null;
  if (character.layers?.available !== true) return <Navigate to="/settings" replace />;
  return children;
}

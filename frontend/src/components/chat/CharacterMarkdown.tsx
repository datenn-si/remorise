import { lazy, memo, Suspense } from 'react';

const LazyCharacterMarkdown = lazy(() =>
  import('./CharacterMarkdownImpl').then((module) => ({
    default: module.CharacterMarkdownImpl,
  })),
);

// The markdown stack (react-markdown, the remark/rehype plugins and
// KaTeX) is the heaviest part of the chat bundle, so it ships as its
// own chunk and loads on first render. Until it lands, the raw text
// shows with its line breaks preserved, so a message never flashes
// empty and the swap to rendered markdown does not move the layout
// more than the formatting itself does.
export const CharacterMarkdown = memo(function CharacterMarkdown({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <div className="character-markdown leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </div>
      }
    >
      <LazyCharacterMarkdown text={text} />
    </Suspense>
  );
});

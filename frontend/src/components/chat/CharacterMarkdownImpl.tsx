import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath];
const rehypePlugins = [rehypeKatex];

// Memoized: a markdown parse is the most expensive render in the
// message list, and settled messages must not re-parse on every
// streamed token of the reply currently being generated.
export const CharacterMarkdownImpl = memo(function CharacterMarkdownImpl({
  text,
}: {
  text: string;
}) {
  return (
    <div className="character-markdown leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

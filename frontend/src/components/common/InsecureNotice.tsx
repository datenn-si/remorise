import { INSECURE_CONTEXT_NOTICE, isPlainHttpRemote } from '../../lib/insecureContext';
import { Banner } from './Banner';

// The plain-http notice. On the chat page it is shown until dismissed
// (the dismissal is stored in the preferences); the settings page
// renders it without a dismiss button so it is always visible there.
// Renders nothing on a secure context (https or localhost).
export function InsecureNotice({ onDismiss }: { onDismiss?: () => void }) {
  if (typeof window === 'undefined' || !isPlainHttpRemote(window.location)) return null;
  return <Banner tone="info" text={INSECURE_CONTEXT_NOTICE} onDismiss={onDismiss} />;
}

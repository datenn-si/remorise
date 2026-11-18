// Stored instants are UTC. SQLite sometimes omits the offset, which browsers read as local time.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = parseInstant(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function parseInstant(value: string): Date {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Date(`${iso}T00:00:00Z`);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return new Date(hasZone ? iso : `${iso}Z`);
}

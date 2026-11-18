export const MEMORY_CATEGORIES = ['event', 'state'] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryStatus = 'active' | 'forgotten';

export type MemoryProvenance = 'explicit' | 'inferred';

/**
 * One memory row in the period model. There is no lineage: a state
 * carries its validity period (period_start/period_end, either end
 * may be open), an event carries its point in time (event_at), and
 * `provisional` marks a row whose time is only approximated until
 * the character asks back and it is pinned down. Memories are
 * read-only from the client; writes happen in the front stage only.
 */
export type Memory = {
  id: number;
  content: string;
  category: MemoryCategory;
  importance: number;
  status: MemoryStatus;
  is_active: boolean;
  provenance: MemoryProvenance;
  keywords: string[];
  // Specific terms: the fact's own concrete words, split from the
  // concept words in keywords. Only a hit on these (or on the
  // content) can carry a forgotten memory back over the border.
  specific_terms: string[];
  period_start: string | null;
  period_end: string | null;
  event_at: string | null;
  provisional: boolean;
  source_type: string;
  source_date: string | null;
  created_at: string;
  content_updated_at: string | null;
  content_update_source_type: string | null;
  content_update_provenance: string | null;
  last_accessed_at: string | null;
  last_recalled_at: string | null;
  reactivation_count: number;
  // Restoration bookkeeping for match revivals — a restoration is
  // not a recall and never touches the recall fields above.
  last_restored_at: string | null;
  restoration_count: number;
  last_reinforced_at: string;
};

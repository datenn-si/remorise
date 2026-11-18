import type { OperationalSettings, OperationalSettingsUpdate } from '../types/settings';
import { request } from './api';

export function getServerSettings(signal?: AbortSignal): Promise<OperationalSettings> {
  return request<OperationalSettings>('/api/settings', { signal });
}

export function updateServerSettings(
  patch: OperationalSettingsUpdate,
): Promise<OperationalSettings> {
  return request<OperationalSettings>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

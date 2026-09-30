import { storage } from '#imports';
import type { AiServiceRule } from '@/lib/config/types';

/** Compile-time only. This capability is never enabled by a page or storage flag. */
export const SHADOW_DEMO = import.meta.env.WXT_SHADOW_DEMO === '1';
export const DEMO_STATE_KEY = 'si_shadow_demo_v1';
export const demoPolicyItem = storage.defineItem<AiServiceRule[]>('local:si_shadow_demo_policy', {
  fallback: [],
});

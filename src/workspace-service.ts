import { logger } from './logger.js';
import {
  type Business,
  getBusinessBySlug,
  getBusinessById,
  listBusinesses,
} from './workspace-db.js';

// ── Slug cache ───────────────────────────────────────────────────────
// Invalidated on any workspace write (createBusiness / updateBusiness /
// archiveBusiness). Dashboard route handlers always go through
// resolveSlug(), so the cache is the only place slug→Business lives.

const slugCache = new Map<string, Business>();
const idCache = new Map<string, Business>();

function primeCaches(): void {
  if (slugCache.size > 0) return;
  for (const b of listBusinesses(true)) {
    slugCache.set(b.slug, b);
    idCache.set(b.id, b);
  }
}

export function invalidateWorkspaceCache(): void {
  slugCache.clear();
  idCache.clear();
}

export function resolveSlug(slug: string): Business | null {
  primeCaches();
  const cached = slugCache.get(slug);
  if (cached) return cached;
  const fresh = getBusinessBySlug(slug);
  if (fresh) {
    slugCache.set(fresh.slug, fresh);
    idCache.set(fresh.id, fresh);
  }
  return fresh;
}

export function resolveId(id: string): Business | null {
  primeCaches();
  const cached = idCache.get(id);
  if (cached) return cached;
  const fresh = getBusinessById(id);
  if (fresh) {
    slugCache.set(fresh.slug, fresh);
    idCache.set(fresh.id, fresh);
  }
  return fresh;
}

/**
 * Returns the business id for a slug, or null if the slug is the special
 * "cross-business" workspace (meaning "no filter"). Used by queries that
 * want to distinguish "scope to this workspace" from "show everything".
 */
export function businessIdForSlug(slug: string | undefined | null): string | null {
  if (!slug || slug === 'cross-business') return null;
  return resolveSlug(slug)?.id ?? null;
}

export function getCrossBusiness(): Business {
  const cb = resolveSlug('cross-business');
  if (!cb) throw new Error('cross-business workspace is missing — migration did not seed it');
  return cb;
}

// ── Per-chat active-workspace context ────────────────────────────────
// Tracks which workspace a given Telegram chat (or dashboard session) is
// currently scoped to. In-memory — persists for the process lifetime, no
// workspace_context table to keep speech architecture untouched.

const activeBySource = new Map<string, string>(); // key: chatId, value: workspace slug

export function setActiveWorkspace(chatId: string, slug: string): Business | null {
  const biz = resolveSlug(slug);
  if (!biz) return null;
  activeBySource.set(chatId, biz.slug);
  logger.info({ chatId, slug: biz.slug }, 'workspace-service: active workspace set');
  return biz;
}

export function getActiveWorkspace(chatId: string): Business {
  const slug = activeBySource.get(chatId);
  if (slug) {
    const biz = resolveSlug(slug);
    if (biz) return biz;
  }
  return getCrossBusiness();
}

export function clearActiveWorkspace(chatId: string): void {
  activeBySource.delete(chatId);
}

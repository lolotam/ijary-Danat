/**
 * Decide how to bind a form image field (URL and/or existing media id) to a
 * `landing_media` row.
 *
 * History: the admin Edit Store form used to prefer an existing media id over
 * a newly uploaded URL. Every brand already had `cover_media_id` / `logo_media_id`,
 * so re-uploading a shop photo or logo looked successful (toast) but left the
 * old `storage_path` in place. A non-empty URL must win over the previous id.
 */

export type LandingMediaLookup = {
  id: string;
  storage_path: string;
  show_in_gallery: boolean;
};

export type LandingMediaResolution =
  | {
      kind: "reuse";
      id: string;
      /** True when the gallery flag on the existing row needs a write. */
      needsGallerySync: boolean;
    }
  | {
      kind: "create";
      storagePath: string;
      /**
       * Prior linked media id superseded by this create. Call sites must
       * deactivate it so the public gallery does not keep showing the old row.
       */
      retireId?: string;
    }
  | {
      kind: "keep";
      id: string | null;
    };

/**
 * Pure decision for resolve-or-create media binding.
 *
 * @param url - Current form image URL (upload public URL, pasted URL, or loaded storage_path)
 * @param existingMediaId - Previously linked landing_media id (may be stale after a re-upload)
 * @param mediaItems - Current media catalog for path/id lookup
 * @param showInGallery - Desired gallery opt-in for this slot
 */
export function planLandingMediaResolution(
  url: string,
  existingMediaId: string | null | undefined,
  mediaItems: LandingMediaLookup[] | undefined,
  showInGallery: boolean,
): LandingMediaResolution {
  const trimmed = url.trim();
  const items = mediaItems ?? [];

  if (trimmed) {
    const byPath = items.find((m) => m.storage_path === trimmed);
    if (byPath) {
      return {
        kind: "reuse",
        id: byPath.id,
        needsGallerySync: byPath.show_in_gallery !== showInGallery,
      };
    }
    // New or replaced URL that is not yet a media row — create, do not keep
    // the previous id (that was the shop-photo-not-saving bug). When replacing,
    // surface the old id so the call site can deactivate it (gallery would
    // otherwise keep both rows while is_active / show_in_gallery stay true).
    return {
      kind: "create",
      storagePath: trimmed,
      ...(existingMediaId ? { retireId: existingMediaId } : {}),
    };
  }

  if (existingMediaId) {
    const byId = items.find((m) => m.id === existingMediaId);
    if (byId) {
      return {
        kind: "reuse",
        id: byId.id,
        needsGallerySync: byId.show_in_gallery !== showInGallery,
      };
    }
    return { kind: "keep", id: existingMediaId };
  }

  return { kind: "keep", id: null };
}

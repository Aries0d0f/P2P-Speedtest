import { useMemo } from "react";

import { tokenToEmojiKey, tokenToSlug } from "~/lib/room-token";

export interface RoomLink {
  slug: string;
  emojiKey: string;
  /** Absolute in the browser, root-relative during SSR, so the two agree on
   * everything the server can actually know. */
  link: string;
}

export function useRoomLink(token: number | null): RoomLink | null {
  return useMemo(() => {
    if (token === null) return null;
    const slug = tokenToSlug(token);
    return {
      slug,
      emojiKey: tokenToEmojiKey(token),
      link:
        typeof window !== "undefined"
          ? `${window.location.origin}/room/${slug}`
          : `/room/${slug}`,
    };
  }, [token]);
}

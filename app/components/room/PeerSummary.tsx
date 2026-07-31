import type { GeoInfo } from "~/model/geo.model";
import type { PeerProfile } from "~/model/peer.model";

function geoSummary(geo: GeoInfo): string | null {
  const place = [geo.city, geo.regionName, geo.country].filter(Boolean);
  if (place.length > 0) return place.join(", ");
  if (geo.proxy !== undefined || geo.hosting !== undefined) {
    const bits: string[] = [];
    if (geo.proxy) bits.push("proxy/VPN");
    if (geo.hosting) bits.push("hosting network");
    return bits.length > 0 ? bits.join(", ") : "residential network";
  }
  return null;
}

export function OtherPeerSummary({ profile }: { profile: PeerProfile }) {
  const geo = profile.geo ? geoSummary(profile.geo) : null;
  return (
    <div className="flex flex-col gap-1 text-center">
      <p className="text-base font-medium text-gray-900 dark:text-gray-100">
        {profile.name}
      </p>
      {profile.ua && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{profile.ua}</p>
      )}
      {profile.ip && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {profile.ip}
          {profile.protocol ? ` (${profile.protocol})` : ""}
        </p>
      )}
      {geo && <p className="text-xs text-gray-500 dark:text-gray-400">{geo}</p>}
    </div>
  );
}

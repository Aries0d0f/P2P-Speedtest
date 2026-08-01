import { useMemo } from "react";
import type { IconType } from "react-icons";
import { FaAndroid, FaApple, FaLinux, FaQuestion, FaWindows } from "react-icons/fa6";
import {
  IoLaptopOutline,
  IoPhonePortraitOutline,
  IoPhonePortraitSharp,
  IoTabletPortraitOutline,
} from "react-icons/io5";
import {
  SiArchlinux,
  SiCentos,
  SiDebian,
  SiDeepin,
  SiElementary,
  SiFedora,
  SiGentoo,
  SiGnu,
  SiKubuntu,
  SiLinuxmint,
  SiManjaro,
  SiOpensuse,
  SiRaspberrypi,
  SiRedhat,
  SiSlackware,
  SiUbuntu,
  SiXubuntu,
} from "react-icons/si";

import type { DeviceBrand, DeviceInfo, DeviceType } from "~/model/peer.model";
import type { PeerView } from "~/model/presentation.model";

/**
 * How a peer is drawn: a form-factor glyph, a platform badge over it, and the
 * words the two stand for.
 *
 * The descriptor behind them is resolved once, in the presentation selector —
 * from what the peer disclosed, or failing that from its user agent. Nothing
 * here re-derives it, so a peer that shared neither is drawn as unknown
 * rather than as whoever is reading.
 */

export interface PeerIcon {
  DeviceIcon: IconType;
  BrandIcon: IconType;
  /** Empty when the peer disclosed nothing to announce, which is what makes
   * the glyphs decorative rather than a claim about that peer. */
  label: string;
}

const BRAND_ICONS: Readonly<Record<DeviceBrand, IconType>> = {
  apple: FaApple,
  microsoft: FaWindows,
  google: FaAndroid,
  linux: FaLinux,
  arch: SiArchlinux,
  centos: SiCentos,
  debian: SiDebian,
  deepin: SiDeepin,
  elementary: SiElementary,
  fedora: SiFedora,
  gentoo: SiGentoo,
  gnu: SiGnu,
  kubuntu: SiKubuntu,
  manjaro: SiManjaro,
  mint: SiLinuxmint,
  raspbian: SiRaspberrypi,
  redhat: SiRedhat,
  slackware: SiSlackware,
  suse: SiOpensuse,
  ubuntu: SiUbuntu,
  xubuntu: SiXubuntu,
};

/** What each badge is called, so the pair reads aloud the way it looks.
 * `google` is the Android mark, which is what that badge says. */
const BRAND_WORDS: Readonly<Record<DeviceBrand, string>> = {
  apple: "Apple",
  microsoft: "Windows",
  google: "Android",
  linux: "Linux",
  arch: "Arch Linux",
  centos: "CentOS",
  debian: "Debian",
  deepin: "Deepin",
  elementary: "elementary OS",
  fedora: "Fedora",
  gentoo: "Gentoo",
  gnu: "GNU",
  kubuntu: "Kubuntu",
  manjaro: "Manjaro",
  mint: "Linux Mint",
  raspbian: "Raspberry Pi OS",
  redhat: "Red Hat",
  slackware: "Slackware",
  suse: "openSUSE",
  ubuntu: "Ubuntu",
  xubuntu: "Xubuntu",
};

const TYPE_WORDS: Readonly<Record<DeviceType, string>> = {
  mobile: "phone",
  tablet: "tablet",
  desktop: "computer",
};

/** Unknown reads as a plain laptop under a question mark rather than as some
 * particular device — the pair never claims more than the peer disclosed. */
function resolve(icon: DeviceInfo | null): PeerIcon {
  const DeviceIcon =
    icon?.type === "mobile"
      ? icon.brand === "apple"
        ? IoPhonePortraitOutline
        : IoPhonePortraitSharp
      : icon?.type === "tablet"
        ? IoTabletPortraitOutline
        : IoLaptopOutline;

  return {
    DeviceIcon,
    BrandIcon: icon?.brand ? BRAND_ICONS[icon.brand] : FaQuestion,
    label: icon
      ? [icon.brand && BRAND_WORDS[icon.brand], icon.type && TYPE_WORDS[icon.type]]
          .filter(Boolean)
          .join(" ")
      : "",
  };
}

export function usePeerIcon(peer: PeerView): PeerIcon {
  return useMemo(() => resolve(peer.icon), [peer.icon]);
}

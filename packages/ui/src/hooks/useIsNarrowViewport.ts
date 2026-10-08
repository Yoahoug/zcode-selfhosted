import { useEffect, useState } from "react";

/**
 * 窄视口判定：手机竖屏 / 分屏窄窗口。
 *
 * 阈值与 Tailwind 的 md 断点对齐（<768px），这样 CSS 的 `md:` 前缀和 JS 判定不会互相矛盾。
 * 判定只看视口宽度，不看 pointer/UA：手机上横屏或桌面端把窗口拖窄，都需要同一套布局。
 */
export const NARROW_VIEWPORT_MEDIA_QUERY = "(max-width: 767px)";

export function readIsNarrowViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY).matches;
}

export function useIsNarrowViewport(): boolean {
  const [isNarrowViewport, setIsNarrowViewport] = useState(readIsNarrowViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY);
    const handleChange = () => setIsNarrowViewport(query.matches);
    // 订阅前先同步一次：首帧到 effect 之间用户可能已经旋转屏幕或拖动了窗口。
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return isNarrowViewport;
}

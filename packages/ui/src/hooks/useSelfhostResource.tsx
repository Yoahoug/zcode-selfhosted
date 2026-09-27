import { useEffect, useRef, useState } from "react";

/**
 * 自托管 server 资源快照 hook。
 *
 * 数据源是 server 的 `GET /api/selfhost/resource`（与页面同源，token 经 URL 参数或
 * cookie 由服务端中间件校验，前端不持有、不透传 token）。
 * 60s 轮询一次；页面不可见时暂停，避免空闲机器被观测本身唤醒。
 */
export interface SelfhostResourceSnapshot {
  serverRssBytes: number;
  serverHeapUsedBytes: number;
  serverUptimeSeconds: number;
  wsConnectionCount: number;
  runningTaskCount: number;
  idleCountdownSeconds: number | null;
  idleTimeoutMinutes: number;
}

export type SelfhostResourceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snapshot: SelfhostResourceSnapshot }
  | { status: "error" };

const POLL_INTERVAL_MS = 60_000;

async function fetchSnapshot(signal: AbortSignal): Promise<SelfhostResourceSnapshot> {
  const response = await fetch("/api/selfhost/resource", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`selfhost resource request failed: ${response.status}`);
  }
  return (await response.json()) as SelfhostResourceSnapshot;
}

export function useSelfhostResource(enabled: boolean): SelfhostResourceState {
  const [state, setState] = useState<SelfhostResourceState>({ status: "idle" });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });

    const poll = async (): Promise<void> => {
      if (cancelled || !enabledRef.current || document.visibilityState === "hidden") return;
      try {
        const snapshot = await fetchSnapshot(controller.signal);
        if (!cancelled) setState({ status: "ready", snapshot });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        if (!cancelled) setState({ status: "error" });
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller.abort();
    };
  }, [enabled]);

  return state;
}

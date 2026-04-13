"use client";

import { useEffect } from "react";

export default function ServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        await navigator.serviceWorker.register("/sw.js");
      } catch {
        // No-op: service worker registration is best-effort in dev.
      }
    };

    register();
  }, []);

  return null;
}

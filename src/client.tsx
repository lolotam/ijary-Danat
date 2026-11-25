import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import { initSentryClient } from "./instrument.client";

/**
 * نقطة دخول المتصفح — نسخة مطابقة لنقطة الدخول الافتراضية في TanStack Start،
 * أُضيفت فقط لتشغيل Sentry قبل أي عرض.
 */
initSentryClient();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});

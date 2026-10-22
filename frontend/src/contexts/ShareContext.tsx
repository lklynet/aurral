import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { ShareModal } from "../components/ShareModal";
import type { ShareItem } from "../utils/shareLink";

type ShareContextValue = { openShare: (item: ShareItem, label?: string) => void };

const ShareContext = createContext<ShareContextValue | null>(null);

export function ShareProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ComponentProps<typeof ShareModal>["request"]>(null);
  const openShare = useCallback(
    (item: ShareItem, label?: string) => setRequest({ item, label }),
    [],
  );
  const close = useCallback(() => setRequest(null), []);
  const value = useMemo(() => ({ openShare }), [openShare]);

  return (
    <ShareContext.Provider value={value}>
      {children}
      <ShareModal request={request} onClose={close} />
    </ShareContext.Provider>
  );
}

export function useShareContext() {
  const context = useContext(ShareContext);
  if (context === null) {
    throw new Error("useShareContext must be used within a ShareProvider");
  }
  return context;
}

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ShareModal } from "../components/ShareModal";
import type { ShareItem } from "../utils/shareLink";

type ShareRequest = { item: ShareItem; label: string | null };
type ShareContextValue = { openShare: (item: ShareItem, label: string | null) => void };

const ShareContext = createContext<ShareContextValue | null>(null);

export function ShareProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ShareRequest | null>(null);
  const openShare = useCallback(
    (item: ShareItem, label: string | null) => setRequest({ item, label }),
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

export const useShareContext = () => useContext(ShareContext);

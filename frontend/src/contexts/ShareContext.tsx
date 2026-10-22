import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { ShareModal } from "../components/ShareModal";

const ShareContext = createContext(null);

export function ShareProvider({ children }) {
  const [request, setRequest] = useState(null);
  const openShare = useCallback((item, label) => setRequest({ item, label }), []);
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

import { useState, useEffect, useRef, useMemo } from "react";
import { Server, ListMusic, Compass, Bell, Users } from "lucide-react";

export function useSettingsTabs(authUser) {
  const [activeTab, setActiveTab] = useState("integrations");
  const [hoveredTabIndex, setHoveredTabIndex] = useState(null);
  const navRef = useRef(null);
  const activeBubbleRef = useRef(null);
  const hoverBubbleRef = useRef(null);
  const linkRefs = useRef({});

  const tabs = useMemo(() => {
    if (authUser?.role !== "admin") {
      return [];
    }
    return [
      { id: "integrations", label: "Integrations", icon: Server },
      { id: "playlists", label: "Playlists", icon: ListMusic },
      { id: "discover", label: "Discover", icon: Compass },
      { id: "notifications", label: "Notifications", icon: Bell },
      { id: "users", label: "Users", icon: Users },
    ];
  }, [authUser?.role]);

  useEffect(() => {
    const validIds = tabs.map((t) => t.id);
    if (!validIds.includes(activeTab)) {
      setActiveTab(validIds[0] || "users");
    }
  }, [tabs, activeTab]);

  useEffect(() => {
    const updateActiveBubble = () => {
      if (!navRef.current || !activeBubbleRef.current) return;
      const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
      if (activeIndex === -1) {
        activeBubbleRef.current.style.opacity = "0";
        return;
      }
      const activeEl = linkRefs.current[activeIndex];
      if (!activeEl) {
        setTimeout(updateActiveBubble, 50);
        return;
      }
      const navRect = navRef.current.getBoundingClientRect();
      const linkRect = activeEl.getBoundingClientRect();
      activeBubbleRef.current.style.left = `${linkRect.left - navRect.left}px`;
      activeBubbleRef.current.style.top = `${linkRect.top - navRect.top}px`;
      activeBubbleRef.current.style.width = `${linkRect.width}px`;
      activeBubbleRef.current.style.height = `${linkRect.height}px`;
      activeBubbleRef.current.style.opacity = "1";
    };
    const timeoutId = setTimeout(updateActiveBubble, 10);
    window.addEventListener("resize", updateActiveBubble);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", updateActiveBubble);
    };
  }, [activeTab, tabs]);

  useEffect(() => {
    const updateHoverBubble = () => {
      if (!navRef.current || !hoverBubbleRef.current) return;
      if (hoveredTabIndex === null) {
        hoverBubbleRef.current.style.left = "0px";
        hoverBubbleRef.current.style.top = "0px";
        hoverBubbleRef.current.style.width = "100%";
        hoverBubbleRef.current.style.height = "100%";
        hoverBubbleRef.current.style.opacity = "0.6";
        return;
      }
      const hoveredEl = linkRefs.current[hoveredTabIndex];
      if (!hoveredEl) return;
      const navRect = navRef.current.getBoundingClientRect();
      const linkRect = hoveredEl.getBoundingClientRect();
      hoverBubbleRef.current.style.left = `${linkRect.left - navRect.left}px`;
      hoverBubbleRef.current.style.top = `${linkRect.top - navRect.top}px`;
      hoverBubbleRef.current.style.width = `${linkRect.width}px`;
      hoverBubbleRef.current.style.height = `${linkRect.height}px`;
      hoverBubbleRef.current.style.opacity = "1";
    };
    updateHoverBubble();
  }, [hoveredTabIndex]);

  return {
    activeTab,
    setActiveTab,
    tabs,
    hoveredTabIndex,
    setHoveredTabIndex,
    navRef,
    activeBubbleRef,
    hoverBubbleRef,
    linkRefs,
  };
}

import { createContext, type RefObject } from "react";

export const MainScrollContext = createContext<RefObject<HTMLElement | null> | null>(null);

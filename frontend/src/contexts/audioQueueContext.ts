import { createContext, useContext } from "react";

export const AudioQueueContext = createContext(null);

export function useAudioQueue() {
  const context = useContext(AudioQueueContext);
  if (!context) {
    throw new Error("useAudioQueue must be used within AudioQueueProvider");
  }
  return context;
}

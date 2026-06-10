import { useContext } from "react";
import { AudioQueueContext } from "../contexts/audioQueueContext";

export function useAudioQueue() {
  const context = useContext(AudioQueueContext);
  if (!context) {
    throw new Error("useAudioQueue must be used within AudioQueueProvider");
  }
  return context;
}

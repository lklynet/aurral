import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { starPromptClient } from "../utils/api/clients/starPrompt.ts";

export default function StarPrompt() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const onWrapped = useLocation().pathname === "/wrapped";
  const claimedFor = useRef<number | null>(null);
  const userId = user?.id;

  useEffect(() => {
    if (!userId || onWrapped || claimedFor.current === userId) return;
    claimedFor.current = userId;
    parseResponse(starPromptClient.$post())
      .then(({ show }) => {
        if (!show) return;
        addToast(
          {
            title: "Enjoying Aurral?",
            message: "A GitHub star helps more people find it.",
            action: {
              label: "Star on GitHub",
              onClick: () =>
                window.open("https://github.com/lklynet/aurral", "_blank", "noopener,noreferrer"),
            },
          },
          "info",
          Infinity,
        );
      })
      .catch(() => {});
  }, [addToast, onWrapped, userId]);

  return null;
}

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "../../../components/icons";
import { ConfirmModal } from "../../../components/ConfirmModal";
import { DotLoader } from "../../../components/DotLoader";
import TooltipButton from "../../../components/TooltipButton";
import { useToast } from "../../../contexts/ToastContext";
import { SettingsNote, SettingsRow } from "../SettingsLayout";

type ApiKeyState = { apiKey: string; managedByEnv?: boolean };

const COPY_FAILED = "Could not copy the API key. Reveal it and copy manually.";

export function ApiKeyRow({
  queryKey,
  load,
  rotate,
  help,
}: {
  queryKey: QueryKey;
  load: (signal: AbortSignal) => Promise<ApiKeyState>;
  rotate: () => Promise<{ apiKey: string }>;
  help: ReactNode;
}) {
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey, queryFn: ({ signal }) => load(signal) });
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rotation = useMutation({
    mutationFn: rotate,
    onSuccess: ({ apiKey }) => {
      queryClient.setQueryData<ApiKeyState>(queryKey, (prev) => ({ ...prev, apiKey }));
      setConfirming(false);
      showSuccess("API key rotated");
    },
    onError: () => showError("Failed to rotate API key"),
  });
  const apiKey = query.data?.apiKey;
  const managedByEnv = query.data?.managedByEnv === true;

  const copy = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(COPY_FAILED);
    }
  };

  return (
    <SettingsRow
      label="API key"
      help={
        <>
          {help}{" "}
          {managedByEnv ? (
            <>
              Set by the <code>AURRAL_API_KEY</code> environment variable.
            </>
          ) : (
            "Keep it private."
          )}
        </>
      }
      stack
    >
      {query.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      ) : apiKey ? (
        <>
          <code className="settings-code">{revealed ? apiKey : "•".repeat(apiKey.length)}</code>
          <TooltipButton
            label={revealed ? "Hide API key" : "Show API key"}
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </TooltipButton>
          <TooltipButton
            label={copied ? "Copied" : "Copy API key"}
            className="btn btn-ghost btn-icon btn-sm"
            onClick={copy}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </TooltipButton>
          {managedByEnv ? null : (
            <TooltipButton
              label="Rotate API key"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => setConfirming(true)}
            >
              <RefreshCw aria-hidden="true" />
            </TooltipButton>
          )}
          <ConfirmModal
            open={confirming}
            title="Rotate API key?"
            body="Apps using the current key stop working."
            confirmLabel="Rotate"
            busyLabel="Rotating…"
            busy={rotation.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() => rotation.mutate()}
          />
        </>
      ) : (
        <SettingsNote tone="error">Couldn&apos;t load the API key.</SettingsNote>
      )}
    </SettingsRow>
  );
}

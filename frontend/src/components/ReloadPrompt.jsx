import { useRegisterSW } from "virtual:pwa-register/react";

function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered() {},
    onRegisterError() {},
  });

  const close = () => {
    setNeedRefresh(false);
  };

  if (!needRefresh) {
    return null;
  }

  return (
    <div className="reload-prompt">
      <div className="reload-prompt__content">
        <p className="reload-prompt__text">
          New content available, click on reload button to update.
        </p>
        <div className="reload-prompt__actions">
          <button
            type="button"
            className="btn btn-primary btn-sm btn--grow"
            onClick={() => updateServiceWorker(true)}
          >
            Reload
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn--grow"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReloadPrompt;

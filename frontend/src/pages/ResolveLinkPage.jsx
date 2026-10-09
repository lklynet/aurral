import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { SkeletonPageHeader, SkeletonRows, SkeletonStatus } from "../components/Skeletons";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { RESOLVE_KINDS, resolveLinkQueryOptions } from "../navigation/resolveLinks.js";

export default function ResolveLinkPage() {
  const { kind } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { showInfo } = useToast();
  const { data, error, isFetching, refetch } = useQuery(resolveLinkQueryOptions(kind, search));
  const invalid = !RESOLVE_KINDS.includes(kind);
  const params = new URLSearchParams(search);
  const name = params.get("name") || params.get("artist") || "";
  useDocumentTitle(name || "Opening");

  useEffect(() => {
    if (!data?.to) return;
    if (data.notice) showInfo(data.notice);
    navigate(data.to, { replace: true, state: data.state });
  }, [data, navigate, showInfo]);

  if (error || invalid) {
    const notFound = invalid || error?.resolveNotFound === true;
    return (
      <main className="library-page native-library-page">
        <div className="native-library-content">
          <div className="native-library-state" role="alert">
            <strong>
              {invalid ? "This link isn't valid" : notFound ? error.message : "Couldn't open this link"}
            </strong>
            <span>
              {notFound
                ? "Try searching for it instead."
                : "Aurral couldn't look this up. Check your connection and try again."}
            </span>
            {notFound ? (
              name ? (
                <Link
                  className="native-library-state__action"
                  to={`/search?q=${encodeURIComponent(name)}`}
                  replace
                >
                  Search for {name}
                </Link>
              ) : (
                <Link className="native-library-state__action" to="/" replace>
                  Back to Discover
                </Link>
              )
            ) : (
              <button
                type="button"
                className="native-library-state__action"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="library-page native-library-page">
      <div className="native-library-content">
        <SkeletonStatus label={name ? `Opening ${name}` : "Opening"}>
          <SkeletonPageHeader />
          <SkeletonRows count={8} />
        </SkeletonStatus>
      </div>
    </main>
  );
}

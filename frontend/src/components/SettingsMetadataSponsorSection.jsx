import { ExternalLink, Heart } from "lucide-react";
import { SPONSOR_URL } from "../constants/sponsor";

function SettingsMetadataSponsorSection() {
  return (
    <div className="settings-page__section settings-page__section--sponsor">
      <div className="settings-page__section-header">
        <h3 className="settings-page__section-title">Support hosted services</h3>
        <Heart
          className="settings-page__sponsor-icon"
          aria-hidden="true"
        />
      </div>
      <p className="settings-page__sponsor-copy">
        Aurral&apos;s metadata and search backends currently run on personal
        infrastructure and may experience occasional downtime. Sponsorship goes
        directly toward maintaining Aurral, keeping those services online, and
        funding cloud capacity when needed.
      </p>
      <a
        href={SPONSOR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-secondary btn-sm settings-page__sponsor-cta"
      >
        <ExternalLink className="settings-page__banner-cta-icon" aria-hidden="true" />
        Become a sponsor
      </a>
    </div>
  );
}

export default SettingsMetadataSponsorSection;

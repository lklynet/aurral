import { useNavigate } from "react-router";
import { Select } from "./Select";

interface PageSectionMobileNavProps {
  basePath?: string;
  sections: readonly { id: string; label: string }[];
  activeId: string;
  label?: string;
  getSectionPath?: (sectionId: string) => string;
  selectId?: string;
}

export function PageSectionMobileNav({
  basePath,
  sections,
  activeId,
  label = "View",
  getSectionPath,
  selectId = "page-section-select",
}: PageSectionMobileNavProps) {
  const navigate = useNavigate();

  return (
    <div className="page-section-mobile-nav">
      <label htmlFor={selectId} className="page-section-mobile-nav__label">
        {label}
      </label>
      <Select
        className="artist-modal-select"
        id={selectId}
        value={activeId}
        onChange={(sectionId) =>
          navigate(getSectionPath ? getSectionPath(sectionId) : `${basePath}/${sectionId}`)
        }
        options={sections.map((section) => ({ value: section.id, label: section.label }))}
      />
    </div>
  );
}

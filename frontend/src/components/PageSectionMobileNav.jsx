import { useNavigate } from "react-router";

export function PageSectionMobileNav({
  basePath,
  sections,
  activeId,
  label = "View",
  getSectionPath,
  selectId = "page-section-select",
}) {
  const navigate = useNavigate();

  return (
    <div className="page-section-mobile-nav">
      <label htmlFor={selectId} className="page-section-mobile-nav__label">
        {label}
      </label>
      <select
        className="artist-modal-select"
        id={selectId}
        value={activeId}
        onChange={(event) =>
          navigate(
            getSectionPath
              ? getSectionPath(event.target.value)
              : `${basePath}/${event.target.value}`,
          )
        }
      >
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.label}
          </option>
        ))}
      </select>
    </div>
  );
}

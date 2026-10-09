import { forwardRef } from "react";
import { Link } from "react-router";

const RouteLink = forwardRef(function RouteLink(props, ref) {
  return <Link ref={ref} {...props} />;
});

export function OptionalLink({ link, children, ...props }) {
  if (!link?.to) {
    const { className } = props;
    return <span className={className}>{children}</span>;
  }
  return (
    <RouteLink to={link.to} state={link.state} {...props}>
      {children}
    </RouteLink>
  );
}

export default RouteLink;

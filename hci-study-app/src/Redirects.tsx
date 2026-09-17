import { Navigate, useLocation } from "react-router-dom";

export function RootRedirect() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/intro",
        search: location.search,  // <- keep ?PROLIFIC_PID=...
      }}
      replace
    />
  );
}

export function FallbackRedirect() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/intro",
        search: location.search,
      }}
      replace
    />
  );
}

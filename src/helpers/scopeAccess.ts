export function filterAllowedProjectScopes(
  requestedScopes: string[] | undefined,
  tokenProjectScopes: string[] | null | undefined
): string[] | undefined {
  if (!requestedScopes?.length) return requestedScopes;
  if (tokenProjectScopes == null) return requestedScopes;

  const allowed = new Set(tokenProjectScopes);

  return requestedScopes.filter((scope) => {
    if (!scope.startsWith("project:")) return true;
    return allowed.has(scope);
  });
}

export function buildBeliefProjectScopeFilter(
  tokenProjectScopes: string[] | null | undefined
): Record<string, unknown> {
  if (tokenProjectScopes == null) return {};
  return {
    scope: {
      $not: {
        $elemMatch: {
          $regex: "^project:",
          $nin: tokenProjectScopes
        }
      }
    }
  };
}

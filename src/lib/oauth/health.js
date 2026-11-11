export function oauthIssue(connection, member) {
  if (connection.authType !== "oauth") return null;
  const errors = [connection.lastError, member?.error, connection.errorCode].filter(Boolean).join(" ");
  // A 403 can mean an unassigned Team seat. Do not label that as revoked OAuth.
  if (!/\b401\b|unauthorized|invalid[_ -](grant|token)|refresh[_ -]?token.*(expired|revoked|invalid)/i.test(errors)) return null;
  return { label: "Reconnect OAuth", message: "The last OAuth authentication check failed. Sign in again with Reconnect.", checkedAt: member?.verifiedAt || connection.lastErrorAt || null };
}

let sequence = 0;

export function openOAuthPopup(browserWindow, url) {
  // A fresh target cannot navigate an existing Claude tab or another login.
  const target = `9router-oauth-${Date.now()}-${++sequence}`;
  return browserWindow.open(url, target, "popup=yes,width=600,height=700,resizable=yes,scrollbars=yes");
}

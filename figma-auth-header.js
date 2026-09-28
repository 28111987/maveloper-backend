// =====================================================================
// FIGMA AUTH HEADER — the one place a Figma REST call picks its header.
//
// Figma accepts two kinds of token, each ONLY in its own header:
//   - OAuth access token (prefix figu_)  -> Authorization: Bearer <token>
//   - personal / plan access token (figd_) and older unprefixed tokens
//                                        -> X-Figma-Token: <token>
// Sending an OAuth token as X-Figma-Token is refused by Figma, so an order
// from a space connected through "Connect to Figma" failed at the first call.
//
// ★ BRANCH ON THE PREFIX, NEVER SWAP THE HEADER. Everything that is not figu_
// returns EXACTLY the header every call sent before this file existed, so the
// global Mavlers token and every pasted token are byte-identical to before.
// The token is passed through as given: no trim, no rewrite, never logged.
// =====================================================================

export const FIGMA_OAUTH_TOKEN_PREFIX = "figu_";

/**
 * @param {string} token  the resolved Figma credential for this call
 * @returns {Object} a fresh headers object carrying exactly one auth header
 */
export function figmaAuthHeaders(token) {
  if (typeof token === "string" && token.startsWith(FIGMA_OAUTH_TOKEN_PREFIX)) {
    return { Authorization: "Bearer " + token };
  }
  return { "X-Figma-Token": token };
}

export default { figmaAuthHeaders, FIGMA_OAUTH_TOKEN_PREFIX };

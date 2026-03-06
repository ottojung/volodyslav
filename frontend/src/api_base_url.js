/**
 * The base URL path for API requests, derived from the configured base path.
 * Strips any trailing slash to allow clean concatenation with API route paths.
 */
const API_BASE_URL = __BASE_PATH__.replace(/\/$/, "") + "/api";

export { API_BASE_URL };

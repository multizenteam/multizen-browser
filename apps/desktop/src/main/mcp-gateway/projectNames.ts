export const PROJECT_NAME_LIMIT = 32;
export const NEW_PROJECT_ID_LIMIT = 24;

/** Count Unicode code points so shortening cannot split a surrogate pair. */
export function shortenProjectName(name: string): string {
  return Array.from(name).slice(0, PROJECT_NAME_LIMIT).join("");
}

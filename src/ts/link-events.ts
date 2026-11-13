/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

// dispatched on document once a link was created from the links section and the links are reloaded
export const LINK_CREATED_EVENT = 'elab:link-created';
// endpoint: experiments_links, items_links... target: id of the linked entity
export type LinkCreatedDetail = { endpoint: string; target: number };

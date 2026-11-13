<?php

declare(strict_types=1);
/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

namespace Elabftw\Elabftw;

use Symfony\Component\HttpFoundation\JsonResponse;

use function dirname;

/**
 * Silent re-authentication for pages that stay open for a long time (whiteboard, main text).
 * The api never logs in from the "remember me" cookie, but init.inc.php does: when the php session
 * is gone (container restart, garbage collection) but the cookie is still valid, requesting this
 * script logs the user back in and starts a new session. Otherwise init.inc.php answers with the
 * X-Elab-Need-Auth header and an empty body.
 */
require_once dirname(__DIR__) . '/init.inc.php';

new JsonResponse(array('ok' => true))->send();

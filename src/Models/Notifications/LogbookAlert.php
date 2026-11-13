<?php

/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

declare(strict_types=1);

namespace Elabftw\Models\Notifications;

use Elabftw\Elabftw\Env;
use Elabftw\Enums\Notifications;
use Elabftw\Interfaces\MailableInterface;
use Elabftw\Models\Users\Users;
use Override;

use function _;
use function sprintf;

/**
 * An instrument logbook entry reports that the instrument needs attention (see Services/LogbookRules.php)
 * Sent to the instrument stewards, or to the team admins when the instrument has none
 */
final class LogbookAlert extends AbstractNotifications implements MailableInterface
{
    protected const PREF = 'notif_logbook_alert';

    protected Notifications $category = Notifications::LogbookAlert;

    /**
     * @param array{instrument_id: int, instrument_title: string, status: string, entry_id: int, entry_title: string, reporter: string} $data
     */
    public function __construct(Users $targetUser, private array $data)
    {
        parent::__construct($targetUser);
    }

    public static function getWebMessage(array $body): string
    {
        return sprintf(_('%s reported "%s" for %s.'), $body['reporter'] ?? '', $body['status'] ?? '', $body['instrument_title'] ?? '');
    }

    #[Override]
    public function getEmail(): array
    {
        $url = Env::asUrl('SITE_URL');
        $body = self::getWebMessage($this->data) . "\n\n";
        $body .= sprintf(_('Logbook entry: %s'), $this->data['entry_title']) . "\n";
        $body .= sprintf('%s/experiments.php?mode=view&id=%d', $url, $this->data['entry_id']) . "\n\n";
        $body .= sprintf(_('Instrument: %s'), $this->data['instrument_title']) . "\n";
        $body .= sprintf('%s/database.php?mode=view&id=%d', $url, $this->data['instrument_id']) . "\n\n";
        $body .= _('You receive this message as steward of this instrument (or as administrator when the instrument has no steward).');
        return array(
            'subject' => sprintf('%s: %s', $this->data['instrument_title'], $this->data['status']),
            'body' => $body,
        );
    }

    #[Override]
    protected function getBody(): array
    {
        return $this->data;
    }
}

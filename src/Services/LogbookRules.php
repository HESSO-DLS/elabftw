<?php

/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

declare(strict_types=1);

namespace Elabftw\Services;

use Elabftw\Elabftw\Db;
use Elabftw\Enums\Action;
use Elabftw\Enums\EntityType;
use Elabftw\Enums\State;
use Elabftw\Models\Items;
use Elabftw\Models\Notifications\LogbookAlert;
use Elabftw\Models\Users\Users;
use PDO;
use Throwable;

use function array_filter;
use function array_map;
use function array_unique;
use function array_values;
use function error_log;
use function implode;
use function in_array;
use function is_array;
use function is_int;
use function is_numeric;
use function is_string;
use function json_decode;
use function mb_strtolower;
use function str_contains;
use function strtolower;
use function sprintf;
use function trim;
use function uasort;

/**
 * Rules of the instrument logbook (see Models/Logbook.php)
 * An instrument (resource) needs a logbook when its "Logbook required" checkbox extra field is on.
 * A logbook entry is an experiment created from an experiment template linked to such an instrument.
 * When the status reported by an entry changes, the instrument status follows the latest entry
 * and the instrument stewards (or the team admins) get an alert if it is not ready.
 */
final class LogbookRules
{
    // name of the checkbox extra field on the instrument, compared case-insensitively
    private const string REQUIRED_FIELD = 'logbook required';

    // colors of the instrument statuses created automatically
    private const string COLOR_READY = '29AE29';

    private const string COLOR_MAINTENANCE = 'E58A00';

    private const string COLOR_OUT = 'C0392B';

    private const string COLOR_OTHER = '6F6F6F';

    public static function isLogbookRequired(?string $metadata): bool
    {
        foreach (self::extraFields($metadata) as $name => $field) {
            if (mb_strtolower(trim((string) $name)) !== self::REQUIRED_FIELD || !is_array($field)) {
                continue;
            }
            $value = $field['value'] ?? null;
            if ($value === true || $value === 1) {
                return true;
            }
            return is_string($value) && in_array(strtolower(trim($value)), array('on', '1', 'true', 'yes'), true);
        }
        return false;
    }

    public static function extraFields(?string $metadata): array
    {
        $decoded = json_decode($metadata ?? '', true);
        if (!is_array($decoded) || !is_array($decoded['extra_fields'] ?? null)) {
            return array();
        }
        return $decoded['extra_fields'];
    }

    /**
     * The status field of a logbook entry: first select field with "status" in its name
     * Ready is the first option of that field
     * @return array{name: string, value: string, ready: bool}|null
     */
    public static function getStatus(?string $metadata): ?array
    {
        $fields = self::extraFields($metadata);
        // follow the order of the form
        uasort($fields, fn($a, $b): int => (int) ($a['position'] ?? 0) <=> (int) ($b['position'] ?? 0));
        foreach ($fields as $name => $field) {
            if (!is_array($field) || ($field['type'] ?? '') !== 'select' || !str_contains(mb_strtolower((string) $name), 'status')) {
                continue;
            }
            $value = $field['value'] ?? '';
            $value = is_array($value) ? implode(', ', $value) : trim((string) $value);
            $first = $field['options'][0] ?? null;
            return array(
                'name' => (string) $name,
                'value' => $value,
                'ready' => $value !== '' && $value === $first,
            );
        }
        return null;
    }

    // logbook templates of an instrument: experiment templates linked to it
    public static function getTemplateIds(int $instrumentId): array
    {
        $Db = Db::getConnection();
        $req = $Db->prepare('SELECT experiments_templates.id
            FROM experiments_templates2items
            INNER JOIN experiments_templates ON (experiments_templates.id = experiments_templates2items.item_id)
            WHERE experiments_templates2items.link_id = :instrument AND experiments_templates.state = :state');
        $req->bindParam(':instrument', $instrumentId, PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $Db->execute($req);
        return array_map('intval', $req->fetchAll(PDO::FETCH_COLUMN));
    }

    // instruments needing a logbook that are linked to an experiment template
    public static function getInstrumentsOfTemplate(int $templateId): array
    {
        $Db = Db::getConnection();
        $req = $Db->prepare('SELECT items.id, items.title, items.team, items.metadata, items.status
            FROM experiments_templates2items
            INNER JOIN items ON (items.id = experiments_templates2items.link_id)
            WHERE experiments_templates2items.item_id = :id AND items.state = :state');
        $req->bindParam(':id', $templateId, PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $Db->execute($req);
        return array_values(array_filter($req->fetchAll(), fn(array $item): bool => self::isLogbookRequired($item['metadata'])));
    }

    public static function isLogbookTemplate(int $templateId): bool
    {
        return self::getInstrumentsOfTemplate($templateId) !== array();
    }

    /**
     * Called after an experiment was created or its metadata changed. Never throws: a logbook problem must not break a save.
     */
    public static function afterChange(Users $actor, int $experimentId, ?string $oldMetadata): void
    {
        try {
            self::handleChange($actor, $experimentId, $oldMetadata);
        } catch (Throwable $e) {
            error_log('Instrument logbook: ' . $e->getMessage());
        }
    }

    private static function handleChange(Users $actor, int $experimentId, ?string $oldMetadata): void
    {
        $Db = Db::getConnection();
        $req = $Db->prepare('SELECT experiments.id, experiments.title, experiments.metadata, experiments.created_from_type,
                experiments.created_from_id, experiments.state, CONCAT(users.firstname, " ", users.lastname) AS fullname
            FROM experiments
            LEFT JOIN users ON (users.userid = experiments.userid)
            WHERE experiments.id = :id');
        $req->bindParam(':id', $experimentId, PDO::PARAM_INT);
        $Db->execute($req);
        $entry = $req->fetch();
        if (!is_array($entry) || (int) $entry['created_from_type'] !== EntityType::Templates->toInt() || $entry['created_from_id'] === null) {
            return;
        }
        $instruments = self::getInstrumentsOfTemplate((int) $entry['created_from_id']);
        if ($instruments === array()) {
            return;
        }
        $status = self::getStatus($entry['metadata']);
        if ($status === null || $status['value'] === '') {
            return;
        }
        $old = self::getStatus($oldMetadata);
        if ($old !== null && $old['value'] === $status['value']) {
            return;
        }

        foreach ($instruments as $instrument) {
            // the instrument status follows the latest entry only
            if (self::isLatestEntry((int) $instrument['id'], $experimentId)) {
                self::setInstrumentStatus($actor, $instrument, $status['value']);
            }
            if (!$status['ready']) {
                foreach (self::getRecipients($instrument) as $userid) {
                    new LogbookAlert(new Users($userid), array(
                        'instrument_id' => (int) $instrument['id'],
                        'instrument_title' => $instrument['title'],
                        'status' => $status['value'],
                        'entry_id' => $experimentId,
                        'entry_title' => $entry['title'],
                        'reporter' => $actor->userData['fullname'] ?? $entry['fullname'] ?? '',
                    ))->create();
                }
            }
        }
    }

    private static function isLatestEntry(int $instrumentId, int $experimentId): bool
    {
        $templateIds = self::getTemplateIds($instrumentId);
        if ($templateIds === array()) {
            return false;
        }
        $Db = Db::getConnection();
        $req = $Db->prepare(sprintf('SELECT MAX(id) FROM experiments
            WHERE created_from_type = :type AND created_from_id IN (%s) AND state = :state', implode(',', $templateIds)));
        $req->bindValue(':type', EntityType::Templates->toInt(), PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $Db->execute($req);
        return (int) $req->fetchColumn() === $experimentId;
    }

    private static function setInstrumentStatus(Users $actor, array $instrument, string $value): void
    {
        $Db = Db::getConnection();
        $team = (int) $instrument['team'];
        $req = $Db->prepare('SELECT id FROM items_status WHERE team = :team AND state = :state AND LOWER(title) = LOWER(:title) ORDER BY id LIMIT 1');
        $req->bindParam(':team', $team, PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $req->bindParam(':title', $value);
        $Db->execute($req);
        $statusId = $req->fetchColumn();
        if ($statusId === false) {
            $lower = mb_strtolower($value);
            $color = self::COLOR_OTHER;
            if (str_contains($lower, 'out of service') || str_contains($lower, 'broken') || str_contains($lower, 'hors service')) {
                $color = self::COLOR_OUT;
            } elseif (str_contains($lower, 'maintenance')) {
                $color = self::COLOR_MAINTENANCE;
            } elseif (str_contains($lower, 'ready') || str_contains($lower, 'prêt')) {
                $color = self::COLOR_READY;
            }
            $insert = $Db->prepare('INSERT INTO items_status (title, color, team) VALUES (:title, :color, :team)');
            $insert->bindParam(':title', $value);
            $insert->bindParam(':color', $color);
            $insert->bindParam(':team', $team, PDO::PARAM_INT);
            $Db->execute($insert);
            $statusId = $Db->lastInsertId();
        }
        if ((int) $instrument['status'] === (int) $statusId) {
            return;
        }
        // the person writing the log usually can't edit the instrument: bypass, the change is in the changelog
        $Items = new Items($actor, (int) $instrument['id'], bypassReadPermission: true, bypassWritePermission: true);
        $Items->patch(Action::Update, array('status' => (string) $statusId));
    }

    // stewards picked in a "users" extra field of the instrument (name containing "steward"), else the team admins
    private static function getRecipients(array $instrument): array
    {
        $ids = array();
        foreach (self::extraFields($instrument['metadata']) as $name => $field) {
            if (!is_array($field) || ($field['type'] ?? '') !== 'users' || !str_contains(mb_strtolower((string) $name), 'steward')) {
                continue;
            }
            $values = is_array($field['value'] ?? null) ? $field['value'] : array($field['value'] ?? '');
            foreach ($values as $value) {
                if (is_int($value) || (is_string($value) && is_numeric(trim($value)))) {
                    $ids[] = (int) $value;
                }
            }
        }
        $ids = array_values(array_unique(array_filter($ids, fn(int $id): bool => $id > 0)));
        if ($ids !== array()) {
            return $ids;
        }
        $Db = Db::getConnection();
        $req = $Db->prepare('SELECT users2teams.users_id FROM users2teams
            INNER JOIN users ON (users.userid = users2teams.users_id)
            WHERE users2teams.teams_id = :team AND users2teams.is_admin = 1 AND users2teams.is_archived = 0 AND users.validated = 1');
        $team = (int) $instrument['team'];
        $req->bindParam(':team', $team, PDO::PARAM_INT);
        $Db->execute($req);
        return array_map('intval', $req->fetchAll(PDO::FETCH_COLUMN));
    }
}

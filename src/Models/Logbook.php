<?php

/**
 * @copyright 2026 HES-SO Valais-Wallis
 * @see https://www.elabftw.net Official website
 * @license AGPL-3.0
 * @package elabftw
 */

declare(strict_types=1);

namespace Elabftw\Models;

use Elabftw\Enums\AccessType;
use Elabftw\Enums\EntityType;
use Elabftw\Enums\State;
use Elabftw\Exceptions\ImproperActionException;
use Elabftw\Interfaces\QueryParamsInterface;
use Exception;
use Override;
use PDO;

use function in_array;
use function is_array;
use function is_string;
use function json_decode;
use function mb_strtolower;
use function sprintf;
use function strtolower;
use function trim;

/**
 * Instrument logbook status of an experiment (read only)
 * An instrument (resource) needs a logbook entry when its "Logbook required" checkbox extra field is on.
 * A logbook entry is an experiment created from an experiment template linked to that instrument,
 * it links to the instrument (inherited from the template) and to the experiment it documents.
 */
final class Logbook extends AbstractRest
{
    // name of the checkbox extra field on the instrument, compared case-insensitively
    private const string REQUIRED_FIELD = 'logbook required';

    public function __construct(public AbstractEntity $Entity, ?int $id = null)
    {
        parent::__construct();
    }

    #[Override]
    public function getApiPath(): string
    {
        return sprintf('%s%d/logbook/', $this->Entity->getApiPath(), $this->Entity->id ?? 0);
    }

    #[Override]
    public function readOne(): array
    {
        return $this->readAll();
    }

    #[Override]
    public function readAll(?QueryParamsInterface $queryParams = null): array
    {
        if ($this->Entity->entityType !== EntityType::Experiments) {
            throw new ImproperActionException('The logbook is only available for experiments.');
        }
        $this->Entity->canOrExplode(AccessType::Read);

        // a logbook entry itself links to the instrument: it never needs a logbook entry
        $createdFromId = $this->Entity->entityData['created_from_id'] ?? null;
        if (($this->Entity->entityData['created_from_type'] ?? null) === EntityType::Templates->toInt()
            && $createdFromId !== null
            && $this->isLogbookTemplate((int) $createdFromId)
        ) {
            return array('is_logbook_entry' => true, 'instruments' => array());
        }

        $instruments = array();
        foreach ($this->getLinkedInstruments() as $instrument) {
            $instruments[] = array(
                'id' => (int) $instrument['id'],
                'title' => $instrument['title'],
                'templates' => $this->getTemplates((int) $instrument['id']),
                'entries' => $this->getEntries((int) $instrument['id']),
            );
        }
        return array('is_logbook_entry' => false, 'instruments' => $instruments);
    }

    // linked resources of this experiment with the "Logbook required" checkbox on
    private function getLinkedInstruments(): array
    {
        $sql = 'SELECT items.id, items.title, items.metadata
            FROM experiments2items
            LEFT JOIN items ON (items.id = experiments2items.link_id)
            WHERE experiments2items.item_id = :id AND items.state = :state AND items.metadata IS NOT NULL';
        $req = $this->Db->prepare($sql);
        $req->bindParam(':id', $this->Entity->id, PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $this->Db->execute($req);
        $res = array();
        foreach ($req->fetchAll() as $row) {
            if (self::isLogbookRequired($row['metadata'])) {
                $res[] = $row;
            }
        }
        return $res;
    }

    private static function isLogbookRequired(?string $metadata): bool
    {
        $decoded = json_decode($metadata ?? '', true);
        if (!is_array($decoded) || !is_array($decoded['extra_fields'] ?? null)) {
            return false;
        }
        foreach ($decoded['extra_fields'] as $name => $field) {
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

    // experiment templates linked to the instrument that the user can read
    private function getTemplates(int $instrumentId): array
    {
        $sql = 'SELECT experiments_templates.id
            FROM experiments_templates2items
            LEFT JOIN experiments_templates ON (experiments_templates.id = experiments_templates2items.item_id)
            WHERE experiments_templates2items.link_id = :instrument AND experiments_templates.state = :state
            ORDER BY experiments_templates.title';
        $req = $this->Db->prepare($sql);
        $req->bindParam(':instrument', $instrumentId, PDO::PARAM_INT);
        $req->bindValue(':state', State::Normal->value, PDO::PARAM_INT);
        $this->Db->execute($req);
        $res = array();
        foreach ($req->fetchAll(PDO::FETCH_COLUMN) as $id) {
            try {
                $template = new Templates($this->Entity->Users, (int) $id)->readOne();
            } catch (Exception) {
                continue;
            }
            $res[] = array(
                'id' => (int) $template['id'],
                'title' => $template['title'],
                'body' => $template['body'] ?? '',
                'content_type' => (int) ($template['content_type'] ?? 1),
                'metadata' => $template['metadata'] ?? null,
            );
        }
        return $res;
    }

    private function isLogbookTemplate(int $templateId): bool
    {
        $sql = 'SELECT items.metadata
            FROM experiments_templates2items
            LEFT JOIN items ON (items.id = experiments_templates2items.link_id)
            WHERE experiments_templates2items.item_id = :id';
        $req = $this->Db->prepare($sql);
        $req->bindParam(':id', $templateId, PDO::PARAM_INT);
        $this->Db->execute($req);
        foreach ($req->fetchAll(PDO::FETCH_COLUMN) as $metadata) {
            if (self::isLogbookRequired($metadata)) {
                return true;
            }
        }
        return false;
    }

    // experiments linked to the instrument that link to this experiment, readable by the user
    private function getEntries(int $instrumentId): array
    {
        $sql = 'SELECT DISTINCT e2e.item_id
            FROM experiments2experiments AS e2e
            INNER JOIN experiments2items AS e2i ON (e2i.item_id = e2e.item_id AND e2i.link_id = :instrument)
            INNER JOIN experiments ON (experiments.id = e2e.item_id)
            WHERE e2e.link_id = :id AND experiments.state IN (:normal, :archived)
            ORDER BY e2e.item_id DESC';
        $req = $this->Db->prepare($sql);
        $req->bindParam(':instrument', $instrumentId, PDO::PARAM_INT);
        $req->bindParam(':id', $this->Entity->id, PDO::PARAM_INT);
        $req->bindValue(':normal', State::Normal->value, PDO::PARAM_INT);
        $req->bindValue(':archived', State::Archived->value, PDO::PARAM_INT);
        $this->Db->execute($req);
        $res = array();
        foreach ($req->fetchAll(PDO::FETCH_COLUMN) as $id) {
            try {
                $entry = new Experiments($this->Entity->Users, (int) $id)->readOne();
            } catch (Exception) {
                continue;
            }
            $res[] = array(
                'id' => (int) $entry['id'],
                'title' => $entry['title'],
                'created_at' => $entry['created_at'] ?? null,
                'fullname' => $entry['fullname'] ?? null,
            );
        }
        return $res;
    }
}

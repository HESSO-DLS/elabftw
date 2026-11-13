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
use Elabftw\Params\DisplayParams;
use Elabftw\Services\LogbookRules;
use Exception;
use Override;
use PDO;
use Symfony\Component\HttpFoundation\InputBag;

use function array_column;
use function array_filter;
use function array_map;
use function array_values;
use function implode;
use function in_array;
use function is_array;
use function sprintf;
use function trim;
use function uasort;

/**
 * Instrument logbook (read only), see Services/LogbookRules.php
 * - experiments: the linked instruments that need a logbook and the entries for this experiment
 * - items: the logbook of the instrument, all entries readable by the user
 */
final class Logbook extends AbstractRest
{
    // entries shown in the logbook of an instrument
    private const int MAX_ENTRIES = 500;

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
        $this->Entity->canOrExplode(AccessType::Read);
        return match ($this->Entity->entityType) {
            EntityType::Experiments => $this->readForExperiment(),
            EntityType::Items => $this->readForInstrument(),
            default => throw new ImproperActionException('The logbook is only available for experiments and resources.'),
        };
    }

    private function readForExperiment(): array
    {
        // a logbook entry itself links to the instrument: it never needs a logbook entry
        $createdFromId = $this->Entity->entityData['created_from_id'] ?? null;
        if (($this->Entity->entityData['created_from_type'] ?? null) === EntityType::Templates->toInt()
            && $createdFromId !== null
            && LogbookRules::isLogbookTemplate((int) $createdFromId)
        ) {
            return array('is_logbook_entry' => true, 'instruments' => array());
        }

        $instruments = array();
        foreach ($this->getLinkedInstruments() as $instrument) {
            $instruments[] = array(
                'id' => (int) $instrument['id'],
                'title' => $instrument['title'],
                'templates' => $this->getTemplates((int) $instrument['id']),
                'entries' => $this->getEntriesOfExperiment((int) $instrument['id']),
            );
        }
        return array('is_logbook_entry' => false, 'instruments' => $instruments);
    }

    private function readForInstrument(): array
    {
        $instrumentId = (int) $this->Entity->id;
        if (!LogbookRules::isLogbookRequired($this->Entity->entityData['metadata'] ?? null)) {
            return array('required' => false, 'templates' => array(), 'fields' => array(), 'entries' => array(), 'latest_status' => null);
        }
        $templates = $this->getTemplates($instrumentId);
        $entries = $this->getEntriesOfInstrument($instrumentId);
        $latest = null;
        foreach ($entries as $entry) {
            if ($entry['status'] !== null && $entry['status']['value'] !== '') {
                $latest = array(
                    'value' => $entry['status']['value'],
                    'ready' => $entry['status']['ready'],
                    'entry_id' => $entry['id'],
                    'fullname' => $entry['fullname'],
                    'created_at' => $entry['created_at'],
                );
                break;
            }
        }
        return array(
            'required' => true,
            'templates' => array_map(fn(array $t): array => array('id' => $t['id'], 'title' => $t['title']), $templates),
            'fields' => $this->getColumns($templates),
            'entries' => $entries,
            'latest_status' => $latest,
        );
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
        return array_values(array_filter($req->fetchAll(), fn(array $row): bool => LogbookRules::isLogbookRequired($row['metadata'])));
    }

    // experiment templates linked to the instrument that the user can read
    private function getTemplates(int $instrumentId): array
    {
        $res = array();
        foreach (LogbookRules::getTemplateIds($instrumentId) as $id) {
            try {
                $template = new Templates($this->Entity->Users, $id)->readOne();
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

    // columns of the logbook table: the template fields, in the order of the form
    private function getColumns(array $templates): array
    {
        $columns = array();
        foreach ($templates as $template) {
            $fields = LogbookRules::extraFields($template['metadata']);
            uasort($fields, fn($a, $b): int => (int) ($a['position'] ?? 0) <=> (int) ($b['position'] ?? 0));
            foreach ($fields as $name => $field) {
                if (!is_array($field) || in_array((string) $name, array_column($columns, 'name'), true)) {
                    continue;
                }
                $columns[] = array('name' => (string) $name, 'type' => $field['type'] ?? 'text');
            }
        }
        return $columns;
    }

    // experiments linked to the instrument that link to this experiment, readable by the user
    private function getEntriesOfExperiment(int $instrumentId): array
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

    // logbook entries of the instrument readable by the user, newest first
    private function getEntriesOfInstrument(int $instrumentId): array
    {
        $templateIds = LogbookRules::getTemplateIds($instrumentId);
        if ($templateIds === array()) {
            return array();
        }
        // the usual list query applies the read permissions: experiments linked to the instrument, all scopes
        $DisplayParams = new DisplayParams(
            requester: $this->Entity->Users,
            entityType: EntityType::Experiments,
            query: new InputBag(array(
                'related' => (string) $instrumentId,
                'related_origin' => EntityType::Items->value,
                'scope' => '3',
                'limit' => (string) self::MAX_ENTRIES,
            )),
            limit: self::MAX_ENTRIES,
            states: array(State::Normal, State::Archived),
        );
        $readable = array_map('intval', array_column(
            new Experiments($this->Entity->Users)->readShow($DisplayParams),
            'id',
        ));
        if ($readable === array()) {
            return array();
        }
        $sql = sprintf('SELECT experiments.id, experiments.title, experiments.created_at, experiments.metadata,
                CONCAT(users.firstname, " ", users.lastname) AS fullname, experiments.userid
            FROM experiments
            LEFT JOIN users ON (users.userid = experiments.userid)
            WHERE experiments.id IN (%s) AND experiments.created_from_type = :type AND experiments.created_from_id IN (%s)
            ORDER BY experiments.created_at DESC, experiments.id DESC',
            implode(',', $readable),
            implode(',', $templateIds),
        );
        $req = $this->Db->prepare($sql);
        $req->bindValue(':type', EntityType::Templates->toInt(), PDO::PARAM_INT);
        $this->Db->execute($req);
        $rows = $req->fetchAll();

        // titles of the experiments documented by the entries, if readable
        $linkedIds = array();
        foreach ($rows as $row) {
            foreach (LogbookRules::extraFields($row['metadata']) as $field) {
                if (is_array($field) && ($field['type'] ?? '') === 'experiments') {
                    foreach ((array) ($field['value'] ?? array()) as $value) {
                        if ((int) $value > 0) {
                            $linkedIds[(int) $value] = true;
                        }
                    }
                }
            }
        }
        $linkedTitles = $this->getReadableTitles(array_keys($linkedIds));

        $entries = array();
        foreach ($rows as $row) {
            $values = array();
            $linked = array();
            foreach (LogbookRules::extraFields($row['metadata']) as $name => $field) {
                if (!is_array($field)) {
                    continue;
                }
                $value = $field['value'] ?? '';
                if (($field['type'] ?? '') === 'experiments') {
                    foreach ((array) $value as $id) {
                        if (isset($linkedTitles[(int) $id])) {
                            $linked[] = array('id' => (int) $id, 'title' => $linkedTitles[(int) $id]);
                        }
                    }
                    continue;
                }
                $value = is_array($value) ? implode(', ', $value) : trim((string) $value);
                if ($value !== '' && !empty($field['unit'])) {
                    $value .= ' ' . $field['unit'];
                }
                $values[(string) $name] = $value;
            }
            $entries[] = array(
                'id' => (int) $row['id'],
                'title' => $row['title'],
                'created_at' => $row['created_at'],
                'fullname' => $row['fullname'],
                'userid' => (int) $row['userid'],
                'linked' => $linked,
                'status' => LogbookRules::getStatus($row['metadata']),
                'values' => $values,
            );
        }
        return $entries;
    }

    // id => title of the experiments the user can read
    private function getReadableTitles(array $ids): array
    {
        $titles = array();
        foreach ($ids as $id) {
            try {
                $Experiments = new Experiments($this->Entity->Users, (int) $id);
                $Experiments->canOrExplode(AccessType::Read);
                $titles[(int) $id] = $Experiments->entityData['title'] ?? ('#' . $id);
            } catch (Exception) {
                continue;
            }
        }
        return $titles;
    }
}

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
use Elabftw\Enums\Action;
use Elabftw\Exceptions\ImproperActionException;
use Elabftw\Interfaces\QueryParamsInterface;
use Override;
use PDO;

use function base64_decode;
use function base64_encode;
use function is_array;
use function is_string;
use function json_decode;
use function sprintf;
use function str_starts_with;
use function strlen;
use function substr;

/**
 * One whiteboard (Excalidraw scene) per entity, stored in {entity_type}_whiteboard (see sql/fork/whiteboard.sql)
 * It is autosaved by the frontend, so it doesn't go through the changelog
 */
final class Whiteboard extends AbstractRest
{
    // mediumblob limit
    private const int MAX_PREVIEW_BYTES = 16_777_215;

    private const string PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

    private const string PNG_MAGIC = "\x89PNG\r\n\x1a\n";

    public function __construct(public AbstractEntity $Entity, ?int $id = null)
    {
        parent::__construct();
    }

    #[Override]
    public function getApiPath(): string
    {
        return sprintf('%s%d/whiteboard/', $this->Entity->getApiPath(), $this->Entity->id ?? 0);
    }

    /**
     * The scene without the preview, an empty content means no whiteboard yet
     */
    #[Override]
    public function readAll(?QueryParamsInterface $queryParams = null): array
    {
        $this->Entity->canOrExplode(AccessType::Read);
        $sql = sprintf('SELECT content, userid, modified_at FROM %s WHERE item_id = :item_id', $this->getTable());
        $req = $this->Db->prepare($sql);
        $req->bindParam(':item_id', $this->Entity->id, PDO::PARAM_INT);
        $this->Db->execute($req);
        $res = $req->fetch();
        if (!is_array($res)) {
            return array('content' => '', 'userid' => null, 'modified_at' => null);
        }
        return $res;
    }

    #[Override]
    public function readOne(): array
    {
        return $this->readAll();
    }

    /**
     * Save the scene: params are content (scene json), preview (png data url) and base_modified_at
     * (modified_at of the version the client started from, to detect concurrent edits)
     */
    #[Override]
    public function patch(Action $action, array $params): array
    {
        if ($action !== Action::Update) {
            throw new ImproperActionException('Invalid action for whiteboard.');
        }
        $this->Entity->canOrExplode(AccessType::Write);
        $content = $this->getValidContent($params['content'] ?? null);
        $preview = $this->getValidPreview($params['preview'] ?? null);
        $this->checkNoConcurrentEdit($params['base_modified_at'] ?? null);

        $sql = sprintf(
            'INSERT INTO %s (item_id, content, preview, userid) VALUES (:item_id, :content, :preview, :userid)
            ON DUPLICATE KEY UPDATE content = VALUES(content), preview = VALUES(preview), userid = VALUES(userid)',
            $this->getTable(),
        );
        $req = $this->Db->prepare($sql);
        $req->bindParam(':item_id', $this->Entity->id, PDO::PARAM_INT);
        $req->bindParam(':content', $content);
        $req->bindParam(':preview', $preview, PDO::PARAM_LOB);
        $req->bindParam(':userid', $this->Entity->Users->requester->userid, PDO::PARAM_INT);
        $this->Db->execute($req);
        $this->Entity->touch();
        return $this->readAll();
    }

    /**
     * Copy the whiteboard to another entity (duplicate, create from template)
     */
    public function duplicate(AbstractEntity $targetEntity, int $id, int $newId): void
    {
        $sql = sprintf(
            'INSERT INTO %s_whiteboard (item_id, content, preview, userid)
            SELECT :new_id, content, preview, userid FROM %s WHERE item_id = :id',
            $targetEntity->entityType->value,
            $this->getTable(),
        );
        $req = $this->Db->prepare($sql);
        $req->bindParam(':new_id', $newId, PDO::PARAM_INT);
        $req->bindParam(':id', $id, PDO::PARAM_INT);
        $this->Db->execute($req);
    }

    /**
     * The png preview as base64, for the pdf export. Read permission is checked by the export.
     */
    public function getPreviewBase64(): ?string
    {
        $sql = sprintf('SELECT preview FROM %s WHERE item_id = :item_id', $this->getTable());
        $req = $this->Db->prepare($sql);
        $req->bindParam(':item_id', $this->Entity->id, PDO::PARAM_INT);
        $this->Db->execute($req);
        $preview = $req->fetchColumn();
        if (!is_string($preview) || $preview === '') {
            return null;
        }
        return base64_encode($preview);
    }

    private function getTable(): string
    {
        return $this->Entity->entityType->value . '_whiteboard';
    }

    private function getValidContent(mixed $content): string
    {
        if (!is_string($content) || $content === '') {
            throw new ImproperActionException('Missing whiteboard content.');
        }
        $scene = json_decode($content, true);
        if (!is_array($scene) || ($scene['type'] ?? null) !== 'excalidraw' || !is_array($scene['elements'] ?? null)) {
            throw new ImproperActionException('Whiteboard content is not a valid Excalidraw scene.');
        }
        return $content;
    }

    private function getValidPreview(mixed $preview): ?string
    {
        if ($preview === null || $preview === '') {
            return null;
        }
        if (!is_string($preview) || !str_starts_with($preview, self::PNG_DATA_URL_PREFIX)) {
            throw new ImproperActionException('Whiteboard preview must be a png data url.');
        }
        $binary = base64_decode(substr($preview, strlen(self::PNG_DATA_URL_PREFIX)), true);
        if ($binary === false || !str_starts_with($binary, self::PNG_MAGIC)) {
            throw new ImproperActionException('Whiteboard preview is not a valid png image.');
        }
        if (strlen($binary) > self::MAX_PREVIEW_BYTES) {
            throw new ImproperActionException('Whiteboard preview is too large.');
        }
        return $binary;
    }

    /**
     * Refuse to overwrite a version saved by someone else after the client loaded the whiteboard
     */
    private function checkNoConcurrentEdit(mixed $baseModifiedAt): void
    {
        $current = $this->readAll();
        if ($current['modified_at'] === null || (int) $current['userid'] === (int) $this->Entity->Users->requester->userid) {
            return;
        }
        if (!is_string($baseModifiedAt) || $baseModifiedAt < $current['modified_at']) {
            throw new ImproperActionException('The whiteboard was changed by someone else in the meantime. Reload the page to get the latest version.');
        }
    }
}

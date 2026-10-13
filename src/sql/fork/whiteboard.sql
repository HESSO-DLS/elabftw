-- fork (HESSO-DLS): one whiteboard (Excalidraw scene) per entity
-- not part of the upstream schema numbering: run on every "bin/console db:update", so it must stay idempotent
CREATE TABLE IF NOT EXISTS `experiments_whiteboard` (
    `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
    `item_id` int(10) unsigned NOT NULL,
    `content` longtext NOT NULL,
    `preview` mediumblob DEFAULT NULL,
    `userid` int(10) unsigned DEFAULT NULL,
    `modified_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_experiments_whiteboard_item_id` (`item_id`),
    CONSTRAINT `fk_experiments_whiteboard_experiments_id` FOREIGN KEY (`item_id`) REFERENCES `experiments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `items_whiteboard` (
    `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
    `item_id` int(10) unsigned NOT NULL,
    `content` longtext NOT NULL,
    `preview` mediumblob DEFAULT NULL,
    `userid` int(10) unsigned DEFAULT NULL,
    `modified_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_items_whiteboard_item_id` (`item_id`),
    CONSTRAINT `fk_items_whiteboard_items_id` FOREIGN KEY (`item_id`) REFERENCES `items` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `experiments_templates_whiteboard` (
    `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
    `item_id` int(10) unsigned NOT NULL,
    `content` longtext NOT NULL,
    `preview` mediumblob DEFAULT NULL,
    `userid` int(10) unsigned DEFAULT NULL,
    `modified_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_experiments_templates_whiteboard_item_id` (`item_id`),
    CONSTRAINT `fk_experiments_templates_whiteboard_experiments_templates_id` FOREIGN KEY (`item_id`) REFERENCES `experiments_templates` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS `items_types_whiteboard` (
    `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
    `item_id` int(10) unsigned NOT NULL,
    `content` longtext NOT NULL,
    `preview` mediumblob DEFAULT NULL,
    `userid` int(10) unsigned DEFAULT NULL,
    `modified_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_items_types_whiteboard_item_id` (`item_id`),
    CONSTRAINT `fk_items_types_whiteboard_items_types_id` FOREIGN KEY (`item_id`) REFERENCES `items_types` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_0900_ai_ci;

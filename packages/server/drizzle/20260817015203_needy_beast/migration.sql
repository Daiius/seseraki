CREATE TABLE `video_kifu_sources` (
	`kifuId` bigint unsigned PRIMARY KEY,
	`videoId` varchar(32) NOT NULL,
	`gameIndex` int NOT NULL,
	`startedAtSec` int NOT NULL,
	`endedAtSec` int NOT NULL,
	`bottomIsSente` boolean NOT NULL,
	`extractorRev` varchar(40) NOT NULL,
	`raw` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_kifu_sources_video_id_game_index_uq` UNIQUE INDEX(`videoId`,`gameIndex`),
	CONSTRAINT `video_kifu_sources_kifuId_kifus_id_fkey` FOREIGN KEY (`kifuId`) REFERENCES `kifus`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `kifus` ADD `source` enum('manual','swars','video') DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX `kifus_source_idx` ON `kifus` (`source`);
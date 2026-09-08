CREATE TABLE `drill_attempts` (
	`id` serial PRIMARY KEY,
	`drillId` bigint unsigned NOT NULL,
	`move` varchar(16),
	`verdict` enum('correct','close','wrong'),
	`lossCp` int,
	`excluded` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now())
);
--> statement-breakpoint
CREATE TABLE `drills` (
	`id` serial PRIMARY KEY,
	`kifuId` bigint unsigned NOT NULL,
	`moveNumber` int NOT NULL,
	`kind` enum('mate','best') NOT NULL,
	`reason` enum('missed_mate','own_blunder') NOT NULL,
	`answerMove` varchar(16) NOT NULL,
	`answerScoreType` varchar(16) NOT NULL,
	`answerScoreValue` int NOT NULL,
	`answerPv` json,
	`candidates` json NOT NULL,
	`matePlies` int,
	`playedMove` varchar(16),
	`playedLossCp` int,
	`analysisRevision` int NOT NULL,
	`blunderCp` int NOT NULL,
	`mateMaxPlies` int NOT NULL,
	`generatorRev` varchar(16) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drills_kifu_id_move_number_kind_uq` UNIQUE INDEX(`kifuId`,`moveNumber`,`kind`)
);
--> statement-breakpoint
CREATE INDEX `drill_attempts_drill_id_idx` ON `drill_attempts` (`drillId`);--> statement-breakpoint
CREATE INDEX `drills_kind_idx` ON `drills` (`kind`);--> statement-breakpoint
ALTER TABLE `drill_attempts` ADD CONSTRAINT `drill_attempts_drillId_drills_id_fkey` FOREIGN KEY (`drillId`) REFERENCES `drills`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `drills` ADD CONSTRAINT `drills_kifuId_kifus_id_fkey` FOREIGN KEY (`kifuId`) REFERENCES `kifus`(`id`) ON DELETE CASCADE;
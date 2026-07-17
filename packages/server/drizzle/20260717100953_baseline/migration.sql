CREATE TABLE `candidate_moves` (
	`id` serial PRIMARY KEY,
	`moveAnalysisId` bigint unsigned NOT NULL,
	`rank` int NOT NULL,
	`move` varchar(255) NOT NULL,
	`scoreType` varchar(16) NOT NULL,
	`scoreValue` int NOT NULL,
	`pv` json,
	`depth` int NOT NULL,
	CONSTRAINT `candidate_moves_move_analysis_id_rank_uq` UNIQUE INDEX(`moveAnalysisId`,`rank`)
);
--> statement-breakpoint
CREATE TABLE `kifus` (
	`id` serial PRIMARY KEY,
	`title` varchar(255) NOT NULL,
	`kifText` text NOT NULL,
	`usiMoves` json,
	`sente` varchar(100),
	`gote` varchar(100),
	`senteDan` smallint,
	`goteDan` smallint,
	`result` varchar(50),
	`swarsGameKey` varchar(255),
	`playedAt` timestamp,
	`analysisCompletedAt` timestamp,
	`memo` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `swarsGameKey_unique` UNIQUE INDEX(`swarsGameKey`)
);
--> statement-breakpoint
CREATE TABLE `move_analyses` (
	`id` serial PRIMARY KEY,
	`kifuId` bigint unsigned NOT NULL,
	`moveNumber` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `move_analyses_kifu_id_move_number_uq` UNIQUE INDEX(`kifuId`,`moveNumber`)
);
--> statement-breakpoint
CREATE INDEX `kifus_analysis_completed_at_idx` ON `kifus` (`analysisCompletedAt`);--> statement-breakpoint
ALTER TABLE `candidate_moves` ADD CONSTRAINT `candidate_moves_moveAnalysisId_move_analyses_id_fkey` FOREIGN KEY (`moveAnalysisId`) REFERENCES `move_analyses`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `move_analyses` ADD CONSTRAINT `move_analyses_kifuId_kifus_id_fkey` FOREIGN KEY (`kifuId`) REFERENCES `kifus`(`id`) ON DELETE CASCADE;
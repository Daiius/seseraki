CREATE TABLE `kifu_positions` (
	`kifuId` bigint unsigned NOT NULL,
	`moveNumber` int NOT NULL,
	`move` varchar(8),
	`sfen` varchar(200) NOT NULL,
	`senteSfen` varchar(200) NOT NULL,
	`goteSfen` varchar(200) NOT NULL,
	`board` binary(81) NOT NULL,
	`hands` binary(14) NOT NULL,
	`sideToMove` enum('b','w') NOT NULL,
	CONSTRAINT PRIMARY KEY(`kifuId`,`moveNumber`),
	CONSTRAINT `kifu_positions_kifuId_kifus_id_fkey` FOREIGN KEY (`kifuId`) REFERENCES `kifus`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `kifu_positions_sfen_idx` ON `kifu_positions` (`sfen`);--> statement-breakpoint
CREATE INDEX `kifu_positions_sente_sfen_idx` ON `kifu_positions` (`senteSfen`);--> statement-breakpoint
CREATE INDEX `kifu_positions_gote_sfen_idx` ON `kifu_positions` (`goteSfen`);
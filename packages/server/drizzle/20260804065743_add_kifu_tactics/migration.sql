CREATE TABLE `kifu_tactics` (
	`kifuId` bigint unsigned NOT NULL,
	`side` enum('sente','gote','both') NOT NULL,
	`label` varchar(32) NOT NULL,
	`turn` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`kifuId`,`side`,`label`),
	CONSTRAINT `kifu_tactics_kifuId_kifus_id_fkey` FOREIGN KEY (`kifuId`) REFERENCES `kifus`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `kifu_tactics_label_idx` ON `kifu_tactics` (`label`);
CREATE TABLE `users` (
	`id` serial PRIMARY KEY,
	`displayName` varchar(100) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `user_aliases` (
	`id` serial PRIMARY KEY,
	`userId` bigint unsigned NOT NULL,
	`name` varchar(100) COLLATE utf8mb4_bin NOT NULL,
	`validFrom` date,
	`validTo` date,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_aliases_name_uq` UNIQUE INDEX(`name`)
);
--> statement-breakpoint
ALTER TABLE `user_aliases` ADD CONSTRAINT `user_aliases_userId_users_id_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO `users` (`displayName`) SELECT '(未設定)' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `users`);--> statement-breakpoint
ALTER TABLE `kifus` ADD `ownerId` bigint unsigned NULL;--> statement-breakpoint
ALTER TABLE `kifus` ADD CONSTRAINT `kifus_ownerId_users_id_fkey` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`);--> statement-breakpoint
UPDATE `kifus` SET `ownerId` = (SELECT `id` FROM `users` ORDER BY `id` LIMIT 1) WHERE `ownerId` IS NULL;--> statement-breakpoint
ALTER TABLE `kifus` MODIFY `ownerId` bigint unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `kifus` ADD `subjectSide` enum('sente','gote');

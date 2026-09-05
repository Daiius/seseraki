ALTER TABLE `kifus` ADD `analysisProfile` enum('quick','full');--> statement-breakpoint
UPDATE `kifus` SET `analysisProfile` = 'full' WHERE `analysisCompletedAt` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `move_analyses` ADD `profile` enum('quick','full') NULL;--> statement-breakpoint
UPDATE `move_analyses` SET `profile` = 'full' WHERE `profile` IS NULL;--> statement-breakpoint
ALTER TABLE `move_analyses` MODIFY `profile` enum('quick','full') NOT NULL;--> statement-breakpoint
ALTER TABLE `move_analyses` ADD `engineName` varchar(255);--> statement-breakpoint
ALTER TABLE `move_analyses` ADD `movetimeMs` int;--> statement-breakpoint
ALTER TABLE `move_analyses` ADD `targetDepth` int;--> statement-breakpoint
ALTER TABLE `move_analyses` ADD `multiPv` int;

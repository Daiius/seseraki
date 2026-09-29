DELETE FROM `kifu_positions`;--> statement-breakpoint
DROP INDEX `kifu_positions_sfen_idx` ON `kifu_positions`;--> statement-breakpoint
DROP INDEX `kifu_positions_sente_sfen_idx` ON `kifu_positions`;--> statement-breakpoint
DROP INDEX `kifu_positions_gote_sfen_idx` ON `kifu_positions`;--> statement-breakpoint
ALTER TABLE `kifu_positions` DROP COLUMN `sfen`;--> statement-breakpoint
ALTER TABLE `kifu_positions` DROP COLUMN `senteSfen`;--> statement-breakpoint
ALTER TABLE `kifu_positions` DROP COLUMN `goteSfen`;--> statement-breakpoint
ALTER TABLE `kifu_positions` ADD `sfenHash` binary(8) NOT NULL;--> statement-breakpoint
ALTER TABLE `kifu_positions` ADD `senteSfenHash` binary(8) NOT NULL;--> statement-breakpoint
ALTER TABLE `kifu_positions` ADD `goteSfenHash` binary(8) NOT NULL;--> statement-breakpoint
CREATE INDEX `kifu_positions_sfen_hash_idx` ON `kifu_positions` (`sfenHash`);--> statement-breakpoint
CREATE INDEX `kifu_positions_sente_sfen_hash_idx` ON `kifu_positions` (`senteSfenHash`);--> statement-breakpoint
CREATE INDEX `kifu_positions_gote_sfen_hash_idx` ON `kifu_positions` (`goteSfenHash`);
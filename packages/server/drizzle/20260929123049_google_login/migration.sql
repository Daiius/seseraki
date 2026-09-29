-- Google ログイン（Better Auth）への切り替え（prd/07 §3.2）。
-- ⚠ drizzle-kit の生成を土台に**手で書き直してある**。生成物のままでは
--   (a) users.id を参照する FK を外さずに型を変えようとして落ちる
--   (b) 既存の所有者の行に name / email が無く NOT NULL・UNIQUE が成り立たない
--   (c) session.token / verification.identifier が既定の照合順序（大文字小文字を区別しない）になる
-- 🔒 既存の行の ID は '1' のまま（bigint の 1 が varchar の '1' になる）。kifus.ownerId・user_aliases.userId の値も書き換えない。
-- 🔒 kifus.ownerId の FK は CASCADE にしない（prd/14 §3.1）。

-- 1. users を参照する FK を外す
ALTER TABLE `user_aliases` DROP FOREIGN KEY `user_aliases_userId_users_id_fkey`;--> statement-breakpoint
ALTER TABLE `kifus` DROP FOREIGN KEY `kifus_ownerId_users_id_fkey`;--> statement-breakpoint
-- 2. users.id を varchar(36) に（AUTO_INCREMENT も外れる）
ALTER TABLE `users` MODIFY COLUMN `id` varchar(36) NOT NULL;--> statement-breakpoint
-- 3. 参照する列も varchar(36) に（値は '1' のまま）
ALTER TABLE `user_aliases` MODIFY COLUMN `userId` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `kifus` MODIFY COLUMN `ownerId` varchar(36) NOT NULL;--> statement-breakpoint
-- 4. Better Auth の列を足し、既存の行を埋めてから NOT NULL・UNIQUE にする（データ投入の例外。prd/07 §3.2）
--    🔴 email は予約ドメインの仮アドレス。所有者の本物の Gmail を先に入れてはいけない（prd/07 §3.1）
ALTER TABLE `users` ADD `name` varchar(255) NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email` varchar(255) NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `emailVerified` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `image` text;--> statement-breakpoint
UPDATE `users` SET `name` = `displayName`, `email` = CONCAT('owner-', `id`, '@example.invalid') WHERE `email` IS NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `name` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `email` varchar(255) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `email_unique` ON `users` (`email`);--> statement-breakpoint
-- 5. FK を張り直す（user_aliases は CASCADE・kifus は CASCADE にしない）
ALTER TABLE `user_aliases` ADD CONSTRAINT `user_aliases_userId_users_id_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `kifus` ADD CONSTRAINT `kifus_ownerId_users_id_fkey` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`);--> statement-breakpoint
-- 6. Better Auth の表を作る
CREATE TABLE `session` (
	`id` varchar(36) PRIMARY KEY,
	`token` varchar(255) COLLATE utf8mb4_bin NOT NULL,
	`userId` varchar(36) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `session_token_uq` UNIQUE INDEX(`token`)
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` varchar(36) PRIMARY KEY,
	`userId` varchar(36) NOT NULL,
	`providerId` varchar(64) NOT NULL,
	`accountId` varchar(255) NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` timestamp,
	`refreshTokenExpiresAt` timestamp,
	`scope` text,
	`password` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `account_provider_account_uq` UNIQUE INDEX(`providerId`,`accountId`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(36) PRIMARY KEY,
	`identifier` varchar(255) COLLATE utf8mb4_bin NOT NULL,
	`value` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
-- 🔴 CASCADE を必ず付ける（drizzle-kit は新規テーブルの FK から落とすことがある。適用後に show create table で確かめる）
ALTER TABLE `account` ADD CONSTRAINT `account_userId_users_id_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_userId_users_id_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE;

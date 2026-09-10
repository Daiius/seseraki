CREATE TABLE `maintenance_marks` (
	`markKey` varchar(64) PRIMARY KEY,
	`appliedAt` timestamp NOT NULL DEFAULT (now()),
	`note` text
);

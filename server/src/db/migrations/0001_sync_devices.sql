CREATE TABLE `sync_devices` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`device_id` TEXT NOT NULL,
	`device_name` TEXT,
	`last_sync_at` TEXT NOT NULL,
	`last_synced_server_updated_at` TEXT,
	`last_sync_completed` INTEGER NOT NULL DEFAULT 0,
	`last_pushed_count` INTEGER NOT NULL DEFAULT 0,
	`last_pulled_count` INTEGER NOT NULL DEFAULT 0,
	`clock_skew_warning` INTEGER NOT NULL DEFAULT 0,
	`updated_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_devices_user_device` ON `sync_devices` (`user_id`, `device_id`);
--> statement-breakpoint
CREATE INDEX `idx_sync_devices_user_last_sync` ON `sync_devices` (`user_id`, `last_sync_at`);

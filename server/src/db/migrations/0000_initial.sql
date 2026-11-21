CREATE TABLE `users` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`username` TEXT NOT NULL UNIQUE COLLATE NOCASE,
	`display_name` TEXT,
	`email` TEXT UNIQUE COLLATE NOCASE,
	`password_hash` TEXT NOT NULL,
	`role` TEXT NOT NULL DEFAULT 'user' CHECK (`role` IN ('admin', 'user')),
	`created_at` TEXT NOT NULL,
	`updated_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`token_hash` TEXT NOT NULL UNIQUE,
	`device_id` TEXT,
	`device_name` TEXT,
	`client_type` TEXT NOT NULL CHECK (`client_type` IN ('web', 'mobile')),
	`replaced_by_id` TEXT,
	`grace_until` TEXT,
	`expires_at` TEXT NOT NULL,
	`revoked_at` TEXT,
	`last_used_at` TEXT,
	`created_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_refresh_tokens_user_id` ON `refresh_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_refresh_tokens_expires_at` ON `refresh_tokens` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`title` TEXT NOT NULL,
	`subtitle` TEXT,
	`authors` TEXT NOT NULL DEFAULT '[]',
	`primary_author` TEXT,
	`series_name` TEXT,
	`series_number` REAL,
	`isbn_10` TEXT,
	`isbn_13` TEXT,
	`page_count` INTEGER CHECK (`page_count` IS NULL OR `page_count` > 0),
	`published_year` INTEGER CHECK (`published_year` IS NULL OR (`published_year` >= 1000 AND `published_year` <= 2100)),
	`genres` TEXT NOT NULL DEFAULT '[]',
	`description` TEXT,
	`cover_key` TEXT,
	`cover_source_url` TEXT,
	`language` TEXT,
	`publisher` TEXT,
	`metadata_source` TEXT NOT NULL DEFAULT 'manual' CHECK (`metadata_source` IN ('manual', 'openlibrary', 'google_books', 'hardcover')),
	`metadata_external_id` TEXT,
	`created_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` TEXT NOT NULL,
	`updated_at` TEXT NOT NULL,
	`server_updated_at` TEXT NOT NULL,
	`deleted_at` TEXT
);
--> statement-breakpoint
CREATE INDEX `idx_books_isbn13` ON `books` (`isbn_13`);
--> statement-breakpoint
CREATE INDEX `idx_books_isbn10` ON `books` (`isbn_10`);
--> statement-breakpoint
CREATE INDEX `idx_books_series` ON `books` (`series_name`, `series_number`);
--> statement-breakpoint
CREATE INDEX `idx_books_primary_author` ON `books` (`primary_author`);
--> statement-breakpoint
CREATE INDEX `idx_books_server_updated_at` ON `books` (`server_updated_at`, `id`);
--> statement-breakpoint
CREATE TABLE `user_books` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`book_id` TEXT NOT NULL REFERENCES `books`(`id`) ON DELETE RESTRICT,
	`status` TEXT NOT NULL DEFAULT 'unread' CHECK (`status` IN ('unread', 'reading', 'read', 'abandoned')),
	`rating` INTEGER CHECK (`rating` IS NULL OR (`rating` >= 1 AND `rating` <= 5)),
	`notes` TEXT,
	`added_at` TEXT NOT NULL,
	`started_at` TEXT,
	`finished_at` TEXT,
	`created_at` TEXT NOT NULL,
	`updated_at` TEXT NOT NULL,
	`server_updated_at` TEXT NOT NULL,
	`deleted_at` TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_books_active_unique` ON `user_books` (`user_id`, `book_id`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_user_books_user_status` ON `user_books` (`user_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_user_books_user_sync` ON `user_books` (`user_id`, `server_updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_user_books_user_added` ON `user_books` (`user_id`, `added_at`);

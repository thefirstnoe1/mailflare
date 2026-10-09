import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8"));
const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const ordered = journal.entries.map(({ tag }) => `${tag}.sql`).filter((name) => files.includes(name));
const migrations = [...ordered, ...files.filter((name) => !ordered.includes(name))];
const dropMigration = "0061_drop_license_settings.sql";

function applyMigration(database, name) {
	database.transaction(() => {
		database.exec(readFileSync(join(migrationsDir, name), "utf8"));
		database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
	})();
}

function databaseFor(t) {
	const database = new Database(":memory:");
	t.after(() => database.close());
	database.pragma("foreign_keys = ON");
	database.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
	return database;
}

function hasLicenseTable(database) {
	return !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'license_settings'").get();
}

test("setup initializes databases through the shared migration runner", () => {
	const source = readFileSync(join(root, "src/lib/setup/migration.ts"), "utf8");
	assert.match(source, /applyPendingMigrations\(db\)/);
});

test("fresh migrated schema accepts current mailbox inserts without removed tables", (t) => {
	const database = databaseFor(t);
	assert.ok(migrations.includes(dropMigration));
	assert.ok(journal.entries.some(({ tag }) => `${tag}.sql` === dropMigration));
	for (const name of migrations) applyMigration(database, name);
	assert.equal(hasLicenseTable(database), false);
	assert.ok(database.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(dropMigration));
	database.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u', 'a@b.c', 'x', 'n', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (
			id, user_id, domain_id, local_part, display_name,
			signature, auto_reply_enabled, auto_reply_subject, auto_reply_body, created_at
		) VALUES ('m', 'u', 'd', 'admin', 'admin', 'sig', 0, 'Out of office', '', 1);
		INSERT INTO auto_reply_deliveries (id, mailbox_id, recipient, sent_at) VALUES ('ar', 'm', 'x@y.z', 1);
	`);
	assert.equal(database.prepare("SELECT signature FROM mailboxes WHERE id = 'm'").get().signature, "sig");
});

test("upgrading an existing database drops persisted activation data", (t) => {
	const database = databaseFor(t);
	const dropIndex = migrations.indexOf(dropMigration);
	assert.notEqual(dropIndex, -1);
	for (const name of migrations.slice(0, dropIndex)) applyMigration(database, name);
	assert.equal(hasLicenseTable(database), true);
	database.exec("INSERT INTO license_settings (id, instance_id, updated_at) VALUES ('default', 'inst', 1)");
	for (const name of migrations.slice(dropIndex)) applyMigration(database, name);
	assert.equal(hasLicenseTable(database), false);
});

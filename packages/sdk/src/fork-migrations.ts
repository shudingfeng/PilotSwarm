/**
 * This fork's own CMS migration numbers.
 *
 * Upstream numbers its migrations one after another (`0001`, `0002`, …), so a number this fork took from that sequence
 * would sooner or later name a different upstream migration, and a database that recorded it would be refused by the
 * name check (`assertRecordedMigrationNames`). A migration of this fork's own therefore takes a version from `9001` up
 * (the block `9000` to `9999`, which upstream's sequence never reaches) and is listed after every upstream migration in
 * `CMS_MIGRATIONS`, so an upstream sync never changes what a recorded fork version means.
 *
 * Upstream's later migrations then run after the fork's on an existing database and before them on a new one, so a
 * fork migration must give the same schema in either order: it only adds objects (columns with constant defaults, new
 * procedures), is idempotent and replaces no upstream procedure. A column it adds to a table that upstream extends later
 * still ends at a different position on the two kinds of database; the commute test reports that, and the sync that
 * brings such an upstream migration decides whether the order matters. The Facts and HorizonDB schemas follow the same
 * rule; this fork has no migration there yet.
 *
 * @module
 */

/**
 * For each of this fork's CMS migrations, the upstream migration it was written against: the last upstream migration
 * in the list when it was added. A deployment that ran it then ran it right after that one, and runs upstream's later
 * migrations after it; the commute test (`test/local/fork-migrations.test.js`) migrates one schema in that order and
 * one in list order, and both must end the same. An upstream sync leaves these entries as they are.
 */
export const FORK_CMS_MIGRATION_BASES: Readonly<Record<string, string>> = Object.freeze({
    "9001": "0095", // dispatcher_delegation, written against canvas_ten_slots
});

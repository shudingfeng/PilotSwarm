/**
 * This fork's own migrations take versions from 9001 to 9999 and are listed after every upstream migration, so a new
 * database runs them last. A deployment that ran one when its base (the upstream migration it was written against,
 * FORK_CMS_MIGRATION_BASES in src/fork-migrations.ts) was upstream's latest ran it right after that base, and the
 * upstream migrations added later after it.
 */

/** Whether a migration version is in the block this fork keeps for its own migrations. */
export function isForkMigrationVersion(version) {
    return Number(version) >= 9000;
}

/**
 * The migrations in the order an existing deployment ran them: each fork migration right after its base, fork
 * migrations with the same base in list order. Throws when a fork migration's base is not an upstream migration of
 * the list.
 */
export function deploymentOrder(migrations, bases) {
    const fork = migrations.filter(migration => isForkMigrationVersion(migration.version));
    const order = migrations
        .filter(migration => !isForkMigrationVersion(migration.version))
        .flatMap(migration => [migration, ...fork.filter(item => bases[item.version] === migration.version)]);
    const unplaced = fork.filter(item => !order.includes(item)).map(item => item.version);
    if (unplaced.length > 0) {
        throw new Error(`Fork migration ${unplaced.join(", ")} has no upstream base in the list`);
    }
    return order;
}

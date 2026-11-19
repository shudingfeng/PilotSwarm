/**
 * This fork numbers its own migrations in a block that upstream's sequence never reaches: versions 9001 to 9999,
 * listed after every upstream migration, so an upstream sync never changes what a recorded fork version means. Each of
 * its CMS migrations names, in FORK_CMS_MIGRATION_BASES, the upstream migration it was written against; an existing
 * deployment ran it right after that one, and test/local/fork-migrations.test.js checks against PostgreSQL that this
 * order and the list order give the same schema. The Facts and HorizonDB lists follow the same rule; this fork has no
 * migration there yet.
 *
 * Run: node --test test/unit/fork-migrations.test.mjs (after npm run build)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { FACTS_MIGRATIONS } from "../../dist/facts-migrations.js";
import { FORK_CMS_MIGRATION_BASES } from "../../dist/fork-migrations.js";
import { loadMigrations } from "../../../horizon-store/src/horizon-migrator.ts";
import { deploymentOrder } from "../helpers/fork-migrations.js";

/**
 * Upstream's versions (below 9000) first and strictly ascending, then this fork's, from 9001 to 9999 and strictly
 * ascending, each with a base in `bases` that is an upstream version of the list, no earlier than the previous fork
 * migration's base. Returns the fork versions.
 */
function assertForkRanges(label, migrations, bases) {
    const versions = migrations.map(migration => migration.version);
    for (const version of versions) assert.match(version, /^\d{4}$/, `${label}: version ${version} has four digits`);
    const firstFork = versions.findIndex(version => Number(version) >= 9000);
    const upstream = firstFork === -1 ? versions : versions.slice(0, firstFork);
    const fork = firstFork === -1 ? [] : versions.slice(firstFork);
    upstream.forEach((version, i) => {
        if (i > 0) assert.ok(Number(version) > Number(upstream[i - 1]), `${label}: upstream ${version} follows ${upstream[i - 1]}`);
    });
    fork.forEach((version, i) => {
        assert.ok(Number(version) >= 9001 && Number(version) <= 9999, `${label}: ${version}, after a fork migration, is in 9001-9999`);
        if (i > 0) assert.ok(Number(version) > Number(fork[i - 1]), `${label}: fork ${version} follows ${fork[i - 1]}`);
        assert.ok(upstream.includes(bases[version]), `${label}: fork ${version}'s base, ${bases[version]}, is an upstream version of the list`);
        if (i > 0) {
            assert.ok(Number(bases[version]) >= Number(bases[fork[i - 1]]),
                `${label}: fork ${version} is based on ${bases[version]}, before ${fork[i - 1]}'s base ${bases[fork[i - 1]]}`);
        }
    });
    assert.deepEqual(Object.keys(bases).sort(), fork, `${label}: the base table names exactly the fork migrations of the list`);
    return fork;
}

test("CMS: upstream's migrations below 9000 in order, then this fork's from 9001, each with its upstream base", () => {
    assert.equal(assertForkRanges("CMS", CMS_MIGRATIONS("s"), FORK_CMS_MIGRATION_BASES)[0], "9001");
});

test("the dispatcher delegation migration is this fork's 9001, written against upstream's 0095", () => {
    const list = CMS_MIGRATIONS("s");
    assert.deepEqual(list.filter(migration => migration.name === "dispatcher_delegation").map(migration => migration.version), ["9001"]);
    assert.equal(FORK_CMS_MIGRATION_BASES["9001"], "0095");
});

test("Facts and HorizonDB: the same rule, with no fork migration yet", () => {
    assertForkRanges("Facts", FACTS_MIGRATIONS("s"), {});
    // A HorizonDB fork migration would also need loadMigrations, which requires contiguous file numbers, to allow the block.
    assertForkRanges("HorizonDB", loadMigrations({ schema: "s", graphName: "g", embeddingDim: 3 }), {});
});

test("an existing deployment ran each fork migration right after its base, and later upstream migrations after it", () => {
    const list = ["0001", "0002", "0003", "9001", "9002", "9003"].map(version => ({ version, name: `m${version}` }));
    const order = (bases) => deploymentOrder(list, bases).map(migration => migration.version);
    assert.deepEqual(order({ 9001: "0001", 9002: "0002", 9003: "0002" }), ["0001", "9001", "0002", "9002", "9003", "0003"]);
    assert.deepEqual(order({ 9001: "0003", 9002: "0003", 9003: "0003" }), ["0001", "0002", "0003", "9001", "9002", "9003"]);
    assert.throws(() => order({ 9001: "0001", 9002: "0004", 9003: "0002" }), /Fork migration 9002 has no upstream base/);

    const cms = deploymentOrder(CMS_MIGRATIONS("s"), FORK_CMS_MIGRATION_BASES).map(migration => migration.version);
    assert.deepEqual([...cms].sort(), CMS_MIGRATIONS("s").map(migration => migration.version).sort());
    assert.equal(cms[cms.indexOf("0095") + 1], "9001");
});

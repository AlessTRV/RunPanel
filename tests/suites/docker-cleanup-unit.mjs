import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The arithmetic and the argument lists behind "Pulisci ora".
 *
 * The button used to report 0 MB freed for a reason that had nothing to do with
 * what it removed: `docker builder prune` under BuildKit ends with
 * `Total:\t1.2GB`, not the `Total reclaimed space:` line the parser looked
 * for, so the largest thing it cleaned was always counted as nothing. And the
 * image tags it retired were never counted at all — `docker rmi` prints no
 * size. Pure functions, so all of it runs without a daemon.
 */
export const meta = { name: "docker-cleanup-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("docker-cleanup-unit");
  const {
    parseDockerSize,
    parseReclaimed,
    footprintFromDf,
    buildCachePruneArgs,
    danglingImagePruneArgs,
    unusedImageRefs,
    composeOrphanImages,
    CONTAINER_LOG_ARGS,
  } = await import(pathToFileURL(join(repoRoot, "lib", "docker-cleanup.ts")).href);

  // --- sizes, as Docker prints them -------------------------------------------
  r.check("bytes", parseDockerSize("0B") === 0);
  r.check("kilobytes are lowercase k in Docker's output", parseDockerSize("12kB") === 12_000, String(parseDockerSize("12kB")));
  r.check("megabytes", parseDockerSize("966.7MB") === 966_700_000, String(parseDockerSize("966.7MB")));
  r.check("gigabytes", parseDockerSize("35.17GB") === 35_170_000_000, String(parseDockerSize("35.17GB")));
  r.check("with the reclaimable percentage still attached", parseDockerSize("13.33GB (37%)") === 13_330_000_000);
  r.check("garbage is zero, not NaN", parseDockerSize("n/a") === 0);

  // --- what a prune says it freed ----------------------------------------------
  r.check("image prune's line", parseReclaimed("Deleted Images:\nx\n\nTotal reclaimed space: 1.5GB") === 1_500_000_000);
  r.check(
    "builder prune's BuildKit line, the one that was always read as zero",
    parseReclaimed("ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nabc\ttrue\t10MB\t2 days ago\nTotal:\t2.25GB") === 2_250_000_000,
    String(parseReclaimed("Total:\t2.25GB"))
  );
  r.check("nothing freed is zero", parseReclaimed("Total:\t0B") === 0);
  r.check("no total line is zero", parseReclaimed("") === 0);

  // --- the whole footprint, from `docker system df` -----------------------------
  {
    const df = "Images\t35.17GB\nContainers\t966.7MB\nLocal Volumes\t1.657GB\nBuild Cache\t7.109GB\n";
    const total = footprintFromDf(df);
    r.check(
      "the footprint sums every kind",
      Math.abs(total - (35_170_000_000 + 966_700_000 + 1_657_000_000 + 7_109_000_000)) < 1,
      String(total)
    );
    r.check("an empty listing is zero", footprintFromDf("") === 0);
  }

  // --- build cache ----------------------------------------------------------------
  r.check(
    "zero hours means all of it",
    buildCachePruneArgs(0).join(" ") === "builder prune -f --all",
    buildCachePruneArgs(0).join(" ")
  );
  r.check(
    "otherwise only what is older than the retention",
    buildCachePruneArgs(168).join(" ") === "builder prune -f --filter until=168h",
    buildCachePruneArgs(168).join(" ")
  );

  // --- images -----------------------------------------------------------------------
  r.check(
    "a routine pass prunes only RunPanel's own dangling images",
    danglingImagePruneArgs(false).join(" ") === "image prune -f --filter dangling=true --filter label=runpanel.managed=true",
    danglingImagePruneArgs(false).join(" ")
  );
  r.check(
    "a deep pass prunes every dangling image: untagged and unused is garbage whoever made it",
    danglingImagePruneArgs(true).join(" ") === "image prune -f --filter dangling=true",
    danglingImagePruneArgs(true).join(" ")
  );
  // Chosen by hand rather than with `prune -a --filter label!=…`: under the
  // containerd image store that combination selects nothing at all, verified
  // against Docker 29 rather than assumed from the documentation.
  {
    const images = [
      { id: "aaaaaaaaaaaa", ref: "espressif/idf:v5.4" },
      { id: "bbbbbbbbbbbb", ref: "postgres:16-alpine" },
      { id: "cccccccccccc", ref: "runpanel/shop:abc123" },
      { id: "dddddddddddd", ref: "<none>:<none>" },
      // One image under two names: both names go, or the image stays.
      { id: "eeeeeeeeeeee", ref: "postgres:15" },
      { id: "eeeeeeeeeeee", ref: "postgres:15.15" },
    ];
    const owned = new Set(["cccccccccccc"]);
    // Containers report the full digest; listings print a short id.
    const used = new Set(["sha256:bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000"]);
    const refs = unusedImageRefs(images, owned, used);
    r.check("an image no container uses is a candidate", refs.includes("espressif/idf:v5.4"), refs.join(","));
    r.check("one a container uses is not, even a stopped one", !refs.includes("postgres:16-alpine"), refs.join(","));
    r.check("RunPanel's rollback tags are spared", !refs.includes("runpanel/shop:abc123"));
    r.check("an untagged one is removed by id", refs.includes("dddddddddddd"), refs.join(","));
    r.check("every name of a multi-tagged image is listed", refs.includes("postgres:15") && refs.includes("postgres:15.15"));
  }

  // --- images compose built for a project that no longer exists ----------------------
  {
    const images = [
      { ref: "runpanel-gone-web:latest", composeProject: "runpanel-gone" },
      { ref: "runpanel-alive-web:latest", composeProject: "runpanel-alive" },
      // A compose project the operator runs by hand, not through the panel.
      { ref: "immich-server:v2", composeProject: "immich" },
      { ref: "plain:latest", composeProject: null },
    ];
    const orphans = composeOrphanImages(images, new Set(["alive"]));
    r.check("a deleted project's compose image is an orphan", orphans.includes("runpanel-gone-web:latest"), orphans.join(","));
    r.check("a live project's is not", !orphans.includes("runpanel-alive-web:latest"));
    r.check("a stack the panel never ran is never touched", !orphans.includes("immich-server:v2"));
    r.check("nor an image compose did not build", !orphans.includes("plain:latest"));
  }

  // --- containers keep their logs bounded ---------------------------------------------
  r.check(
    "every container RunPanel starts rotates its log",
    CONTAINER_LOG_ARGS.join(" ") === "--log-opt max-size=10m --log-opt max-file=3",
    CONTAINER_LOG_ARGS.join(" ")
  );

  return r.result();
}

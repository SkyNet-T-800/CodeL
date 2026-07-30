import { execFile } from "node:child_process";

import { 
    cp,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath} from "node:url";  

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(
    new URL("../../fixtures/w2-repo", import.meta.url)
)

export interface TemporaryRepository {
    readonly temporaryRoot: string;
    readonly repoRoot: string;
    readonly outsideRoot: string;
    cleanup(): Promise<void>;
}

export async function createTemporaryRepository(
    options: { readonly initializeGit?: boolean } = {}
): Promise<TemporaryRepository> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "repo-circuit-w2-"));
    const repoRoot = join(temporaryRoot, "repo");
    const outsideRoot = join(temporaryRoot, "outside");

    await cp(fixtureRoot, repoRoot, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "outside\n", "utf8");
    await writeFile(
        join(repoRoot, "binary.bin"),
        Buffer.from([0x00, 0x01, 0x02, 0x03])
    );

    await symlink(outsideRoot, join(repoRoot, "escape"), "dir");

    if (options.initializeGit === true) {
        await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });
        await execFileAsync("git", ["config", "user.name", "fixture-user"], {
            cwd: repoRoot
        });
        await execFileAsync("git", ["config", "user.email", "fixture@example.invalid"], {
            cwd: repoRoot
        });
        await execFileAsync("git", ["add", "."], { cwd: repoRoot });
        await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], {
            cwd: repoRoot
        }); 
    }

    return {
        temporaryRoot,
        repoRoot,
        outsideRoot,
        async cleanup() {
            await rm(temporaryRoot, { recursive: true, force: true });
        }
    };



}

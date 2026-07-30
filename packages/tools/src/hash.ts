import { createHash } from "node:crypto";

import type { ReadFileBytesOptions } from "./text-file.js";
import { readFileBytes } from "./text-file.js";

export function sha256Hex(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(
    filePath: string,
    options: ReadFileBytesOptions = {}
): Promise<string> {
    return sha256Hex(await readFileBytes(filePath, options));
}
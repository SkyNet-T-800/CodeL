import { open } from "node:fs/promises";

import { ToolError } from "@repo-circuit/core";

import { 
    assertPositiveSafeInteger,
    DEFAULT_TOOL_LIMITS
} from "./limits.js"

export interface ReadFileBytesOptions {
    readonly maxBytes?: number;
}

export interface TextFileContents {
    readonly content: string;
    readonly byteLength: number;
}

function isErrno(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code
    );
}

export function isProbablyBinary(data: Uint8Array): boolean {
    if (data.includes(0)) {
        return true;
    }

    const sample = data.subarray(0, Math.min(data.byteLength, 8_192));
    let suspiciousControls = 0;
    for (const byte of sample) {
        const allowedWhitespace = byte === 9 || byte === 10 || byte === 13;
        if ((byte < 32 && !allowedWhitespace) || byte === 127) {
            suspiciousControls += 1;
        }
    }
    return sample.byteLength > 0 && suspiciousControls / sample.byteLength > 0.1;
}

export async function readFileBytes(
    filePath: string,
    options: ReadFileBytesOptions = {}
): Promise<Uint8Array> {
    const maxBytes = assertPositiveSafeInteger(
        options.maxBytes ?? DEFAULT_TOOL_LIMITS.maxFileBytes,
        "maxBytes"
    )

    let handle;
    try {
        handle = await open(filePath, "r");
    } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            throw new ToolError("PATH_NOT_FOUND", "File does not exist");
        }
        throw error;
    }

    try {
        const fileStats = await handle.stat();
        if (!fileStats.isFile()) {
            throw new ToolError("NOT_A_FILE", "Path is not a regular file");
        }
        if (fileStats.size > maxBytes) {
            throw new ToolError(
                "FILE_TOO_LARGE",
                `File exceeds the ${maxBytes}-byte limit`,
                { maxBytes }
            )
        }

        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        while (true) {
            const remainingWithSentinel = maxBytes + 1 - byteLength;
            if (remainingWithSentinel <= 0) {
                throw new ToolError(
                    "FILE_TOO_LARGE",
                    `File exceeds the ${maxBytes}-byte limit`,
                    { maxBytes }
                );
            }
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remainingWithSentinel));
            const { bytesRead } = await handle.read(buffer, 0 , buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            byteLength += bytesRead;
            if (byteLength > maxBytes) {
                throw new ToolError(
                    "FILE_TOO_LARGE",
                    `File exceeds the ${maxBytes}-byte limit`,
                    { maxBytes }
                );
            }
            chunks.push(buffer.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, byteLength);
    } finally {
        await handle.close();
    }
}

export function decodeUtf8Text(data: Uint8Array): string {
    if (isProbablyBinary(data)) {
        throw new ToolError("BINARY_FILE", "Binary files are not supported");
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
        throw new ToolError("BINARY_FILE", "File is not valid UTF-8 text");
    }
}

export async function readTextFile(
    filePath: string,
    options: ReadFileBytesOptions = {}
): Promise<TextFileContents> {
    const bytes = await readFileBytes(filePath, options);
    return {
        content: decodeUtf8Text(bytes),
        byteLength: bytes.byteLength
    };
}




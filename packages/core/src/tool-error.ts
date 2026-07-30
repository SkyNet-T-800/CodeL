import type { JsonObject } from "./contracts.js";

export class ToolError extends Error {
    readonly code: string;
    readonly details: JsonObject | undefined;

    constructor(code: string, message: string, details?: JsonObject) {
        super(message);
        this.name = "ToolError";
        this.code = code;
        this.details = details;
    }
}
import type { JsonObject, JsonValue } from "./contracts.js";

export interface JsonSchemaIssue {
    readonly path: string;
    readonly message: string;
}

const JSON_TYPES = new Set([
    "array",
    "boolean",
    "integer",
    "null",
    "number",
    "object",
    "string"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function escapePathKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

function describeType(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return "integer";
    }
    return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((item, index) => jsonEquals(item, right[index]))
        );
    }
    if (isRecord(left) && isRecord(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every(
                (key) => hasOwn(right, key) && jsonEquals(left[key], right[key])
            )
        );
    }
    return false;
}

function schemaArray(
    schema: Record<string, unknown>,
    keyword: "allOf" | "anyOf" | "oneOf"
): readonly JsonObject[] | undefined {
    const value = schema[keyword];
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || !value.every(isRecord)) {
        throw new Error(`Invalid JSON Schema: ${keyword} must be an array of schemas`);
    }
    return value as readonly JsonObject[];
}

function schemaKeyword(
    schema: Record<string, unknown>,
    keyword: "if" | "then" | "else"
): JsonObject | undefined {
    const value = schema[keyword];
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`Invalid JSON Schema: ${keyword} must be a schema`);
    }
    return value as JsonObject;
}

function numericKeyword(
    schema: Record<string, unknown>,
    keyword: string
): number | undefined {
    const value = schema[keyword];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Invalid JSON Schema: ${keyword} must be a finite number`);
    }
    return value;
}

function nonNegativeIntegerKeyword(
    schema: Record<string, unknown>,
    keyword: string
): number | undefined {
    const value = numericKeyword(schema, keyword);
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(`Invalid JSON Schema: ${keyword} must be a non-negative integer`);
    }
    return value;
}

function validateNode(
    schema: JsonObject,
    value: unknown,
    path: string,
    depth: number
): JsonSchemaIssue[] {
    if (depth > 64) {
        throw new Error("Invalid JSON Schema: nesting exceeds 64 levels");
    }

    const schemaRecord: Record<string, unknown> = schema;
    const issues: JsonSchemaIssue[] = [];

    const allOf = schemaArray(schemaRecord, "allOf");
    if (allOf !== undefined) {
        for (const child of allOf) {
            issues.push(...validateNode(child, value, path, depth + 1));
        }
    }

    const anyOf = schemaArray(schemaRecord, "anyOf");
    if (anyOf !== undefined && !anyOf.some((child)=> validateNode(child, value, path, depth + 1).length === 0 )) {
        issues.push({ path, message: "must match at least one anyOf schema" });
    }

    const oneOf = schemaArray(schemaRecord, "oneOf");
    if (oneOf !== undefined) {
        const matches = oneOf.filter(
            (child) => validateNode(child, value, path, depth + 1).length === 0
        ).length;
        if (matches === 0) {
            issues.push({ path, message: "must match exactly one oneOf schema" });
        }
    }

    const ifSchema = schemaKeyword(schemaRecord, "if");
    const thenSchema = schemaKeyword(schemaRecord, "then");
    const elseSchema = schemaKeyword(schemaRecord, "else");
    if (ifSchema !== undefined) {
        const conditionMatches =
            validateNode(ifSchema, value, path, depth + 1).length === 0;
        const branch = conditionMatches ? thenSchema : elseSchema;
        if (branch !== undefined) {
            issues.push(...validateNode(branch, value, path, depth + 1));
        }
    }

    if (hasOwn(schemaRecord, "const") && !jsonEquals(value, schemaRecord.const)) {
        issues.push({ path, message: "must match const schema" });
    }

    const enumValues = schemaRecord.enum;
    if (enumValues !== undefined) {
        if (!Array.isArray(enumValues)) {
            throw new Error(`Invalid JSON Schema: enum must be an array`);
        }
        if (!enumValues.includes(value)) {
            issues.push({ path, message: "must equal one of the enum values" });
        }
    }

    const decalredType = schemaRecord.type;
    let allowedTypes: readonly string[] | undefined;
    if (typeof decalredType === "string") {
        allowedTypes = [decalredType];
    } else if (
        Array.isArray(decalredType) && decalredType.length > 0 &&
        decalredType.every((item) => typeof item === "string")
    ) {
        allowedTypes = decalredType;
    } else if (decalredType !== undefined) {
        throw new Error(
            "Invalid JSON Schema: type must be a string or non-empty string array"
        );
    }

    if (allowedTypes !== undefined) {
        const schemaTypesAreValid = allowedTypes.every((type) =>
            JSON_TYPES.has(type)
        );

        const valueMatches = allowedTypes.some((type) =>
            matchesType(value, type)
        );

        if (!schemaTypesAreValid || !valueMatches) {
            issues.push({
            path,
            message: `must be ${allowedTypes.join(" or ")}; received ${describeType(value)}`
            });
            return issues;
        }
    }

    if (typeof value === "string") {
        const minLength = nonNegativeIntegerKeyword(schemaRecord, "minLength");
        const maxLength = nonNegativeIntegerKeyword(schemaRecord, "maxLength");
        if (minLength !== undefined && [...value].length < minLength) {
            issues.push({ path, message: `must contain at least ${minLength} characters` });
        }
        if (maxLength !== undefined && [...value].length > maxLength) {
            issues.push({ path, message: `must contain at most ${maxLength} characters` });
        }
        if (schemaRecord.pattern !== undefined) {
            if (typeof schemaRecord.pattern !== "string") {
                throw new Error("Invalid JSON Schema: pattern must be a string");
            }
            let pattern: RegExp;
            try {
                pattern = new RegExp(schemaRecord.pattern, "u");
            } catch (error) {
                throw new Error("Invalid JSON Schema: pattern must be a valid regular expression");
            }
            if (!pattern.test(value)) {
                issues.push({ path, message: "must match the declared pattern"})
            }
        }
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        const minimum = numericKeyword(schemaRecord, "minimum");
        const maximum = numericKeyword(schemaRecord, "maximum");
        const exclusiveMinimum = numericKeyword(schemaRecord, "exclusiveMinimum");
        const exclusiveMaximum = numericKeyword(schemaRecord, "exclusiveMaximum");
        if (minimum !== undefined && value < minimum) {
            issues.push({ path, message: `must be greater than or equal to ${minimum}` });
        }
        if (maximum !== undefined && value > maximum) {
            issues.push({ path, message: `must be less than or equal to ${maximum}` });
        }
        if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
            issues.push({ path, message: `must be greater than ${exclusiveMinimum}` });
        }
        if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
            issues.push({ path, message: `must be less than ${exclusiveMaximum}` });
        }
    }

    if (Array.isArray(value)) {
        const minItems = nonNegativeIntegerKeyword(schemaRecord, "minItems");
        const maxItems = nonNegativeIntegerKeyword(schemaRecord, "maxItems");
        if (minItems !== undefined && value.length < minItems) {
            issues.push({ path, message: `must contain at least ${minItems} items` });
        }
        if (maxItems !== undefined && value.length > maxItems) {
            issues.push({ path, message: `must contain at most ${maxItems} items` });
        }
        const uniqueItems = schemaRecord.uniqueItems;
        if (uniqueItems !== undefined && typeof uniqueItems !== "boolean") {
            throw new Error("Invalid JSON Schema: uniqueItems must be a boolean");
        }
        if (uniqueItems === true) {
            duplicateSearch:
            for (let left = 0; left < value.length; left += 1) {
                for (let right = left + 1; right < value.length; right += 1) {
                    if (jsonEquals(value[left], value[right])) {
                        issues.push({
                            path,
                            message: `must contain unique items; indexes ${left} and ${right} are equal`
                        });
                        break duplicateSearch;
                    }
                }
            }
        }
        if (schemaRecord.items !== undefined) {
            if (!isRecord(schemaRecord.items)) {
                throw new Error("Invalid JSON Schema: items must be a schema");
            }
            value.forEach((item, index) => {
                issues.push(
                    ...validateNode(
                        schemaRecord.items as JsonObject,
                        item,
                        `${path}[${index}]`,
                        depth + 1
                    )
                );
            });
        }
    }   

    if (isRecord(value)) {
        const minProperties = nonNegativeIntegerKeyword(schemaRecord, "minProperties");
        const maxProperties = nonNegativeIntegerKeyword(schemaRecord, "maxProperties");
        const keys = Object.keys(value);
        if (minProperties !== undefined && keys.length < minProperties) {
            issues.push({
                path,
                message: `must contain at least ${minProperties} properties`
            });
        }
        if (maxProperties !== undefined && keys.length > maxProperties) {
            issues.push({
                path,
                message: `must contain at most ${maxProperties} properties`
            });
        }

        const required = schemaRecord.required;
        if (
            required !== undefined &&
            (!Array.isArray(required) || 
               !required.every((key) => typeof key === "string"))
        ) {
            throw new Error("Invalid JSON Schema: required must be a string array");
        }
        for (const key of (required ?? []) as readonly string[]) {
            if (!hasOwn(value, key)) {
                issues.push({
                    path: `${path}${escapePathKey(key)}`,
                    message: "is required"
                });
            }
        }

        const properties = schemaRecord.properties;
        if (properties !== undefined && !isRecord(properties)) {
            throw new Error("Invalid JSON Schema: properties must be an object");
        }

        const propertySchemas = properties ?? {};
        for (const [key, childSchema] of Object.entries(propertySchemas)) {
            if (!isRecord(childSchema)) {
                throw new Error(
                    `Invalid JSON Schema: properties.${key} must be a schema`
                )
            }
            if (hasOwn(value, key)) {
                issues.push(
                    ...validateNode(
                        childSchema as JsonObject,
                        value[key],
                        `${path}${escapePathKey(key)}`,
                        depth + 1
                    )
                );
            }
        }

        const additionalProperties = schemaRecord.additionalProperties;
        if (
            additionalProperties !== undefined &&
            typeof additionalProperties !== "boolean" &&
            !isRecord(additionalProperties)
        ) {
            throw new Error("Invalid JSON Schema: additionalProperties must be boolean or a schema")
        }
        for (const key of keys) {
            if (hasOwn(propertySchemas, key)) {
                continue;
            }
            if (additionalProperties === false) {
                issues.push({
                    path: `${path}${escapePathKey(key)}`,
                    message: "is not an allowed property"
                });
            } else if (isRecord(additionalProperties)) {
                issues.push(
                    ...validateNode(
                        additionalProperties as JsonObject,
                        value[key],
                        `${path}${escapePathKey(key)}`,
                        depth + 1
                    )
                );
            }
        }
    }
    return issues;
}

export function validateJsonSchema(
    schema: JsonObject,
    value: JsonValue
): readonly JsonSchemaIssue[] {
    return validateNode(schema, value, "$", 0);
}












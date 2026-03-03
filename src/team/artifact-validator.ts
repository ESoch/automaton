/**
 * Artifact Content Validator
 *
 * Validates artifact content_json against JSON schemas
 * based on artifact_type. Unknown types pass validation
 * (forward-compatible).
 */

import Ajv from "ajv";
import type { ValidateFunction, ErrorObject } from "ajv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Map artifact_type to schema file name
const SCHEMA_MAP: Record<string, string> = {
  opportunity_brief: "opportunity-brief-content.json",
  design_doc: "design-doc-content.json",
  eval_report: "eval-report-content.json",
  security_review: "security-review-content.json",
  retrospective: "retrospective-content.json",
};

// Resolve schemas directory (3 levels up from automaton/src/team/ to project root)
const SCHEMAS_DIR = path.resolve(__dirname, "..", "..", "..", "schemas");

const compiledValidators = new Map<string, ValidateFunction>();

function createAjv(): { compile: (schema: object) => ValidateFunction } {
  // Handle CJS/ESM interop — Ajv may be the class itself or { default: class }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvClass = (Ajv as any).default ?? Ajv;
  return new AjvClass({ allErrors: true });
}

function getValidator(artifactType: string): ValidateFunction | null {
  const schemaFile = SCHEMA_MAP[artifactType];
  if (!schemaFile) return null;

  if (compiledValidators.has(artifactType)) {
    return compiledValidators.get(artifactType)!;
  }

  const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
  if (!fs.existsSync(schemaPath)) return null;

  const rawSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  // Remove $schema and $id to avoid Ajv meta-schema issues and caching conflicts
  const { $schema: _s, $id: _i, ...schema } = rawSchema;

  const ajv = createAjv();
  const validate = ajv.compile(schema);
  compiledValidators.set(artifactType, validate);
  return validate;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate artifact content against its type's JSON schema.
 * Unknown artifact types pass validation (forward-compatible).
 */
export function validateArtifactContent(
  artifactType: string,
  contentJson: string,
): ValidationResult {
  const validator = getValidator(artifactType);

  // Unknown types pass validation
  if (!validator) {
    return { valid: true, errors: [] };
  }

  let content: unknown;
  try {
    content = JSON.parse(contentJson);
  } catch {
    return { valid: false, errors: ["content_json is not valid JSON"] };
  }

  const valid = validator(content);
  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = ((validator.errors ?? []) as ErrorObject[]).map((err) => {
    const field = err.instancePath || "/";
    return `${field}: ${err.message}`;
  });

  return { valid: false, errors };
}

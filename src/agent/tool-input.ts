/** JSON Schema keywords used by review tools. Keep registration and execution on this contract. */
export type ToolInputSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  enum?: readonly (string | number | boolean | null)[];
  properties?: Record<string, ToolInputSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: ToolInputSchema;
  minItems?: number; maxItems?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number; exclusiveMinimum?: number;
};

/** Validate the declared subset; session methods still own state-dependent/domain checks. */
export function validateToolInput(schema: ToolInputSchema, value: unknown, path = '参数'): void {
  const fail = () => { throw new Error(`${path}不符合工具参数约定。`); };
  if (schema.enum && !schema.enum.some(option => option === value)) fail();
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
      const object = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      if (schema.required?.some(key => !Object.hasOwn(object, key))) fail();
      for (const key of Object.keys(object)) {
        if (Object.hasOwn(properties, key)) validateToolInput(properties[key], object[key], `${path}.${key}`);
        else if (schema.additionalProperties === false) fail();
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) fail();
      const array = value as unknown[];
      if (schema.minItems !== undefined && array.length < schema.minItems || schema.maxItems !== undefined && array.length > schema.maxItems) fail();
      if (schema.items) for (const [index, item] of array.entries()) validateToolInput(schema.items, item, `${path}[${index}]`);
      break;
    }
    case 'string': {
      if (typeof value !== 'string') fail();
      const string = value as string;
      // JSON Schema measures Unicode code points rather than UTF-16 code units.
      const length = Array.from(string).length;
      if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) fail();
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(string)) fail();
      break;
    }
    case 'number': case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) fail();
      const number = value as number;
      if (schema.minimum !== undefined && number < schema.minimum || schema.maximum !== undefined && number > schema.maximum || schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum) fail();
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail();
  }
}

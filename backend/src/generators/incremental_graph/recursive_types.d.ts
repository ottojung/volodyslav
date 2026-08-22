
/**
 * A number admitted as a ConstValue is finite. TypeScript cannot distinguish
 * finite numbers structurally, so NodeKey serialization validates this runtime
 * invariant before persistence.
 */
export type ConstNumber = number;

export type ConstValue = ConstNumber | string | boolean | Array<ConstValue> | { [key: string]: ConstValue };

/** A recursively JSON-round-trippable semantic graph value. */
export type ComputedValue = null | ConstNumber | string | boolean | Array<ComputedValue> | { [key: string]: ComputedValue };

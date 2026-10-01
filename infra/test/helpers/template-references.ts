/**
 * Finds every resource in a synthesized template that refers to a given logical ID, in any
 * CloudFormation form: `Ref` and `Fn::GetAtt` arrays, `DependsOn`, the dotted
 * `Fn::GetAtt` string (`Id.Arn`), and `${Id}` / `${Id.Attr}` inside `Fn::Sub` strings.
 * Codex round 3 (R3-4) showed a search for the quoted ID alone misses `Fn::Sub`.
 *
 * Deliberately conservative: any string equal to the ID or beginning with `Id.` counts as a
 * reference, so a coincidental match fails a test rather than hiding one.
 */
export function referencesLogicalId(value: unknown, logicalId: string): boolean {
  if (typeof value === 'string') {
    return value === logicalId
      || value.startsWith(`${logicalId}.`)
      || value.includes(`\${${logicalId}}`)
      || value.includes(`\${${logicalId}.`);
  }
  if (Array.isArray(value)) return value.some(item => referencesLogicalId(item, logicalId));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => referencesLogicalId(key, logicalId) || referencesLogicalId(item, logicalId));
  }
  return false;
}

/** Logical IDs of every resource (other than the target itself) that references `logicalId` or contains any literal. */
export function resourcesReferencing(resources: Record<string, unknown>, logicalId: string, literals: string[] = []): string[] {
  return Object.entries(resources)
    .filter(([id]) => id !== logicalId)
    .filter(([, resource]) => referencesLogicalId(resource, logicalId) || literals.some(literal => JSON.stringify(resource).includes(literal)))
    .map(([id]) => id)
    .sort();
}

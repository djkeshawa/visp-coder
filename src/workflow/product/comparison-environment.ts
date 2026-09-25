/** Compare receipts of the same kind; command and capture identities have different domains. */
export function comparableEnvironments(
  before: { readonly comparisonEnvironment?: string },
  after: { readonly comparisonEnvironment?: string },
) {
  return (
    !!before.comparisonEnvironment?.trim() &&
    before.comparisonEnvironment === after.comparisonEnvironment
  );
}

export interface RepairEnvironmentChange {
  readonly from: string;
  readonly to: string;
}

/** An explicit assessment binds the exact observed change; unknown identities remain unusable. */
export function repairEnvironments(
  before: { readonly comparisonEnvironment?: string },
  after: { readonly comparisonEnvironment?: string },
  change?: RepairEnvironmentChange,
) {
  if (!change) return comparableEnvironments(before, after);
  return (
    !!before.comparisonEnvironment?.trim() &&
    !!after.comparisonEnvironment?.trim() &&
    before.comparisonEnvironment !== after.comparisonEnvironment &&
    change.from === before.comparisonEnvironment &&
    change.to === after.comparisonEnvironment
  );
}
